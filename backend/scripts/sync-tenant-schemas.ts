// =====================================================
// Aplica el schema tenant ACTUAL a TODAS las bases de datos de tenants
// existentes (prisma db push por cada conexión registrada).
//
// Úsalo cada vez que cambies prisma/tenant/schema.prisma y necesites
// propagar el cambio a los tenants ya creados (provisioning solo lo
// aplica a tenants nuevos).
//
// Es aditivo y seguro para cambios como "agregar tabla/columna".
//
// Uso:  tsx --env-file=.env.dev scripts/sync-tenant-schemas.ts
//   (en producción usa el .env correspondiente)
// =====================================================
import '../src/lib/env';
import { execSync } from 'child_process';
import path from 'path';
import { globalPrisma } from '../src/lib/globalPrisma';
import { decryptConnection } from '../src/lib/tenantCrypto';

async function main() {
  const schemaPath = path.resolve(__dirname, '../prisma/tenant/schema.prisma');

  const conns = await globalPrisma.tenantConnection.findMany({
    include: { tenant: { select: { slug: true, status: true } } }
  });

  if (!conns.length) {
    console.log('No hay tenants registrados. Nada que sincronizar.');
    return;
  }

  console.log(`→ Sincronizando schema tenant en ${conns.length} base(s) de datos…\n`);

  let ok = 0;
  const failed: string[] = [];

  for (const conn of conns) {
    const slug = conn.tenant.slug;
    if (conn.tenant.status !== 'ACTIVE') {
      console.log(`⏭  ${slug} (status: ${conn.tenant.status}) — omitido`);
      continue;
    }
    const { user, password } = decryptConnection(conn);
    const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${conn.dbHost}:${conn.dbPort}/${conn.dbName}?schema=public`;

    process.stdout.write(`→ ${slug} (${conn.dbName})… `);
    try {
      execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss --skip-generate`, {
        env: { ...process.env, TENANT_DATABASE_URL: url },
        stdio: 'pipe'
      });
      console.log('✓');
      ok++;
    } catch (e: any) {
      console.log('✗');
      console.error(`   ${e.stderr?.toString() || e.message}`);
      failed.push(slug);
    }
  }

  console.log(`\n✓ ${ok} sincronizado(s)${failed.length ? ` · ✗ ${failed.length} con error: ${failed.join(', ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => globalPrisma.$disconnect());
