import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';
import { createNotification } from '../../lib/notifications';

const fmtMoney = (v: unknown) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));

export const cardsRouter = Router();
cardsRouter.use(requireAuth, (req, res, next) => requirePermission('cards', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const cardSchema = z.object({
  name: z.string().trim().min(2).max(80),
  type: z.enum(['CREDIT', 'DEBIT']),
  bankId: z.coerce.number().int().positive().optional().nullable(),
  bankName: z.string().trim().max(80).optional().nullable(),
  last4: z.string().trim().max(4).optional().nullable(),
  creditLimit: z.coerce.number().finite().gte(0).lte(99_999_999_999.99).optional().nullable(),
  cutoffDay: z.coerce.number().int().min(1).max(31).optional().nullable(),
  paymentDueDay: z.coerce.number().int().min(1).max(31).optional().nullable(),
  currentBalance: z.coerce.number().finite().gte(-99_999_999_999.99).lte(99_999_999_999.99).default(0)
}).strict();

/** Resuelve el nombre del banco a partir del bankId (denormalizado para mostrar). */
async function resolveBankName(prisma: any, userId: number, bankId?: number | null): Promise<string | null> {
  if (!bankId) return null;
  const bank = await prisma.bank.findFirst({ where: { id: bankId, userId }, select: { name: true } });
  return bank?.name ?? null;
}

cardsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.card.findMany({
    where: { userId: req.tenantUserId!, isActive: true },
    include: { bank: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' }
  });
  res.json(rows);
});

cardsRouter.post('/', async (req, res) => {
  const body = cardSchema.parse(req.body);
  const userId = req.tenantUserId!;
  const bankName = body.bankId ? await resolveBankName(req.tenantPrisma!, userId, body.bankId) : (body.bankName ?? null);
  const row = await req.tenantPrisma!.card.create({ data: { ...body, bankName, userId } });
  void auditFromReq(req, 'CREATE', 'card', row.id, `Tarjeta "${row.name}"`);
  res.status(201).json(row);
});

cardsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const body = cardSchema.partial().parse(raw);
  // Solo actualiza los campos realmente enviados (evita que el default(0) pise el saldo).
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  const data: Record<string, unknown> = {};
  if (has('name')) data.name = body.name;
  if (has('type')) data.type = body.type;
  if (has('last4')) data.last4 = body.last4 ?? null;
  if (has('creditLimit')) data.creditLimit = body.creditLimit ?? null;
  if (has('cutoffDay')) data.cutoffDay = body.cutoffDay ?? null;
  if (has('paymentDueDay')) data.paymentDueDay = body.paymentDueDay ?? null;
  // El saldo SÍ es editable (saldo de débito / saldo usado de crédito).
  if (has('currentBalance')) data.currentBalance = body.currentBalance ?? 0;
  if (has('bankId')) {
    data.bankId = body.bankId ?? null;
    data.bankName = body.bankId ? await resolveBankName(req.tenantPrisma!, userId, body.bankId) : null;
  }
  const row = await req.tenantPrisma!.card.update({ where: { id, userId }, data });
  void auditFromReq(req, 'UPDATE', 'card', id, `Tarjeta "${row.name}"`);
  res.json(row);
});

cardsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const force = req.query.force === '1' || req.query.force === 'true';
  const card = await req.tenantPrisma!.card.findFirst({ where: { id, userId } });
  if (!card) return res.status(404).json({ message: 'Tarjeta no encontrada' });
  if (!force && card.type === 'CREDIT' && Math.abs(Number(card.currentBalance)) > 0.009) {
    return res.status(409).json({
      message: `La tarjeta tiene un saldo usado de ${fmtMoney(card.currentBalance)}. ¿Deseas marcarla inactiva igualmente?`,
      code: 'NONZERO_BALANCE',
      balance: Number(card.currentBalance)
    });
  }
  await req.tenantPrisma!.card.update({ where: { id, userId }, data: { isActive: false } });
  void auditFromReq(req, 'DELETE', 'card', id, `Tarjeta "${card.name}" marcada inactiva`);
  res.status(204).send();
});

/**
 * Pago de tarjeta de crédito: sale dinero de una cuenta y baja el saldo usado de la tarjeta.
 * Registra un movimiento CARD_PAYMENT (no cuenta como gasto en el resumen ingreso/gasto).
 */
const paySchema = z.object({
  accountId: z.coerce.number().int().positive(),
  amount: z.coerce.number().finite().gt(0).lte(99_999_999_999.99),
  movementDate: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional().nullable()
}).strict();

cardsRouter.post('/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const body = paySchema.parse(req.body);
  const amt = Number(body.amount);

  const result = await req.tenantPrisma!.$transaction(async (tx) => {
    const card = await tx.card.findFirst({ where: { id, userId } });
    if (!card) throw Object.assign(new Error('Tarjeta no encontrada'), { status: 404 });
    if (card.type !== 'CREDIT') throw Object.assign(new Error('Solo aplica a tarjetas de crédito'), { status: 400 });
    const account = await tx.account.findFirst({ where: { id: body.accountId, userId } });
    if (!account) throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 });

    await tx.account.update({ where: { id: account.id }, data: { currentBalance: { decrement: amt } } });
    await tx.card.update({ where: { id: card.id }, data: { currentBalance: { decrement: amt } } });
    const movement = await tx.movement.create({
      data: {
        userId,
        type: 'CARD_PAYMENT',
        amount: amt,
        movementDate: body.movementDate ?? new Date(),
        description: `Pago de tarjeta "${card.name}"`,
        paymentMethod: 'BANK_TRANSFER',
        accountId: account.id,
        cardId: card.id,
        notes: body.notes ?? null
      }
    });
    return { movement, cardName: card.name, accountName: account.name };
  });

  void auditFromReq(req, 'CREATE', 'movement', result.movement.id, `Pago de tarjeta "${result.cardName}" desde "${result.accountName}" · ${fmtMoney(amt)}`);
  void createNotification(req.tenantPrisma!, {
    userId, type: 'MOVEMENT_CREATED',
    title: 'Pago de tarjeta',
    body: `Pagaste ${fmtMoney(amt)} de "${result.cardName}" desde "${result.accountName}"`,
    link: '/cards', email: true
  }).catch(() => { /* logueado dentro */ });

  res.status(201).json(result.movement);
});
