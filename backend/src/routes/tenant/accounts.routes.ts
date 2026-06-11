import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import type { Prisma } from '.prisma/tenant';

export const accountsRouter = Router();
accountsRouter.use(requireAuth, (req, res, next) => requirePermission('accounts', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const accountSchema = z.object({
  name: z.string().trim().min(2).max(80),
  type: z.enum(['CASH', 'BANK', 'WALLET', 'DEBIT', 'RECEIVABLE']),
  holder: z.string().trim().max(120).optional().nullable(),
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
    include: { bank: true },
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
      accountKind: body.accountKind ?? null,
      accountNumber: body.accountNumber?.trim() || null,
      bankId: body.bankId ?? null,
      bankName,
      initialBalance: body.initialBalance,
      currentBalance: body.initialBalance
    },
    include: { bank: true }
  });
  res.status(201).json(row);
});

accountsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = accountSchema.partial().parse(req.body);
  const userId = req.tenantUserId!;

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.type !== undefined) data.type = body.type;
  if (body.holder !== undefined) data.holder = body.holder?.trim() || null;
  if (body.accountKind !== undefined) data.accountKind = body.accountKind ?? null;
  if (body.accountNumber !== undefined) data.accountNumber = body.accountNumber?.trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, 'bankId')) {
    data.bankId = body.bankId ?? null;
    data.bankName = await resolveBankName(req, userId, body.bankId ?? null);
  }

  const row = await req.tenantPrisma!.account.update({
    where: { id, userId },
    data,
    include: { bank: true }
  });
  res.json(row);
});

accountsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.account.update({
    where: { id, userId: req.tenantUserId! },
    data: { isActive: false }
  });
  res.status(204).send();
});
