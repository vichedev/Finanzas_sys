/**
 * Migración: convierte el sistema single-tenant actual a multitenant.
 *
 * Asume que ANTES de correr este script:
 *  1. Ya existe la DB "finanzas_global" (vacía pero con schema aplicado)
 *  2. La DB actual con datos sigue siendo "finanzas_db" o ya fue renombrada a "finanzas_t_default"
 *  3. Las env vars están configuradas: GLOBAL_DATABASE_URL, TENANT_ENCRYPTION_KEY, POSTGRES_ADMIN_URL
 *
 * Lo que hace:
 *  - Crea Plan default ENTERPRISE
 *  - Crea Tenant "default" en global
 *  - Crea PG user "tu_default" con password fuerte
 *  - GRANT a tu_default sobre finanzas_t_default
 *  - Cifra credenciales y guarda en TenantConnection
 *  - Copia los users del schema antiguo (User) a TenantMembership (en global)
 *    y a User local del tenant (sin passwordHash)
 *  - Si hay un ADMIN, también lo registra como SuperAdmin en global
 *
 * Uso:
 *   pnpm tsx scripts/migrate-to-multitenant.ts
 */

import { Client as PgClient } from 'pg';
import crypto from 'crypto';
import { globalPrisma } from '../src/lib/globalPrisma';
import { encryptConnection } from '../src/lib/tenantCrypto';
import { getTenantPrisma } from '../src/lib/tenantPrisma';
import { logger } from '../src/lib/logger';

const TENANT_SLUG = process.env.MIGRATE_SLUG || 'default';
const TENANT_LEGAL_NAME = process.env.MIGRATE_LEGAL_NAME || 'Empresa Principal';
const TENANT_EMAIL = process.env.MIGRATE_EMAIL || 'admin@example.com';
const SOURCE_DB = process.env.MIGRATE_SOURCE_DB || 'finanzas_db';   // DB actual con datos
const TARGET_DB = `finanzas_t_${TENANT_SLUG}`;

function generatePassword(): string {
  return crypto.randomBytes(36).toString('base64url').slice(0, 48);
}

async function main() {
  const adminUrl = process.env.POSTGRES_ADMIN_URL!;
  const pgHost = process.env.PG_HOST || 'postgres';
  const pgPort = Number(process.env.PG_PORT || 5432);

  const pg = new PgClient({ connectionString: adminUrl });
  await pg.connect();

  try {
    // 1. Plan default si no existe
    let plan = await globalPrisma.plan.findUnique({ where: { code: 'ENTERPRISE' } });
    if (!plan) {
      plan = await globalPrisma.plan.create({
        data: { code: 'ENTERPRISE', name: 'Enterprise', maxUsers: 9999, maxMovements: 9999999 }
      });
    }

    // 2. Renombrar DB actual a target si hace falta
    const exists = await pg.query(`SELECT 1 FROM pg_database WHERE datname=$1`, [TARGET_DB]);
    if (exists.rowCount === 0) {
      logger.info({ from: SOURCE_DB, to: TARGET_DB }, 'renombrando DB');
      await pg.query(`ALTER DATABASE "${SOURCE_DB}" RENAME TO "${TARGET_DB}";`);
    }

    // 3. Crear PG user dedicado para este tenant
    const dbUser = `tu_${TENANT_SLUG}`;
    const dbPass = generatePassword();
    const userExists = await pg.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [dbUser]);
    // DDL no acepta parámetros — pero el password es base64url (sin comillas), seguro interpolar
    const safePass = dbPass.replace(/'/g, "''");
    if (userExists.rowCount === 0) {
      await pg.query(`CREATE USER "${dbUser}" WITH ENCRYPTED PASSWORD '${safePass}';`);
    } else {
      await pg.query(`ALTER USER "${dbUser}" WITH ENCRYPTED PASSWORD '${safePass}';`);
    }
    await pg.query(`ALTER DATABASE "${TARGET_DB}" OWNER TO "${dbUser}";`);
    await pg.query(`GRANT ALL PRIVILEGES ON DATABASE "${TARGET_DB}" TO "${dbUser}";`);

    // 4. Crear Tenant + TenantConnection en global
    const enc = encryptConnection({ user: dbUser, password: dbPass });
    let tenant = await globalPrisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
    if (!tenant) {
      tenant = await globalPrisma.tenant.create({
        data: {
          slug: TENANT_SLUG, legalName: TENANT_LEGAL_NAME, email: TENANT_EMAIL,
          planId: plan.id, status: 'ACTIVE'
        }
      });
    }

    const conn = await globalPrisma.tenantConnection.findUnique({ where: { tenantId: tenant.id } });
    if (!conn) {
      await globalPrisma.tenantConnection.create({
        data: {
          tenantId: tenant.id, dbHost: pgHost, dbPort: pgPort,
          dbName: TARGET_DB,
          dbUserCipher: enc.userCipher, dbPasswordCipher: enc.passwordCipher
        }
      });
    } else {
      await globalPrisma.tenantConnection.update({
        where: { tenantId: tenant.id },
        data: { dbHost: pgHost, dbPort: pgPort, dbName: TARGET_DB,
                dbUserCipher: enc.userCipher, dbPasswordCipher: enc.passwordCipher }
      });
    }

    // 5. Migrar users existentes a TenantMembership
    // Nota: requiere que en la DB tenant siga existiendo la tabla User legacy con passwordHash
    const tenantPrisma = await getTenantPrisma(tenant.id);
    // @ts-ignore - posiblemente todavía existe el User legacy con passwordHash si la migración del schema no se aplicó
    const legacyUsers: any[] = await tenantPrisma.$queryRawUnsafe(
      `SELECT id, email, name, "passwordHash", role, "isActive" FROM "User"`
    );

    for (const u of legacyUsers) {
      const role = u.role === 'ADMIN' || u.role === 'SUPERADMIN' ? 'ADMIN_EMPRESA' : 'USUARIO_EMPRESA';
      await globalPrisma.tenantMembership.upsert({
        where: { email_tenantId: { email: u.email, tenantId: tenant.id } },
        update: { passwordHash: u.passwordHash, name: u.name, role, isActive: u.isActive },
        create: {
          email: u.email, passwordHash: u.passwordHash, name: u.name,
          tenantId: tenant.id, role, isActive: u.isActive, activatedAt: new Date()
        }
      });

      // Si era SUPERADMIN, además registrarlo como SuperAdmin global
      if (u.role === 'SUPERADMIN') {
        await globalPrisma.superAdmin.upsert({
          where: { email: u.email },
          update: { passwordHash: u.passwordHash, name: u.name, isActive: u.isActive },
          create: {
            email: u.email, passwordHash: u.passwordHash, name: u.name,
            role: 'SUPER_ADMIN', isActive: u.isActive
          }
        });
      }
    }

    logger.info({ tenantId: tenant.id, slug: TENANT_SLUG, users: legacyUsers.length }, 'migración completa');
    console.log('\n✓ Migración exitosa');
    console.log(`  Tenant: ${tenant.slug} (${tenant.id})`);
    console.log(`  DB: ${TARGET_DB}`);
    console.log(`  Users migrados: ${legacyUsers.length}`);
  } finally {
    await pg.end();
    await globalPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Migración falló:', err);
  process.exit(1);
});
