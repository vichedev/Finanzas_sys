import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';

export const recurringsRouter = Router();
recurringsRouter.use(requireAuth, (req, res, next) => requirePermission('recurrings', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const schema = z.object({
  name: z.string().min(2),
  type: z.enum(['INCOME', 'EXPENSE']),
  amount: z.coerce.number().positive(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  nextRunDate: z.coerce.date(),
  endDate: z.coerce.date().optional().nullable(),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'DEBIT_CARD', 'CREDIT_CARD', 'WALLET', 'OTHER']),
  categoryId: z.coerce.number().optional().nullable(),
  notes: z.string().optional().nullable()
}).strict();

recurringsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.recurringRule.findMany({
    where: { userId: req.tenantUserId! },
    include: { category: true },
    orderBy: { nextRunDate: 'asc' }
  });
  res.json(rows);
});

recurringsRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const row = await req.tenantPrisma!.recurringRule.create({ data: { ...body, userId: req.tenantUserId! } });
  res.status(201).json(row);
});

recurringsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = schema.partial().parse(req.body);
  const row = await req.tenantPrisma!.recurringRule.update({ where: { id, userId: req.tenantUserId! }, data: body });
  res.json(row);
});

recurringsRouter.put('/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const body = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'FINISHED']) }).strict().parse(req.body);
  const row = await req.tenantPrisma!.recurringRule.update({ where: { id, userId: req.tenantUserId! }, data: body });
  res.json(row);
});

recurringsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.recurringRule.delete({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
