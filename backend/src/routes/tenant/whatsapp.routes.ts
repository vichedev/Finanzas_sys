import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';
import { getStatus, connect, disconnect } from '../../whatsapp/gateway';

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
    userId: cfg?.userId ?? null,
    hasAiKey: !!ai?.apiKeyEnc       // sin clave de IA el bot no puede transcribir
  };
}

whatsappRouter.get('/status', async (req, res) => {
  res.json(await buildStatus(req.tenantPrisma!));
});

// Activar/desactivar los avisos proactivos de gasto.
const cfgSchema = z.object({ coachEnabled: z.boolean() }).strict();
whatsappRouter.put('/config', async (req, res) => {
  const { coachEnabled } = cfgSchema.parse(req.body ?? {});
  await req.tenantPrisma!.whatsappConfig.upsert({
    where: { id: 1 },
    create: { id: 1, enabled: false, userId: req.tenantUserId!, coachEnabled },
    update: { coachEnabled }
  });
  res.json(await buildStatus(req.tenantPrisma!));
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
