import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import type { Prisma } from '.prisma/tenant';

export const cardsRouter = Router();
cardsRouter.use(requireAuth, (req, res, next) => requirePermission('cards', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const cardSchema = z.object({
  name: z.string().trim().min(2).max(80),
  type: z.enum(['CREDIT', 'DEBIT']),
  bankName: z.string().trim().max(80).optional().nullable(),
  last4: z.string().trim().max(4).optional().nullable(),
  creditLimit: z.coerce.number().finite().gte(0).lte(99_999_999_999.99).optional().nullable(),
  cutoffDay: z.coerce.number().int().min(1).max(31).optional().nullable(),
  paymentDueDay: z.coerce.number().int().min(1).max(31).optional().nullable(),
  currentBalance: z.coerce.number().finite().gte(-99_999_999_999.99).lte(99_999_999_999.99).default(0)
}).strict();

cardsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.card.findMany({
    where: { userId: req.tenantUserId!, isActive: true },
    orderBy: { createdAt: 'asc' }
  });
  res.json(rows);
});

cardsRouter.post('/', async (req, res) => {
  const body = cardSchema.parse(req.body);
  const row = await req.tenantPrisma!.card.create({ data: { ...body, userId: req.tenantUserId! } });
  res.status(201).json(row);
});

cardsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = cardSchema.partial().parse(req.body);
  // currentBalance se deriva de movimientos; no editable post-creación
  const { currentBalance: _cb, ...editable } = body as Record<string, unknown> & { currentBalance?: number };
  const row = await req.tenantPrisma!.card.update({ where: { id, userId: req.tenantUserId! }, data: editable });
  res.json(row);
});

cardsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.card.update({ where: { id, userId: req.tenantUserId! }, data: { isActive: false } });
  res.status(204).send();
});
