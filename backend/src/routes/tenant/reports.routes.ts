import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { buildMonthlyReportPdf } from '../../lib/reportPdf';
import { buildMonthlyWorkbook } from '../../lib/excelReport';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requirePermission('reports', 'read'));

function monthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { start, end };
}

reportsRouter.get('/monthly.pdf', async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year || now.getUTCFullYear());
  const month = Number(req.query.month || now.getUTCMonth() + 1);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ message: 'Año inválido' });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ message: 'Mes inválido' });
  }

  const userId = req.tenantUserId!;
  const { start, end } = monthRange(year, month);

  const [user, totals, byCategory, categories] = await Promise.all([
    req.tenantPrisma!.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, currency: true }
    }),
    req.tenantPrisma!.movement.groupBy({
      by: ['type'],
      where: { userId, movementDate: { gte: start, lt: end } },
      _sum: { amount: true }
    }),
    req.tenantPrisma!.movement.groupBy({
      by: ['categoryId', 'type'],
      where: { userId, movementDate: { gte: start, lt: end } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } }
    }),
    req.tenantPrisma!.category.findMany({ where: { userId } })
  ]);

  if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

  const income = Number(totals.find((t) => t.type === 'INCOME')?._sum.amount || 0);
  const expense = Number(totals.find((t) => t.type === 'EXPENSE')?._sum.amount || 0);

  const filename = `reporte-${year}-${String(month).padStart(2, '0')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  buildMonthlyReportPdf(
    {
      year,
      month,
      income,
      expense,
      balance: income - expense,
      byCategory: byCategory
        .filter((row) => row.type === 'INCOME' || row.type === 'EXPENSE')
        .map((row) => ({
          type: row.type as 'INCOME' | 'EXPENSE',
          categoryName: categories.find((c) => c.id === row.categoryId)?.name || 'Sin categoría',
          amount: Number(row._sum.amount || 0)
        })),
      user: { name: user.name, email: user.email, currency: user.currency || 'USD' }
    },
    res
  );
});

reportsRouter.get('/monthly.xlsx', async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year || now.getUTCFullYear());
  const month = Number(req.query.month || now.getUTCMonth() + 1);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ message: 'Año inválido' });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ message: 'Mes inválido' });
  }

  // El cliente tenant tiene el mismo shape relevante (user/movement/category) que el global.
  // Se castea a any porque buildMonthlyWorkbook está tipada con el PrismaClient global.
  const buffer = await buildMonthlyWorkbook({
    userId: req.tenantUserId!,
    year,
    month,
    prisma: req.tenantPrisma! as any
  });

  const filename = `reporte-${year}-${String(month).padStart(2, '0')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
});
