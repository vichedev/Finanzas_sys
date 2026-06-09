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

if [[ "$PREV" == "$CURR" && "$REBUILD_ALL" != "1" ]]; then
  echo "✓ Ya está al día ($CURR). Nada que hacer."
  echo "  (Si actualizaste y no ves cambios, fuerza la reconstrucción: bash update.sh --rebuild-all)"
  exit 0
fi

if [[ "$PREV" == "$CURR" ]]; then
  echo "→ Sin commits nuevos, pero --rebuild-all forzará reconstrucción y sincronización."
else
  echo "→ Cambios: $PREV → $CURR"
fi

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

# Si cambió el schema global (o se fuerza), aplicar db push del schema global
if [[ "$REBUILD_ALL" == "1" ]] || git diff --name-only "$PREV" "$CURR" | grep -q "prisma/global/schema.prisma"; then
  echo "→ Sincronizando el schema global..."
  docker compose exec -T backend npm run prisma:push:global || true
fi

# El schema tenant no se aplica con db push directo (cada tenant tiene su DB).
# sync:tenants:prod recorre TODAS las BD de empresas y aplica el schema tenant
# actual (aditivo e idempotente: agrega tablas/columnas nuevas como Invoice).
if [[ "$REBUILD_ALL" == "1" ]] || git diff --name-only "$PREV" "$CURR" | grep -q "prisma/tenant/schema.prisma"; then
  echo "→ Sincronizando el schema de todas las empresas..."
  if docker compose exec -T backend npm run sync:tenants:prod; then
    echo "✓ Schema tenant sincronizado en todas las empresas."
  else
    echo "⚠️  La sincronización de tenants falló. Córrela manualmente y revisa los logs:"
    echo "     docker compose exec backend npm run sync:tenants:prod"
  fi
fi

echo
docker compose ps --format "{{.Name}}: {{.Status}}"
echo
echo "✓ Actualización completada"
