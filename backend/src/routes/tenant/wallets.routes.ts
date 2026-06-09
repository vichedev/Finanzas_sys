import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';

export const walletsRouter = Router();
walletsRouter.use(requireAuth, (req, res, next) =>
  requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next)
);

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  provider: z.string().trim().max(60).optional().nullable(),
  identifier: z.string().trim().max(120).optional().nullable(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(300).optional().nullable()
}).strict();

walletsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.wallet.findMany({
    where: { userId: req.tenantUserId! },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
  });
  res.json(rows);
});

walletsRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const row = await req.tenantPrisma!.wallet.create({ data: { ...body, userId: req.tenantUserId! } });
  res.status(201).json(row);
});

walletsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = schema.partial().parse(req.body);
  const existing = await req.tenantPrisma!.wallet.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== req.tenantUserId!) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }
  const row = await req.tenantPrisma!.wallet.update({ where: { id, userId: req.tenantUserId! }, data: body });
  res.json(row);
});

walletsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await req.tenantPrisma!.wallet.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== req.tenantUserId!) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }
  await req.tenantPrisma!.wallet.delete({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
