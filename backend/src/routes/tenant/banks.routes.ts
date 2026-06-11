import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';

export const banksRouter = Router();
banksRouter.use(requireAuth, (req, res, next) => requirePermission('movements', req.method === 'GET' ? 'read' : 'write')(req, res, next));

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  accountNumber: z.string().trim().max(40).optional().nullable(),
  accountKind: z.enum(['SAVINGS', 'CHECKING']).optional().nullable(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(300).optional().nullable()
}).strict();

banksRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.bank.findMany({
    where: { userId: req.tenantUserId! },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
  });
  res.json(rows);
});

banksRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  const row = await req.tenantPrisma!.bank.create({ data: { ...body, userId: req.tenantUserId! } });
  void auditFromReq(req, 'CREATE', 'bank', row.id, `Banco "${row.name}"`);
  res.status(201).json(row);
});

banksRouter.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = schema.partial().parse(req.body);
  const row = await req.tenantPrisma!.bank.update({ where: { id, userId: req.tenantUserId! }, data: body });
  void auditFromReq(req, 'UPDATE', 'bank', id, `Banco "${row.name}"`);
  res.json(row);
});

banksRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.tenantUserId!;
  const force = req.query.force === '1' || req.query.force === 'true';
  const bank = await req.tenantPrisma!.bank.findFirst({ where: { id, userId } });
  if (!bank) return res.status(404).json({ message: 'Banco no encontrado' });
  const [accounts, cards] = await Promise.all([
    req.tenantPrisma!.account.count({ where: { userId, bankId: id, isActive: true } }),
    req.tenantPrisma!.card.count({ where: { userId, bankId: id, isActive: true } })
  ]);
  if (!force && (accounts > 0 || cards > 0)) {
    return res.status(409).json({
      message: `Este banco está asociado a ${accounts} cuenta(s) y ${cards} tarjeta(s). Si lo eliminas, quedarán sin banco. ¿Continuar?`,
      code: 'BANK_IN_USE',
      accounts, cards
    });
  }
  await req.tenantPrisma!.bank.delete({ where: { id, userId } });
  void auditFromReq(req, 'DELETE', 'bank', id, `Banco "${bank.name}" eliminado`);
  res.status(204).send();
});
