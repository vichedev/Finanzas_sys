import { Request, Response, NextFunction } from 'express';

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.kind !== 'super') return res.status(403).json({ message: 'Solo super-admin' });
  return next();
}
