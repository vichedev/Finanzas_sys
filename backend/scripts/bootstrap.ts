// =====================================================
// Bootstrap de una instalación limpia (modo multi-empresa)
//
// 1. Siembra/actualiza el primer SuperAdmin de la plataforma.
// 2. (Opcional) crea la PRIMERA empresa con su admin, reutilizando
//    provisionTenant() — sólo si todavía no existe ninguna empresa.
//
// Es idempotente: re-ejecutarlo no duplica nada.
//
// Uso (todo por variables de entorno):
//   SEED_EMAIL=owner@plataforma.com SEED_PASSWORD=Sup3rSecreta SEED_NAME="Dueño" \
//   [COMPANY_NAME="Mi Empresa" COMPANY_EMAIL=admin@miempresa.com \
//    COMPANY_ADMIN_NAME="Admin" COMPANY_ADMIN_PASSWORD=Empresa1234 COMPANY_RUC=...] \
//     npx tsx scripts/bootstrap.ts
// =====================================================
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { globalPrisma } from '../src/lib/globalPrisma';
import { provisionTenant } from '../src/lib/tenantProvisioning';

async function seedSuperAdmin() {
  const email = (process.env.SEED_EMAIL || '').toLowerCase().trim();
  const password = process.env.SEED_PASSWORD || '';
  const name = process.env.SEED_NAME || 'Super Admin';

  if (!email || !password) {
    throw new Error('Faltan SEED_EMAIL y/o SEED_PASSWORD.');
  }
  if (password.length < 10) {
    throw new Error('SEED_PASSWORD debe tener al menos 10 caracteres.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const sa = await globalPrisma.superAdmin.upsert({
    where: { email },
    update: { passwordHash, name, isActive: true, failedAttempts: 0, lockedUntil: null },
    create: { email, passwordHash, name, role: 'SUPER_ADMIN', isActive: true }
  });

  console.log(`✓ SuperAdmin listo: ${sa.email} (${sa.id})`);
  return sa;
}

async function seedFirstCompany(superAdminId: string) {
  const companyName = process.env.COMPANY_NAME?.trim();
  if (!companyName) {
    console.log('· No se pidió crear empresa (COMPANY_NAME vacío). Puedes crearla luego desde el panel SuperAdmin.');
    return;
  }

  const existing = await globalPrisma.tenant.count();
  if (existing > 0) {
    console.log(`· Ya existen ${existing} empresa(s). No se crea ninguna nueva.`);
    return;
  }

  const email = (process.env.COMPANY_EMAIL || '').toLowerCase().trim();
  const adminName = process.env.COMPANY_ADMIN_NAME?.trim() || 'Administrador';
  const adminPassword = process.env.COMPANY_ADMIN_PASSWORD || '';
  const ruc = process.env.COMPANY_RUC?.trim() || undefined;

  if (!email || !adminPassword) {
    throw new Error('Para crear la empresa necesitas COMPANY_EMAIL y COMPANY_ADMIN_PASSWORD.');
  }
  if (adminPassword.length < 8) {
    throw new Error('COMPANY_ADMIN_PASSWORD debe tener al menos 8 caracteres.');
  }

  console.log(`→ Creando primera empresa "${companyName}" (esto provisiona su base de datos)...`);
  const tenant = await provisionTenant(
    { legalName: companyName, ruc, email, adminName, adminPassword },
    superAdminId
  );
  console.log(`✓ Empresa creada: ${tenant.legalName} (slug: ${tenant.slug}, id: ${tenant.id})`);
  console.log(`  Admin de la empresa: ${email}`);
}

async function main() {
  const sa = await seedSuperAdmin();
  await seedFirstCompany(sa.id);
}

main()
  .catch((e) => { console.error('✗ Bootstrap falló:', e.message || e); process.exit(1); })
  .finally(() => globalPrisma.$disconnect());
