import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';

const fmtMoney = (v: unknown) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));

export const accountsRouter = Router();
accountsRouter.use(requireAuth, (req, res, next) => requirePermission('accounts', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const accountSchema = z.object({
  name: z.string().trim().min(2).max(80),
  type: z.enum(['CASH', 'BANK', 'WALLET', 'DEBIT', 'RECEIVABLE']),
  holder: z.string().trim().max(120).optional().nullable(),
  entityId: z.coerce.number().int().positive().optional().nullable(),
  accountKind: z.enum(['SAVINGS', 'CHECKING']).optional().nullable(),
  accountNumber: z.string().trim().max(40).optional().nullable(),
  bankId: z.coerce.number().int().positive().optional().nullable(),
  initialBalance: z.coerce.number().finite().gte(-99_999_999_999.99).lte(99_999_999_999.99).default(0)
}).strict();

// Solo resuelve el nombre del banco (el número de cuenta ahora es propio de la cuenta).
async function resolveBankName(req: any, userId: number, bankId: number | null | undefined) {
  if (!bankId) return null;
  const bank = await req.tenantPrisma!.bank.findFirstOrThrow({
    where: { id: bankId, userId },
    select: { name: true }
  });
  return bank.name;
}

accountsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.account.findMany({
    where: { userId: req.tenantUserId!, isActive: true },
    include: { bank: true, entity: true },
    orderBy: { createdAt: 'asc' }
  });
  res.json(rows);
});

accountsRouter.post('/', async (req, res) => {
  const body = accountSchema.parse(req.body);
  const bankName = await resolveBankName(req, req.tenantUserId!, body.bankId);
  const row = await req.tenantPrisma!.account.create({
    data: {
      userId: req.tenantUserId!,
      name: body.name,
      type: body.type,
      holder: body.holder?.trim() || null,
      entityId: body.entityId ?? null,
      accountKind: body.accountKind ?? null,
      accountNumber: body.accountNumber?.trim() || null,
      bankId: body.bankId ?? null,
      bankName,
      initialBalance: body.initialBalance,
      currentBalance: body.initialBalance
    },
    include: { bank: true }
  });
  void auditFromReq(req, 'CREATE', 'account', row.id, `Cuenta "${row.name}"`);
  res.status(201).json(row);
});

accountsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = accountSchema.partial().parse(req.body);
  const userId = req.tenantUserId!;

  const existing = await req.tenantPrisma!.account.findFirst({ where: { id, userId } });
  if (!existing) return res.status(404).json({ message: 'Cuenta no encontrada' });

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.type !== undefined) data.type = body.type;
  if (body.holder !== undefined) data.holder = body.holder?.trim() || null;
  if (body.entityId !== undefined) data.entityId = body.entityId ?? null;
  if (body.accountKind !== undefined) data.accountKind = body.accountKind ?? null;
  if (body.accountNumber !== undefined) data.accountNumber = body.accountNumber?.trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, 'bankId')) {
    data.bankId = body.bankId ?? null;
    data.bankName = await resolveBankName(req, userId, body.bankId ?? null);
  }
  // Al editar el saldo inicial, ajustamos el saldo actual por la MISMA diferencia,
  // así el cambio se refleja al momento sin perder el efecto de los movimientos.
  if (body.initialBalance !== undefined) {
    const newInitial = Number(body.initialBalance);
    const delta = newInitial - Number(existing.initialBalance);
    data.initialBalance = newInitial;
    data.currentBalance = Number(existing.currentBalance) + delta;
  }

  const row = await req.tenantPrisma!.account.update({
    where: { id, userId },
    data,
    include: { bank: true }
  });
  void auditFromReq(req, 'UPDATE', 'account', id, `Cuenta "${row.name}"`);
  res.json(row);
});

accountsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const force = req.query.force === '1' || req.query.force === 'true';
  const account = await req.tenantPrisma!.account.findFirst({ where: { id, userId } });
  if (!account) return res.status(404).json({ message: 'Cuenta no encontrada' });
  if (!force && Math.abs(Number(account.currentBalance)) > 0.009) {
    return res.status(409).json({
      message: `La cuenta tiene un saldo de ${fmtMoney(account.currentBalance)}. ¿Deseas marcarla inactiva igualmente?`,
      code: 'NONZERO_BALANCE',
      balance: Number(account.currentBalance)
    });
  }
  await req.tenantPrisma!.account.update({ where: { id, userId }, data: { isActive: false } });
  void auditFromReq(req, 'DELETE', 'account', id, `Cuenta "${account.name}" marcada inactiva`);
  res.status(204).send();
});

/**
 * Conciliación: ajusta el saldo de la cuenta al saldo real informado, creando
 * un movimiento ADJUSTMENT que deja rastro de la diferencia.
 */
const reconcileSchema = z.object({
  realBalance: z.coerce.number().finite().gte(-99_999_999_999.99).lte(99_999_999_999.99),
  notes: z.string().trim().max(300).optional().nullable()
}).strict();

accountsRouter.post('/:id/reconcile', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const body = reconcileSchema.parse(req.body);

  const result = await req.tenantPrisma!.$transaction(async (tx) => {
    const account = await tx.account.findFirst({ where: { id, userId } });
    if (!account) throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 });
    const current = Number(account.currentBalance);
    const diff = Number((body.realBalance - current).toFixed(2));
    if (Math.abs(diff) < 0.005) return { account, diff: 0, movement: null };

    await tx.account.update({ where: { id }, data: { currentBalance: body.realBalance } });
    const movement = await tx.movement.create({
      data: {
        userId,
        type: 'ADJUSTMENT',
        amount: Math.abs(diff),
        isCredit: diff > 0, // true = subió el saldo
        movementDate: new Date(),
        description: `Ajuste de saldo "${account.name}"`,
        paymentMethod: 'OTHER',
        accountId: id,
        notes: body.notes ?? `De ${fmtMoney(current)} a ${fmtMoney(body.realBalance)}`
      }
    });
    return { account, diff, movement };
  });

  void auditFromReq(req, 'UPDATE', 'account', id, `Conciliación de "${result.account.name}": ${fmtMoney(result.diff)}`);
  res.json({ ok: true, diff: result.diff, movementId: result.movement?.id ?? null });
});
