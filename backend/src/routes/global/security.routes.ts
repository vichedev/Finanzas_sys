import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { globalPrisma } from '../../lib/globalPrisma';
import { requireAuth } from '../../middleware/auth';
import { blockIp, lockAccount, MANUAL_BLOCK_MINUTES, normalizeIp, recordLoginEvent, unblockIp, type LoginEventType } from '../../lib/loginSecurity';

// =====================================================================
// Eventos y bloqueos del login (Configuración → Seguridad).
//   - SuperAdmin: ve todos los eventos y bloqueos; bloquea y desbloquea cuentas e IP.
//   - Admin de empresa: solo eventos y cuentas de su empresa; no gestiona IP.
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

  // Estado actual de lo que aparece en la página, para ofrecer la acción correcta en cada fila.
  const now = new Date();
  const emails = [...new Set(events.flatMap((e) => (e.email ? [e.email] : [])))];
  const ips = [...new Set(events.flatMap((e) => (e.ip ? [e.ip] : [])))];
  const [members, supers, ipBlocks] = await Promise.all([
    globalPrisma.tenantMembership.findMany({
      where: { email: { in: emails }, ...(tenantId ? { tenantId } : {}) },
      select: { email: true, lockedUntil: true }
    }),
    tenantId ? [] : globalPrisma.superAdmin.findMany({ where: { email: { in: emails } }, select: { email: true, lockedUntil: true } }),
    tenantId ? [] : globalPrisma.ipBlock.findMany({ where: { ip: { in: ips }, blockedUntil: { gt: now } }, select: { ip: true } })
  ]);
  const locked = new Map<string, boolean>();
  for (const a of [...members, ...supers]) {
    locked.set(a.email, (locked.get(a.email) ?? false) || (!!a.lockedUntil && a.lockedUntil > now));
  }
  const blockedIps = new Set(ipBlocks.map((b) => b.ip));

  return res.json({
    total,
    currentIp: normalizeIp(req.ip),
    events: events.map(({ tenantIds: _tenantIds, ...event }) => ({
      ...event,
      account: event.email && locked.has(event.email)
        ? { locked: locked.get(event.email)!, self: event.email === req.auth!.email }
        : null,
      ipBlocked: !!event.ip && blockedIps.has(event.ip)
    }))
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

const minutesSchema = z.number().int().refine((m) => MANUAL_BLOCK_MINUTES.includes(m), 'Duración no permitida');
const lockSchema = z.object({ email: z.string().trim().toLowerCase().min(3).max(120), minutes: minutesSchema });

// ------------------------- POST /accounts/lock -------------------------
// Un correo puede tener una cuenta por empresa: el admin de empresa solo alcanza la suya.
securityRouter.post('/accounts/lock', async (req, res) => {
  const { email, minutes } = lockSchema.parse(req.body);
  if (email === req.auth!.email) return res.status(400).json({ message: 'No puedes bloquear tu propia cuenta' });
  const tenantId = tenantScope(req);
  const [members, sa] = await Promise.all([
    globalPrisma.tenantMembership.findMany({ where: { email, ...(tenantId ? { tenantId } : {}) }, select: { id: true, tenantId: true } }),
    tenantId ? null : globalPrisma.superAdmin.findUnique({ where: { email }, select: { id: true } })
  ]);
  if (!members.length && !sa) return res.status(404).json({ message: 'Cuenta no encontrada' });

  const untils = await Promise.all([
    ...members.map((m) => lockAccount('TenantMembership', m.id, minutes)),
    ...(sa ? [lockAccount('SuperAdmin', sa.id, minutes)] : [])
  ]);
  await recordLoginEvent({
    type: 'ACCOUNT_LOCKED', email, ip: normalizeIp(req.ip), tenantIds: members.map((m) => m.tenantId), req,
    metadata: { by: req.auth!.email, until: untils[0], manual: true }
  });
  return res.json({ ok: true, until: untils[0] });
});

// ------------------------- POST /accounts/unlock-email -------------------------
securityRouter.post('/accounts/unlock-email', async (req, res) => {
  const { email } = lockSchema.pick({ email: true }).parse(req.body);
  const tenantId = tenantScope(req);
  const now = new Date();
  const lockedNow = { email, lockedUntil: { gt: now } };
  const clear = { failedAttempts: 0, lockedUntil: null, lastFailedAt: null };
  const members = await globalPrisma.tenantMembership.findMany({
    where: { ...lockedNow, ...(tenantId ? { tenantId } : {}) },
    select: { id: true, tenantId: true }
  });
  const sa = tenantId ? null : await globalPrisma.superAdmin.findFirst({ where: lockedNow, select: { id: true } });
  if (!members.length && !sa) return res.status(404).json({ message: 'La cuenta no está bloqueada' });

  await Promise.all([
    globalPrisma.tenantMembership.updateMany({ where: { id: { in: members.map((m) => m.id) } }, data: clear }),
    ...(sa ? [globalPrisma.superAdmin.update({ where: { id: sa.id }, data: clear })] : [])
  ]);
  await recordLoginEvent({
    type: 'ACCOUNT_UNLOCKED', email, ip: normalizeIp(req.ip), tenantIds: members.map((m) => m.tenantId), req,
    metadata: { by: req.auth!.email }
  });
  return res.json({ ok: true });
});

// ------------------------- POST /ips/block (solo plataforma) -------------------------
securityRouter.post('/ips/block', async (req, res) => {
  if (req.auth?.kind !== 'super') return res.status(403).json({ message: 'Solo administradores de plataforma' });
  const body = z.object({ ip: z.string().trim().min(1).max(64), minutes: minutesSchema }).parse(req.body);
  // El panel envía la IP tal como se guardó; una IPv6 ya viene como /64.
  const ip = normalizeIp(body.ip.replace(/\/64$/, ''));
  if (!ip) return res.status(400).json({ message: 'IP no válida' });
  if (ip === normalizeIp(req.ip)) return res.status(400).json({ message: 'No puedes bloquear la IP desde la que trabajas' });

  const until = await blockIp(ip, body.minutes);
  await recordLoginEvent({ type: 'IP_BLOCKED', ip, req, metadata: { by: req.auth.email, until, manual: true } });
  return res.json({ ok: true, until });
});

// ------------------------- POST /ips/unblock (solo plataforma) -------------------------
securityRouter.post('/ips/unblock', async (req, res) => {
  if (req.auth?.kind !== 'super') return res.status(403).json({ message: 'Solo administradores de plataforma' });
  const { ip } = z.object({ ip: z.string().min(1).max(64) }).parse(req.body);
  if (!(await unblockIp(ip))) return res.status(404).json({ message: 'La IP no está bloqueada' });
  await recordLoginEvent({ type: 'IP_UNBLOCKED', ip, req, metadata: { by: req.auth.email } });
  return res.json({ ok: true });
});
