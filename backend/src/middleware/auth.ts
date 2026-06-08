import { Request, Response, NextFunction } from 'express';
import { verifyToken, type JwtPayload } from '../lib/jwt';
import { globalPrisma } from '../lib/globalPrisma';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: JwtPayload;
      tenantPrisma?: import('../lib/tenantPrisma').TenantPrisma;
      tenantId?: string;
      tenantUserId?: number;       // User.id local del tenant
      isImpersonating?: boolean;
    }
  }
}

export type TenantPrisma = Awaited<ReturnType<typeof import('../lib/tenantPrisma').getTenantPrisma>>;

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ message: 'No autorizado' });

  let payload: JwtPayload;
  try {
    payload = verifyToken(header.slice(7));
  } catch {
    return res.status(401).json({ message: 'Token inválido' });
  }

  if (payload.kind === 'pending') {
    return res.status(401).json({ message: 'Selecciona un tenant primero' });
  }

  // Validar tokenVersion contra DB
  if (payload.kind === 'super') {
    const sa = await globalPrisma.superAdmin.findUnique({
      where: { id: payload.id },
      select: { tokenVersion: true, isActive: true }
    });
    if (!sa || !sa.isActive || sa.tokenVersion !== payload.tokenVersion) {
      return res.status(401).json({ message: 'Sesión inválida' });
    }
  } else {
    const m = await globalPrisma.tenantMembership.findUnique({
      where: { id: payload.id },
      select: { tokenVersion: true, isActive: true, tenantId: true }
    });
    if (!m || !m.isActive || m.tokenVersion !== payload.tokenVersion || m.tenantId !== payload.tenantId) {
      return res.status(401).json({ message: 'Sesión inválida' });
    }
  }

  req.auth = payload;
  return next();
}
