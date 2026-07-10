import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '.prisma/tenant';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { createNotification } from '../../lib/notifications';
import { auditFromReq } from '../../lib/tenantAudit';
import { accountBelongsToDebitCard } from '../../lib/debitCard';

const MOVE_LABEL: Record<string, string> = { INCOME: 'Ingreso', EXPENSE: 'Gasto', TRANSFER: 'Transferencia', WITHDRAWAL: 'Retiro', PURCHASE: 'Compra' };
const fmtMoney = (v: unknown) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));

export const movementsRouter = Router();
movementsRouter.use(requireAuth, (req, res, next) => requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const trimmedString = (min = 2, max = 200) => z.string().trim().min(min).max(max);
const moneyAmount = z.coerce.number().finite().gt(0).lte(99_999_999_999.99);

const movementSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'WITHDRAWAL', 'PURCHASE', 'CARD_PAYMENT', 'ADJUSTMENT']),
  expenseKind: z.enum(['FIXED', 'VARIABLE', 'NON_ACCOUNTABLE']).optional().nullable(),
  amount: moneyAmount,
  movementDate: z.coerce.date(),
  description: trimmedString(2, 200),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'DEPOSIT', 'DEBIT_CARD', 'CREDIT_CARD', 'WALLET', 'OTHER']),
  accountId: z.coerce.number().optional().nullable(),
  toAccountId: z.coerce.number().optional().nullable(),
  cardId: z.coerce.number().optional().nullable(),
  walletId: z.coerce.number().optional().nullable(),
  categoryId: z.coerce.number().optional().nullable(),
  debtId: z.coerce.number().optional().nullable(),
  recurringRuleId: z.coerce.number().optional().nullable(),
  fromBankId: z.coerce.number().optional().nullable(),
  toBankId: z.coerce.number().optional().nullable(),
  vendor: z.string().trim().max(120).optional().nullable(),
  isCredit: z.coerce.boolean().optional().default(false),
  dueDate: z.coerce.date().optional().nullable(),
  commission: z.coerce.number().min(0).max(99_999_999.99).optional().nullable(),
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
  // Coherencia tipo↔campos: evita movimientos que descuadran los saldos
  // (p. ej. una transferencia sin destino haría "desaparecer" el dinero del origen).
  if (d.type === 'TRANSFER') {
    if (!d.accountId) ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'La transferencia requiere cuenta de origen' });
    if (!d.toAccountId) ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: 'La transferencia requiere cuenta de destino' });
    if (d.accountId && d.toAccountId && d.accountId === d.toAccountId) {
      ctx.addIssue({ code: 'custom', path: ['toAccountId'], message: 'El origen y el destino deben ser distintos' });
    }
  }
  if (d.type === 'CARD_PAYMENT') {
    if (!d.accountId) ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'El pago de tarjeta requiere cuenta de origen' });
    if (!d.cardId) ctx.addIssue({ code: 'custom', path: ['cardId'], message: 'El pago de tarjeta requiere la tarjeta' });
  }
  if (d.type === 'WITHDRAWAL' && !d.accountId) {
    ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'El retiro requiere la cuenta de la que sale el efectivo' });
  }
  if (d.type === 'ADJUSTMENT' && !d.accountId) {
    ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'El ajuste requiere una cuenta' });
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

// OJO: solo aplica a tarjetas de CRÉDITO, donde currentBalance = deuda usada.
// Una tarjeta de DÉBITO no guarda saldo: es un acceso a sus cuentas enlazadas,
// y el movimiento ya lo absorbe la cuenta vía accountDelta().
function cardDelta(type: string, amount: number, isCredit?: boolean) {
  if (type === 'EXPENSE') return amount;
  if (type === 'PURCHASE' && !isCredit) return amount;
  return 0;
}

/** Tipo de la tarjeta ('CREDIT' | 'DEBIT'), o null si no existe. */
async function cardTypeOf(tx: Prisma.TransactionClient, userId: number, cardId: number): Promise<string | null> {
  const c = await tx.card.findFirst({ where: { id: cardId, userId }, select: { type: true } });
  return c?.type ?? null;
}

/**
 * Un movimiento con tarjeta de DÉBITO debe decir de qué cuenta sale el dinero:
 * la tarjeta no guarda saldo, es un acceso a las cuentas del mismo banco y titular.
 * La cuenta elegida debe ser una de ellas (mismo banco y, si la tarjeta tiene
 * titular, mismo titular).
 */
async function assertDebitCardHasAccount(
  tx: Prisma.TransactionClient,
  userId: number,
  body: { type: string; cardId?: number | null; accountId?: number | null }
) {
  if (!body.cardId || body.type === 'CARD_PAYMENT') return;
  const card = await tx.card.findFirst({ where: { id: body.cardId, userId }, select: { type: true, bankId: true, name: true } });
  if (!card || card.type !== 'DEBIT') return;
  if (!body.accountId) {
    throw Object.assign(
      new Error('Un movimiento con tarjeta de débito requiere la cuenta bancaria de la que sale el dinero.'),
      { status: 400 }
    );
  }
  const account = await tx.account.findFirst({ where: { id: body.accountId, userId }, select: { bankId: true, name: true } });
  if (!account || !accountBelongsToDebitCard(card, account)) {
    throw Object.assign(
      new Error('La cuenta elegida no pertenece a esa tarjeta (debe ser del mismo banco y titular).'),
      { status: 400 }
    );
  }
}

function debtDelta(type: string, amount: number) {
  if (type === 'EXPENSE' || type === 'INCOME') return -amount;
  return 0;
}

async function assertOwnership(
  tx: Prisma.TransactionClient,
  userId: number,
  ids: { accountId?: number | null; toAccountId?: number | null; cardId?: number | null; walletId?: number | null; categoryId?: number | null; debtId?: number | null; recurringRuleId?: number | null; fromBankId?: number | null; toBankId?: number | null }
) {
  const checks: Promise<unknown>[] = [];
  if (ids.accountId) checks.push(tx.account.findFirstOrThrow({ where: { id: ids.accountId, userId }, select: { id: true } }));
  if (ids.toAccountId) checks.push(tx.account.findFirstOrThrow({ where: { id: ids.toAccountId, userId }, select: { id: true } }));
  if (ids.cardId) checks.push(tx.card.findFirstOrThrow({ where: { id: ids.cardId, userId }, select: { id: true } }));
  if (ids.walletId) checks.push(tx.wallet.findFirstOrThrow({ where: { id: ids.walletId, userId }, select: { id: true } }));
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
  body: { type: string; amount: number | string; accountId?: number | null; toAccountId?: number | null; commission?: number | string | null; cardId?: number | null; debtId?: number | null; isCredit?: boolean | null }
) {
  const amt = Number(body.amount);
  const ic = !!body.isCredit;
  // Transferencia entre cuentas: sale del origen (+comisión), entra al destino.
  if (body.type === 'TRANSFER') {
    const com = Number(body.commission || 0);
    if (body.accountId) await tx.account.update({ where: { id: body.accountId, userId }, data: { currentBalance: { decrement: amt + com } } });
    if (body.toAccountId) await tx.account.update({ where: { id: body.toAccountId, userId }, data: { currentBalance: { increment: amt } } });
    return;
  }
  // Pago de tarjeta: sale de la cuenta y baja el saldo usado de la tarjeta.
  if (body.type === 'CARD_PAYMENT') {
    if (body.accountId) await tx.account.update({ where: { id: body.accountId, userId }, data: { currentBalance: { decrement: amt } } });
    if (body.cardId) await tx.card.update({ where: { id: body.cardId, userId }, data: { currentBalance: { decrement: amt } } });
    return;
  }
  // Ajuste/conciliación: isCredit=true sube el saldo, false lo baja.
  if (body.type === 'ADJUSTMENT') {
    if (body.accountId) await tx.account.update({ where: { id: body.accountId, userId }, data: { currentBalance: { increment: ic ? amt : -amt } } });
    return;
  }
  if (body.accountId) {
    const d = accountDelta(body.type, amt, ic);
    if (d !== 0) await tx.account.update({ where: { id: body.accountId, userId }, data: { currentBalance: { increment: d } } });
  }
  if (body.cardId) {
    // Débito: sin saldo propio (lo absorbe la cuenta enlazada, ya descontada arriba).
    const isCreditCard = (await cardTypeOf(tx, userId, body.cardId)) === 'CREDIT';
    const d = isCreditCard ? cardDelta(body.type, amt, ic) : 0;
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
  prev: { type: string; amount: Prisma.Decimal | number | string; accountId: number | null; toAccountId?: number | null; commission?: Prisma.Decimal | number | string | null; cardId: number | null; debtId: number | null; isCredit?: boolean | null }
) {
  const amt = Number(prev.amount);
  const ic = !!prev.isCredit;
  if (prev.type === 'TRANSFER') {
    const com = Number(prev.commission || 0);
    if (prev.accountId) await tx.account.update({ where: { id: prev.accountId, userId }, data: { currentBalance: { increment: amt + com } } });
    if (prev.toAccountId) await tx.account.update({ where: { id: prev.toAccountId, userId }, data: { currentBalance: { decrement: amt } } });
    return;
  }
  if (prev.type === 'CARD_PAYMENT') {
    if (prev.accountId) await tx.account.update({ where: { id: prev.accountId, userId }, data: { currentBalance: { increment: amt } } });
    if (prev.cardId) await tx.card.update({ where: { id: prev.cardId, userId }, data: { currentBalance: { increment: amt } } });
    return;
  }
  if (prev.type === 'ADJUSTMENT') {
    if (prev.accountId) await tx.account.update({ where: { id: prev.accountId, userId }, data: { currentBalance: { increment: ic ? -amt : amt } } });
    return;
  }
  if (prev.accountId) {
    const d = -accountDelta(prev.type, amt, ic);
    if (d !== 0) await tx.account.update({ where: { id: prev.accountId, userId }, data: { currentBalance: { increment: d } } });
  }
  if (prev.cardId) {
    // Debe espejar exactamente la regla de applyDeltas, o editar/borrar descuadraría.
    const isCreditCard = (await cardTypeOf(tx, userId, prev.cardId)) === 'CREDIT';
    const d = isCreditCard ? -cardDelta(prev.type, amt, ic) : 0;
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
    include: { category: true, account: true, toAccount: true, card: true, wallet: true, debt: true, fromBank: true, toBank: true },
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
    await assertDebitCardHasAccount(tx, userId, body);
    const movement = await tx.movement.create({
      data: { ...body, userId, attachmentMeta: body.attachmentMeta ?? Prisma.JsonNull }
    });
    await applyDeltas(tx, userId, body);
    return movement;
  });

  void auditFromReq(req, 'CREATE', 'movement', row.id, `${MOVE_LABEL[row.type] || row.type}: "${row.description}" · ${fmtMoney(row.amount)}`);

  // Notificaciones (no bloquean la respuesta)
  void (async () => {
    const prisma = req.tenantPrisma!;
    await createNotification(prisma, {
      userId, type: 'MOVEMENT_CREATED',
      title: 'Nuevo movimiento',
      body: `${MOVE_LABEL[row.type] || row.type}: "${row.description}" · ${fmtMoney(row.amount)}`,
      link: '/movements', email: true
    });
    if (row.accountId) {
      const acc = await prisma.account.findUnique({ where: { id: row.accountId }, select: { name: true, currentBalance: true } });
      if (acc && Number(acc.currentBalance) < 0) {
        await createNotification(prisma, {
          userId, type: 'LOW_BALANCE',
          title: 'Saldo negativo',
          body: `La cuenta "${acc.name}" quedó en ${fmtMoney(acc.currentBalance)}`,
          link: '/accounts',
          dedupeKey: `low-balance:${row.accountId}:${new Date().toISOString().slice(0, 10)}`,
          email: true
        });
      }
    }
  })().catch(() => { /* ya logueado dentro de createNotification */ });

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
    await assertDebitCardHasAccount(tx, userId, body);
    await revertDeltas(tx, userId, prev);
    const updated = await tx.movement.update({
      where: { id },
      data: { ...body, attachmentMeta: body.attachmentMeta ?? Prisma.JsonNull }
    });
    await applyDeltas(tx, userId, body);
    return updated;
  });

  void auditFromReq(req, 'UPDATE', 'movement', id, `${MOVE_LABEL[row.type] || row.type}: "${row.description}" · ${fmtMoney(row.amount)}`);
  res.json(row);
});

movementsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;

  await req.tenantPrisma!.$transaction(async (tx) => {
    const prev = await tx.movement.findUnique({ where: { id } });
    if (!prev || prev.userId !== userId) throw Object.assign(new Error('Not found'), { code: 'P2025' });
    await revertDeltas(tx, userId, prev);
    await tx.attachment.deleteMany({ where: { userId, entityType: 'MOVEMENT', entityId: id } });
    await tx.movement.delete({ where: { id } });
  });

  void auditFromReq(req, 'DELETE', 'movement', id, 'Movimiento eliminado');
  res.status(204).send();
});

movementsRouter.get('/monthly-summary', async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year || now.getUTCFullYear());
  const month = Number(req.query.month || now.getUTCMonth() + 1);
  const { start, end } = monthRange(year, month);

  const userId = req.tenantUserId!;
  // Misma definición de Ingresos/Gastos que el Dashboard y la tabla de Movimientos:
  //  - Ingreso = INCOME
  //  - Gasto   = EXPENSE + WITHDRAWAL + PURCHASE pagada (no fiada) + comisiones
  const [totals, byCategory, categories] = await Promise.all([
    req.tenantPrisma!.$queryRaw<Array<{ income: number; expense: number }>>(Prisma.sql`
      SELECT
        SUM(CASE WHEN "type" = 'INCOME' THEN "amount" ELSE 0 END)::float8 AS income,
        (SUM(CASE
            WHEN "type" IN ('EXPENSE', 'WITHDRAWAL') THEN "amount"
            WHEN "type" = 'PURCHASE' AND "isCredit" = false THEN "amount"
            ELSE 0 END)
         + COALESCE(SUM("commission"), 0))::float8 AS expense
      FROM "Movement"
      WHERE "userId" = ${userId} AND "movementDate" >= ${start} AND "movementDate" < ${end}
    `),
    req.tenantPrisma!.movement.groupBy({
      by: ['categoryId', 'type'],
      where: { userId, movementDate: { gte: start, lt: end } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } }
    }),
    req.tenantPrisma!.category.findMany({ where: { userId } })
  ]);

  const income = Number(totals[0]?.income || 0);
  const expense = Number(totals[0]?.expense || 0);

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
