import jwt from 'jsonwebtoken';

const ISSUER = 'finanzas';
const AUDIENCE = 'finanzas-api';

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no configurado');
  return secret;
}

function defaultExpires(): string {
  return process.env.JWT_EXPIRES_IN || '1d';
}

export type JwtKind = 'super' | 'tenant' | 'pending';

export interface SuperAdminPayload {
  kind: 'super';
  id: string;                    // SuperAdmin.id
  email: string;
  role: 'SUPER_ADMIN' | 'SUPPORT';
  tokenVersion: number;
}

export interface TenantUserPayload {
  kind: 'tenant';
  id: string;                    // TenantMembership.id
  email: string;
  tenantId: string;
  role: 'ADMIN_EMPRESA' | 'USUARIO_EMPRESA';
  tokenVersion: number;
}

export interface PendingPayload {
  kind: 'pending';
  email: string;
  /** Si está presente, el email es también SUPER_ADMIN — el frontend ofrece esa opción al usuario */
  superAdminId?: string;
  tenants: { id: string; slug: string; name: string }[];
  exp?: number;
}

export type JwtPayload = SuperAdminPayload | TenantUserPayload | PendingPayload;

export function signToken(payload: JwtPayload, expiresIn?: string): string {
  const exp = (payload.kind === 'pending' ? '5m' : (expiresIn || defaultExpires())) as jwt.SignOptions['expiresIn'];
  return jwt.sign(payload as any, getSecret(), {
    algorithm: 'HS256',
    expiresIn: exp,
    issuer: ISSUER,
    audience: AUDIENCE
  });
}

export function verifyToken<T extends JwtPayload = JwtPayload>(token: string): T {
  return jwt.verify(token, getSecret(), {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE
  }) as T;
}
