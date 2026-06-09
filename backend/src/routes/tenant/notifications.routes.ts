import { Router } from 'express';
import { z } from 'zod';
import { runReminderScan } from '../../lib/reminders';

// Notificaciones del usuario del tenant. No requiere permisos de módulo:
// cada usuario ve y gestiona SUS notificaciones. auth + tenantContext vienen
// del montaje (tenantScope) en index.ts.
export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const rows = await req.tenantPrisma!.notification.findMany({
    where: { userId: req.tenantUserId! },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  res.json(rows);
});

notificationsRouter.get('/unread-count', async (req, res) => {
  const count = await req.tenantPrisma!.notification.count({
    where: { userId: req.tenantUserId!, isRead: false }
  });
  res.json({ count });
});

notificationsRouter.get('/prefs', async (req, res) => {
  const user = await req.tenantPrisma!.user.findUnique({
    where: { id: req.tenantUserId! },
    select: { emailNotifications: true }
  });
  res.json({ emailNotifications: user?.emailNotifications ?? true });
});

notificationsRouter.put('/prefs', async (req, res) => {
  const body = z.object({ emailNotifications: z.boolean() }).strict().parse(req.body);
  await req.tenantPrisma!.user.update({
    where: { id: req.tenantUserId! },
    data: { emailNotifications: body.emailNotifications }
  });
  res.json({ emailNotifications: body.emailNotifications });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.notification.updateMany({
    where: { id, userId: req.tenantUserId! },
    data: { isRead: true }
  });
  res.json({ ok: true });
});

notificationsRouter.post('/read-all', async (req, res) => {
  await req.tenantPrisma!.notification.updateMany({
    where: { userId: req.tenantUserId!, isRead: false },
    data: { isRead: true }
  });
  res.json({ ok: true });
});

notificationsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await req.tenantPrisma!.notification.deleteMany({ where: { id, userId: req.tenantUserId! } });
  res.status(204).send();
});

// Dispara manualmente el escaneo de recordatorios (vencimientos, IVA).
// Útil para probar sin esperar al scheduler. Es global pero idempotente (dedupe).
notificationsRouter.post('/scan', async (_req, res) => {
  await runReminderScan();
  res.json({ ok: true });
});
