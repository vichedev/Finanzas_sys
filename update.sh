#!/usr/bin/env bash
# =====================================================
# Finanzas Mensuales — Actualizador
# Trae los últimos cambios, reconstruye y aplica migraciones
# Uso: sudo bash update.sh [--rebuild-all]
# =====================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/finanzas}"
REBUILD_ALL=0

for arg in "$@"; do
  case "$arg" in
    --rebuild-all) REBUILD_ALL=1 ;;
    -h|--help)
      echo "Uso: bash update.sh [--rebuild-all]"
      echo "  --rebuild-all   Reconstruye backend y frontend (lento). Sin este flag solo frontend."
      exit 0
      ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "Ejecuta con sudo." >&2; exit 1; fi
if [[ ! -d "$APP_DIR/.git" ]]; then echo "No se encontró $APP_DIR. Corre install.sh primero." >&2; exit 1; fi

cd "$APP_DIR"

echo "→ git pull"
PREV=$(git rev-parse --short HEAD)
git pull --ff-only
CURR=$(git rev-parse --short HEAD)

if [[ "$PREV" == "$CURR" ]]; then
  echo "✓ Ya está al día ($CURR). Nada que hacer."
  exit 0
fi

echo "→ Cambios: $PREV → $CURR"

# Detectar si backend o schema cambiaron para decidir si reconstruir backend
BACKEND_CHANGED=0
if git diff --name-only "$PREV" "$CURR" | grep -qE "^backend/|^docker-compose.yml"; then
  BACKEND_CHANGED=1
fi

if [[ "$REBUILD_ALL" == "1" || "$BACKEND_CHANGED" == "1" ]]; then
  echo "→ Reconstruyendo todos los servicios..."
  docker compose up -d --build
else
  echo "→ Reconstruyendo solo frontend..."
  docker compose up -d --build --no-deps frontend
fi

# Esperar backend healthy
for i in $(seq 1 30); do
  status=$(docker inspect -f "{{.State.Health.Status}}" finanzas_backend 2>/dev/null || echo "starting")
  [[ "$status" == "healthy" ]] && break
  sleep 2
done

# Si cambió el schema global, aplicar db push solo al schema global
if git diff --name-only "$PREV" "$CURR" | grep -q "prisma/global/schema.prisma"; then
  echo "→ Aplicando cambios al schema global (prisma db push global)..."
  docker compose exec -T backend npm run prisma:push:global || true
fi

# El schema tenant no se aplica con db push directo (cada tenant tiene su DB).
# Si hay un script de migración tenant nuevo, el operador lo corre manualmente:
#   docker compose exec backend npx tsx scripts/<script>.ts
if git diff --name-only "$PREV" "$CURR" | grep -q "prisma/tenant/schema.prisma"; then
  echo
  echo "⚠️  Detecté cambios en prisma/tenant/schema.prisma."
  echo "   Si añadiste columnas/enums nuevos, corré el script de migración tenant correspondiente, ej.:"
  echo "     docker compose exec backend npx tsx scripts/migrate-add-expense-kind.ts"
  echo
fi

echo
docker compose ps --format "{{.Name}}: {{.Status}}"
echo
echo "✓ Actualización completada"
