import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth, (req, res, next) =>
  requirePermission('invoices', req.method === 'GET' ? 'read' : 'write')(req, res, next)
);

const MONTH_LABEL = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function shiftMonth(year: number, month: number, delta: number) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function utcRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { start, end };
}

const schema = z.object({
  kind: z.enum(['SALE', 'PURCHASE']),
  status: z.enum(['ISSUED', 'PAID', 'VOID']).optional(),
  number: z.string().max(60).optional().nullable(),
  counterparty: z.string().min(1).max(160),
  counterpartyTaxId: z.string().max(20).optional().nullable(),
  issueDate: z.coerce.date(),
  netAmount: z.coerce.number().nonnegative(),
  vatRate: z.coerce.number().min(0).max(100),
  description: z.string().max(200).optional().nullable(),
  accountId: z.coerce.number().optional().nullable(),
  notes: z.string().max(500).optional().nullable()
}).strict();

/** Calcula vatAmount y total a partir del neto y la tarifa (no confiamos en el cliente). */
function computeTotals(netAmount: number, vatRate: number) {
  const vatAmount = round2(netAmount * (vatRate / 100));
  const total = round2(netAmount + vatAmount);
  return { vatAmount, total };
}

invoicesRouter.get('/', async (req, res) => {
  const where: { userId: number; kind?: 'SALE' | 'PURCHASE' } = { userId: req.tenantUserId! };
  const kind = req.query.kind;
  if (kind === 'SALE' || kind === 'PURCHASE') where.kind = kind;

  const rows = await req.tenantPrisma!.invoice.findMany({
    where,
    include: { account: { select: { id: true, name: true } } },
    orderBy: { issueDate: 'desc' }
  });
  res.json(rows);
});

/**
 * Resumen de IVA del período tributario (year/month por fecha de emisión).
 * IVA a pagar = IVA cobrado en ventas − IVA crédito en compras.
 * Se declara y paga el mes siguiente.
 */
invoicesRouter.get('/vat-summary', async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year || now.getUTCFullYear());
  const month = Number(req.query.month || now.getUTCMonth() + 1);
  const { start, end } = utcRange(year, month);

  const grouped = await req.tenantPrisma!.invoice.groupBy({
    by: ['kind'],
    where: {
      userId: req.tenantUserId!,
      status: { not: 'VOID' },
      issueDate: { gte: start, lt: end }
    },
    _sum: { netAmount: true, vatAmount: true, total: true },
    _count: { _all: true }
  });

  const sale = grouped.find((g) => g.kind === 'SALE');
  const purchase = grouped.find((g) => g.kind === 'PURCHASE');

  const salesNet = Number(sale?._sum.netAmount || 0);
  const salesVat = Number(sale?._sum.vatAmount || 0);
  const salesTotal = Number(sale?._sum.total || 0);
  const salesCount = sale?._count._all || 0;

  const purchasesNet = Number(purchase?._sum.netAmount || 0);
  const purchasesVat = Number(purchase?._sum.vatAmount || 0);
  const purchasesTotal = Number(purchase?._sum.total || 0);
  const purchasesCount = purchase?._count._all || 0;

  const netVat = round2(salesVat - purchasesVat); // + a pagar, − crédito a favor
  const pay = shiftMonth(year, month, 1); // se declara el mes siguiente

  res.json({
    period: { year, month, label: `${MONTH_LABEL[month - 1]} ${year}` },
    paymentPeriod: { year: pay.year, month: pay.month, label: `${MONTH_LABEL[pay.month - 1]} ${pay.year}` },
    sales: { net: salesNet, vat: salesVat, total: salesTotal, count: salesCount },
    purchases: { net: purchasesNet, vat: purchasesVat, total: purchasesTotal, count: purchasesCount },
    vatToPay: netVat > 0 ? netVat : 0,
    vatCredit: netVat < 0 ? round2(-netVat) : 0,
    netVat
  });
});

invoicesRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const { vatAmount, total } = computeTotals(body.netAmount, body.vatRate);

  const row = await req.tenantPrisma!.invoice.create({
    data: {
      userId: req.tenantUserId!,
      kind: body.kind,
      status: body.status ?? 'ISSUED',
      number: body.number?.trim() || null,
      counterparty: body.counterparty.trim(),
      counterpartyTaxId: body.counterpartyTaxId?.trim() || null,
      issueDate: body.issueDate,
      netAmount: body.netAmount,
      vatRate: body.vatRate,
      vatAmount,
      total,
      description: body.description?.trim() || null,
      accountId: body.accountId || null,
      notes: body.notes?.trim() || null
    }
  });
  res.status(201).json(row);
});

invoicesRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = schema.partial().parse(req.body);

  const existing = await req.tenantPrisma!.invoice.findUnique({
    where: { id },
    select: { userId: true, netAmount: true, vatRate: true }
  });
  if (!existing || existing.userId !== req.tenantUserId!) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }

  const data: Record<string, unknown> = {};
  if (body.kind !== undefined) data.kind = body.kind;
  if (body.status !== undefined) data.status = body.status;
  if (body.number !== undefined) data.number = body.number?.trim() || null;
  if (body.counterparty !== undefined) data.counterparty = body.counterparty.trim();
  if (body.counterpartyTaxId !== undefined) data.counterpartyTaxId = body.counterpartyTaxId?.trim() || null;
  if (body.issueDate !== undefined) data.issueDate = body.issueDate;
  if (body.description !== undefined) data.description = body.description?.trim() || null;
  if (body.accountId !== undefined) data.accountId = body.accountId || null;
  if (body.notes !== undefined) data.notes = body.notes?.trim() || null;

  // Si cambia el neto o la tarifa, recalculamos IVA y total.
  if (body.netAmount !== undefined || body.vatRate !== undefined) {
    const net = body.netAmount ?? Number(existing.netAmount);
    const rate = body.vatRate ?? Number(existing.vatRate);
    const { vatAmount, total } = computeTotals(net, rate);
    data.netAmount = net;
    data.vatRate = rate;
    data.vatAmount = vatAmount;
    data.total = total;
  }

  const row = await req.tenantPrisma!.invoice.update({ where: { id, userId: req.tenantUserId! }, data });
  res.json(row);
});

invoicesRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await req.tenantPrisma!.invoice.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== req.tenantUserId!) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }
  await req.tenantPrisma!.attachment.deleteMany({ where: { userId: req.tenantUserId!, entityType: 'INVOICE', entityId: id } });
  await req.tenantPrisma!.invoice.delete({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
