import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { globalPrisma } from '../../lib/globalPrisma';
import { signToken, verifyToken, type PendingPayload, type SuperAdminPayload, type TenantUserPayload } from '../../lib/jwt';
import { requireAuth } from '../../middleware/auth';
import { logSuperAccess } from '../../lib/auditLog';
import { logger } from '../../lib/logger';

export const globalAuthRouter = Router();

const GENERIC_AUTH_ERROR = 'Credenciales inválidas';
const DUMMY_HASH = bcrypt.hashSync('this-is-a-dummy-password-for-timing-protection', 12);
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(1).max(200)
});

const selectSchema = z.object({
  // 'super' para entrar como super admin; tenantId para entrar a una empresa
  choice: z.union([
    z.literal('super'),
    z.string().min(1).max(100)
  ])
});

// ------------------------- POST /login -------------------------
globalAuthRouter.post('/login', async (req, res) => {
  const body = loginSchema.parse(req.body);
  const email = body.email.toLowerCase().trim();
  const now = new Date();

  // Buscar ambos en paralelo
  const [sa, memberships] = await Promise.all([
    globalPrisma.superAdmin.findUnique({ where: { email } }),
    globalPrisma.tenantMembership.findMany({
      where: { email },
      include: { tenant: { select: { id: true, slug: true, legalName: true, status: true, logoUrl: true } } }
    })
  ]);

  if (!sa && memberships.length === 0) {
    // Email no existe — timing-safe
    await bcrypt.compare(body.password, DUMMY_HASH);
    return res.status(401).json({ message: GENERIC_AUTH_ERROR });
  }

  // ---- Validar password contra SuperAdmin (si existe y no está bloqueado) ----
  let saOk = false;
  if (sa) {
    if (sa.lockedUntil && sa.lockedUntil > now) {
      // Bloqueado — caemos al tenant flow si hay memberships, sino 401
    } else {
      saOk = await bcrypt.compare(body.password, sa.passwordHash);
    }
  }

  // ---- Validar password contra membership(s) ----
  let matchedMembership: typeof memberships[number] | null = null;
  for (const m of memberships) {
    if (m.lockedUntil && m.lockedUntil > now) continue;
    if (await bcrypt.compare(body.password, m.passwordHash)) {
      matchedMembership = m;
      break;
    }
  }

  // ---- Si ningún match → contar fallos y 401 ----
  if (!saOk && !matchedMembership) {
    // Subir contador en SA si existe
    if (sa) {
      const next = sa.failedAttempts + 1;
      const data = next >= MAX_FAILED
        ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
        : { failedAttempts: next };
      await globalPrisma.superAdmin.update({ where: { id: sa.id }, data }).catch(() => {});
      logSuperAccess(sa.id, null, 'SUPER_ADMIN_LOGIN_FAILED', req).catch((e) => logger.error({ err: e }, 'audit failed'));
    }
    // Subir contador en cada membership no bloqueado
    await Promise.all(memberships.map((m) => {
      if (m.lockedUntil && m.lockedUntil > now) return Promise.resolve();
      const next = m.failedAttempts + 1;
      const data = next >= MAX_FAILED
        ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
        : { failedAttempts: next };
      return globalPrisma.tenantMembership.update({ where: { id: m.id }, data }).catch(() => {});
    }));
    return res.status(401).json({ message: GENERIC_AUTH_ERROR });
  }

  // ---- Memberships utilizables (activos en tenants ACTIVOS) ----
  const usableTenants = memberships.filter((m) => m.isActive && m.tenant.status === 'ACTIVE');

  // ---- Reset contadores donde matchó password ----
  if (sa && saOk) {
    if (sa.failedAttempts !== 0 || sa.lockedUntil !== null) {
      await globalPrisma.superAdmin.update({ where: { id: sa.id }, data: { failedAttempts: 0, lockedUntil: null } });
    }
  }
  if (matchedMembership) {
    if (matchedMembership.failedAttempts !== 0 || matchedMembership.lockedUntil !== null) {
      await globalPrisma.tenantMembership.update({
        where: { id: matchedMembership.id },
        data: { failedAttempts: 0, lockedUntil: null }
      });
    }
  }

  // SuperAdmin inactivo: tratamos como si no existiera
  const saUsable = sa && saOk && sa.isActive;

  // ---- Decidir flujo ----

  // CASO A: solo super (sin tenants)
  if (saUsable && usableTenants.length === 0) {
    await globalPrisma.superAdmin.update({ where: { id: sa!.id }, data: { lastLoginAt: now } });
    const payload: SuperAdminPayload = {
      kind: 'super', id: sa!.id, email: sa!.email, role: sa!.role, tokenVersion: sa!.tokenVersion
    };
    logSuperAccess(sa!.id, null, 'SUPER_ADMIN_LOGIN', req).catch((e) => logger.error({ err: e }, 'audit failed'));
    return res.json({
      token: signToken(payload),
      user: { kind: 'super', id: sa!.id, email: sa!.email, name: sa!.name, role: sa!.role }
    });
  }

  // CASO B: solo tenant(s) — sin super
  if (!saUsable) {
    if (usableTenants.length === 0) {
      return res.status(401).json({ message: GENERIC_AUTH_ERROR });
    }
    if (usableTenants.length === 1) {
      const only = usableTenants[0];
      await globalPrisma.tenantMembership.update({ where: { id: only.id }, data: { lastLoginAt: now } });
      const payload: TenantUserPayload = {
        kind: 'tenant', id: only.id, email: only.email, tenantId: only.tenantId,
        role: only.role, tokenVersion: only.tokenVersion
      };
      return res.json({
        token: signToken(payload),
        user: {
          kind: 'tenant', id: only.id, email: only.email, name: only.name, role: only.role,
          tenant: { id: only.tenant.id, slug: only.tenant.slug, name: only.tenant.legalName, logoUrl: only.tenant.logoUrl }
        }
      });
    }
    // N tenants → pending sin super
    const payload: PendingPayload = {
      kind: 'pending',
      email,
      tenants: usableTenants.map((m) => ({ id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.legalName }))
    };
    return res.json({
      pending: true,
      token: signToken(payload),
      tenants: payload.tenants
    });
  }

  // CASO C: super + tenant(s) → pending CON super y tenants
  const payload: PendingPayload = {
    kind: 'pending',
    email,
    superAdminId: sa!.id,
    tenants: usableTenants.map((m) => ({ id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.legalName }))
  };
  return res.json({
    pending: true,
    token: signToken(payload),
    superAvailable: true,
    tenants: payload.tenants
  });
});

// ------------------------- POST /select-tenant -------------------------
// Acepta { choice: 'super' } o { choice: '<tenantId>' }
globalAuthRouter.post('/select-tenant', async (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ message: 'No autorizado' });

  let pending: PendingPayload;
  try {
    pending = verifyToken<PendingPayload>(header.slice(7));
  } catch {
    return res.status(401).json({ message: 'Token inválido' });
  }
  if (pending.kind !== 'pending') {
    return res.status(400).json({ message: 'Token no es de selección' });
  }

  // Soportar también el body legacy { tenantId }
  const choiceRaw = (req.body?.choice ?? req.body?.tenantId) as unknown;
  const parsed = selectSchema.safeParse({ choice: choiceRaw });
  if (!parsed.success) return res.status(400).json({ message: 'Selección inválida' });
  const { choice } = parsed.data;

  // Caso: elige super
  if (choice === 'super') {
    if (!pending.superAdminId) return res.status(403).json({ message: 'Opción super-admin no disponible' });
    const sa = await globalPrisma.superAdmin.findUnique({ where: { id: pending.superAdminId } });
    if (!sa || !sa.isActive) return res.status(403).json({ message: 'Super admin no disponible' });
    await globalPrisma.superAdmin.update({ where: { id: sa.id }, data: { lastLoginAt: new Date() } });
    const payload: SuperAdminPayload = {
      kind: 'super', id: sa.id, email: sa.email, role: sa.role, tokenVersion: sa.tokenVersion
    };
    logSuperAccess(sa.id, null, 'SUPER_ADMIN_LOGIN', req).catch((e) => logger.error({ err: e }, 'audit failed'));
    return res.json({
      token: signToken(payload),
      user: { kind: 'super', id: sa.id, email: sa.email, name: sa.name, role: sa.role }
    });
  }

  // Caso: elige un tenant
  const inList = pending.tenants.find((t) => t.id === choice);
  if (!inList) return res.status(403).json({ message: 'Tenant no permitido' });

  const m = await globalPrisma.tenantMembership.findUnique({
    where: { email_tenantId: { email: pending.email, tenantId: choice } },
    include: { tenant: { select: { id: true, slug: true, legalName: true, status: true, logoUrl: true } } }
  });
  if (!m || !m.isActive || m.tenant.status !== 'ACTIVE') {
    return res.status(403).json({ message: 'Tenant no disponible' });
  }

  await globalPrisma.tenantMembership.update({ where: { id: m.id }, data: { lastLoginAt: new Date() } });

  const payload: TenantUserPayload = {
    kind: 'tenant', id: m.id, email: m.email, tenantId: m.tenantId, role: m.role, tokenVersion: m.tokenVersion
  };
  return res.json({
    token: signToken(payload),
    user: {
      kind: 'tenant', id: m.id, email: m.email, name: m.name, role: m.role,
      tenant: { id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.legalName, logoUrl: m.tenant.logoUrl }
    }
  });
});

// ------------------------- GET /me -------------------------
globalAuthRouter.get('/me', requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.kind === 'super') {
    const sa = await globalPrisma.superAdmin.findUnique({
      where: { id: auth.id },
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true, lastLoginAt: true }
    });
    if (!sa) return res.status(404).json({ message: 'No encontrado' });
    return res.json({ kind: 'super', ...sa });
  }
  if (auth.kind === 'tenant') {
    const m = await globalPrisma.tenantMembership.findUnique({
      where: { id: auth.id },
      include: { tenant: { select: { id: true, slug: true, legalName: true, status: true, logoUrl: true } } }
    });
    if (!m) return res.status(404).json({ message: 'No encontrado' });
    return res.json({
      kind: 'tenant',
      id: m.id,
      email: m.email,
      name: m.name,
      role: m.role,
      isActive: m.isActive,
      permissions: m.permissions,
      tenant: {
        id: m.tenant.id,
        slug: m.tenant.slug,
        name: m.tenant.legalName,
        status: m.tenant.status,
        logoUrl: m.tenant.logoUrl
      }
    });
  }
  return res.status(400).json({ message: 'Token inválido' });
});

// ------------------------- POST /logout -------------------------
globalAuthRouter.post('/logout', requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.kind === 'super') {
    await globalPrisma.superAdmin.update({
      where: { id: auth.id },
      data: { tokenVersion: { increment: 1 } }
    });
  } else if (auth.kind === 'tenant') {
    await globalPrisma.tenantMembership.update({
      where: { id: auth.id },
      data: { tokenVersion: { increment: 1 } }
    });
  }
  return res.json({ ok: true });
});
