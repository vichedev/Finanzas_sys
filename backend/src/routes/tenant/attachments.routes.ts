import { Router } from 'express';
import { z } from 'zod';

// Comprobantes (imagen/PDF) asociados a una entidad (movimiento, factura, deuda).
// Se suben como base64 en JSON (sin multer). auth + tenantContext vienen del montaje.
export const attachmentsRouter = Router();

const ALLOWED = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ENTITY_TYPES = ['MOVEMENT', 'INVOICE', 'DEBT'] as const;

const createSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.coerce.number().int().positive(),
  filename: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1)
}).strict();

attachmentsRouter.get('/', async (req, res) => {
  const entityType = String(req.query.entityType || '');
  const entityId = Number(req.query.entityId || 0);
  if (!(ENTITY_TYPES as readonly string[]).includes(entityType) || !entityId) return res.json([]);
  const rows = await req.tenantPrisma!.attachment.findMany({
    where: { userId: req.tenantUserId!, entityType, entityId },
    select: { id: true, filename: true, mimeType: true, size: true, createdAt: true, entityType: true, entityId: true },
    orderBy: { createdAt: 'asc' }
  });
  res.json(rows);
});

// Todos los comprobantes del usuario, enriquecidos con el registro al que
// pertenecen (para la sección Documentos: búsqueda, filtros, orden cronológico).
attachmentsRouter.get('/all', async (req, res) => {
  const userId = req.tenantUserId!;
  const p = req.tenantPrisma!;
  const atts = await p.attachment.findMany({
    where: { userId },
    select: { id: true, filename: true, mimeType: true, size: true, createdAt: true, entityType: true, entityId: true },
    orderBy: { createdAt: 'desc' }
  });

  const ids = (t: string) => atts.filter((a) => a.entityType === t).map((a) => a.entityId);
  const [movs, invs, debts] = await Promise.all([
    p.movement.findMany({ where: { id: { in: ids('MOVEMENT') } }, select: { id: true, description: true, movementDate: true } }),
    p.invoice.findMany({ where: { id: { in: ids('INVOICE') } }, select: { id: true, number: true, counterparty: true, issueDate: true } }),
    p.debt.findMany({ where: { id: { in: ids('DEBT') } }, select: { id: true, name: true, createdAt: true } })
  ]);
  const movMap = new Map(movs.map((m) => [m.id, m]));
  const invMap = new Map(invs.map((i) => [i.id, i]));
  const debtMap = new Map(debts.map((d) => [d.id, d]));

  const ENTITY_LABEL: Record<string, string> = { MOVEMENT: 'Movimiento', INVOICE: 'Factura', DEBT: 'Deuda' };
  const result = atts.map((a) => {
    let contextLabel = '—';
    let contextDate = a.createdAt as Date;
    let link = '';
    if (a.entityType === 'MOVEMENT') {
      const m = movMap.get(a.entityId);
      contextLabel = m?.description || 'Movimiento eliminado';
      contextDate = (m?.movementDate as Date) || a.createdAt;
      link = '/movements';
    } else if (a.entityType === 'INVOICE') {
      const i = invMap.get(a.entityId);
      contextLabel = i ? (i.number ? `Factura ${i.number}` : i.counterparty) : 'Factura eliminada';
      contextDate = (i?.issueDate as Date) || a.createdAt;
      link = '/invoices';
    } else if (a.entityType === 'DEBT') {
      const d = debtMap.get(a.entityId);
      contextLabel = d?.name || 'Deuda eliminada';
      contextDate = (d?.createdAt as Date) || a.createdAt;
      link = '/debts';
    }
    return { ...a, entityLabel: ENTITY_LABEL[a.entityType] || a.entityType, contextLabel, contextDate, link };
  });
  res.json(result);
});

attachmentsRouter.post('/', async (req, res) => {
  const body = createSchema.parse(req.body);
  if (!ALLOWED.includes(body.mimeType)) {
    return res.status(400).json({ message: 'Tipo no permitido. Solo imágenes (PNG, JPG, WEBP, GIF) o PDF.' });
  }
  const b64 = body.dataBase64.includes(',') ? body.dataBase64.split(',').pop() || '' : body.dataBase64;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return res.status(400).json({ message: 'El archivo está vacío.' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ message: 'Archivo demasiado grande (máximo 8 MB).' });

  const row = await req.tenantPrisma!.attachment.create({
    data: {
      userId: req.tenantUserId!,
      entityType: body.entityType,
      entityId: body.entityId,
      filename: body.filename,
      mimeType: body.mimeType,
      size: buf.length,
      data: buf
    },
    select: { id: true, filename: true, mimeType: true, size: true, createdAt: true, entityType: true, entityId: true }
  });
  res.status(201).json(row);
});

attachmentsRouter.get('/:id/file', async (req, res) => {
  const id = Number(req.params.id);
  const row = await req.tenantPrisma!.attachment.findFirst({ where: { id, userId: req.tenantUserId! } });
  if (!row) return res.status(404).json({ message: 'No encontrado' });
  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
  res.send(Buffer.from(row.data));
});

attachmentsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.attachment.deleteMany({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});
