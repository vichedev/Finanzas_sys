import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import type { Prisma } from '.prisma/tenant';

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth, (req, res, next) => requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const schema = z.object({
  name: z.string().trim().min(2).max(60),
  type: z.enum(['INCOME', 'EXPENSE']).optional().nullable(), // ya no obligatorio
  color: z.string().trim().max(20).optional().nullable(),
  icon: z.string().trim().max(60).optional().nullable()
}).strict();

categoriesRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.category.findMany({
    where: { userId: req.tenantUserId! },
    orderBy: [{ name: 'asc' }]
  });
  res.json(rows);
});

categoriesRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const row = await req.tenantPrisma!.category.create({ data: { ...body, userId: req.tenantUserId! } });
  res.status(201).json(row);
});

categoriesRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = schema.partial().parse(req.body);
  const row = await req.tenantPrisma!.category.update({ where: { id, userId: req.tenantUserId! }, data: body });
  res.json(row);
});

categoriesRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.category.delete({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
