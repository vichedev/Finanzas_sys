import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';

export const budgetsRouter = Router();
budgetsRouter.use(requireAuth, (req, res, next) => requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const schema = z.object({
  categoryId: z.coerce.number().int().positive(),
  amount: z.coerce.number().finite().gt(0).lte(99_999_999_999.99),
  period: z.enum(['MONTHLY']).default('MONTHLY')
}).strict();

function monthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { start, end };
}

/** Lista presupuestos con el gasto del mes en curso y el % consumido. */
budgetsRouter.get('/', async (req, res) => {
  const userId = req.tenantUserId!;
  const now = new Date();
  const year = Number(req.query.year || now.getUTCFullYear());
  const month = Number(req.query.month || now.getUTCMonth() + 1);
  const { start, end } = monthRange(year, month);

  const [budgets, spentByCat] = await Promise.all([
    req.tenantPrisma!.budget.findMany({
      where: { userId, isActive: true },
      include: { category: true },
      orderBy: { createdAt: 'asc' }
    }),
    req.tenantPrisma!.movement.groupBy({
      by: ['categoryId'],
      where: { userId, type: 'EXPENSE', movementDate: { gte: start, lt: end } },
      _sum: { amount: true }
    })
  ]);

  const spentMap = new Map<number, number>();
  for (const r of spentByCat) if (r.categoryId != null) spentMap.set(r.categoryId, Number(r._sum.amount || 0));

  res.json({
    year, month,
    budgets: budgets.map((b) => {
      const limit = Number(b.amount);
      const spent = spentMap.get(b.categoryId) || 0;
      const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
      return {
        id: b.id,
        categoryId: b.categoryId,
        categoryName: b.category?.name || 'Sin categoría',
        categoryColor: b.category?.color || null,
        amount: limit,
        period: b.period,
        spent,
        remaining: Number((limit - spent).toFixed(2)),
        pct
      };
    })
  });
});

budgetsRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const userId = req.tenantUserId!;
  // upsert por (userId, categoryId, period): re-crear actualiza el límite.
  const row = await req.tenantPrisma!.budget.upsert({
    where: { userId_categoryId_period: { userId, categoryId: body.categoryId, period: body.period } },
    create: { userId, categoryId: body.categoryId, amount: body.amount, period: body.period },
    update: { amount: body.amount, isActive: true }
  });
  void auditFromReq(req, 'CREATE', 'budget', row.id, `Presupuesto categoría #${body.categoryId} · límite ${body.amount}`);
  res.status(201).json(row);
});

budgetsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const body = schema.partial().parse(req.body);
  const data: Record<string, unknown> = {};
  if (body.amount !== undefined) data.amount = body.amount;
  if (body.categoryId !== undefined) data.categoryId = body.categoryId;
  const row = await req.tenantPrisma!.budget.update({ where: { id, userId }, data });
  void auditFromReq(req, 'UPDATE', 'budget', id, `Presupuesto actualizado`);
  res.json(row);
});

budgetsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  await req.tenantPrisma!.budget.delete({ where: { id, userId } });
  void auditFromReq(req, 'DELETE', 'budget', id, `Presupuesto eliminado`);
  res.status(204).send();
});
