// =====================================================
// Sincroniza el schema GLOBAL en tu Postgres local (desarrollo).
// Compone GLOBAL_DATABASE_URL desde las variables POR PARTES del .env activo
// (lib/env.ts) antes de invocar el CLI de Prisma. Crea la DB si no existe.
//
// Uso: tsx --env-file=.env.dev scripts/db-push.ts
//   (o vía npm: npm run dev:db:push)
// =====================================================
import '../src/lib/env';
import { execSync } from 'child_process';

console.log('→ prisma db push (schema global)…');
execSync('npx prisma db push --schema=prisma/global/schema.prisma --skip-generate', {
  stdio: 'inherit'
});
console.log('✓ Schema global sincronizado en la DB local.');
