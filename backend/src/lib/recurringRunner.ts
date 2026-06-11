import { PrismaClient, RecurringFrequency } from '.prisma/tenant';
import { logger } from './logger';

type TenantPrisma = PrismaClient;

function addInterval(date: Date, freq: RecurringFrequency): Date {
  const d = new Date(date);
  switch (freq) {
    case 'DAILY': d.setUTCDate(d.getUTCDate() + 1); break;
    case 'WEEKLY': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'MONTHLY': d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'YEARLY': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return d;
}

const MAX_CATCHUP = 60; // tope de seguridad por regla y corrida

/**
 * Genera los movimientos pendientes de las reglas recurrentes activas cuyo
 * nextRunDate ya venció. Avanza la fecha y finaliza las reglas que pasaron su endDate.
 * Devuelve cuántos movimientos creó.
 */
export async function runDueRecurringRules(prisma: TenantPrisma, userId: number): Promise<number> {
  const now = new Date();
  let created = 0;

  const rules = await prisma.recurringRule.findMany({
    where: { userId, status: 'ACTIVE', nextRunDate: { lte: now } }
  });

  for (const rule of rules) {
    try {
      await prisma.$transaction(async (tx) => {
        let runDate = new Date(rule.nextRunDate);
        let status: 'ACTIVE' | 'FINISHED' = 'ACTIVE';
        let iterations = 0;

        while (runDate <= now && iterations < MAX_CATCHUP) {
          if (rule.endDate && runDate > rule.endDate) { status = 'FINISHED'; break; }

          await tx.movement.create({
            data: {
              userId,
              type: rule.type,
              amount: rule.amount,
              movementDate: runDate,
              description: rule.name,
              paymentMethod: rule.paymentMethod,
              categoryId: rule.categoryId,
              recurringRuleId: rule.id,
              notes: 'Generado automáticamente (recurrente)'
            }
          });
          created++;
          runDate = addInterval(runDate, rule.frequency);
          iterations++;
        }

        if (rule.endDate && runDate > rule.endDate) status = 'FINISHED';

        await tx.recurringRule.update({
          where: { id: rule.id },
          data: { nextRunDate: runDate, status }
        });
      });
    } catch (err) {
      logger.error({ err, ruleId: rule.id, userId }, 'recurring rule generation failed');
    }
  }

  return created;
}
