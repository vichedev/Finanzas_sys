import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { globalPrisma } from '../../lib/globalPrisma';
import { requireAuth } from '../../middleware/auth';
import { requireSuperAdmin } from '../../middleware/superAdmin';
import { provisionTenant, suspendTenant, reactivateTenant, deprovisionTenant } from '../../lib/tenantProvisioning';
import { logSuperAccess } from '../../lib/auditLog';
import { logger } from '../../lib/logger';

function generateStrongPassword(length = 16): string {
  // Alfabeto sin caracteres ambiguos (0/O, 1/l/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const superAdminRouter = Router();

superAdminRouter.use(requireAuth, requireSuperAdmin);

// Schemas (slug, plan y subdomain ya no se piden — el slug se genera del legalName)
const provisionSchema = z.object({
  legalName: z.string().min(2).max(200),
  ruc: z.string().min(3).max(20).optional().or(z.literal('').transform(() => undefined)),
  email: z.string().email().max(120),
  adminName: z.string().min(2).max(120),
  adminPassword: z.string().min(10).max(200),
  logoUrl: z.string().url().max(2000).optional().or(z.literal('').transform(() => undefined))
});

const editSchema = z.object({
  legalName: z.string().min(2).max(200).optional(),
  ruc: z.string().min(3).max(20).nullable().optional(),
  logoUrl: z.string().url().max(2000).nullable().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CANCELED']).optional()
});

const createSuperAdminSchema = z.object({
  email: z.string().email().max(120),
  name: z.string().min(2).max(120),
  password: z.string().min(10).max(200),
  role: z.enum(['SUPER_ADMIN', 'SUPPORT']).default('SUPPORT')
});

// ------------------------- GET /tenants -------------------------
superAdminRouter.get('/tenants', async (_req, res) => {
  const tenants = await globalPrisma.tenant.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { memberships: true } }
    }
  });
  return res.json({
    tenants: tenants.map((t) => ({
      id: t.id,
      legalName: t.legalName,
      ruc: t.ruc,
      email: t.email,
      status: t.status,
      logoUrl: t.logoUrl,
      memberCount: t._count.memberships,
      createdAt: t.createdAt,
      suspendedAt: t.suspendedAt
    }))
  });
});

// ------------------------- POST /tenants -------------------------
superAdminRouter.post('/tenants', async (req, res) => {
  const body = provisionSchema.parse(req.body);
  const actorId = req.auth!.kind === 'super' ? req.auth!.id : '';
  try {
    const tenant = await provisionTenant(body, actorId);
    return res.status(201).json({ tenant });
  } catch (e: any) {
    logger.error({ err: e }, 'provisionTenant failed');
    return res.status(400).json({ message: e.message || 'No se pudo provisionar el tenant' });
  }
});

// ------------------------- PATCH /tenants/:id -------------------------
superAdminRouter.patch('/tenants/:id', async (req, res) => {
  const body = editSchema.parse(req.body);
  const id = req.params.id;
  const existing = await globalPrisma.tenant.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: 'Tenant no encontrado' });

  const data: Record<string, unknown> = {};
  if (body.legalName !== undefined) data.legalName = body.legalName;
  if (body.ruc !== undefined) data.ruc = body.ruc;
  if (body.logoUrl !== undefined) data.logoUrl = body.logoUrl;
  if (body.status !== undefined) {
    data.status = body.status;
    if (body.status === 'SUSPENDED') data.suspendedAt = new Date();
    if (body.status === 'ACTIVE') data.suspendedAt = null;
  }
  const updated = await globalPrisma.tenant.update({ where: { id }, data });
  const actorId = req.auth!.kind === 'super' ? req.auth!.id : '';
  logSuperAccess(actorId, id, 'TENANT_EDIT', req, {
    changes: body
  }).catch((e) => logger.error({ err: e }, 'audit failed'));

  return res.json({ tenant: updated });
});

// ------------------------- POST /tenants/:id/suspend -------------------------
superAdminRouter.post('/tenants/:id/suspend', async (req, res) => {
  const actorId = req.auth!.kind === 'super' ? req.auth!.id : '';
  try {
    await suspendTenant(req.params.id, actorId);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
});

// ------------------------- POST /tenants/:id/reactivate -------------------------
superAdminRouter.post('/tenants/:id/reactivate', async (req, res) => {
  const actorId = req.auth!.kind === 'super' ? req.auth!.id : '';
  try {
    await reactivateTenant(req.params.id, actorId);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
});

// ------------------------- DELETE /tenants/:id -------------------------
// Elimina la empresa por completo (registro + base de datos). IRREVERSIBLE.
// Requiere confirmar enviando { confirm: "<razón social exacta>" }.
const deleteSchema = z.object({ confirm: z.string().min(1) });
superAdminRouter.delete('/tenants/:id', async (req, res) => {
  const actorId = req.auth!.kind === 'super' ? req.auth!.id : '';
  const tenant = await globalPrisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!tenant) return res.status(404).json({ message: 'Empresa no encontrada' });

  const parsed = deleteSchema.safeParse(req.body ?? {});
  if (!parsed.success || parsed.data.confirm.trim() !== tenant.legalName) {
    return res.status(400).json({ message: `Para eliminar, confirma escribiendo el nombre exacto: "${tenant.legalName}"` });
  }

  try {
    await deprovisionTenant(req.params.id, actorId);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(e.status || 400).json({ message: e.message || 'No se pudo eliminar la empresa' });
  }
});

// ------------------------- POST /tenants/:id/reset-admin-password -------------------------
// Body opcional: { password?: string }. Si no se envia, genera una aleatoria y la devuelve UNA sola vez.
const resetPasswordSchema = z.object({
  password: z.string().min(10).max(200).optional()
});

superAdminRouter.post('/tenants/:id/reset-admin-password', async (req, res) => {
  const body = resetPasswordSchema.parse(req.body ?? {});
  const tenantId = req.params.id;

  const tenant = await globalPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return res.status(404).json({ message: 'Tenant no encontrado' });

  // Buscamos el admin de la empresa por el email de contacto del tenant
  const admin = await globalPrisma.tenantMembership.findUnique({
    where: { email_tenantId: { email: tenant.email, tenantId } }
  });
  if (!admin) {
    return res.status(404).json({
      message: 'No se encontro un administrador asociado al email de la empresa.'
    });
  }

  const generated = !body.password;
  const password = body.password ?? generateStrongPassword(16);
  const passwordHash = await bcrypt.hash(password, 12);

  await globalPrisma.tenantMembership.update({
    where: { id: admin.id },
    data: {
      passwordHash,
      failedAttempts: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 }
    }
  });

  const actorId = req.auth!.kind === 'super' ? req.auth!.id : '';
  logSuperAccess(actorId, tenantId, 'TENANT_ADMIN_RESET_PASSWORD', req, {
    membershipId: admin.id,
    email: admin.email,
    generated
  }).catch((e) => logger.error({ err: e }, 'audit failed'));

  // Solo devolvemos la contrasenia si fue generada por el sistema (para mostrarla una sola vez)
  return res.json({
    ok: true,
    email: admin.email,
    password: generated ? password : undefined,
    generated
  });
});

// ------------------------- PATCH /tenants/:id/admin-email -------------------------
const changeEmailSchema = z.object({
  newEmail: z.string().email().max(120)
});

superAdminRouter.patch('/tenants/:id/admin-email', async (req, res) => {
  const { newEmail: rawEmail } = changeEmailSchema.parse(req.body);
  const newEmail = rawEmail.toLowerCase().trim();
  const tenantId = req.params.id;

  const tenant = await globalPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return res.status(404).json({ message: 'Tenant no encontrado' });

  const oldEmail = tenant.email;
  if (oldEmail === newEmail) {
    return res.status(400).json({ message: 'El nuevo email es igual al actual.' });
  }

  const admin = await globalPrisma.tenantMembership.findUnique({
    where: { email_tenantId: { email: oldEmail, tenantId } }
  });
  if (!admin) {
    return res.status(404).json({
      message: 'No se encontro un administrador asociado al email actual.'
    });
  }

  // Conflicto: ya existe otra membership con ese email dentro del tenant
  const conflict = await globalPrisma.tenantMembership.findUnique({
    where: { email_tenantId: { email: newEmail, tenantId } }
  });
  if (conflict) {
    return res.status(409).json({ message: 'Ya existe un usuario con ese email en esta empresa.' });
  }

  await globalPrisma.$transaction([
    globalPrisma.tenant.update({ where: { id: tenantId }, data: { email: newEmail } }),
    globalPrisma.tenantMembership.update({
      where: { id: admin.id },
      data: { email: newEmail, tokenVersion: { increment: 1 } }
    })
  ]);

  const actorId = req.auth!.kind === 'super' ? req.auth!.id : '';
  logSuperAccess(actorId, tenantId, 'TENANT_ADMIN_CHANGE_EMAIL', req, {
    membershipId: admin.id,
    oldEmail,
    newEmail
  }).catch((e) => logger.error({ err: e }, 'audit failed'));

  return res.json({ ok: true, email: newEmail });
});

// ------------------------- GET /plans -------------------------
superAdminRouter.get('/plans', async (_req, res) => {
  const plans = await globalPrisma.plan.findMany({
    orderBy: [{ isActive: 'desc' }, { monthlyPrice: 'asc' }]
  });
  return res.json({ plans });
});

// ------------------------- GET /audit-logs -------------------------
superAdminRouter.get('/audit-logs', async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId.length > 0
    ? req.query.tenantId
    : undefined;
  const logs = await globalPrisma.superAdminAuditLog.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      superAdmin: { select: { id: true, email: true, name: true } },
      tenant: { select: { id: true, slug: true, legalName: true } }
    }
  });
  return res.json({ logs });
});

// ------------------------- POST /super-admins (DESHABILITADO) -------------------------
// Por seguridad, no se permite crear super admins desde la API.
// Solo se puede insertar uno manualmente vía SQL en el bootstrap inicial.
superAdminRouter.post('/super-admins', (_req, res) => {
  return res.status(403).json({
    message: 'La creación de administradores globales está deshabilitada. Contacta al administrador del sistema.'
  });
});

// ------------------------- GET /tenants/:id/users -------------------------
superAdminRouter.get('/tenants/:id/users', async (req, res) => {
  const id = req.params.id;
  const tenant = await globalPrisma.tenant.findUnique({ where: { id } });
  if (!tenant) return res.status(404).json({ message: 'Tenant no encontrado' });
  const memberships = await globalPrisma.tenantMembership.findMany({
    where: { tenantId: id },
    orderBy: { invitedAt: 'desc' },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      invitedAt: true,
      activatedAt: true,
      lastLoginAt: true,
      lockedUntil: true
    }
  });
  return res.json({ memberships });
});
