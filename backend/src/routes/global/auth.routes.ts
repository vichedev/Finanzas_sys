import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { globalPrisma } from '../../lib/globalPrisma';
import { signToken, verifyToken, type PendingPayload, type SuperAdminPayload, type TenantUserPayload } from '../../lib/jwt';
import { requireAuth } from '../../middleware/auth';
import { logSuperAccess } from '../../lib/auditLog';
import { logger } from '../../lib/logger';
import { checkIpBlock, claimAttempt, evaluateIpBlock, normalizeIp, recordLoginEvent, releaseAttempt, type AttemptClaim } from '../../lib/loginSecurity';

export const globalAuthRouter = Router();

const GENERIC_AUTH_ERROR = 'Credenciales inválidas';
const DUMMY_HASH = bcrypt.hashSync('this-is-a-dummy-password-for-timing-protection', 12);

const loginSchema = z.object({
  // Identificador de acceso: aceptamos emails normales y también usuarios tipo
  // "admin@maat-finanzas" (sin TLD) usados por el admin sembrado. Solo se usa
  // como clave de búsqueda, así que no exigimos formato RFC de email.
  email: z.string().trim().min(3).max(120),
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
  const ip = normalizeIp(req.ip);
  const ipBlock = await checkIpBlock(ip);
  if (ipBlock) {
    res.setHeader('Retry-After', String(ipBlock.retryAfterSeconds));
    return res.status(429).json({ message: 'Demasiados intentos desde tu conexión. Intenta más tarde.' });
  }

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
  const allTenantIds = memberships.map((m) => m.tenantId);

  const rejectLogin = async (type: 'LOGIN_FAILED' | 'LOCKED_ATTEMPT', reason: string) => {
    await recordLoginEvent({ type, email, ip, reason, tenantIds: allTenantIds, req });
    await evaluateIpBlock(ip, req);
    return res.status(401).json({ message: GENERIC_AUTH_ERROR });
  };

  if (!sa && memberships.length === 0) {
    // Email no existe — timing-safe
    await bcrypt.compare(body.password, DUMMY_HASH);
    return rejectLogin('LOGIN_FAILED', 'UNKNOWN_ACCOUNT');
  }

  // ---- Reservar un intento en cada cuenta antes de comparar contraseñas ----
  const [saClaim, ...membershipClaims] = await Promise.all<AttemptClaim | null>([
    sa ? claimAttempt('SuperAdmin', sa.id) : Promise.resolve(null),
    ...memberships.map((m) => claimAttempt('TenantMembership', m.id))
  ]);

  if (!saClaim?.claimed && !membershipClaims.some((c) => c?.claimed)) {
    // Todas bloqueadas: se compara igual para que el tiempo de respuesta no lo delate.
    await bcrypt.compare(body.password, DUMMY_HASH);
    return rejectLogin('LOCKED_ATTEMPT', 'ACCOUNT_LOCKED');
  }

  // ---- Validar password contra SuperAdmin ----
  const saOk = sa && saClaim?.claimed ? await bcrypt.compare(body.password, sa.passwordHash) : false;

  // ---- Validar password contra membership(s) ----
  // Cada empresa tiene su propia credencial: como un admin de empresa puede crear
  // un usuario con cualquier correo, solo da acceso la empresa cuya contraseña coincide.
  const matchedMemberships: typeof memberships = [];
  for (const [i, m] of memberships.entries()) {
    if (!membershipClaims[i]?.claimed) continue;
    if (await bcrypt.compare(body.password, m.passwordHash)) matchedMemberships.push(m);
  }

  // ---- Si ningún match: el intento reservado queda contado ----
  if (!saOk && matchedMemberships.length === 0) {
    if (sa) {
      logSuperAccess(sa.id, null, 'SUPER_ADMIN_LOGIN_FAILED', req).catch((e) => logger.error({ err: e }, 'audit failed'));
    }
    if (saClaim?.lockedNow || membershipClaims.some((c) => c?.lockedNow)) {
      await recordLoginEvent({ type: 'ACCOUNT_LOCKED', email, ip, tenantIds: allTenantIds, req });
    }
    return rejectLogin('LOGIN_FAILED', 'BAD_CREDENTIALS');
  }

  // ---- Liquidar los intentos reservados ----
  // Solo se limpia la credencial que coincidió. En las demás únicamente se devuelve
  // este intento: conocer la contraseña de una empresa no debe borrar los fallos
  // acumulados en otra, o se podría atacar esa otra cuenta sin llegar al bloqueo.
  const matchedIds = new Set(matchedMemberships.map((m) => m.id));
  const clearAttempts = { failedAttempts: 0, lockedUntil: null, lastFailedAt: null };
  const settleSuperAdmin = () => {
    if (!sa || !saClaim?.claimed) return null;
    return saOk
      ? globalPrisma.superAdmin.update({ where: { id: sa.id }, data: clearAttempts })
      : releaseAttempt('SuperAdmin', sa.id, saClaim.lockedNow);
  };
  await Promise.all([
    settleSuperAdmin(),
    ...memberships.map((m, i) => {
      const claim = membershipClaims[i];
      if (!claim?.claimed) return null;
      return matchedIds.has(m.id)
        ? globalPrisma.tenantMembership.update({ where: { id: m.id }, data: clearAttempts })
        : releaseAttempt('TenantMembership', m.id, claim.lockedNow);
    })
  ]);

  // ---- Memberships utilizables (activos en tenants ACTIVOS) ----
  const usableTenants = matchedMemberships.filter((m) => m.isActive && m.tenant.status === 'ACTIVE');

  // SuperAdmin inactivo: tratamos como si no existiera
  const saUsable = sa && saOk && sa.isActive;

  const logSuccess = () => recordLoginEvent({
    type: 'LOGIN_SUCCESS', email, ip, req,
    tenantIds: matchedMemberships.map((m) => m.tenantId)
  });

  // ---- Decidir flujo ----

  // CASO A: solo super (sin tenants)
  if (saUsable && usableTenants.length === 0) {
    await logSuccess();
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
      return rejectLogin('LOGIN_FAILED', 'ACCOUNT_INACTIVE');
    }
    await logSuccess();
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
  await logSuccess();
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
    if (!sa || !sa.isActive || (sa.lockedUntil && sa.lockedUntil > new Date())) {
      return res.status(403).json({ message: 'Super admin no disponible' });
    }
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
  if (!m || !m.isActive || m.tenant.status !== 'ACTIVE' || (m.lockedUntil && m.lockedUntil > new Date())) {
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
