import { Request, Response, NextFunction } from 'express';
import { getTenantPrisma } from '../lib/tenantPrisma';
import { globalPrisma } from '../lib/globalPrisma';
import { logSuperAccess } from '../lib/auditLog';
import { logger } from '../lib/logger';

export async function tenantContext(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) return res.status(401).json({ message: 'No autenticado' });

  let targetTenantId: string | null = null;

  if (req.auth.kind === 'super') {
    targetTenantId = (req.headers['x-impersonate-tenant'] as string) || null;
    if (targetTenantId) {
      req.isImpersonating = true;
      // Audit log non-blocking
      logSuperAccess(req.auth.id, targetTenantId, 'IMPERSONATE_QUERY', req).catch((e) =>
        logger.error({ err: e }, 'audit failed')
      );
    } else {
      // Super sin header de tenant intentando acceder a una ruta tenant:
      // devuelve 400 claro (no 500 por undefined.x)
      return res.status(400).json({
        message: 'Como super-admin, debes seleccionar una empresa (X-Impersonate-Tenant) para acceder a estos datos.'
      });
    }
  } else if (req.auth.kind === 'tenant') {
    targetTenantId = req.auth.tenantId;
  }

  if (!targetTenantId) return res.status(400).json({ message: 'Tenant no resuelto' });

  try {
    req.tenantPrisma = await getTenantPrisma(targetTenantId);
    req.tenantId = targetTenantId;

    // Mapeo del User local del tenant por email
    const email = req.auth.kind === 'tenant' ? req.auth.email : null;
    if (email) {
      const localUser = await req.tenantPrisma.user.findUnique({
        where: { email },
        select: { id: true, isActive: true }
      });
      if (!localUser) {
        // Auto-provisioning: si el TenantMembership existe pero no el User local, crearlo
        const m = await globalPrisma.tenantMembership.findUnique({
          where: { email_tenantId: { email, tenantId: targetTenantId } }
        });
        if (m) {
          const created = await req.tenantPrisma.user.create({
            data: { email: m.email, name: m.name, role: m.role, isActive: m.isActive }
          });
          req.tenantUserId = created.id;
        } else {
          return res.status(403).json({ message: 'Usuario no tiene acceso a este tenant' });
        }
      } else {
        if (!localUser.isActive) return res.status(403).json({ message: 'Usuario inactivo' });
        req.tenantUserId = localUser.id;
      }
    }
    return next();
  } catch (e: any) {
    return res.status(e.status || 500).json({ message: e.message });
  }
}
