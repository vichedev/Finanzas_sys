import { Router } from 'express';
import { Prisma } from '.prisma/tenant';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { accountBelongsToDebitCard } from '../../lib/debitCard';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requirePermission('reports', 'read'));

const PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#a855f7', '#ef4444', '#94a3b8', '#06b6d4', '#ec4899'];

function utcRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { start, end };
}

function shiftMonth(year: number, month: number, delta: number) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

const MONTH_LABEL = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

dashboardRouter.get('/', async (req, res) => {
  const userId = req.tenantUserId!;
  const now = new Date();
  const year = Number(req.query.year || now.getUTCFullYear());
  const month = Number(req.query.month || now.getUTCMonth() + 1);
  const { start, end } = utcRange(year, month);
  const prev = shiftMonth(year, month, -1);
  const prevRange = utcRange(prev.year, prev.month);

  const monthsBack = 6;
  const seriesStart = (() => {
    const s = shiftMonth(year, month, -(monthsBack - 1));
    return new Date(Date.UTC(s.year, s.month - 1, 1));
  })();

  // Definición unificada de Ingresos/Gastos (igual que la tabla de Movimientos):
  //  - Ingreso  = movimientos INCOME
  //  - Gasto    = EXPENSE + WITHDRAWAL + PURCHASE pagada (no fiada) + comisiones
  //  (TRANSFER, CARD_PAYMENT y ADJUSTMENT se reflejan en los saldos de cuentas/tarjetas, no en estos KPIs)
  const sumExpr = Prisma.sql`
    SUM(CASE WHEN "type" = 'INCOME' THEN "amount" ELSE 0 END)::float8 AS income,
    (SUM(CASE
        WHEN "type" IN ('EXPENSE', 'WITHDRAWAL') THEN "amount"
        WHEN "type" = 'PURCHASE' AND "isCredit" = false THEN "amount"
        ELSE 0 END)
     + COALESCE(SUM("commission"), 0))::float8 AS expense
  `;

  const [
    totals,
    prevTotals,
    seriesRows,
    expenseByCategoryRows,
    categories,
    recentMovements,
    accounts,
    cards,
    debitAccounts,
    debtAggregates,
    debtCounts,
    activeRecurrings
  ] = await Promise.all([
    req.tenantPrisma!.$queryRaw<Array<{ income: number; expense: number }>>(Prisma.sql`
      SELECT ${sumExpr} FROM "Movement"
      WHERE "userId" = ${userId} AND "movementDate" >= ${start} AND "movementDate" < ${end}
    `),
    req.tenantPrisma!.$queryRaw<Array<{ income: number; expense: number }>>(Prisma.sql`
      SELECT ${sumExpr} FROM "Movement"
      WHERE "userId" = ${userId} AND "movementDate" >= ${prevRange.start} AND "movementDate" < ${prevRange.end}
    `),
    req.tenantPrisma!.$queryRaw<Array<{ y: number; m: number; income: number; expense: number }>>(Prisma.sql`
      SELECT EXTRACT(YEAR FROM "movementDate")::int AS y,
             EXTRACT(MONTH FROM "movementDate")::int AS m,
             ${sumExpr}
      FROM "Movement"
      WHERE "userId" = ${userId}
        AND "movementDate" >= ${seriesStart}
        AND "movementDate" < ${end}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `),
    req.tenantPrisma!.$queryRaw<Array<{ categoryId: number | null; amount: number }>>(Prisma.sql`
      SELECT "categoryId", SUM("amount")::float8 AS amount
      FROM "Movement"
      WHERE "userId" = ${userId} AND "movementDate" >= ${start} AND "movementDate" < ${end}
        AND ("type" = 'EXPENSE' OR ("type" = 'PURCHASE' AND "isCredit" = false))
      GROUP BY "categoryId"
      ORDER BY amount DESC
    `),
    req.tenantPrisma!.category.findMany({ where: { userId } }),
    req.tenantPrisma!.movement.findMany({
      where: { userId, movementDate: { gte: start, lt: end } },
      include: { category: true, account: true, card: true },
      orderBy: { movementDate: 'desc' },
      take: 5
    }),
    req.tenantPrisma!.account.findMany({
      where: { userId, isActive: true },
      orderBy: { name: 'asc' }
    }),
    req.tenantPrisma!.card.findMany({
      where: { userId, isActive: true },
      orderBy: { name: 'asc' }
    }),
    // Cuentas activas: para derivar el saldo de las tarjetas de débito (banco+titular).
    req.tenantPrisma!.account.findMany({ where: { userId, isActive: true }, select: { bankId: true, name: true, currentBalance: true } }),
    req.tenantPrisma!.debt.groupBy({
      by: ['kind'],
      where: { userId, status: { in: ['OPEN', 'PARTIAL'] } },
      _sum: { balance: true },
      _count: { _all: true }
    }),
    req.tenantPrisma!.debt.count({ where: { userId, status: { in: ['OPEN', 'PARTIAL'] } } }),
    req.tenantPrisma!.recurringRule.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { amount: true, frequency: true, type: true }
    })
  ]);

  const income = Number(totals[0]?.income || 0);
  const expense = Number(totals[0]?.expense || 0);
  const prevIncome = Number(prevTotals[0]?.income || 0);
  const prevExpense = Number(prevTotals[0]?.expense || 0);
  const balance = income - expense;
  const prevBalance = prevIncome - prevExpense;

  const monthlySeries = (() => {
    const buckets: Array<{ key: string; label: string; income: number; expense: number; year: number; month: number }> = [];
    for (let i = monthsBack - 1; i >= 0; i--) {
      const ref = shiftMonth(year, month, -i);
      buckets.push({
        key: `${ref.year}-${ref.month}`,
        label: `${MONTH_LABEL[ref.month - 1]} ${ref.year}`,
        income: 0,
        expense: 0,
        year: ref.year,
        month: ref.month
      });
    }
    for (const row of seriesRows) {
      const bucket = buckets.find((b) => b.year === row.y && b.month === row.m);
      if (!bucket) continue;
      bucket.income = Number(row.income || 0);
      bucket.expense = Number(row.expense || 0);
    }
    return buckets.map(({ year: _y, month: _m, ...rest }) => rest);
  })();

  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const expenseByCategory = expenseByCategoryRows.map((row, idx) => {
    const cat = row.categoryId ? categoryMap.get(row.categoryId) : null;
    return {
      categoryId: row.categoryId,
      name: cat?.name || 'Sin categoría',
      color: cat?.color || PALETTE[idx % PALETTE.length],
      amount: Number(row.amount || 0)
    };
  });

  const debts = {
    payable: { total: 0, count: 0 },
    receivable: { total: 0, count: 0 },
    loan: { total: 0, count: 0 },
    activeCount: debtCounts,
    activeTotal: 0
  };
  for (const row of debtAggregates) {
    const total = Number(row._sum.balance || 0);
    const count = row._count._all;
    debts.activeTotal += total;
    if (row.kind === 'PAYABLE') debts.payable = { total, count };
    if (row.kind === 'RECEIVABLE') debts.receivable = { total, count };
    if (row.kind === 'LOAN') debts.loan = { total, count };
  }

  const recurringMonthly = activeRecurrings.reduce((sum, rule) => {
    const amount = Number(rule.amount || 0);
    let monthly = 0;
    if (rule.frequency === 'MONTHLY') monthly = amount;
    else if (rule.frequency === 'YEARLY') monthly = amount / 12;
    else if (rule.frequency === 'WEEKLY') monthly = amount * 4.33;
    else if (rule.frequency === 'DAILY') monthly = amount * 30;
    return rule.type === 'EXPENSE' ? sum + monthly : sum;
  }, 0);

  res.json({
    period: { year, month, label: `${MONTH_LABEL[month - 1]} ${year}` },
    kpis: {
      income,
      expense,
      balance,
      prevIncome,
      prevExpense,
      prevBalance,
      debtTotal: debts.activeTotal,
      debtCount: debts.activeCount
    },
    monthlySeries,
    expenseByCategory,
    recentMovements: recentMovements.map((m) => ({
      id: m.id,
      date: m.movementDate,
      description: m.description,
      type: m.type,
      paymentMethod: m.paymentMethod,
      isCredit: m.isCredit,
      amount: Number(m.amount),
      category: m.category ? { id: m.category.id, name: m.category.name, color: m.category.color } : null,
      account: m.account ? { id: m.account.id, name: m.account.name, type: m.account.type } : null,
      card: m.card ? { id: m.card.id, name: m.card.name, type: m.card.type } : null
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      bankName: a.bankName,
      currentBalance: Number(a.currentBalance)
    })),
    cards: cards.map((c) => {
      // Débito: saldo = suma de las cuentas del mismo banco y titular. Resto: valor guardado.
      const balance = c.type === 'DEBIT'
        ? debitAccounts
            .filter((a) => accountBelongsToDebitCard(c, a))
            .reduce((sum, a) => sum + Number(a.currentBalance ?? 0), 0)
        : Number(c.currentBalance);
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        bankName: c.bankName,
        last4: c.last4,
        creditLimit: c.creditLimit ? Number(c.creditLimit) : null,
        currentBalance: balance,
        cutoffDay: c.cutoffDay,
        paymentDueDay: c.paymentDueDay,
        available: c.creditLimit ? Number(c.creditLimit) - balance : null
      };
    }),
    debts,
    recurring: {
      monthlyEstimated: recurringMonthly,
      activeCount: activeRecurrings.length
    }
  });
});
