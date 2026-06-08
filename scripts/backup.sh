#!/bin/bash
# =====================================================
# Finanzas — Backup multi-empresa
# Respalda la DB global Y la DB de cada empresa (finanzas_t_*).
# Las empresas se descubren desde la tabla TenantConnection del global.
#
# Variables opcionales:
#   APP_DIR (def. /opt/finanzas)        BACKUP_DEST (def. /var/backups/finanzas)
#   BACKUP_RETENTION_DAYS (def. 30)     PG_CONTAINER (def. finanzas_postgres)
#   BACKUP_GPG_PASSPHRASE  -> cifra cada dump con AES256
# =====================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/finanzas}"
DEST="${BACKUP_DEST:-/var/backups/finanzas}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
CONTAINER="${PG_CONTAINER:-finanzas_postgres}"

# ---- Cargar credenciales ----
if [[ -r "$APP_DIR/.env" ]]; then
  set -a; . "$APP_DIR/.env"; set +a
elif [[ -r /root/.finanzas_secrets ]]; then
  # compat con instalaciones antiguas
  source /root/.finanzas_secrets
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-${PG_PASS:-}}"
else
  echo "No encuentro $APP_DIR/.env ni /root/.finanzas_secrets" >&2
  exit 1
fi

PGUSER="${POSTGRES_USER:-finanzas_user}"
PGPASS="${POSTGRES_PASSWORD:-}"
GLOBAL_DB="${POSTGRES_DB:-finanzas_global}"
[[ -n "$PGPASS" ]] || { echo "POSTGRES_PASSWORD vacío en el .env" >&2; exit 1; }

mkdir -p "$DEST"
TS=$(date +%F_%H%M)

# Dump de una DB -> $DEST/<db>_<ts>.sql.gz (+ .gpg opcional)
dump_db() {
  local db="$1"
  local out="$DEST/${db}_${TS}.sql.gz"
  local tmp; tmp=$(mktemp "$DEST/.tmp.XXXXXX")
  if docker exec -e PGPASSWORD="$PGPASS" "$CONTAINER" \
       pg_dump -U "$PGUSER" -Fc "$db" 2>/dev/null | gzip > "$tmp"; then
    mv "$tmp" "$out"; chmod 600 "$out"
    if [[ -n "${BACKUP_GPG_PASSPHRASE:-}" ]]; then
      command -v gpg >/dev/null 2>&1 || { echo "BACKUP_GPG_PASSPHRASE definida pero gpg no está instalado." >&2; exit 1; }
      gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase "$BACKUP_GPG_PASSPHRASE" --output "${out}.gpg" "$out"
      rm -f "$out"; out="${out}.gpg"; chmod 600 "$out"
    fi
    echo "  ✓ ${db} → $(basename "$out")"
  else
    rm -f "$tmp"
    echo "  ✗ Falló el dump de ${db}" >&2
    return 1
  fi
}

echo "→ Backup de la DB global (${GLOBAL_DB})"
dump_db "$GLOBAL_DB"

echo "→ Backup de las empresas (finanzas_t_*)"
TENANT_DBS=$(docker exec -e PGPASSWORD="$PGPASS" "$CONTAINER" \
  psql -U "$PGUSER" -d "$GLOBAL_DB" -tAc \
  'SELECT "dbName" FROM "TenantConnection" ORDER BY "dbName";' 2>/dev/null || echo "")

if [[ -z "${TENANT_DBS// /}" ]]; then
  echo "  (sin empresas registradas todavía)"
else
  while IFS= read -r db; do
    db="$(echo "$db" | tr -d '[:space:]')"
    [[ -n "$db" ]] && dump_db "$db"
  done <<< "$TENANT_DBS"
fi

# ---- Retención ----
find "$DEST" -name "*.sql.gz"     -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
find "$DEST" -name "*.sql.gz.gpg" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

echo "✓ Backup completado en $DEST"
