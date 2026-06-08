import { NextFunction, Request, Response } from 'express';
import { ModuleName, normalizePermissions } from '../lib/permissions';
import { globalPrisma } from '../lib/globalPrisma';

const cache = new Map<string, { perms: ReturnType<typeof normalizePermissions>; expires: number }>();
const TTL = 30_000;

export function requirePermission(mod: ModuleName, action: 'read' | 'write') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ message: 'No autenticado' });

    // SUPER_ADMIN y ADMIN_EMPRESA pasan sin chequeo de módulos
    if (req.auth.kind === 'super') return next();
    if (req.auth.kind === 'tenant' && req.auth.role === 'ADMIN_EMPRESA') return next();

    if (req.auth.kind !== 'tenant') {
      return res.status(403).json({ message: 'Sin permisos' });
    }

    // Cargar permissions desde TenantMembership (cacheado 30s)
    const cached = cache.get(req.auth.id);
    let perms;
    if (cached && cached.expires > Date.now()) {
      perms = cached.perms;
    } else {
      const m = await globalPrisma.tenantMembership.findUnique({
        where: { id: req.auth.id },
        select: { permissions: true }
      });
      perms = normalizePermissions(m?.permissions);
      cache.set(req.auth.id, { perms, expires: Date.now() + TTL });
    }

    const level = perms[mod];
    if (level === 'none') return res.status(403).json({ message: `Sin permisos para ${mod}` });
    if (action === 'write' && level !== 'edit') {
      return res.status(403).json({ message: `Solo lectura en ${mod}` });
    }
    return next();
  };
}

export function invalidatePermissionsCache(membershipId: string): void {
  cache.delete(membershipId);
}
