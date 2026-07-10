/**
 * SOLO LECTURA: por cada tarjeta de DÉBITO, muestra las cuentas que componen su
 * saldo (mismo banco y titular) y la suma, vs. el saldo almacenado (obsoleto).
 * No escribe nada. Sirve para verificar que cada tarjeta toma exactamente las
 * cuentas correctas.
 *
 * Uso: npx tsx scripts/inspect-debit-cards.ts
 */
import { Client as PgClient } from 'pg';
import { globalPrisma } from '../src/lib/globalPrisma';
import { decryptConnection } from '../src/lib/tenantCrypto';

async function inspectTenant(slug: string, dbHost: string, dbPort: number, dbName: string, dbUser: string, dbPassword: string) {
  const url = `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}:${dbPort}/${dbName}`;
  const client = new PgClient({ connectionString: url });
  await client.connect();
  try {
    const cards = await client.query<{ id: number; name: string; bankId: number | null; bankName: string | null; last4: string | null; stored: string }>(`
      SELECT "id", "name", "bankId", "bankName", "last4", "currentBalance"::text AS stored
        FROM "Card" WHERE "type" = 'DEBIT' AND "isActive" = true ORDER BY "name";
    `);
    if (!cards.rows.length) { console.log(`\n[${slug}] sin tarjetas de débito activas.`); return; }
    console.log(`\n===== ${slug} =====`);
    for (const c of cards.rows) {
      // Mismo criterio que el backend: mismo banco y name == nombre de la tarjeta (normalizado).
      const accts = await client.query<{ name: string; kind: string | null; num: string | null; bal: string }>(`
        SELECT "name", "accountKind" AS kind, "accountNumber" AS num, "currentBalance"::text AS bal
          FROM "Account"
         WHERE "isActive" = true AND "bankId" = $1
           AND lower(regexp_replace(btrim("name"), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($2), '\\s+', ' ', 'g'))
         ORDER BY "name";
      `, [c.bankId, c.name]);
      const sum = accts.rows.reduce((s, a) => s + Number(a.bal), 0);
      console.log(`\n💳 ${c.name}  (${c.bankName ?? 'sin banco'} · ****${c.last4 ?? '????'})`);
      console.log(`   banco=${c.bankId} titular="${c.name}" · saldo guardado (obsoleto)=${c.stored}`);
      if (!accts.rows.length) {
        console.log('   ⚠ no coincide ninguna cuenta (¿la tarjeta no tiene banco, o no hay cuentas de ese banco/titular?)');
      } else {
        for (const a of accts.rows) {
          const k = a.kind === 'SAVINGS' ? 'Ahorros' : a.kind === 'CHECKING' ? 'Corriente' : (a.kind ?? '');
          console.log(`     • ${a.name} · ${k} ${a.num ? '****' + a.num.slice(-4) : ''}  =  ${a.bal}`);
        }
        console.log(`   ▶ SALDO DERIVADO (suma) = ${sum.toFixed(2)}   (${accts.rows.length} cuenta${accts.rows.length === 1 ? '' : 's'})`);
      }
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const conns = await globalPrisma.tenantConnection.findMany({ include: { tenant: { select: { slug: true, status: true } } } });
  for (const c of conns) {
    if (c.tenant.status !== 'ACTIVE') continue;
    const { user, password } = decryptConnection(c);
    try { await inspectTenant(c.tenant.slug, c.dbHost, c.dbPort, c.dbName, user, password); }
    catch (e: any) { console.error(`[${c.tenant.slug}] error: ${e.message}`); }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
