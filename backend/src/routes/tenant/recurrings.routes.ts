import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';
import { runDueRecurringRules } from '../../lib/recurringRunner';
import type { TenantPrisma } from '../../lib/tenantPrisma';

export const recurringsRouter = Router();
recurringsRouter.use(requireAuth, (req, res, next) => requirePermission('recurrings', req.method === 'GET' ? 'read' : 'write')(req, res, next));

/** Genera los movimientos pendientes de reglas vencidas. Lo llama el frontend al cargar. */
recurringsRouter.post('/run', async (req, res) => {
  const created = await runDueRecurringRules(req.tenantPrisma!, req.tenantUserId!);
  res.json({ created });
});

const schema = z.object({
  name: z.string().min(2),
  type: z.enum(['INCOME', 'EXPENSE']),
  amount: z.coerce.number().positive(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  nextRunDate: z.coerce.date(),
  endDate: z.coerce.date().optional().nullable(),
  paymentMethod: z.enum(['CASH', 'BANK_TRANSFER', 'DEBIT_CARD', 'CREDIT_CARD', 'WALLET', 'OTHER']),
  categoryId: z.coerce.number().optional().nullable(),
  accountId: z.coerce.number().optional().nullable(),
  notes: z.string().optional().nullable()
}).strict();

recurringsRouter.get('/', async (req, res) => {
  // Generación perezosa: al listar, materializa lo vencido (no bloquea si falla).
  await runDueRecurringRules(req.tenantPrisma!, req.tenantUserId!).catch(() => {});
  const rows = await req.tenantPrisma!.recurringRule.findMany({
    where: { userId: req.tenantUserId! },
    include: { category: true },
    orderBy: { nextRunDate: 'asc' }
  });
  res.json(rows);
});

// Verifica que la cuenta (si se envía) pertenezca al usuario.
async function assertAccount(prisma: Pick<TenantPrisma, 'account'>, userId: number, accountId?: number | null) {
  if (accountId == null) return;
  const acc = await prisma.account.findFirst({ where: { id: accountId, userId }, select: { id: true } });
  if (!acc) throw Object.assign(new Error('La cuenta no existe o no es tuya'), { status: 400 });
}

recurringsRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  await assertAccount(req.tenantPrisma!, req.tenantUserId!, body.accountId);
  const row = await req.tenantPrisma!.recurringRule.create({ data: { ...body, userId: req.tenantUserId! } });
  void auditFromReq(req, 'CREATE', 'recurring', row.id, `Recurrente "${row.name}"`);
  res.status(201).json(row);
});

recurringsRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = schema.partial().parse(req.body);
  await assertAccount(req.tenantPrisma!, req.tenantUserId!, body.accountId);
  const row = await req.tenantPrisma!.recurringRule.update({ where: { id, userId: req.tenantUserId! }, data: body });
  void auditFromReq(req, 'UPDATE', 'recurring', id, `Recurrente "${row.name}"`);
  res.json(row);
});

recurringsRouter.put('/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const body = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'FINISHED']) }).strict().parse(req.body);
  const row = await req.tenantPrisma!.recurringRule.update({ where: { id, userId: req.tenantUserId! }, data: body });
  res.json(row);
});

recurringsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.recurringRule.delete({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
