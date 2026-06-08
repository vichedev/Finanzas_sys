#!/usr/bin/env bash
# =====================================================
# Finanzas Mensuales — Instalador para VPS Linux
# Compatible con Debian 11+, Ubuntu 22+, AlmaLinux 9, Rocky 9
# Uso: sudo bash install.sh
# =====================================================
set -euo pipefail

# ---------- Colores ----------
if [[ -t 1 ]]; then
  C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'; C_YEL=$'\033[1;33m'
  C_BLU=$'\033[1;34m'; C_CYN=$'\033[1;36m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_CYN=""; C_DIM=""; C_END=""
fi

say()  { printf "%s\n" "$*"; }
info() { printf "${C_BLU}ℹ${C_END}  %s\n" "$*"; }
ok()   { printf "${C_GRN}✓${C_END}  %s\n" "$*"; }
warn() { printf "${C_YEL}⚠${C_END}  %s\n" "$*"; }
err()  { printf "${C_RED}✗${C_END}  %s\n" "$*" >&2; }
step() { printf "\n${C_CYN}━━ %s ━━${C_END}\n" "$*"; }

# ---------- Defaults ----------
APP_DIR="${APP_DIR:-/opt/finanzas}"
REPO_URL="${REPO_URL:-https://github.com/vichedev/Finanzas_sys.git}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_NAME="${ADMIN_NAME:-Administrador}"
SETUP_UFW="${SETUP_UFW:-ask}"      # ask | yes | no
ALLOWED_NET="${ALLOWED_NET:-0.0.0.0/0}"
SETUP_FAIL2BAN="${SETUP_FAIL2BAN:-ask}"
SETUP_SWAP="${SETUP_SWAP:-ask}"
CREDS_FILE="${CREDS_FILE:-/root/finanzas-credenciales.txt}"

NON_INTERACTIVE="${NON_INTERACTIVE:-0}"

# Lee siempre del terminal (/dev/tty), NO de stdin. Esto permite que el
# instalador funcione tanto como archivo local (sudo bash install.sh) como
# por tubería (curl ... | sudo bash), donde stdin es el propio script y un
# `read` normal lo corrompería ("syntax error near fi").
TTY_OK=0
if [[ -r /dev/tty ]]; then TTY_OK=1; fi

ask_yn() {
  local prompt="$1"; local default="${2:-y}"
  if [[ "$NON_INTERACTIVE" == "1" || "$TTY_OK" != "1" ]]; then echo "$default"; return; fi
  local yn
  read -r -p "$(printf "${C_YEL}? %s [%s/%s]: ${C_END}" "$prompt" \
    "$([[ $default == y ]] && echo Y || echo y)" \
    "$([[ $default == y ]] && echo n || echo N)")" yn < /dev/tty || true
  yn="${yn:-$default}"
  case "${yn,,}" in y|yes|s|si) echo y ;; *) echo n ;; esac
}

ask_str() {
  local prompt="$1"; local default="${2:-}"
  if [[ "$NON_INTERACTIVE" == "1" || "$TTY_OK" != "1" ]]; then echo "$default"; return; fi
  local val
  if [[ -n "$default" ]]; then
    read -r -p "$(printf "${C_YEL}? %s [%s]: ${C_END}" "$prompt" "$default")" val < /dev/tty || true
    echo "${val:-$default}"
  else
    read -r -p "$(printf "${C_YEL}? %s: ${C_END}" "$prompt")" val < /dev/tty || true
    echo "$val"
  fi
}

ask_pass() {
  local prompt="$1"
  if [[ "$NON_INTERACTIVE" == "1" || "$TTY_OK" != "1" ]]; then echo ""; return; fi
  local val
  read -rs -p "$(printf "${C_YEL}? %s: ${C_END}" "$prompt")" val < /dev/tty || true
  echo "" >&2
  echo "$val"
}

# ---------- 1. Verificaciones previas ----------
step "1/9  Verificaciones del sistema"

if [[ $EUID -ne 0 ]]; then
  err "Este script debe correrse como root. Usa: sudo bash install.sh"
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  err "No se pudo detectar el sistema operativo."
  exit 1
fi

# shellcheck source=/dev/null
. /etc/os-release
OS_ID="${ID:-unknown}"
OS_VER="${VERSION_ID:-0}"
info "Sistema detectado: $PRETTY_NAME"

PKG_MGR=""
case "$OS_ID" in
  debian|ubuntu) PKG_MGR="apt" ;;
  almalinux|rocky|centos|rhel|fedora) PKG_MGR="dnf" ;;
  *) err "Distribución no soportada: $OS_ID. Probado en Debian, Ubuntu, AlmaLinux, Rocky."; exit 1 ;;
esac
ok "Gestor de paquetes: $PKG_MGR"

# Verificar RAM y disco
RAM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
DISK_AVAIL_MB=$(df -m / | awk 'NR==2{print $4}')
info "RAM total: ${RAM_MB} MB · Disco libre: ${DISK_AVAIL_MB} MB"
if (( RAM_MB < 1500 )); then warn "RAM por debajo de 1.5 GB. Se recomienda crear swap (paso 3)."; fi
if (( DISK_AVAIL_MB < 5000 )); then err "Se requieren al menos 5 GB libres en /."; exit 1; fi

# ---------- 2. Instalar paquetes base ----------
step "2/9  Paquetes base (curl, git, openssl, ca-certificates)"

if [[ "$PKG_MGR" == "apt" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git openssl >/dev/null
else
  dnf install -y -q ca-certificates curl gnupg2 git openssl >/dev/null
fi
ok "Paquetes base instalados"

# ---------- 3. Swap (opcional) ----------
step "3/9  Swap"

if swapon --show | grep -q .; then
  ok "Swap ya está activa: $(swapon --show --noheadings | awk '{print $3}' | head -1)"
else
  ans="$SETUP_SWAP"
  if [[ "$ans" == "ask" ]]; then ans=$(ask_yn "Crear archivo swap de 2 GB para evitar OOM?" y); fi
  if [[ "$ans" == "y" ]] || [[ "$ans" == "yes" ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
    ok "Swap 2 GB creada y persistida en /etc/fstab"
  else
    warn "Saltado: swap no se creó"
  fi
fi

# ---------- 4. Docker ----------
step "4/9  Docker y Docker Compose plugin"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) ya instalado"
else
  info "Instalando Docker desde el repositorio oficial..."
  if [[ "$PKG_MGR" == "apt" ]]; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${OS_ID} ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  else
    dnf -y install dnf-plugins-core >/dev/null
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1 || \
      dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo >/dev/null 2>&1 || true
    dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  fi
  systemctl enable --now docker
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,) instalado"
fi

# ---------- 5. Firewall (opcional) ----------
step "5/9  Firewall"

ans="$SETUP_UFW"
if [[ "$ans" == "ask" ]]; then ans=$(ask_yn "Configurar firewall (UFW/firewalld) para permitir solo SSH+HTTP?" y); fi

if [[ "$ans" == "y" ]] || [[ "$ans" == "yes" ]]; then
  net="$ALLOWED_NET"
  if [[ "$NON_INTERACTIVE" != "1" ]] && [[ "$net" == "0.0.0.0/0" ]]; then
    net=$(ask_str "Rango de IPs permitido (CIDR, ej. 203.0.113.0/24 o 0.0.0.0/0 para abierto)" "0.0.0.0/0")
  fi

  if [[ "$PKG_MGR" == "apt" ]]; then
    apt-get install -y -qq ufw >/dev/null
    ufw --force reset >/dev/null
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
    ufw allow from "$net" to any port 22 proto tcp comment "SSH" >/dev/null
    ufw allow from "$net" to any port 80 proto tcp comment "HTTP" >/dev/null
    ufw --force enable >/dev/null
    ok "UFW configurado (22, 80) desde $net"
  else
    dnf install -y -q firewalld >/dev/null
    systemctl enable --now firewalld
    firewall-cmd --permanent --add-service=ssh >/dev/null
    firewall-cmd --permanent --add-service=http >/dev/null
    firewall-cmd --reload >/dev/null
    ok "firewalld configurado (ssh, http)"
  fi
else
  warn "Saltado: firewall no se configuró"
fi

# ---------- 6. fail2ban (opcional) ----------
step "6/9  fail2ban"

if systemctl is-active fail2ban >/dev/null 2>&1; then
  ok "fail2ban ya está activo"
else
  ans="$SETUP_FAIL2BAN"
  if [[ "$ans" == "ask" ]]; then ans=$(ask_yn "Instalar fail2ban para proteger SSH?" y); fi
  if [[ "$ans" == "y" ]] || [[ "$ans" == "yes" ]]; then
    if [[ "$PKG_MGR" == "apt" ]]; then
      apt-get install -y -qq fail2ban >/dev/null
    else
      dnf install -y -q fail2ban >/dev/null
    fi
    systemctl enable --now fail2ban
    ok "fail2ban activo con jail sshd"
  else
    warn "Saltado: fail2ban no se instaló"
  fi
fi

# ---------- 7. Clonar / actualizar el repo ----------
step "7/9  Repositorio en $APP_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  info "Actualizando repo existente..."
  git -C "$APP_DIR" pull --ff-only
  ok "Repo actualizado: $(git -C "$APP_DIR" rev-parse --short HEAD)"
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
  ok "Repo clonado: $(git -C "$APP_DIR" rev-parse --short HEAD)"
fi
cd "$APP_DIR"

# ---------- 8. Configuración (.env) ----------
step "8/9  Configuración (.env y secretos)"

# Detectar IP pública para CORS_ORIGIN
PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo "")
if [[ -z "$PUBLIC_IP" ]]; then PUBLIC_IP=$(hostname -I | awk '{print $1}'); fi
CORS_ORIGIN="${CORS_ORIGIN:-http://$PUBLIC_IP}"
info "CORS_ORIGIN = $CORS_ORIGIN"

FRESH_ENV=0

# --- Credenciales del administrador inicial (se siembran desde el .env) ---
if [[ -z "$ADMIN_EMAIL" ]]; then
  ADMIN_EMAIL=$(ask_str "Email del administrador (SuperAdmin, dueño de la plataforma)" "admin@$(hostname -f 2>/dev/null || echo finanzas.local)")
fi
if [[ -z "$ADMIN_NAME" || "$ADMIN_NAME" == "Administrador" ]]; then
  ADMIN_NAME=$(ask_str "Nombre del administrador" "Administrador")
fi
if [[ -z "$ADMIN_PASSWORD" || ${#ADMIN_PASSWORD} -lt 10 ]]; then
  ADMIN_PASSWORD=$(ask_pass "Contraseña del administrador (mín. 10 caracteres; vacío = aleatoria)")
  if [[ -z "$ADMIN_PASSWORD" || ${#ADMIN_PASSWORD} -lt 10 ]]; then
    ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  fi
fi

# ¿Crear también la primera empresa en el primer arranque?
create_company=n
if [[ "$NON_INTERACTIVE" != "1" ]]; then
  create_company=$(ask_yn "¿Crear también tu primera empresa en el primer arranque?" y)
else
  create_company=$([[ -n "${COMPANY_NAME:-}" ]] && echo y || echo n)
fi
if [[ "$create_company" == "y" ]]; then
  COMPANY_NAME=${COMPANY_NAME:-$(ask_str "Nombre de la empresa" "Mi Empresa")}
  COMPANY_EMAIL=${COMPANY_EMAIL:-$(ask_str "Email del admin de la empresa" "$ADMIN_EMAIL")}
  COMPANY_ADMIN_NAME=${COMPANY_ADMIN_NAME:-$(ask_str "Nombre del admin de la empresa" "Administrador")}
  if [[ -z "${COMPANY_ADMIN_PASSWORD:-}" || ${#COMPANY_ADMIN_PASSWORD} -lt 8 ]]; then
    COMPANY_ADMIN_PASSWORD=$(ask_pass "Contraseña del admin de la empresa (mín. 8; vacío = aleatoria)")
    if [[ -z "$COMPANY_ADMIN_PASSWORD" || ${#COMPANY_ADMIN_PASSWORD} -lt 8 ]]; then
      COMPANY_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)
    fi
  fi
fi

if [[ ! -f backend/.env ]]; then
  FRESH_ENV=1
  JWT_SECRET=$(openssl rand -hex 48)
  TENANT_ENCRYPTION_KEY=$(openssl rand -hex 32)
  PG_PASS=$(openssl rand -base64 24 | tr -d '/+=')

  # Un único backend/.env configura todo. La BD se define POR PARTES (no una URL
  # en una línea); el backend deriva las URLs internamente. POSTGRES_DB es la DB
  # GLOBAL; cada empresa creada obtiene su propia DB finanzas_t_* automáticamente.
  cat > backend/.env <<EOF
# ===== Finanzas — generado por install.sh $(date -Iseconds) =====

# ---- Base de datos PostgreSQL (por partes) ----
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=finanzas_user
POSTGRES_PASSWORD=$PG_PASS
POSTGRES_DB=finanzas_global

# ---- Seguridad ----
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=1d
TENANT_ENCRYPTION_KEY=$TENANT_ENCRYPTION_KEY

# ---- Aplicación ----
NODE_ENV=production
PORT=4000
CORS_ORIGIN=$CORS_ORIGIN

# ---- Administrador inicial (se crea/actualiza en cada arranque) ----
SEED_EMAIL=$ADMIN_EMAIL
SEED_PASSWORD=$ADMIN_PASSWORD
SEED_NAME=$ADMIN_NAME
EOF

  if [[ "$create_company" == "y" ]]; then
    cat >> backend/.env <<EOF

# ---- Primera empresa (se crea una sola vez en el primer arranque) ----
COMPANY_NAME=$COMPANY_NAME
COMPANY_EMAIL=$COMPANY_EMAIL
COMPANY_ADMIN_NAME=$COMPANY_ADMIN_NAME
COMPANY_ADMIN_PASSWORD=$COMPANY_ADMIN_PASSWORD
EOF
  fi
  chmod 600 backend/.env

  cat > "$CREDS_FILE" <<EOF
=== Finanzas — credenciales generadas $(date -Iseconds) ===
POSTGRES_PASSWORD=$PG_PASS
JWT_SECRET=$JWT_SECRET
TENANT_ENCRYPTION_KEY=$TENANT_ENCRYPTION_KEY
CORS_ORIGIN=$CORS_ORIGIN
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
ADMIN_NAME=$ADMIN_NAME
EOF
  if [[ "$create_company" == "y" ]]; then
    {
      echo "COMPANY_NAME=$COMPANY_NAME"
      echo "COMPANY_EMAIL=$COMPANY_EMAIL"
      echo "COMPANY_ADMIN_PASSWORD=$COMPANY_ADMIN_PASSWORD"
    } >> "$CREDS_FILE"
  fi
  chmod 600 "$CREDS_FILE"
  ok "Secretos y administrador guardados en $CREDS_FILE"
else
  ok "backend/.env ya existe — se preserva (no se modifica el administrador)"
fi

# ---------- 9. Build, up, db push y bootstrap admin ----------
step "9/9  Construyendo y levantando servicios"

info "Construyendo imágenes (puede tardar 3-8 min la primera vez)..."
docker compose build --quiet

info "Levantando containers..."
docker compose up -d

# Esperar postgres healthy
info "Esperando que postgres esté listo..."
for i in $(seq 1 30); do
  if [[ "$(docker inspect -f "{{.State.Health.Status}}" finanzas_postgres 2>/dev/null)" == "healthy" ]]; then
    break
  fi
  sleep 2
done

# Esperar backend healthy
info "Esperando que backend esté listo..."
for i in $(seq 1 30); do
  if [[ "$(docker inspect -f "{{.State.Health.Status}}" finanzas_backend 2>/dev/null)" == "healthy" ]]; then
    break
  fi
  sleep 2
done

# El schema global lo sincroniza el entrypoint del backend al arrancar.
# Verificamos que ya esté aplicado (la tabla SuperAdmin debe existir).
set -a; . ./backend/.env; set +a
info "Verificando el schema global..."
HAS_SCHEMA=""
for i in $(seq 1 15); do
  HAS_SCHEMA=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" finanzas_postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "SELECT to_regclass('public.\"SuperAdmin\"') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]' || echo "")
  [[ "$HAS_SCHEMA" == "t" ]] && break
  sleep 2
done
if [[ "$HAS_SCHEMA" == "t" ]]; then
  ok "Schema global sincronizado"
else
  warn "El schema global no aparece todavía. Forzando push manual..."
  docker compose exec -T backend npm run prisma:push:global || \
    warn "No se pudo sincronizar el schema (revisa: docker compose logs backend)"
fi

# ---------- Verificar el administrador inicial ----------
# El entrypoint del backend lo crea a partir de SEED_*/COMPANY_* del .env.
info "Verificando el administrador inicial..."
SUPERADMIN_COUNT=0
for i in $(seq 1 10); do
  SUPERADMIN_COUNT=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" finanzas_postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'SELECT COUNT(*) FROM "SuperAdmin";' 2>/dev/null | tr -d '[:space:]' || echo 0)
  [[ "${SUPERADMIN_COUNT:-0}" -ge 1 ]] && break
  sleep 2
done

if [[ "${SUPERADMIN_COUNT:-0}" -ge 1 ]]; then
  ok "Administrador inicial listo: $ADMIN_EMAIL"
else
  warn "El administrador no aparece todavía. Forzando bootstrap..."
  docker compose exec -T backend npm run bootstrap || \
    warn "No se pudo crear el administrador (revisa: docker compose logs backend)"
fi

# ---------- Reporte final ----------
echo
say "${C_GRN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_END}"
say "${C_GRN}  ✓  Instalación completada${C_END}"
say "${C_GRN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_END}"
echo
say "URLs:"
say "  ${C_CYN}App:${C_END}      http://$PUBLIC_IP/"
say "  ${C_CYN}API:${C_END}      http://127.0.0.1:4000/api/health  (solo localhost)"
echo
say "${C_DIM}BD: para administrarla con tu pgAdmin local, abre un túnel SSH al puerto 5437:${C_END}"
say "${C_DIM}    ssh -L 5437:127.0.0.1:5437 root@$PUBLIC_IP   →  conecta a localhost:5437${C_END}"
echo
say "Credenciales guardadas en: ${C_YEL}$CREDS_FILE${C_END} (chmod 600)"
echo
if [[ "${FRESH_ENV:-0}" == "1" ]]; then
  say "SuperAdmin (dueño de la plataforma):"
  say "  ${C_CYN}Email:${C_END}     $ADMIN_EMAIL"
  say "  ${C_CYN}Password:${C_END}  $ADMIN_PASSWORD"
  if [[ "${create_company:-n}" == "y" ]]; then
    echo
    say "Primera empresa: ${C_CYN}${COMPANY_NAME}${C_END}"
    say "  Admin de la empresa: ${C_CYN}${COMPANY_EMAIL}${C_END} / ${C_CYN}${COMPANY_ADMIN_PASSWORD}${C_END}"
  else
    echo
    say "${C_DIM}Entra como SuperAdmin y crea tu primera empresa desde el panel \"Empresas\".${C_END}"
  fi
  warn "Guarda estas contraseñas y cámbialas tras el primer login."
fi
echo
say "Comandos útiles:"
say "  ${C_DIM}Ver estado:${C_END}    docker compose -f $APP_DIR/docker-compose.yml ps"
say "  ${C_DIM}Ver logs:${C_END}      docker compose -f $APP_DIR/docker-compose.yml logs -f backend"
say "  ${C_DIM}Actualizar:${C_END}    bash $APP_DIR/update.sh"
say "  ${C_DIM}Backup DB:${C_END}     bash $APP_DIR/scripts/backup.sh"
echo
warn "TLS: actualmente la app sirve HTTP plano. Para producción usa Cloudflare Tunnel o Caddy/Let's Encrypt."
echo
