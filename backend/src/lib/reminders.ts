import { globalPrisma } from './globalPrisma';
import { getTenantPrisma, type TenantPrisma } from './tenantPrisma';
import { createNotification } from './notifications';
import { logger } from './logger';

const MONTH_LABEL = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DAYS_AHEAD = 3;

const money = (v: unknown) =>
  new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const fmtDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;

async function scanTenant(prisma: TenantPrisma) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const soon = new Date(today);
  soon.setUTCDate(soon.getUTCDate() + DAYS_AHEAD);

  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });

  for (const u of users) {
    const userId = u.id;

    // 1) Deudas por vencer
    const debts = await prisma.debt.findMany({
      where: { userId, status: { in: ['OPEN', 'PARTIAL'] }, dueDate: { gte: today, lte: soon } }
    });
    for (const d of debts) {
      if (!d.dueDate) continue;
      await createNotification(prisma, {
        userId, type: 'PAYMENT_DUE',
        title: 'Pago por vencer',
        body: `"${d.name}" vence el ${fmtDate(d.dueDate)} · saldo ${money(d.balance)}`,
        link: '/debts',
        dedupeKey: `debt-due:${d.id}:${ymd(d.dueDate)}`,
        email: true
      });
    }

    // 2) Compras fiadas por pagar
    const purchases = await prisma.movement.findMany({
      where: { userId, type: 'PURCHASE', isCredit: true, dueDate: { gte: today, lte: soon } }
    });
    for (const m of purchases) {
      if (!m.dueDate) continue;
      await createNotification(prisma, {
        userId, type: 'PAYMENT_DUE',
        title: 'Compra fiada por pagar',
        body: `"${m.description}" se paga el ${fmtDate(m.dueDate)} · ${money(m.amount)}`,
        link: '/movements',
        dedupeKey: `purchase-due:${m.id}:${ymd(m.dueDate)}`,
        email: true
      });
    }

    // 3) Pagos recurrentes próximos
    const recs = await prisma.recurringRule.findMany({
      where: { userId, status: 'ACTIVE', nextRunDate: { gte: today, lte: soon } }
    });
    for (const r of recs) {
      await createNotification(prisma, {
        userId, type: 'PAYMENT_DUE',
        title: 'Pago recurrente próximo',
        body: `"${r.name}" se ejecuta el ${fmtDate(r.nextRunDate)} · ${money(r.amount)}`,
        link: '/recurrings',
        dedupeKey: `recurring-due:${r.id}:${ymd(r.nextRunDate)}`,
        email: true
      });
    }

    // 4) IVA por pagar (primeros 5 días del mes, sobre el mes anterior)
    if (now.getUTCDate() <= 5) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const grouped = await prisma.invoice.groupBy({
        by: ['kind'],
        where: { userId, status: { not: 'VOID' }, issueDate: { gte: start, lt: end } },
        _sum: { vatAmount: true }
      });
      const salesVat = Number(grouped.find((g) => g.kind === 'SALE')?._sum.vatAmount || 0);
      const purchVat = Number(grouped.find((g) => g.kind === 'PURCHASE')?._sum.vatAmount || 0);
      const toPay = salesVat - purchVat;
      if (toPay > 0) {
        const label = `${MONTH_LABEL[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
        await createNotification(prisma, {
          userId, type: 'VAT_DUE',
          title: 'IVA por pagar',
          body: `IVA a declarar de ${label}: ${money(toPay)}`,
          link: '/invoices',
          dedupeKey: `vat-due:${start.getUTCFullYear()}-${start.getUTCMonth() + 1}`,
          email: true
        });
      }
    }
  }
}

/** Recorre todos los tenants activos y genera recordatorios. Defensivo por tenant. */
export async function runReminderScan(): Promise<void> {
  try {
    const conns = await globalPrisma.tenantConnection.findMany({
      include: { tenant: { select: { status: true, slug: true } } }
    });
    for (const conn of conns) {
      if (conn.tenant.status !== 'ACTIVE') continue;
      try {
        const prisma = await getTenantPrisma(conn.tenantId);
        await scanTenant(prisma);
      } catch (err) {
        logger.error({ err, tenant: conn.tenant.slug }, 'reminder scan failed for tenant');
      }
    }
    logger.info('reminder scan completed');
  } catch (err) {
    logger.error({ err }, 'reminder scan failed');
  }
}
