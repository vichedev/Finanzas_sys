import type { TenantPrisma } from './tenantPrisma';
import { sendMail, isMailerConfigured, getPublicUrl } from './mailer';
import { logger } from './logger';

export interface CreateNotificationInput {
  userId: number;
  type: 'MOVEMENT_CREATED' | 'PAYMENT_DUE' | 'VAT_DUE' | 'LOW_BALANCE' | string;
  title: string;
  body: string;
  link?: string | null;
  /** Si se pasa, evita crear/enviar la misma notificación dos veces. */
  dedupeKey?: string | null;
  /** Intenta enviar correo (sujeto a la preferencia del usuario y a tener SMTP). */
  email?: boolean;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function notificationEmailHtml(p: { name: string; title: string; body: string; link: string }): string {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 540px; margin: 0 auto; color: #0f172a">
      <div style="background:#4f46e5; color:#fff; padding:18px 22px; border-radius:12px 12px 0 0">
        <strong style="font-size:16px">🔔 ${escapeHtml(p.title)}</strong>
      </div>
      <div style="border:1px solid #e2e8f0; border-top:none; padding:20px 22px; border-radius:0 0 12px 12px">
        <p style="margin:0 0 8px">Hola ${escapeHtml(p.name)},</p>
        <p style="margin:0 0 18px; color:#334155">${escapeHtml(p.body)}</p>
        <a href="${escapeHtml(p.link)}" style="display:inline-block; background:#4f46e5; color:#fff; text-decoration:none; padding:10px 18px; border-radius:8px; font-weight:600">Abrir en Finanzas</a>
        <p style="color:#94a3b8; font-size:12px; margin-top:20px">Puedes desactivar estos correos desde el ícono de la campana en el sistema.</p>
      </div>
    </div>`;
}

/**
 * Crea una notificación in-app y, opcionalmente, envía un correo.
 * Es defensiva: cualquier error se loguea y no interrumpe el flujo que la invoca.
 * Devuelve la notificación creada, o null si se omitió (duplicada) o falló.
 */
export async function createNotification(prisma: TenantPrisma, input: CreateNotificationInput) {
  try {
    if (input.dedupeKey) {
      const existing = await prisma.notification.findFirst({
        where: { userId: input.userId, dedupeKey: input.dedupeKey },
        select: { id: true }
      });
      if (existing) return null;
    }

    const notif = await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        dedupeKey: input.dedupeKey ?? null
      }
    });

    if (input.email) {
      const user = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { email: true, name: true, emailNotifications: true }
      });
      if (user?.email && user.emailNotifications && (await isMailerConfigured())) {
        const base = (await getPublicUrl()).replace(/\/$/, '');
        const link = input.link ? `${base}${input.link}` : base;
        const res = await sendMail({
          to: user.email,
          subject: `🔔 ${input.title}`,
          html: notificationEmailHtml({ name: user.name, title: input.title, body: input.body, link })
        });
        if (res.ok) {
          await prisma.notification.update({ where: { id: notif.id }, data: { emailSent: true } });
        }
      }
    }

    return notif;
  } catch (err) {
    logger.error({ err }, 'createNotification failed');
    return null;
  }
}
