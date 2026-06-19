import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';

// Catálogo de razones sociales / entidades. Las cuentas y tarjetas se asignan a una de estas.
export const entitiesRouter = Router();
entitiesRouter.use(requireAuth, (req, res, next) =>
  requirePermission('accounts', req.method === 'GET' ? 'read' : 'write')(req, res, next)
);

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['PERSONAL', 'BUSINESS']).default('PERSONAL'),
  taxId: z.string().trim().max(40).optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable()
}).strict();

entitiesRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.entity.findMany({
    where: { userId: req.tenantUserId! },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { accounts: true, cards: true } } }
  });
  res.json(rows);
});

entitiesRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const row = await req.tenantPrisma!.entity.create({ data: { ...body, userId: req.tenantUserId! } });
  void auditFromReq(req, 'CREATE', 'entity', row.id, `Razón social "${row.name}"`);
  res.status(201).json(row);
});

entitiesRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const body = schema.partial().parse(req.body);
  const existing = await req.tenantPrisma!.entity.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== userId) return res.status(404).json({ message: 'Recurso no encontrado' });
  const row = await req.tenantPrisma!.entity.update({ where: { id, userId }, data: body });
  void auditFromReq(req, 'UPDATE', 'entity', id, `Razón social "${row.name}"`);
  res.json(row);
});

entitiesRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const existing = await req.tenantPrisma!.entity.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== userId) return res.status(404).json({ message: 'Recurso no encontrado' });
  // onDelete: SetNull deja las cuentas/tarjetas sin razón social (no las borra).
  await req.tenantPrisma!.entity.delete({ where: { id, userId } });
  void auditFromReq(req, 'DELETE', 'entity', id, 'Razón social eliminada');
  res.status(204).send();
});
