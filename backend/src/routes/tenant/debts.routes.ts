import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';
import { accountBelongsToDebitCard } from '../../lib/debitCard';
import type { TenantPrisma } from '../../lib/tenantPrisma';

export const debtsRouter = Router();
debtsRouter.use(requireAuth, (req, res, next) => requirePermission('debts', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const fmtMoney = (v: unknown) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));

// Verifica que la cuenta (si se envía) pertenezca al usuario.
async function assertAccount(prisma: Pick<TenantPrisma, 'account'>, userId: number, accountId?: number | null) {
  if (accountId == null) return;
  const acc = await prisma.account.findFirst({ where: { id: accountId, userId }, select: { id: true } });
  if (!acc) throw Object.assign(new Error('La cuenta no existe o no es tuya'), { status: 400 });
}

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
  cutoffDay: z.coerce.number().int().min(1).max(31).optional().nullable(),
  paymentDay: z.coerce.number().int().min(1).max(31).optional().nullable(),
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
  await assertAccount(req.tenantPrisma!, req.tenantUserId!, body.accountId);
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
  void auditFromReq(req, 'CREATE', 'debt', row.id, `Deuda "${row.name}"`);
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

  await assertAccount(req.tenantPrisma!, req.tenantUserId!, body.accountId);

  const data: Record<string, unknown> = { ...body };
  delete data.kind;

  const row = await req.tenantPrisma!.debt.update({
    where: { id, userId: req.tenantUserId! },
    data
  });
  void auditFromReq(req, 'UPDATE', 'debt', id, `Deuda "${row.name}"`);
  res.json(row);
});

// Registra un abono/pago a la deuda: descuenta el saldo, mueve la cuenta de origen
// y genera un movimiento de GASTO (salida de dinero) ligado a la deuda.
const paySchema = z.object({
  amount: z.coerce.number().finite().gt(0).lte(99_999_999_999.99),
  accountId: z.coerce.number().int().positive().optional().nullable(),
  cardId: z.coerce.number().int().positive().optional().nullable(),
  movementDate: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional().nullable()
}).strict();

debtsRouter.post('/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const body = paySchema.parse(req.body);

  const result = await req.tenantPrisma!.$transaction(async (tx) => {
    const debt = await tx.debt.findFirst({ where: { id, userId } });
    if (!debt) throw Object.assign(new Error('Deuda no encontrada'), { status: 404 });
    const balance = Number(debt.balance);
    if (balance <= 0) throw Object.assign(new Error('Esta deuda no tiene saldo pendiente.'), { status: 400 });
    const pay = Math.min(Number(body.amount), balance); // no se paga más de lo que se debe

    // Origen del pago: una tarjeta o una cuenta. Si se envían ambos, la tarjeta manda.
    let account = null as { id: number; name: string; bankId?: number | null } | null;
    let card = null as { id: number; name: string; type: string } | null;
    if (body.cardId) {
      const found = await tx.card.findFirst({
        where: { id: body.cardId, userId },
        select: { id: true, name: true, type: true, bankId: true }
      });
      if (!found) throw Object.assign(new Error('Tarjeta no encontrada'), { status: 400 });
      card = { id: found.id, name: found.name, type: found.type };
      if (found.type === 'CREDIT') {
        // Crédito: el gasto incrementa el saldo usado (la deuda con el banco).
        await tx.card.update({ where: { id: found.id }, data: { currentBalance: { increment: pay } } });
      } else {
        // Débito: la tarjeta no guarda saldo; el dinero sale de una cuenta suya
        // (mismo banco y titular). Si solo hay una, se toma esa.
        let accId = body.accountId ?? null;
        if (!accId) {
          const bankAccounts = await tx.account.findMany({
            where: { userId, isActive: true, bankId: found.bankId ?? -1 },
            select: { id: true, bankId: true, name: true }
          });
          const matches = bankAccounts.filter((a) => accountBelongsToDebitCard(found, a));
          if (matches.length === 1) accId = matches[0].id;
        }
        if (!accId) {
          throw Object.assign(
            new Error(`Elige la cuenta de la que sale el pago: la tarjeta de débito "${found.name}" cubre varias cuentas.`),
            { status: 400 }
          );
        }
        account = await tx.account.findFirst({ where: { id: accId, userId }, select: { id: true, name: true, bankId: true } });
        if (!account) throw Object.assign(new Error('Cuenta no encontrada'), { status: 400 });
        if (!accountBelongsToDebitCard(found, account)) {
          throw Object.assign(new Error('La cuenta elegida no pertenece a esa tarjeta (debe ser del mismo banco y titular).'), { status: 400 });
        }
        await tx.account.update({ where: { id: account.id }, data: { currentBalance: { decrement: pay } } });
      }
    } else if (body.accountId) {
      account = await tx.account.findFirst({ where: { id: body.accountId, userId }, select: { id: true, name: true } });
      if (!account) throw Object.assign(new Error('Cuenta no encontrada'), { status: 400 });
      await tx.account.update({ where: { id: account.id }, data: { currentBalance: { decrement: pay } } });
    }

    const newBalance = balance - pay;
    await tx.debt.update({
      where: { id, userId },
      data: { balance: newBalance, status: newBalance <= 0 ? 'PAID' : 'PARTIAL' }
    });

    const movement = await tx.movement.create({
      data: {
        userId,
        type: 'EXPENSE',
        amount: pay,
        movementDate: body.movementDate ?? new Date(),
        description: `Pago de deuda "${debt.name}"`,
        paymentMethod: card ? (card.type === 'CREDIT' ? 'CREDIT_CARD' : 'DEBIT_CARD') : 'BANK_TRANSFER',
        accountId: account?.id ?? null,
        cardId: card?.id ?? null,
        debtId: debt.id,
        notes: body.notes ?? null
      }
    });
    return { debt, movement, pay, accountName: account?.name ?? card?.name ?? null };
  });

  void auditFromReq(req, 'UPDATE', 'debt', id, `Abono a deuda "${result.debt.name}" · ${fmtMoney(result.pay)}`);
  res.status(201).json({ debtId: id, movementId: result.movement.id, paid: result.pay });
});

debtsRouter.put('/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const body = z.object({ status: z.enum(['OPEN', 'PARTIAL', 'PAID', 'CANCELED']) }).strict().parse(req.body);
  const existing = await req.tenantPrisma!.debt.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== req.tenantUserId!) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }
  // Una deuda marcada PAGADA debe quedar con balance 0 (coherencia).
  const data: Record<string, unknown> = { status: body.status };
  if (body.status === 'PAID') data.balance = 0;
  const row = await req.tenantPrisma!.debt.update({ where: { id, userId: req.tenantUserId! }, data });
  void auditFromReq(req, 'UPDATE', 'debt', id, `Deuda "${row.name}" → ${body.status}`);
  res.json(row);
});

debtsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await req.tenantPrisma!.debt.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== req.tenantUserId!) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }
  await req.tenantPrisma!.debt.delete({ where: { id, userId: req.tenantUserId! } });
  void auditFromReq(req, 'DELETE', 'debt', id, 'Deuda eliminada');
  res.status(204).send();
});
