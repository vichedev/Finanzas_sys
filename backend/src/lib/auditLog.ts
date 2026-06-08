import type { Request } from 'express';
import { globalPrisma } from './globalPrisma';
import { logger } from './logger';

type Action =
  | 'TENANT_CREATE' | 'TENANT_EDIT' | 'TENANT_SUSPEND' | 'TENANT_REACTIVATE' | 'TENANT_DELETE'
  | 'TENANT_ADMIN_RESET_PASSWORD' | 'TENANT_ADMIN_CHANGE_EMAIL'
  | 'IMPERSONATE_LOGIN' | 'IMPERSONATE_QUERY' | 'ROTATE_CREDS' | 'PLAN_CHANGE'
  | 'SUPER_ADMIN_LOGIN' | 'SUPER_ADMIN_LOGIN_FAILED';

export async function logSuperAccess(
  superAdminId: string,
  tenantId: string | null,
  action: Action,
  req: Request,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await globalPrisma.superAdminAuditLog.create({
      data: {
        superAdminId,
        tenantId,
        action,
        resource: req.path,
        ip: req.ip || (req.headers['x-forwarded-for'] as string | undefined) || null,
        userAgent: (req.headers['user-agent'] as string | undefined) || null,
        metadata: { method: req.method, ...metadata }
      }
    });
  } catch (err) {
    logger.error({ err, superAdminId, tenantId, action }, 'audit log failed');
  }
}
