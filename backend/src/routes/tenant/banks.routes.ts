import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import type { Prisma } from '.prisma/tenant';

export const banksRouter = Router();
banksRouter.use(requireAuth, (req, res, next) => requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  accountNumber: z.string().trim().max(40).optional().nullable(),
  accountKind: z.enum(['SAVINGS', 'CHECKING']).optional().nullable(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(300).optional().nullable()
}).strict();

banksRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.bank.findMany({
    where: { userId: req.tenantUserId! },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
  });
  res.json(rows);
});

banksRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const row = await req.tenantPrisma!.bank.create({ data: { ...body, userId: req.tenantUserId! } });
  res.status(201).json(row);
});

banksRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = schema.partial().parse(req.body);
  const row = await req.tenantPrisma!.bank.update({ where: { id, userId: req.tenantUserId! }, data: body });
  res.json(row);
});

banksRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.bank.delete({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
