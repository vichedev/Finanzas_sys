import { Client as PgClient } from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import path from 'path';
import { globalPrisma } from './globalPrisma';
import { encryptConnection } from './tenantCrypto';
import { getTenantPrisma } from './tenantPrisma';
import { logger } from './logger';

function generateStrongPassword(length = 48): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quitar acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    || 'empresa';
}

async function uniqueSlug(base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await globalPrisma.tenant.findUnique({ where: { slug: candidate } })) {
    candidate = `${base}-${n++}`;
    if (candidate.length > 40) candidate = `${base.slice(0, 30)}-${n}`;
  }
  return candidate;
}

interface ProvisionInput {
  legalName: string;
  ruc?: string;
  email: string;
  adminName: string;
  adminPassword: string;
  logoUrl?: string;
}

export async function provisionTenant(input: ProvisionInput, actorSuperAdminId: string) {
  const slug = await uniqueSlug(slugify(input.legalName));
  const safeName = slug.replace(/-/g, '_');
  const dbName = `finanzas_t_${safeName}`;
  const dbUser = `tu_${safeName}`;
  const dbPass = generateStrongPassword(48);

  const adminUrl = process.env.POSTGRES_ADMIN_URL;
  if (!adminUrl) throw new Error('POSTGRES_ADMIN_URL no está configurada');

  const pg = new PgClient({ connectionString: adminUrl });
  await pg.connect();

  try {
    // 1. CREATE USER y CREATE DATABASE (DDL no soporta parámetros — escapamos comillas)
    const safePass = dbPass.replace(/'/g, "''");
    await pg.query(`CREATE USER "${dbUser}" WITH ENCRYPTED PASSWORD '${safePass}';`);
    await pg.query(`CREATE DATABASE "${dbName}" OWNER "${dbUser}";`);
    await pg.query(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC;`);
    await pg.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}";`);

    // 2. Aplicar schema tenant con prisma db push sobre la nueva DB
    const pgHost = process.env.PG_HOST || 'postgres';
    const pgPort = process.env.PG_PORT || '5432';
    const tenantUrl = `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPass)}@${pgHost}:${pgPort}/${dbName}?schema=public`;
    const schemaPath = path.resolve(__dirname, '../../prisma/tenant/schema.prisma');

    try {
      execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss --skip-generate`, {
        env: { ...process.env, TENANT_DATABASE_URL: tenantUrl },
        stdio: 'pipe'
      });
    } catch (e: any) {
      logger.error({ err: e.message, stderr: e.stderr?.toString() }, 'prisma db push failed');
      throw new Error(`No se pudo aplicar el schema del tenant: ${e.message}`);
    }

    // 3. Registrar tenant + conexión cifrada + membresía del admin
    const enc = encryptConnection({ user: dbUser, password: dbPass });
    const adminPasswordHash = await bcrypt.hash(input.adminPassword, 12);

    const tenant = await globalPrisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          slug, legalName: input.legalName, ruc: input.ruc,
          email: input.email, logoUrl: input.logoUrl,
          status: 'ACTIVE'
        }
      });
      await tx.tenantConnection.create({
        data: {
          tenantId: t.id, dbHost: pgHost, dbPort: Number(pgPort),
          dbName, dbUserCipher: enc.userCipher, dbPasswordCipher: enc.passwordCipher
        }
      });
      await tx.tenantMembership.create({
        data: {
          email: input.email, passwordHash: adminPasswordHash, name: input.adminName,
          tenantId: t.id, role: 'ADMIN_EMPRESA', isActive: true, activatedAt: new Date()
        }
      });
      await tx.superAdminAuditLog.create({
        data: {
          superAdminId: actorSuperAdminId, tenantId: t.id,
          action: 'TENANT_CREATE', metadata: { slug, dbName }
        }
      });
      return t;
    });

    // 4. Seed User local en la DB del tenant
    const tenantPrisma = await getTenantPrisma(tenant.id);
    await tenantPrisma.user.create({
      data: {
        email: input.email, name: input.adminName,
        role: 'ADMIN_EMPRESA', isActive: true
      }
    });

    logger.info({ tenantId: tenant.id, slug, dbName }, 'tenant provisioned');
    return tenant;

  } catch (err) {
    // Rollback infrastructura si la creación falló a mitad
    await pg.query(`DROP DATABASE IF EXISTS "${dbName}";`).catch(() => {});
    await pg.query(`DROP USER IF EXISTS "${dbUser}";`).catch(() => {});
    throw err;
  } finally {
    await pg.end();
  }
}

export async function suspendTenant(tenantId: string, actorSuperAdminId: string) {
  await globalPrisma.tenant.update({
    where: { id: tenantId },
    data: { status: 'SUSPENDED', suspendedAt: new Date() }
  });
  await globalPrisma.superAdminAuditLog.create({
    data: { superAdminId: actorSuperAdminId, tenantId, action: 'TENANT_SUSPEND' }
  });
}

export async function reactivateTenant(tenantId: string, actorSuperAdminId: string) {
  await globalPrisma.tenant.update({
    where: { id: tenantId },
    data: { status: 'ACTIVE', suspendedAt: null }
  });
  await globalPrisma.superAdminAuditLog.create({
    data: { superAdminId: actorSuperAdminId, tenantId, action: 'TENANT_REACTIVATE' }
  });
}
