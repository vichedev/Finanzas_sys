import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { encryptString, decryptString } from '../../lib/tenantCrypto';
import { testConnection, normalizeImap } from '../../lib/mailReader';
import { ingestTenantMail } from '../../lib/mailIngest';
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
  const out = rows.map((r: any) => ({
    id: r.id, subject: r.subject, from: r.fromAddr, vendor: r.vendor,
    amount: r.amount != null ? Number(r.amount) : null,
    docDate: r.docDate, kind: r.kind, status: r.status, movementId: r.movementId,
    receivedAt: r.receivedAt, createdAt: r.createdAt,
    reason: (r.raw && typeof r.raw === 'object' ? (r.raw as any).reason : null) || null
  }));
  res.json(out);
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

// Aprueba un comprobante PENDIENTE → crea el movimiento desde lo interpretado.
mailRouter.post('/receipts/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const rec = await req.tenantPrisma!.mailReceipt.findFirst({ where: { id, userId: req.tenantUserId! } });
  if (!rec) return res.status(404).json({ message: 'Comprobante no encontrado.' });
  if (rec.movementId) return res.status(409).json({ message: 'Este comprobante ya fue registrado.' });
  const draft = (rec.raw && typeof rec.raw === 'object' ? (rec.raw as any).draft : null);
  if (!draft) return res.status(400).json({ message: 'No hay datos suficientes para registrar este comprobante.' });
  try {
    const mv = await createMovement(req.tenantPrisma!, req.tenantUserId!, draft);
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
