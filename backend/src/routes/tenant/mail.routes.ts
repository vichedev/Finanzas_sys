import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { encryptString, decryptString } from '../../lib/tenantCrypto';
import { testConnection, normalizeImap } from '../../lib/mailReader';
import { ingestTenantMail, attachComprobanteImage } from '../../lib/mailIngest';
import { createMovement } from './movements.routes';
import { auditFromReq } from '../../lib/tenantAudit';

// Lector de correo (IMAP) para ingerir comprobantes. Config + prueba de conexión.
export const mailRouter = Router();
mailRouter.use(requireAuth, (req, res, next) =>
  requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next)
);

async function getCfg(prisma: any) { return prisma.mailConfig.findUnique({ where: { id: 1 } }); }

function publicCfg(cfg: any) {
  return {
    enabled: cfg?.enabled ?? false,
    host: cfg?.host || 'imap.gmail.com',
    port: cfg?.port ?? 993,
    email: cfg?.email || null,
    folder: cfg?.folder || 'INBOX',
    autoCreate: cfg?.autoCreate ?? false,
    hasPassword: !!cfg?.passwordEnc,
    lastCheckAt: cfg?.lastCheckAt || null
  };
}

mailRouter.get('/config', async (req, res) => {
  res.json(publicCfg(await getCfg(req.tenantPrisma!)));
});

const cfgSchema = z.object({
  enabled: z.boolean().optional(),
  host: z.string().trim().min(3).max(100).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  email: z.string().trim().email().max(120).optional(),
  password: z.string().trim().min(4).max(200).optional(),
  folder: z.string().trim().max(60).optional(),
  autoCreate: z.boolean().optional()
}).strict();

mailRouter.put('/config', async (req, res) => {
  const body = cfgSchema.parse(req.body);
  const existing = await getCfg(req.tenantPrisma!);
  const data: Record<string, unknown> = {};
  if (body.enabled !== undefined) data.enabled = body.enabled;
  // Normaliza host/puerto IMAP: corrige el típico smtp.gmail.com:587 → imap.gmail.com:993.
  if (body.host !== undefined || body.port !== undefined) {
    const norm = normalizeImap(
      body.host ?? existing?.host,
      body.port ?? existing?.port,
      body.email ?? existing?.email ?? undefined
    );
    data.host = norm.host;
    data.port = norm.port;
  }
  if (body.email !== undefined) data.email = body.email;
  if (body.folder !== undefined) data.folder = body.folder;
  if (body.autoCreate !== undefined) data.autoCreate = body.autoCreate;
  // Gmail muestra la contraseña de aplicación con espacios (atmx uvcu botx kmjv);
  // son 16 caracteres sin espacios. Los quitamos para que no falle el login.
  if (body.password) {
    const appPass = body.password.replace(/\s+/g, '');
    data.passwordEnc = encryptString(appPass);
  }

  const cfg = await req.tenantPrisma!.mailConfig.upsert({
    where: { id: 1 },
    create: { id: 1, userId: req.tenantUserId!, ...data },
    update: data
  });
  void auditFromReq(req, 'UPDATE', 'mail', 1, 'Lector de correo actualizado');
  res.json(publicCfg(cfg));
});

// Prueba la conexión IMAP con las credenciales guardadas.
mailRouter.post('/test', async (req, res) => {
  const cfg = await getCfg(req.tenantPrisma!);
  if (!cfg?.email || !cfg?.passwordEnc) {
    return res.status(400).json({ message: 'Configura primero el correo y la contraseña de aplicación.' });
  }
  let password: string;
  try { password = decryptString(cfg.passwordEnc); }
  catch { return res.status(500).json({ message: 'No se pudo leer la contraseña guardada.' }); }

  const norm = normalizeImap(cfg.host, cfg.port, cfg.email);
  const r = await testConnection({ host: norm.host, port: norm.port, email: cfg.email, password, folder: cfg.folder });
  if (!r.ok) return res.status(400).json({ message: r.error });
  res.json(r);
});

// Historial de comprobantes (bandeja + lo ya registrado), lo más reciente primero.
mailRouter.get('/receipts', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  const rows = await req.tenantPrisma!.mailReceipt.findMany({
    where: { userId: req.tenantUserId! },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, subject: true, fromAddr: true, vendor: true, amount: true, docDate: true,
      kind: true, status: true, movementId: true, receivedAt: true, createdAt: true, raw: true
    }
  });
  const out = rows.map((r: any) => {
    const raw = (r.raw && typeof r.raw === 'object') ? r.raw as any : {};
    const ex = raw.ex || {};
    const draft = raw.draft || {};
    return {
      id: r.id, subject: r.subject, from: r.fromAddr, vendor: r.vendor,
      amount: r.amount != null ? Number(r.amount) : null,
      docDate: r.docDate, kind: r.kind, status: r.status, movementId: r.movementId,
      receivedAt: r.receivedAt, createdAt: r.createdAt,
      reason: raw.reason || null,
      resolved: !!raw.resolved,
      // Detalle de lo interpretado (para "Ver detalle" y pre-llenar el selector).
      detail: {
        medio: ex.medio || null, ultimos4: ex.ultimos4 || null, banco: ex.banco || null,
        categoria: ex.categoria || null, tipo: ex.tipo || null,
        paymentMethod: draft.paymentMethod || null, accountId: draft.accountId ?? null,
        cardId: draft.cardId ?? null, categoryId: draft.categoryId ?? null
      }
    };
  });
  res.json(out);
});

// Opciones para el selector manual de la bandeja (cuentas, tarjetas de crédito, categorías).
mailRouter.get('/options', async (req, res) => {
  const userId = req.tenantUserId!;
  const [accounts, cards, categories] = await Promise.all([
    req.tenantPrisma!.account.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true }, orderBy: { name: 'asc' } }),
    req.tenantPrisma!.card.findMany({ where: { userId, isActive: true, type: 'CREDIT' }, select: { id: true, name: true, bankName: true, last4: true }, orderBy: { name: 'asc' } }),
    req.tenantPrisma!.category.findMany({ where: { userId }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  ]);
  res.json({ accounts, creditCards: cards, categories });
});

// Dispara una revisión del buzón AHORA (manual). Devuelve el resumen.
mailRouter.post('/check', async (req, res) => {
  const cfg = await getCfg(req.tenantPrisma!);
  if (!cfg?.enabled) return res.status(400).json({ message: 'Activa la lectura automática y guarda antes de revisar.' });
  if (!cfg?.email || !cfg?.passwordEnc) return res.status(400).json({ message: 'Configura el correo y la contraseña de aplicación.' });
  const r = await ingestTenantMail(req.tenantPrisma!);
  if (r.error) return res.status(400).json({ message: r.error });
  res.json(r);
});

// Aprueba un comprobante PENDIENTE → crea el movimiento, opcionalmente con el
// instrumento (tarjeta/cuenta) y categoría elegidos por el usuario en la bandeja.
const approveSchema = z.object({
  accountId: z.coerce.number().int().positive().optional().nullable(),
  cardId: z.coerce.number().int().positive().optional().nullable(),
  categoryId: z.coerce.number().int().positive().optional().nullable(),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'DEPOSIT', 'DEBIT_CARD', 'CREDIT_CARD', 'WALLET', 'OTHER']).optional()
}).strict();

mailRouter.post('/receipts/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const body = approveSchema.parse(req.body || {});
  const rec = await req.tenantPrisma!.mailReceipt.findFirst({ where: { id, userId: req.tenantUserId! } });
  if (!rec) return res.status(404).json({ message: 'Comprobante no encontrado.' });
  if (rec.movementId) return res.status(409).json({ message: 'Este comprobante ya fue registrado.' });
  const draft = (rec.raw && typeof rec.raw === 'object' ? { ...(rec.raw as any).draft } : null);
  if (!draft) return res.status(400).json({ message: 'No hay datos suficientes para registrar este comprobante.' });

  // El usuario puede corregir el instrumento antes de registrar (dato correcto).
  if (body.cardId) { draft.cardId = body.cardId; draft.accountId = null; draft.paymentMethod = 'CREDIT_CARD'; }
  else if (body.accountId) { draft.accountId = body.accountId; draft.cardId = null; draft.paymentMethod = body.paymentMethod || 'DEBIT_CARD'; }
  else if (body.paymentMethod) { draft.paymentMethod = body.paymentMethod; if (body.paymentMethod === 'CASH') { draft.accountId = null; draft.cardId = null; } }
  if (body.categoryId !== undefined) draft.categoryId = body.categoryId;

  // Si el usuario eligió cuenta/tarjeta, fija también el banco de la columna.
  try {
    if (draft.cardId) { const c = await req.tenantPrisma!.card.findUnique({ where: { id: draft.cardId }, select: { bankId: true } }); if (c?.bankId) draft.fromBankId = c.bankId; }
    else if (draft.accountId) { const a = await req.tenantPrisma!.account.findUnique({ where: { id: draft.accountId }, select: { bankId: true } }); if (a?.bankId) { if (draft.type === 'INCOME') draft.toBankId = a.bankId; else draft.fromBankId = a.bankId; } }
  } catch { /* banco es opcional */ }

  try {
    const mv = await createMovement(req.tenantPrisma!, req.tenantUserId!, draft);
    const ex = (rec.raw && typeof rec.raw === 'object') ? (rec.raw as any).ex : null;
    await attachComprobanteImage(req.tenantPrisma!, req.tenantUserId!, mv.id, ex, draft);
    await req.tenantPrisma!.mailReceipt.update({ where: { id }, data: { status: 'APPROVED', movementId: mv.id } });
    void auditFromReq(req, 'CREATE', 'movement', mv.id, 'Movimiento creado desde comprobante de correo');
    res.json({ ok: true, movementId: mv.id });
  } catch (e: any) {
    res.status(400).json({ message: e?.message || 'No se pudo registrar el movimiento.' });
  }
});

// Descarta un comprobante de la bandeja.
mailRouter.post('/receipts/:id/discard', async (req, res) => {
  const id = Number(req.params.id);
  const rec = await req.tenantPrisma!.mailReceipt.findFirst({ where: { id, userId: req.tenantUserId! } });
  if (!rec) return res.status(404).json({ message: 'Comprobante no encontrado.' });
  await req.tenantPrisma!.mailReceipt.update({ where: { id }, data: { status: 'DISCARDED' } });
  res.json({ ok: true });
});
