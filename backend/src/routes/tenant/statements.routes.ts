import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';

// Estados de cuenta bancarios: subir archivos (PDF/imagen) y listarlos cronológicamente.
export const statementsRouter = Router();
statementsRouter.use(requireAuth, (req, res, next) =>
  requirePermission('accounts', req.method === 'GET' ? 'read' : 'write')(req, res, next)
);

const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAX = 12 * 1024 * 1024; // 12 MB

const schema = z.object({
  accountId: z.coerce.number().int().positive().optional().nullable(),
  periodDate: z.coerce.date(),
  title: z.string().trim().min(1).max(160),
  filename: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(100),
  dataBase64: z.string().min(1),
  notes: z.string().trim().max(500).optional().nullable()
}).strict();

// Lista (sin el binario) ordenada cronológicamente (más reciente primero).
statementsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.bankStatement.findMany({
    where: { userId: req.tenantUserId! },
    select: { id: true, accountId: true, periodDate: true, title: true, filename: true, mimeType: true, size: true, notes: true, createdAt: true, account: { select: { id: true, name: true, bankName: true } } },
    orderBy: [{ periodDate: 'desc' }, { createdAt: 'desc' }]
  });
  res.json(rows);
});

// Descarga/visualización del archivo.
statementsRouter.get('/:id/file', async (req, res) => {
  const id = Number(req.params.id);
  const row = await req.tenantPrisma!.bankStatement.findFirst({ where: { id, userId: req.tenantUserId! } });
  if (!row) return res.status(404).json({ message: 'No encontrado' });
  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
  res.send(Buffer.from(row.data));
});

statementsRouter.post('/', async (req, res) => {
  const body = schema.parse(req.body);
  if (!ALLOWED.includes(body.mimeType)) return res.status(400).json({ message: 'Solo PDF o imágenes.' });
  const buffer = Buffer.from(body.dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (buffer.length > MAX) return res.status(400).json({ message: 'El archivo supera 12 MB.' });
  if (body.accountId) {
    const acc = await req.tenantPrisma!.account.findFirst({ where: { id: body.accountId, userId: req.tenantUserId! }, select: { id: true } });
    if (!acc) return res.status(400).json({ message: 'La cuenta no existe o no es tuya.' });
  }
  const row = await req.tenantPrisma!.bankStatement.create({
    data: {
      userId: req.tenantUserId!,
      accountId: body.accountId ?? null,
      periodDate: body.periodDate,
      title: body.title.trim(),
      filename: body.filename.trim(),
      mimeType: body.mimeType,
      size: buffer.length,
      data: buffer,
      notes: body.notes?.trim() || null
    },
    select: { id: true }
  });
  void auditFromReq(req, 'CREATE', 'statement', row.id, `Estado de cuenta "${body.title.trim()}"`);
  res.status(201).json({ id: row.id });
});

statementsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await req.tenantPrisma!.bankStatement.findFirst({ where: { id, userId: req.tenantUserId! }, select: { id: true } });
  if (!existing) return res.status(404).json({ message: 'No encontrado' });
  await req.tenantPrisma!.bankStatement.delete({ where: { id } });
  void auditFromReq(req, 'DELETE', 'statement', id, 'Estado de cuenta eliminado');
  res.status(204).send();
});
