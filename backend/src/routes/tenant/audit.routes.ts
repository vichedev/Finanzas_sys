import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';

export const auditRouter = Router();
auditRouter.use(requireAuth, requirePermission('reports', 'read'));

const VALID_ENTITIES = ['movement', 'account', 'card', 'bank', 'budget', 'recurring'];

auditRouter.get('/', async (req, res) => {
  const take = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const where: Record<string, unknown> = {};
  const entity = typeof req.query.entity === 'string' ? req.query.entity : null;
  if (entity && VALID_ENTITIES.includes(entity)) where.entity = entity;
  const action = typeof req.query.action === 'string' ? req.query.action : null;
  if (action && ['CREATE', 'UPDATE', 'DELETE'].includes(action)) where.action = action;

  const rows = await req.tenantPrisma!.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take
  });
  res.json(rows);
});
