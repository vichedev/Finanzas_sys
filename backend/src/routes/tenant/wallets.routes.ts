import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import type { TenantPrisma } from '../../lib/tenantPrisma';

// Cliente Prisma del tenant o cliente de transacción (ambos exponen .account / .walletAccount).
type TxClient = Pick<TenantPrisma, 'account' | 'walletAccount' | 'wallet'>;

export const walletsRouter = Router();
walletsRouter.use(requireAuth, (req, res, next) =>
  requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next)
);

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  provider: z.string().trim().max(60).optional().nullable(),
  identifier: z.string().trim().max(120).optional().nullable(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(300).optional().nullable(),
  // Cuentas de banco que respaldan la billetera (N–N). undefined = no tocar; [] = limpiar.
  accountIds: z.array(z.number().int().positive()).optional()
}).strict();

// Devuelve solo los ids de cuentas (del usuario) que existen, sin duplicados.
async function validAccountIds(prisma: TxClient, userId: number, ids: number[]): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await prisma.account.findMany({ where: { id: { in: unique }, userId }, select: { id: true } });
  return rows.map((r) => r.id);
}

// Aplana la billetera para la respuesta: agrega accountIds.
function shape(w: { accountLinks?: { accountId: number }[] } & Record<string, unknown>) {
  const { accountLinks, ...rest } = w;
  return { ...rest, accountIds: (accountLinks ?? []).map((l) => l.accountId) };
}

const withLinks = { accountLinks: { select: { accountId: true } } };

walletsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.wallet.findMany({
    where: { userId: req.tenantUserId! },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    include: withLinks
  });
  res.json(rows.map(shape));
});

walletsRouter.post('/', async (req, res) => {
  const { accountIds, ...data } = schema.parse(req.body);
  const userId = req.tenantUserId!;
  const ids = accountIds ? await validAccountIds(req.tenantPrisma!, userId, accountIds) : [];
  const row = await req.tenantPrisma!.wallet.create({
    data: { ...data, userId, accountLinks: { create: ids.map((accountId) => ({ accountId })) } },
    include: withLinks
  });
  res.status(201).json(shape(row));
});

walletsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { accountIds, ...data } = schema.partial().parse(req.body);
  const userId = req.tenantUserId!;
  const existing = await req.tenantPrisma!.wallet.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== userId) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }
  const row = await req.tenantPrisma!.$transaction(async (tx) => {
    await tx.wallet.update({ where: { id, userId }, data });
    // Sincroniza los enlaces solo si el cliente envió accountIds.
    if (accountIds !== undefined) {
      const ids = await validAccountIds(tx, userId, accountIds);
      await tx.walletAccount.deleteMany({ where: { walletId: id } });
      if (ids.length) await tx.walletAccount.createMany({ data: ids.map((accountId) => ({ walletId: id, accountId })) });
    }
    return tx.wallet.findUniqueOrThrow({ where: { id }, include: withLinks });
  });
  res.json(shape(row));
});

walletsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await req.tenantPrisma!.wallet.findUnique({ where: { id }, select: { userId: true } });
  if (!existing || existing.userId !== req.tenantUserId!) {
    return res.status(404).json({ message: 'Recurso no encontrado' });
  }
  await req.tenantPrisma!.wallet.delete({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
