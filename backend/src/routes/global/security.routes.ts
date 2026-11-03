import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { globalPrisma } from '../../lib/globalPrisma';
import { requireAuth } from '../../middleware/auth';
import { normalizeIp, recordLoginEvent, unblockIp, type LoginEventType } from '../../lib/loginSecurity';

// =====================================================================
// Eventos y bloqueos del login (Configuración → Seguridad).
//   - SuperAdmin: ve todos los eventos y bloqueos, y levanta bloqueos de IP.
//   - Admin de empresa: solo eventos y cuentas de su empresa.
// Vive en la BD global, por eso no pasa por el contexto de tenant.
// =====================================================================
export const securityRouter = Router();

function requireSecurityAccess(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.kind === 'super') return next();
  if (req.auth?.kind === 'tenant' && req.auth.role === 'ADMIN_EMPRESA') return next();
  return res.status(403).json({ message: 'Solo administradores' });
}

securityRouter.use(requireAuth, requireSecurityAccess);

const EVENT_TYPES = ['LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOCKED_ATTEMPT', 'ACCOUNT_LOCKED', 'ACCOUNT_UNLOCKED', 'IP_BLOCKED', 'IP_UNBLOCKED'] as const;

const eventsQuery = z.object({
  type: z.enum(EVENT_TYPES).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const tenantScope = (req: Request) => (req.auth?.kind === 'tenant' ? req.auth.tenantId : null);

// ------------------------- GET /events -------------------------
securityRouter.get('/events', async (req, res) => {
  const q = eventsQuery.parse(req.query);
  const tenantId = tenantScope(req);
  const where = {
    ...(tenantId ? { tenantIds: { has: tenantId } } : {}),
    ...(q.type ? { type: q.type as LoginEventType } : {}),
    ...(q.search ? { OR: [
      { email: { contains: q.search, mode: 'insensitive' as const } },
      { ip: { contains: q.search } }
    ] } : {})
  };
  const [events, total] = await Promise.all([
    globalPrisma.loginEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.limit, skip: q.offset }),
    globalPrisma.loginEvent.count({ where })
  ]);
  return res.json({
    total,
    events: events.map(({ tenantIds: _tenantIds, ...event }) => event)
  });
});

// ------------------------- GET /blocks -------------------------
securityRouter.get('/blocks', async (req, res) => {
  const now = new Date();
  const tenantId = tenantScope(req);
  const memberships = await globalPrisma.tenantMembership.findMany({
    where: { lockedUntil: { gt: now }, ...(tenantId ? { tenantId } : {}) },
    orderBy: { lockedUntil: 'desc' },
    select: { id: true, email: true, name: true, lockedUntil: true, tenant: { select: { legalName: true } } }
  });
  const accounts = memberships.map((m) => ({
    kind: 'membership' as const, id: m.id, email: m.email, name: m.name, lockedUntil: m.lockedUntil, company: m.tenant.legalName
  }));
  if (tenantId) return res.json({ accounts, ips: [] });

  const [superAdmins, ips] = await Promise.all([
    globalPrisma.superAdmin.findMany({
      where: { lockedUntil: { gt: now } },
      select: { id: true, email: true, name: true, lockedUntil: true }
    }),
    globalPrisma.ipBlock.findMany({ where: { blockedUntil: { gt: now } }, orderBy: { blockedUntil: 'desc' } })
  ]);
  return res.json({
    accounts: [...superAdmins.map((s) => ({ kind: 'super' as const, ...s, company: null })), ...accounts],
    ips
  });
});

const unlockSchema = z.object({ kind: z.enum(['membership', 'super']), id: z.string().min(1).max(100) });

// ------------------------- POST /accounts/unlock -------------------------
securityRouter.post('/accounts/unlock', async (req, res) => {
  const body = unlockSchema.parse(req.body);
  const tenantId = tenantScope(req);
  const clear = { failedAttempts: 0, lockedUntil: null, lastFailedAt: null };

  if (body.kind === 'super') {
    if (tenantId) return res.status(403).json({ message: 'Solo administradores de plataforma' });
    const target = await globalPrisma.superAdmin.findUnique({ where: { id: body.id } });
    if (!target) return res.status(404).json({ message: 'Cuenta no encontrada' });
    await globalPrisma.superAdmin.update({ where: { id: body.id }, data: clear });
    await recordLoginEvent({
      type: 'ACCOUNT_UNLOCKED', email: target.email, ip: normalizeIp(req.ip), req,
      metadata: { by: req.auth!.email }
    });
    return res.json({ ok: true });
  }

  const target = await globalPrisma.tenantMembership.findFirst({
    where: { id: body.id, ...(tenantId ? { tenantId } : {}) }
  });
  if (!target) return res.status(404).json({ message: 'Cuenta no encontrada' });
  await globalPrisma.tenantMembership.update({ where: { id: body.id }, data: clear });
  await recordLoginEvent({
    type: 'ACCOUNT_UNLOCKED', email: target.email, ip: normalizeIp(req.ip), tenantIds: [target.tenantId], req,
    metadata: { by: req.auth!.email }
  });
  return res.json({ ok: true });
});

// ------------------------- POST /ips/unblock (solo plataforma) -------------------------
securityRouter.post('/ips/unblock', async (req, res) => {
  if (req.auth?.kind !== 'super') return res.status(403).json({ message: 'Solo administradores de plataforma' });
  const { ip } = z.object({ ip: z.string().min(1).max(64) }).parse(req.body);
  if (!(await unblockIp(ip))) return res.status(404).json({ message: 'La IP no está bloqueada' });
  await recordLoginEvent({ type: 'IP_UNBLOCKED', ip, req, metadata: { by: req.auth.email } });
  return res.json({ ok: true });
});
