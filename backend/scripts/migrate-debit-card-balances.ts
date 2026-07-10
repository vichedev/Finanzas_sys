/**
 * Migración idempotente: recalcula los saldos de las cuentas desde el ledger, y
 * pone a 0 el saldo almacenado de las tarjetas de DÉBITO (que ya no se usa).
 *
 * Contexto: una tarjeta de débito no guarda dinero, es un acceso a las cuentas del
 * mismo banco y titular; su saldo se deriva sumando esas cuentas. Antes el sistema
 * le llevaba un saldo propio y le SUMABA cada gasto (semántica de crédito), y los
 * gastos con débito nunca debitaban la cuenta. Esto reconcilia todo.
 *
 * Qué hace, por cada tenant (idempotente):
 *   1. Asigna los gastos históricos con tarjeta de débito y sin cuenta a la cuenta
 *      del mismo banco y titular, SOLO cuando hay exactamente una candidata (sin
 *      ambigüedad). Los que quedan con varias candidatas se reportan.
 *   2. [--apply] Recalcula el saldo de TODAS las cuentas: initialBalance + ledger.
 *   3. [--apply] Pone a 0 el currentBalance de las tarjetas de DÉBITO.
 *
 * Las tarjetas de CRÉDITO no se tocan: su currentBalance sigue siendo la deuda usada.
 *
 * Uso:
 *   npx tsx scripts/migrate-debit-card-balances.ts            # simulacro (no escribe)
 *   npx tsx scripts/migrate-debit-card-balances.ts --apply    # aplica los cambios
 *
 * Haz un respaldo (Configuración → Respaldo) antes de correr con --apply.
 */

import { Client as PgClient } from 'pg';
import { globalPrisma } from '../src/lib/globalPrisma';
import { decryptConnection } from '../src/lib/tenantCrypto';
import { logger } from '../src/lib/logger';

const APPLY = process.argv.includes('--apply');

/**
 * Suma de los movimientos que afectan a una cuenta. Debe reflejar EXACTAMENTE
 * applyDeltas() de movements.routes.ts, o los saldos quedarían mal.
 */
const LEDGER_SUM = `
  a."initialBalance"
  + COALESCE((
      SELECT SUM(CASE
        WHEN m."type" = 'INCOME'                              THEN  m."amount"
        WHEN m."type" IN ('EXPENSE', 'WITHDRAWAL')            THEN -m."amount"
        WHEN m."type" = 'PURCHASE' AND m."isCredit" = false   THEN -m."amount"
        WHEN m."type" = 'CARD_PAYMENT'                        THEN -m."amount"
        WHEN m."type" = 'TRANSFER'                            THEN -(m."amount" + COALESCE(m."commission", 0))
        WHEN m."type" = 'ADJUSTMENT'                          THEN (CASE WHEN m."isCredit" THEN m."amount" ELSE -m."amount" END)
        ELSE 0
      END)
      FROM "Movement" m WHERE m."accountId" = a."id"
    ), 0)
  + COALESCE((
      SELECT SUM(m."amount")
      FROM "Movement" m WHERE m."toAccountId" = a."id" AND m."type" = 'TRANSFER'
    ), 0)
`;

type Report = { assigned: number; ambiguous: number; accounts: number; cardsZeroed: number };

async function migrateTenant(dbHost: string, dbPort: number, dbName: string, dbUser: string, dbPassword: string): Promise<Report> {
  const url = `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;
  const client = new PgClient({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');

    // 1. Gastos históricos con tarjeta de débito y sin cuenta: se asignan a la única
    //    cuenta del mismo banco y titular (nombre de cuenta = nombre de tarjeta,
    //    normalizado). Si hay varias candidatas, se deja sin tocar (ambiguo).
    const NORM = (col: string) => `lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`;
    const assign = await client.query(`
      WITH candidate AS (
        SELECT m."id" AS "movementId",
               (SELECT a."id"
                  FROM "Account" a
                 WHERE a."userId" = c."userId"
                   AND a."isActive" = true
                   AND a."bankId" = c."bankId"
                   AND ${NORM('a."name"')} = ${NORM('c."name"')}) AS "onlyAccountId"
          FROM "Movement" m
          JOIN "Card" c ON c."id" = m."cardId"
         WHERE c."type" = 'DEBIT'
           AND m."accountId" IS NULL
           AND m."type" <> 'CARD_PAYMENT'
           AND c."bankId" IS NOT NULL
      )
      UPDATE "Movement" m
         SET "accountId" = candidate."onlyAccountId"
        FROM candidate
       WHERE m."id" = candidate."movementId"
         AND candidate."onlyAccountId" IS NOT NULL;
    `);
    const assigned = assign.rowCount ?? 0;

    // Cuenta cuántos quedaron ambiguos (varias cuentas candidatas → no se pudo asignar).
    const amb = await client.query<{ n: string }>(`
      SELECT COUNT(*)::text AS n
        FROM "Movement" m
        JOIN "Card" c ON c."id" = m."cardId"
       WHERE c."type" = 'DEBIT' AND m."accountId" IS NULL AND m."type" <> 'CARD_PAYMENT';
    `);
    const ambiguous = Number(amb.rows[0]?.n ?? 0);

    let accounts = 0, cardsZeroed = 0;

    if (APPLY) {
      // 2. Recalcular el saldo de cada cuenta desde el ledger (fuente de verdad).
      const acc = await client.query(`UPDATE "Account" a SET "currentBalance" = ${LEDGER_SUM};`);
      accounts = acc.rowCount ?? 0;

      // 3. El saldo almacenado de las tarjetas de débito deja de usarse (se deriva).
      const cz = await client.query(`UPDATE "Card" SET "currentBalance" = 0 WHERE "type" = 'DEBIT' AND "currentBalance" <> 0;`);
      cardsZeroed = cz.rowCount ?? 0;

      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK'); // simulacro: no se escribe nada
    }

    return { assigned, ambiguous, accounts, cardsZeroed };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { /* conexión ya rota */ });
    throw e;
  } finally {
    await client.end();
  }
}

async function main() {
  if (!APPLY) logger.info('SIMULACRO: no se escribe nada. Usa --apply para aplicar los cambios.');

  const conns = await globalPrisma.tenantConnection.findMany({
    include: { tenant: { select: { slug: true, status: true } } }
  });
  logger.info({ count: conns.length }, 'tenants encontrados');

  let ambiguousTotal = 0;
  for (const c of conns) {
    if (c.tenant.status !== 'ACTIVE') {
      logger.warn({ slug: c.tenant.slug, status: c.tenant.status }, 'tenant no activo, saltando');
      continue;
    }
    const { user, password } = decryptConnection(c);
    try {
      const r = await migrateTenant(c.dbHost, c.dbPort, c.dbName, user, password);
      logger.info({ slug: c.tenant.slug, ...r }, APPLY ? 'migrado' : 'simulacro ok');
      if (r.ambiguous) {
        ambiguousTotal += r.ambiguous;
        logger.warn(
          { slug: c.tenant.slug, movimientos: r.ambiguous },
          'gastos con tarjeta de débito que cubren varias cuentas: no se pudo elegir de cuál salieron. Edítalos en Movimientos y asigna la cuenta.'
        );
      }
    } catch (e: any) {
      logger.error({ slug: c.tenant.slug, err: e.message }, 'migración falló (sin cambios en ese tenant)');
    }
  }

  if (ambiguousTotal) {
    logger.warn({ ambiguousTotal }, 'Esos movimientos no entraron al recálculo hasta que les asignes cuenta manualmente.');
  }
  logger.info(APPLY ? 'completado' : 'simulacro completado (nada se escribió)');
}

main().then(() => process.exit(0)).catch((e) => {
  logger.error({ err: e.message }, 'fatal');
  process.exit(1);
});
