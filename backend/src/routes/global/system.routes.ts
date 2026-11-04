import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requireSystemAdmin } from '../../middleware/systemAdmin';
import { readStatus, requestAction } from '../../lib/systemUpdate';
import { logger } from '../../lib/logger';

// Actualización del sistema desde la UI (super-admin o admin de empresa).
// No usa tenantScope: la acción es global (toca todo el servidor).
export const systemRouter = Router();
systemRouter.use(requireAuth, requireSystemAdmin);

systemRouter.get('/update', (_req, res) => {
  res.json(readStatus());
});

systemRouter.post('/update/check', (_req, res) => {
  const r = requestAction('check');
  if (!r.ok) return res.status(400).json({ message: r.error });
  res.json({ queued: true });
});

systemRouter.post('/update/apply', (req, res) => {
  const r = requestAction('apply');
  if (!r.ok) return res.status(400).json({ message: r.error });
  logger.warn({ by: (req as any).auth?.email || (req as any).auth?.kind }, 'system: actualización solicitada desde la UI');
  res.json({ queued: true });
});
