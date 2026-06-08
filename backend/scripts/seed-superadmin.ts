// =====================================================
// Seed del primer SUPER_ADMIN (modo multitenant)
// Uso:
//   SEED_EMAIL=admin@local SEED_PASSWORD=changeme123 SEED_NAME="Admin" \
//     npx tsx scripts/seed-superadmin.ts
// Si ya existe un SuperAdmin con ese email, actualiza su password.
// =====================================================
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { globalPrisma } from '../src/lib/globalPrisma';

async function main() {
  const email = (process.env.SEED_EMAIL || '').toLowerCase().trim();
  const password = process.env.SEED_PASSWORD || '';
  const name = process.env.SEED_NAME || 'Super Admin';

  if (!email || !password) {
    console.error('Faltan SEED_EMAIL y/o SEED_PASSWORD.');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('SEED_PASSWORD debe tener al menos 10 caracteres.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const sa = await globalPrisma.superAdmin.upsert({
    where: { email },
    update: { passwordHash, name, isActive: true, failedAttempts: 0, lockedUntil: null },
    create: { email, passwordHash, name, role: 'SUPER_ADMIN', isActive: true }
  });

  console.log('✓ SuperAdmin listo:');
  console.log('  id:    ', sa.id);
  console.log('  email: ', sa.email);
  console.log('  role:  ', sa.role);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => globalPrisma.$disconnect());
