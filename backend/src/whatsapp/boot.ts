// Arranque del bot de WhatsApp: registra el handler y reconecta el socket del
// primer tenant que tenga el bot habilitado (socket único, un solo usuario).
import { logger } from '../lib/logger';
import { globalPrisma } from '../lib/globalPrisma';
import { getTenantPrisma } from '../lib/tenantPrisma';
import { setIncomingHandler, connect } from './gateway';
import { handleIncoming } from './pipeline';

export async function bootWhatsapp(): Promise<void> {
  setIncomingHandler(handleIncoming);
  try {
    const conns = await globalPrisma.tenantConnection.findMany({
      include: { tenant: { select: { status: true, slug: true } } }
    });
    for (const conn of conns) {
      if (conn.tenant.status !== 'ACTIVE') continue;
      try {
        const prisma = await getTenantPrisma(conn.tenantId);
        const cfg = await prisma.whatsappConfig.findUnique({ where: { id: 1 } });
        if (cfg?.enabled) {
          logger.info({ tenant: conn.tenant.slug }, 'wa: reconectando bot habilitado');
          await connect(conn.tenantId, cfg.userId ?? null);
          break; // socket único: solo el primero habilitado
        }
      } catch (e: any) {
        // Si la tabla WhatsappConfig aún no existe en ese tenant, se ignora.
        logger.warn({ tenant: conn.tenant.slug, e: e?.message }, 'wa: no se pudo revisar config del tenant');
      }
    }
  } catch (e: any) {
    logger.error({ e: e?.message }, 'wa: boot scan falló');
  }
}
