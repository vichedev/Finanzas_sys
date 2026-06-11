import type { Request } from 'express';
import { logger } from './logger';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

interface AuditDetails {
  userId?: number | null;
  userEmail?: string | null;
  action: AuditAction;
  entity: string; // movement | account | card | bank | budget | recurring
  entityId?: number | null;
  summary?: string | null;
}

/** Cliente Prisma de tenant (o transacción) que expone auditLog. */
type AuditClient = { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } };

/**
 * Registra una entrada de auditoría en la BD del tenant.
 * Fire-and-forget: nunca rompe la operación principal si falla.
 */
export async function logTenantAudit(prisma: AuditClient, details: AuditDetails): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: details.userId ?? null,
        userEmail: details.userEmail ?? null,
        action: details.action,
        entity: details.entity,
        entityId: details.entityId ?? null,
        summary: details.summary ?? null
      }
    });
  } catch (err) {
    logger.error({ err, entity: details.entity, action: details.action }, 'tenant audit log failed');
  }
}

/** Atajo: extrae userId/email del request y registra. No bloquea (await opcional). */
export function auditFromReq(
  req: Request,
  action: AuditAction,
  entity: string,
  entityId: number | null | undefined,
  summary?: string
): Promise<void> {
  const email = req.auth?.kind === 'tenant' ? req.auth.email : null;
  return logTenantAudit(req.tenantPrisma as unknown as AuditClient, {
    userId: req.tenantUserId ?? null,
    userEmail: email,
    action,
    entity,
    entityId: entityId ?? null,
    summary
  });
}
