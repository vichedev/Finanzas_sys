import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';

export const debtsRouter = Router();
debtsRouter.use(requireAuth, (req, res, next) => requirePermission('debts', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const schema = z.object({
  kind: z.enum(['PAYABLE', 'RECEIVABLE', 'LOAN']),
  name: z.string().min(2),
  counterparty: z.string().optional().nullable(),
  principal: z.coerce.number().positive(),
  balance: z.coerce.number().optional(),
  interestRate: z.coerce.number().optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
  accountId: z.coerce.number().optional().nullable(),
  notes: z.string().optional().nullable(),
  installmentAmount: z.coerce.number().optional().nullable(),
  installmentDueDay: z.coerce.number().int().min(1).max(31).optional().nullable(),
  termMonths: z.coerce.number().int().min(1).max(600).optional().nullable(),
  totalToPay: z.coerce.number().optional().nullable()
}).strict();

debtsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.debt.findMany({
    where: { userId: req.tenantUserId! },
    include: { account: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(rows);
});

debtsRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const isLoan = body.kind === 'LOAN';
  const row = await req.tenantPrisma!.debt.create({
    data: {
      ...body,
      userId: req.tenantUserId!,
      balance: body.balance ?? body.principal,
      installmentAmount: isLoan ? (body.installmentAmount ?? null) : null,
      installmentDueDay: isLoan ? (body.installmentDueDay ?? null) : null,
      termMonths: isLoan ? (body.termMonths ?? null) : null,
      totalToPay: isLoan ? (body.totalToPay ?? null) : null
    }
  });
  res.status(201).json(row);
});

debtsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = schema.partial().parse(req.body);

  const existing = await req.tenantPrisma!.debt.findUnique({ where: { id }, select: { userId: true, kind: true, balance: true } });
  if (!existing || existing.userId !== req.tenantUserId!) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }
  // kind es inmutable: cambiarlo desincroniza balances con movements asociados
  if (body.kind !== undefined && body.kind !== existing.kind) {
    return res.status(400).json({ message: 'No se puede cambiar el tipo de la deuda. Crea una nueva.' });
  }

  const data: Record<string, unknown> = { ...body };
  delete data.kind;

  const row = await req.tenantPrisma!.debt.update({
    where: { id, userId: req.tenantUserId! },
    data
  });
  res.json(row);
});

debtsRouter.put('/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const body = z.object({ status: z.enum(['OPEN', 'PARTIAL', 'PAID', 'CANCELED']) }).strict().parse(req.body);
  const row = await req.tenantPrisma!.debt.update({ where: { id, userId: req.tenantUserId! }, data: body });
  res.json(row);
});

debtsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.debt.delete({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
