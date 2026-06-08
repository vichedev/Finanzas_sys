import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '.prisma/tenant';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';

export const movementsRouter = Router();
movementsRouter.use(requireAuth, (req, res, next) => requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const trimmedString = (min = 2, max = 200) => z.string().trim().min(min).max(max);
const moneyAmount = z.coerce.number().finite().gt(0).lte(99_999_999_999.99);

const movementSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'WITHDRAWAL', 'PURCHASE']),
  expenseKind: z.enum(['FIXED', 'VARIABLE', 'NON_ACCOUNTABLE']).optional().nullable(),
  amount: moneyAmount,
  movementDate: z.coerce.date(),
  description: trimmedString(2, 200),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'DEPOSIT', 'DEBIT_CARD', 'CREDIT_CARD', 'WALLET', 'OTHER']),
  accountId: z.coerce.number().optional().nullable(),
  cardId: z.coerce.number().optional().nullable(),
  categoryId: z.coerce.number().optional().nullable(),
  debtId: z.coerce.number().optional().nullable(),
  recurringRuleId: z.coerce.number().optional().nullable(),
  fromBankId: z.coerce.number().optional().nullable(),
  toBankId: z.coerce.number().optional().nullable(),
  vendor: z.string().trim().max(120).optional().nullable(),
  isCredit: z.coerce.boolean().optional().default(false),
  dueDate: z.coerce.date().optional().nullable(),
  familyMember: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  installmentNumber: z.coerce.number().int().min(1).max(360).optional().nullable(),
  installmentTotal: z.coerce.number().int().min(1).max(360).optional().nullable(),
  attachmentMeta: z.any().optional().nullable().refine(
    (v) => v == null || JSON.stringify(v).length <= 4000,
    { message: 'attachmentMeta demasiado grande' }
  )
}).strict().superRefine((d, ctx) => {
  if (d.installmentNumber && d.installmentTotal && d.installmentNumber > d.installmentTotal) {
    ctx.addIssue({ code: 'custom', path: ['installmentNumber'], message: 'No puede ser mayor que installmentTotal' });
  }
  if (d.type !== 'EXPENSE' && d.expenseKind) {
    ctx.addIssue({ code: 'custom', path: ['expenseKind'], message: 'Solo aplica cuando type=EXPENSE' });
  }
});

function monthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { start, end };
}

function accountDelta(type: string, amount: number, isCredit?: boolean) {
  if (type === 'INCOME') return amount;
  if (type === 'EXPENSE' || type === 'WITHDRAWAL') return -amount;
  if (type === 'PURCHASE' && !isCredit) return -amount;
  return 0;
}

function cardDelta(type: string, amount: number, isCredit?: boolean) {
  if (type === 'EXPENSE') return amount;
  if (type === 'PURCHASE' && !isCredit) return amount;
  return 0;
}

function debtDelta(type: string, amount: number) {
  if (type === 'EXPENSE' || type === 'INCOME') return -amount;
  return 0;
}

async function assertOwnership(
  tx: Prisma.TransactionClient,
  userId: number,
  ids: { accountId?: number | null; cardId?: number | null; categoryId?: number | null; debtId?: number | null; recurringRuleId?: number | null; fromBankId?: number | null; toBankId?: number | null }
) {
  const checks: Promise<unknown>[] = [];
  if (ids.accountId) checks.push(tx.account.findFirstOrThrow({ where: { id: ids.accountId, userId }, select: { id: true } }));
  if (ids.cardId) checks.push(tx.card.findFirstOrThrow({ where: { id: ids.cardId, userId }, select: { id: true } }));
  if (ids.categoryId) checks.push(tx.category.findFirstOrThrow({ where: { id: ids.categoryId, userId }, select: { id: true } }));
  if (ids.debtId) checks.push(tx.debt.findFirstOrThrow({ where: { id: ids.debtId, userId }, select: { id: true } }));
  if (ids.recurringRuleId) checks.push(tx.recurringRule.findFirstOrThrow({ where: { id: ids.recurringRuleId, userId }, select: { id: true } }));
  if (ids.fromBankId) checks.push(tx.bank.findFirstOrThrow({ where: { id: ids.fromBankId, userId }, select: { id: true } }));
  if (ids.toBankId) checks.push(tx.bank.findFirstOrThrow({ where: { id: ids.toBankId, userId }, select: { id: true } }));
  await Promise.all(checks);
}

async function applyDeltas(
  tx: Prisma.TransactionClient,
  userId: number,
  body: { type: string; amount: number | string; accountId?: number | null; cardId?: number | null; debtId?: number | null; isCredit?: boolean | null }
) {
  const amt = Number(body.amount);
  const ic = !!body.isCredit;
  if (body.accountId) {
    const d = accountDelta(body.type, amt, ic);
    if (d !== 0) await tx.account.update({ where: { id: body.accountId, userId }, data: { currentBalance: { increment: d } } });
  }
  if (body.cardId) {
    const d = cardDelta(body.type, amt, ic);
    if (d !== 0) await tx.card.update({ where: { id: body.cardId, userId }, data: { currentBalance: { increment: d } } });
  }
  if (body.debtId) {
    const d = debtDelta(body.type, amt);
    if (d !== 0) await tx.debt.update({ where: { id: body.debtId, userId }, data: { balance: { increment: d } } });
  }
}

async function revertDeltas(
  tx: Prisma.TransactionClient,
  userId: number,
  prev: { type: string; amount: Prisma.Decimal | number | string; accountId: number | null; cardId: number | null; debtId: number | null; isCredit?: boolean | null }
) {
  const amt = Number(prev.amount);
  const ic = !!prev.isCredit;
  if (prev.accountId) {
    const d = -accountDelta(prev.type, amt, ic);
    if (d !== 0) await tx.account.update({ where: { id: prev.accountId, userId }, data: { currentBalance: { increment: d } } });
  }
  if (prev.cardId) {
    const d = -cardDelta(prev.type, amt, ic);
    if (d !== 0) await tx.card.update({ where: { id: prev.cardId, userId }, data: { currentBalance: { increment: d } } });
  }
  if (prev.debtId) {
    const d = -debtDelta(prev.type, amt);
    if (d !== 0) await tx.debt.update({ where: { id: prev.debtId, userId }, data: { balance: { increment: d } } });
  }
}

movementsRouter.get('/', async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year || now.getUTCFullYear());
  const month = Number(req.query.month || now.getUTCMonth() + 1);
  const { start, end } = monthRange(year, month);

  const where: any = { userId: req.tenantUserId!, movementDate: { gte: start, lt: end } };
  const rawType = typeof req.query.type === 'string' ? req.query.type : null;
  if (rawType && ['INCOME', 'EXPENSE', 'TRANSFER', 'WITHDRAWAL', 'PURCHASE'].includes(rawType)) {
    where.type = rawType;
  }
  const rawKind = typeof req.query.expenseKind === 'string' ? req.query.expenseKind : null;
  if (rawKind && ['FIXED', 'VARIABLE', 'NON_ACCOUNTABLE'].includes(rawKind)) {
    where.type = 'EXPENSE';
    where.expenseKind = rawKind;
  }

  const rows = await req.tenantPrisma!.movement.findMany({
    where,
    include: { category: true, account: true, card: true, debt: true, fromBank: true, toBank: true },
    orderBy: { movementDate: 'desc' },
    take: 500
  });
  res.json(rows);
});

movementsRouter.post('/', async (req, res) => {
  const body = movementSchema.parse(req.body);
  const userId = req.tenantUserId!;

  const row = await req.tenantPrisma!.$transaction(async (tx) => {
    await assertOwnership(tx, userId, body);
    const movement = await tx.movement.create({
      data: { ...body, userId, attachmentMeta: body.attachmentMeta ?? Prisma.JsonNull }
    });
    await applyDeltas(tx, userId, body);
    return movement;
  });

  res.status(201).json(row);
});

movementsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = movementSchema.parse(req.body);
  const userId = req.tenantUserId!;

  const row = await req.tenantPrisma!.$transaction(async (tx) => {
    const prev = await tx.movement.findUnique({ where: { id } });
    if (!prev || prev.userId !== userId) throw Object.assign(new Error('Not found'), { code: 'P2025' });
    await assertOwnership(tx, userId, body);
    await revertDeltas(tx, userId, prev);
    const updated = await tx.movement.update({
      where: { id },
      data: { ...body, attachmentMeta: body.attachmentMeta ?? Prisma.JsonNull }
    });
    await applyDeltas(tx, userId, body);
    return updated;
  });

  res.json(row);
});

movementsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;

  await req.tenantPrisma!.$transaction(async (tx) => {
    const prev = await tx.movement.findUnique({ where: { id } });
    if (!prev || prev.userId !== userId) throw Object.assign(new Error('Not found'), { code: 'P2025' });
    await revertDeltas(tx, userId, prev);
    await tx.movement.delete({ where: { id } });
  });

  res.status(204).send();
});

movementsRouter.get('/monthly-summary', async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year || now.getUTCFullYear());
  const month = Number(req.query.month || now.getUTCMonth() + 1);
  const { start, end } = monthRange(year, month);

  const [totals, byCategory, categories] = await Promise.all([
    req.tenantPrisma!.movement.groupBy({
      by: ['type'],
      where: { userId: req.tenantUserId!, movementDate: { gte: start, lt: end } },
      _sum: { amount: true }
    }),
    req.tenantPrisma!.movement.groupBy({
      by: ['categoryId', 'type'],
      where: { userId: req.tenantUserId!, movementDate: { gte: start, lt: end } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } }
    }),
    req.tenantPrisma!.category.findMany({ where: { userId: req.tenantUserId! } })
  ]);

  const income = Number(totals.find((t) => t.type === 'INCOME')?._sum.amount || 0);
  const expense = Number(totals.find((t) => t.type === 'EXPENSE')?._sum.amount || 0);

  res.json({
    year, month, income, expense, balance: income - expense,
    byCategory: byCategory.map((row) => ({
      type: row.type,
      categoryId: row.categoryId,
      categoryName: categories.find((c) => c.id === row.categoryId)?.name || 'Sin categoría',
      amount: Number(row._sum.amount || 0)
    }))
  });
});
