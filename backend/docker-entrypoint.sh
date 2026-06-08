#!/bin/sh
# =====================================================
# Finanzas — Entrypoint del backend
# Hace que CUALQUIER arranque (docker compose up o install.sh)
# deje el sistema consistente, sin pasos manuales:
#   0. Compone GLOBAL_DATABASE_URL desde las variables POSTGRES_* sueltas.
#   1. Espera a que Postgres acepte conexiones.
#   2. Sincroniza el schema GLOBAL (idempotente).
#   3. Crea/actualiza el ADMINISTRADOR INICIAL (y opcionalmente la 1ª empresa)
#      a partir de SEED_*/COMPANY_* del entorno.
#   4. Arranca el servidor (exec del CMD).
# =====================================================
set -e

log() { printf '[entrypoint] %s\n' "$*"; }

# ---- 0. Componer la URL global desde las partes (si no viene ya armada) ----
if [ -z "${GLOBAL_DATABASE_URL:-}" ]; then
  GLOBAL_DATABASE_URL="$(node -e 'const u=encodeURIComponent;const h=process.env.POSTGRES_HOST||"postgres";const p=process.env.POSTGRES_PORT||5432;const U=process.env.POSTGRES_USER||"finanzas_user";const P=process.env.POSTGRES_PASSWORD||"";const D=process.env.POSTGRES_DB||"finanzas_global";process.stdout.write(`postgresql://${u(U)}:${u(P)}@${h}:${p}/${D}?schema=public`)')"
  export GLOBAL_DATABASE_URL
fi

# ---- 1. Esperar a la base de datos global ----
log "Esperando a la base de datos..."
node -e '
const { Client } = require("pg");
const url = process.env.GLOBAL_DATABASE_URL;
if (!url) { console.error("GLOBAL_DATABASE_URL no está definida"); process.exit(2); }
(async () => {
  for (let i = 1; i <= 60; i++) {
    try {
      const c = new Client({ connectionString: url });
      await c.connect();
      await c.end();
      process.exit(0);
    } catch (e) {
      if (i === 1 || i % 5 === 0) console.log(`  DB no lista todavía (intento ${i}/60): ${e.code || e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error("La base de datos no respondió tras 120s");
  process.exit(1);
})();
'
log "Base de datos disponible."

# ---- 2. Sincronizar el schema global (no destructivo en arranques normales) ----
log "Sincronizando schema global..."
if npx prisma db push --schema=prisma/global/schema.prisma --skip-generate 2>/tmp/prisma-global.log; then
  log "Schema global sincronizado."
else
  log "AVISO: no se pudo sincronizar el schema global automáticamente:"
  sed 's/^/[entrypoint]   /' /tmp/prisma-global.log >&2 || true
  log "El servidor arrancará igual. Revisa con: docker compose exec backend npm run prisma:push:global"
fi

# ---- 3. Administrador inicial desde el entorno (idempotente) ----
# Si defines SEED_EMAIL + SEED_PASSWORD en el .env, el admin se crea/actualiza
# en cada arranque. Con COMPANY_* además crea la primera empresa (una sola vez).
if [ -n "${SEED_EMAIL:-}" ] && [ -n "${SEED_PASSWORD:-}" ]; then
  log "Aplicando administrador inicial (${SEED_EMAIL})..."
  if npm run bootstrap; then
    log "Administrador inicial listo."
  else
    log "AVISO: el bootstrap del administrador falló (continuo con el arranque)."
  fi
else
  log "Sin SEED_EMAIL/SEED_PASSWORD: no se crea administrador automáticamente."
fi

# ---- 4. Arrancar el servidor ----
log "Iniciando API..."
exec "$@"
