/**
 * Migración idempotente: añade ExpenseKind enum + Movement.expenseKind a TODAS las DBs tenant.
 *
 * - Crea el tipo enum ExpenseKind (FIXED, VARIABLE, NON_ACCOUNTABLE) si no existe.
 * - Añade columna expenseKind a Movement (nullable) si no existe.
 * - Backfill: gastos existentes (type=EXPENSE) → VARIABLE.
 * - Crea índice (userId, type, expenseKind) si no existe.
 *
 * Uso (dentro del contenedor backend):
 *   docker compose exec backend npx tsx scripts/migrate-add-expense-kind.ts
 */

import { Client as PgClient } from 'pg';
import { globalPrisma } from '../src/lib/globalPrisma';
import { decryptConnection } from '../src/lib/tenantCrypto';
import { logger } from '../src/lib/logger';

async function migrateTenant(dbHost: string, dbPort: number, dbName: string, dbUser: string, dbPassword: string) {
  const url = `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;
  const client = new PgClient({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ExpenseKind') THEN
          CREATE TYPE "ExpenseKind" AS ENUM ('FIXED', 'VARIABLE', 'NON_ACCOUNTABLE');
        END IF;
      END$$;
    `);
    await client.query(`ALTER TABLE "Movement" ADD COLUMN IF NOT EXISTS "expenseKind" "ExpenseKind";`);
    const upd = await client.query(`
      UPDATE "Movement"
         SET "expenseKind" = 'VARIABLE'
       WHERE "type" = 'EXPENSE' AND "expenseKind" IS NULL;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "Movement_userId_type_expenseKind_idx" ON "Movement"("userId", "type", "expenseKind");`);
    return upd.rowCount ?? 0;
  } finally {
    await client.end();
  }
}

async function main() {
  const conns = await globalPrisma.tenantConnection.findMany({
    include: { tenant: { select: { slug: true, status: true } } }
  });
  logger.info({ count: conns.length }, 'tenants encontrados');

  let totalBackfilled = 0;
  for (const c of conns) {
    if (c.tenant.status !== 'ACTIVE') {
      logger.warn({ slug: c.tenant.slug, status: c.tenant.status }, 'tenant no activo, saltando');
      continue;
    }
    const { user, password } = decryptConnection(c);
    try {
      const rows = await migrateTenant(c.dbHost, c.dbPort, c.dbName, user, password);
      totalBackfilled += rows;
      logger.info({ slug: c.tenant.slug, dbName: c.dbName, backfilled: rows }, 'migrado');
    } catch (e: any) {
      logger.error({ slug: c.tenant.slug, err: e.message }, 'migración falló');
    }
  }
  logger.info({ totalBackfilled }, 'completado');
}

main().then(() => process.exit(0)).catch((e) => {
  logger.error({ err: e.message }, 'fatal');
  process.exit(1);
});
