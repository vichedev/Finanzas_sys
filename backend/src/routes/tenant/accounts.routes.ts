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
  bankId: z.coerce.number().int().positive().optional().nullable(),
  initialBalance: z.coerce.number().finite().gte(-99_999_999_999.99).lte(99_999_999_999.99).default(0)
}).strict();

async function resolveBankMeta(req: any, userId: number, bankId: number | null | undefined) {
  if (!bankId) return { bankId: null, bankName: null, accountNumber: null };
  const bank = await req.tenantPrisma!.bank.findFirstOrThrow({
    where: { id: bankId, userId },
    select: { id: true, name: true, accountNumber: true }
  });
  return { bankId: bank.id, bankName: bank.name, accountNumber: bank.accountNumber ?? null };
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
  const meta = await resolveBankMeta(req, req.tenantUserId!, body.bankId);
  const row = await req.tenantPrisma!.account.create({
    data: {
      userId: req.tenantUserId!,
      name: body.name,
      type: body.type,
      bankId: meta.bankId,
      bankName: meta.bankName,
      accountNumber: meta.accountNumber,
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
  if (Object.prototype.hasOwnProperty.call(body, 'bankId')) {
    const meta = await resolveBankMeta(req, userId, body.bankId ?? null);
    data.bankId = meta.bankId;
    data.bankName = meta.bankName;
    data.accountNumber = meta.accountNumber;
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
