import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';
import { getStatus, connect, disconnect, setAllowedNumbers } from '../../whatsapp/gateway';

/** Normaliza una lista de números a solo dígitos (>= 8), sin duplicados. */
function normalizeNumbers(list: unknown): string[] {
  const arr = Array.isArray(list) ? list : String(list ?? '').split(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const d = String(raw ?? '').replace(/\D/g, '');
    if (d.length >= 8 && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

// Rutas para la pantalla de Ajustes → Asistente WhatsApp.
// El socket de Baileys es único en el proceso; estos endpoints lo pilotan y
// guardan el estado configurable en WhatsappConfig (singleton del tenant).
export const whatsappRouter = Router();
whatsappRouter.use(requireAuth, (req, res, next) =>
  requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next)
);

async function buildStatus(prisma: any) {
  const cfg = await prisma.whatsappConfig.findUnique({ where: { id: 1 } });
  const ai = await prisma.aiConfig.findUnique({ where: { id: 1 } });
  const s = getStatus();
  return {
    state: s.state,                 // idle | connecting | qr | connected | logged_out
    qr: s.qr,                       // data URL del QR (solo cuando state='qr')
    linkedNumber: cfg?.linkedNumber ?? s.linkedNumber ?? null,
    enabled: cfg?.enabled ?? false,
    coachEnabled: cfg?.coachEnabled ?? true,  // avisos proactivos de gasto
    allowedNumbers: normalizeNumbers(cfg?.allowedNumbers), // números autorizados a escribir al bot
    allowSelfChat: cfg?.allowSelfChat ?? true,             // atender también la "nota para mí"
    userId: cfg?.userId ?? null,
    hasAiKey: !!(ai?.apiKeyEnc || ai?.transcribeApiKeyEnc) // sin clave de IA/Groq el bot no puede transcribir
  };
}

whatsappRouter.get('/status', async (req, res) => {
  res.json(await buildStatus(req.tenantPrisma!));
});

// Avisos proactivos + lista blanca de números autorizados + self-chat.
const cfgSchema = z.object({
  coachEnabled: z.boolean().optional(),
  allowedNumbers: z.array(z.string().trim().max(20)).max(20).optional(),
  allowSelfChat: z.boolean().optional()
}).strict();
whatsappRouter.put('/config', async (req, res) => {
  const body = cfgSchema.parse(req.body ?? {});
  const data: Record<string, unknown> = {};
  if (body.coachEnabled !== undefined) data.coachEnabled = body.coachEnabled;
  if (body.allowSelfChat !== undefined) data.allowSelfChat = body.allowSelfChat;
  if (body.allowedNumbers !== undefined) data.allowedNumbers = normalizeNumbers(body.allowedNumbers).join(',');

  await req.tenantPrisma!.whatsappConfig.upsert({
    where: { id: 1 },
    create: { id: 1, enabled: false, userId: req.tenantUserId!, ...data },
    update: data
  });
  // Aplica la lista blanca al socket en vivo (sin reconectar).
  const status = await buildStatus(req.tenantPrisma!);
  setAllowedNumbers(status.allowedNumbers, status.allowSelfChat);
  res.json(status);
});

// Vincular / activar: guarda a qué usuario se imputan los movimientos, marca
// enabled y arranca el socket (mostrará el QR la primera vez).
whatsappRouter.post('/connect', async (req, res) => {
  const userId = req.tenantUserId!;
  await req.tenantPrisma!.whatsappConfig.upsert({
    where: { id: 1 },
    create: { id: 1, enabled: true, userId },
    update: { enabled: true, userId }
  });
  await connect(req.tenantId!, userId);
  void auditFromReq(req, 'UPDATE', 'whatsapp', 1, 'Bot de WhatsApp vinculado/activado');
  res.json(await buildStatus(req.tenantPrisma!));
});

// Desvincular / pausar. logout=true además borra la sesión (re-escaneo de QR).
const disconnectSchema = z.object({ logout: z.boolean().optional() }).strict();
whatsappRouter.post('/disconnect', async (req, res) => {
  const { logout } = disconnectSchema.parse(req.body ?? {});
  await req.tenantPrisma!.whatsappConfig.upsert({
    where: { id: 1 },
    create: { id: 1, enabled: false, userId: req.tenantUserId! },
    update: { enabled: false, ...(logout ? { linkedNumber: null } : {}) }
  });
  await disconnect(!!logout);
  void auditFromReq(req, 'UPDATE', 'whatsapp', 1, logout ? 'Bot de WhatsApp desvinculado' : 'Bot de WhatsApp pausado');
  res.json(await buildStatus(req.tenantPrisma!));
});
