// =====================================================
// Avisos proactivos de gasto por WhatsApp. Periódicamente revisa las finanzas
// del usuario vinculado y, si hay algo relevante, le envía un mensaje coach.
// Se apoya en lastCoachAt (WhatsappConfig) para no spamear (~una vez al día).
// =====================================================
import { logger } from '../lib/logger';
import { getTenantPrisma } from '../lib/tenantPrisma';
import { getStatus, sendToOwner } from './gateway';
import { proactiveCoach } from './assistant';

const COACH_MIN_INTERVAL = 20 * 60 * 60 * 1000; // ~20 h entre avisos

export async function runCoachScan(): Promise<void> {
  try {
    const st = getStatus();
    if (st.state !== 'connected' || !st.tenantId || st.userId == null) return;

    const prisma = await getTenantPrisma(st.tenantId);
    const cfg = await prisma.whatsappConfig.findUnique({ where: { id: 1 } });
    if (!cfg?.enabled || !cfg.coachEnabled) return;
    if (cfg.lastCoachAt && Date.now() - new Date(cfg.lastCoachAt).getTime() < COACH_MIN_INTERVAL) return;

    const msg = await proactiveCoach(prisma, st.userId);
    // Marca el intento aunque no haya nada, para no repetir el análisis cada hora.
    await prisma.whatsappConfig.update({ where: { id: 1 }, data: { lastCoachAt: new Date() } }).catch(() => {});
    if (msg) {
      const sent = await sendToOwner(msg);
      logger.info({ tenant: st.tenantId, sent }, 'wa: aviso proactivo');
    }
  } catch (e: any) {
    logger.error({ e: e?.message }, 'wa: coach scan falló');
  }
}
