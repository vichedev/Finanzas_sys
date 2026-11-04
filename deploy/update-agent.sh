#!/usr/bin/env bash
# =====================================================
# Agente de actualización (corre en el HOST, por cron cada minuto).
# El backend (en su contenedor) deja una señal en .update-channel/request con
# "check" o "apply"; este agente la procesa: busca actualizaciones o aplica el
# git pull + rebuild + up + sync de tenants. Escribe el estado para la UI.
#
# Instalación con systemd (recomendada; respuesta INSTANTÁNEA vía .path):
#   mkdir -p /opt/finanzas/.update-channel && chmod 777 /opt/finanzas/.update-channel
#   cp /opt/finanzas/deploy/finanzas-update.service /etc/systemd/system/
#   cp /opt/finanzas/deploy/finanzas-update.timer   /etc/systemd/system/
#   cp /opt/finanzas/deploy/finanzas-update.path    /etc/systemd/system/
#   systemctl daemon-reload
#   systemctl enable --now finanzas-update.timer finanzas-update.path
#   # El .path dispara el agente al instante cuando la UI deja una petición (inotify);
#   # el .timer solo mantiene el latido y actúa de respaldo.
#
# Alternativa con cron (si no hay systemd):
#   ( crontab -l 2>/dev/null; echo '* * * * * REPO_DIR=/opt/finanzas bash /opt/finanzas/deploy/update-agent.sh >> /var/log/finanzas-update.log 2>&1' ) | crontab -
# =====================================================
set -uo pipefail

# El cron trae un PATH mínimo: aseguramos que encuentre git y docker.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

REPO="${REPO_DIR:-/opt/finanzas}"
# git rechaza repos con "dueño dudoso" cuando corre por cron; lo marcamos seguro.
git config --global --add safe.directory "$REPO" 2>/dev/null || true
CH="$REPO/.update-channel"
BRANCH="${UPDATE_BRANCH:-main}"
mkdir -p "$CH"

# Un solo agente a la vez (una actualización puede tardar varios minutos).
exec 9>"$CH/.lock"
flock -n 9 || exit 0

ver()  { git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown; }
now()  { date -Iseconds; }

# Latido: deja la versión actual y la hora, para que la UI sepa que el agente vive.
printf 'version=%s\nat=%s\n' "$(ver)" "$(now)" > "$CH/heartbeat"

# Sin solicitud pendiente, nada más que hacer.
[ -f "$CH/request" ] || exit 0
action="$(tr -dc 'a-z' < "$CH/request")"
rm -f "$CH/request"

if [ "$action" = "check" ]; then
  printf 'state=checking\nversion=%s\ncheckedAt=%s\n' "$(ver)" "$(now)" > "$CH/status"
  git -C "$REPO" fetch --quiet origin "$BRANCH" 2>/dev/null
  behind="$(git -C "$REPO" rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)"
  git -C "$REPO" log --format='%s' "HEAD..origin/$BRANCH" 2>/dev/null | head -12 > "$CH/commits.txt"
  printf 'state=idle\nversion=%s\nbehind=%s\ncheckedAt=%s\n' "$(ver)" "$behind" "$(now)" > "$CH/status"

elif [ "$action" = "apply" ]; then
  printf 'state=updating\nversion=%s\nstartedAt=%s\n' "$(ver)" "$(now)" > "$CH/status"
  {
    set -e
    cd "$REPO"
    echo "== git fetch/reset =="; git fetch --quiet origin "$BRANCH"; git reset --hard "origin/$BRANCH"
    echo "== docker compose build =="; docker compose build backend frontend
    echo "== docker compose up -d =="; docker compose up -d
    echo "== esperando backend =="; sleep 15
    echo "== sync tenants =="; docker compose exec -T backend npm run sync:tenants:prod || echo "sync omitido/falló (continúa)"
    echo "== LISTO =="
  } > "$CH/update.log" 2>&1
  rc=$?
  : > "$CH/commits.txt"
  if [ "$rc" -eq 0 ]; then
    printf 'state=done\nversion=%s\nbehind=0\nupdatedAt=%s\n' "$(ver)" "$(now)" > "$CH/status"
  else
    printf 'state=error\nversion=%s\nerror=%s\nupdatedAt=%s\n' "$(ver)" "La actualización falló. Revisa el log." "$(now)" > "$CH/status"
  fi
fi
