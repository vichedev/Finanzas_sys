import { Request, Response, NextFunction } from 'express';

// Permite acciones del sistema (actualizaciones) al SUPER_ADMIN o al
// ADMIN_EMPRESA (operador del servidor). Un usuario normal no pasa.
export function requireSystemAdmin(req: Request, res: Response, next: NextFunction) {
  const a: any = req.auth;
  if (a?.kind === 'super') return next();
  if (a?.kind === 'tenant' && a.role === 'ADMIN_EMPRESA') return next();
  return res.status(403).json({ message: 'Solo administradores pueden actualizar el sistema.' });
}
