<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { securityApi, type BlockedIp, type LockedAccount, type LoginEvent, type LoginEventType } from '../api/security';
import { useAuthStore } from '../stores/auth';
import { useConfirm } from '../composables/useConfirm';

const auth = useAuthStore();
const { confirm, alert } = useConfirm();

const PAGE_SIZE = 50;

const EVENT_LABEL: Record<LoginEventType, string> = {
  LOGIN_SUCCESS: 'Acceso correcto',
  LOGIN_FAILED: 'Intento fallido',
  LOCKED_ATTEMPT: 'Intento en cuenta bloqueada',
  ACCOUNT_LOCKED: 'Cuenta bloqueada',
  ACCOUNT_UNLOCKED: 'Cuenta desbloqueada',
  IP_BLOCKED: 'IP bloqueada',
  IP_UNBLOCKED: 'IP desbloqueada'
};
const EVENT_TONE: Record<LoginEventType, string> = {
  LOGIN_SUCCESS: 'ok',
  LOGIN_FAILED: 'warn',
  LOCKED_ATTEMPT: 'warn',
  ACCOUNT_LOCKED: 'bad',
  ACCOUNT_UNLOCKED: 'info',
  IP_BLOCKED: 'bad',
  IP_UNBLOCKED: 'info'
};
const REASON_LABEL: Record<string, string> = {
  UNKNOWN_ACCOUNT: 'La cuenta no existe',
  BAD_CREDENTIALS: 'Contraseña incorrecta',
  ACCOUNT_LOCKED: 'La cuenta estaba bloqueada',
  ACCOUNT_INACTIVE: 'Cuenta o empresa inactiva'
};
const EVENT_TYPES = Object.keys(EVENT_LABEL) as LoginEventType[];

const events = ref<LoginEvent[]>([]);
const total = ref(0);
const accounts = ref<LockedAccount[]>([]);
const ips = ref<BlockedIp[]>([]);
const typeFilter = ref<LoginEventType | ''>('');
const search = ref('');
const offset = ref(0);
const loading = ref(false);
const errorMsg = ref('');

const pageLabel = computed(() => {
  if (!total.value) return 'Sin eventos';
  return `${offset.value + 1}–${Math.min(offset.value + PAGE_SIZE, total.value)} de ${total.value}`;
});

const dateFormat = new Intl.DateTimeFormat('es-EC', {
  timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'medium'
});
const formatDate = (value: string) => dateFormat.format(new Date(value));

function eventDetail(event: LoginEvent): string {
  if (event.reason) return REASON_LABEL[event.reason] ?? event.reason;
  const meta = event.metadata;
  if (event.type === 'IP_BLOCKED' && meta) {
    return `${meta.failures} fallos en ${meta.accounts} cuentas, hasta ${formatDate(String(meta.until))}`;
  }
  if (meta?.by) return `Por ${meta.by}`;
  return '';
}

async function load() {
  loading.value = true;
  errorMsg.value = '';
  try {
    const [eventData, blockData] = await Promise.all([
      securityApi.events({
        type: typeFilter.value || undefined,
        search: search.value.trim() || undefined,
        limit: PAGE_SIZE,
        offset: offset.value
      }),
      securityApi.blocks()
    ]);
    events.value = eventData.events;
    total.value = eventData.total;
    accounts.value = blockData.accounts;
    ips.value = blockData.ips;
  } catch {
    errorMsg.value = 'No se pudieron cargar los eventos de seguridad.';
  } finally {
    loading.value = false;
  }
}

function applyFilters() {
  offset.value = 0;
  load();
}

function movePage(delta: number) {
  offset.value = Math.max(0, offset.value + delta * PAGE_SIZE);
  load();
}

watch(typeFilter, applyFilters);

async function unlockAccount(account: LockedAccount) {
  const accepted = await confirm({
    title: 'Desbloquear cuenta',
    message: `¿Desbloquear a ${account.email}? Podrá volver a intentar el acceso de inmediato.`,
    confirmText: 'Desbloquear'
  });
  if (!accepted) return;
  try {
    await securityApi.unlockAccount(account.kind, account.id);
    await load();
  } catch {
    await alert('No se pudo desbloquear la cuenta.');
  }
}

async function unblockIp(block: BlockedIp) {
  const accepted = await confirm({
    title: 'Desbloquear IP',
    message: `¿Desbloquear ${block.ip}? Si fue un ataque, podrá volver a intentarlo.`,
    confirmText: 'Desbloquear'
  });
  if (!accepted) return;
  try {
    await securityApi.unblockIp(block.ip);
    await load();
  } catch {
    await alert('No se pudo desbloquear la IP.');
  }
}

onMounted(load);
</script>

<template>
  <div class="security">
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div class="panel">
      <div class="panel-header">
        <div>
          <h2>Bloqueos activos</h2>
          <p class="info-text">
            Una cuenta se bloquea 15 minutos tras 5 intentos fallidos.
            <template v-if="auth.isSuper">Una IP se bloquea tras 20 fallos sobre 5 o más cuentas distintas en 15 minutos.</template>
          </p>
        </div>
      </div>

      <h3 class="block-title">Cuentas ({{ accounts.length }})</h3>
      <p v-if="!accounts.length" class="empty">No hay cuentas bloqueadas.</p>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr><th>Cuenta</th><th v-if="auth.isSuper">Empresa</th><th>Hasta</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="account in accounts" :key="account.kind + account.id">
              <td>{{ account.email }}</td>
              <td v-if="auth.isSuper">{{ account.company || 'Plataforma' }}</td>
              <td>{{ formatDate(account.lockedUntil) }}</td>
              <td class="row-action"><button type="button" class="mini" @click="unlockAccount(account)">Desbloquear</button></td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-if="auth.isSuper">
        <h3 class="block-title">Direcciones IP ({{ ips.length }})</h3>
        <p v-if="!ips.length" class="empty">No hay direcciones IP bloqueadas.</p>
        <div v-else class="table-scroll">
          <table>
            <thead>
              <tr><th>IP</th><th>Motivo</th><th>Rechazados</th><th>Hasta</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="block in ips" :key="block.ip">
                <td>{{ block.ip }}</td>
                <td>{{ block.failureCount }} fallos en {{ block.accountCount }} cuentas</td>
                <td>{{ block.blockedAttempts }}</td>
                <td>{{ formatDate(block.blockedUntil) }}</td>
                <td class="row-action"><button type="button" class="mini" @click="unblockIp(block)">Desbloquear</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div>
          <h2>Eventos de acceso</h2>
          <p class="info-text">Se conservan 90 días. Las horas están en hora de Ecuador.</p>
        </div>
        <button type="button" :disabled="loading" @click="load">{{ loading ? 'Actualizando…' : 'Actualizar' }}</button>
      </div>

      <form class="filters" @submit.prevent="applyFilters">
        <select v-model="typeFilter" aria-label="Tipo de evento">
          <option value="">Todos los eventos</option>
          <option v-for="type in EVENT_TYPES" :key="type" :value="type">{{ EVENT_LABEL[type] }}</option>
        </select>
        <input v-model="search" type="search" maxlength="120" placeholder="Buscar por cuenta o IP" aria-label="Buscar por cuenta o IP" />
        <button type="submit">Buscar</button>
      </form>

      <p v-if="!events.length && !loading" class="empty">No hay eventos con estos filtros.</p>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr><th>Fecha</th><th>Evento</th><th>Cuenta</th><th>IP</th><th>Detalle</th></tr>
          </thead>
          <tbody>
            <tr v-for="event in events" :key="event.id">
              <td class="nowrap">{{ formatDate(event.createdAt) }}</td>
              <td class="nowrap"><span class="badge" :class="EVENT_TONE[event.type]">{{ EVENT_LABEL[event.type] }}</span></td>
              <td>{{ event.email || '—' }}</td>
              <td class="nowrap">{{ event.ip || '—' }}</td>
              <td>{{ eventDetail(event) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="pager">
        <span>{{ pageLabel }}</span>
        <div>
          <button type="button" class="mini" :disabled="offset === 0 || loading" @click="movePage(-1)">Anterior</button>
          <button type="button" class="mini" :disabled="offset + PAGE_SIZE >= total || loading" @click="movePage(1)">Siguiente</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.security { display: flex; flex-direction: column; gap: 16px; }
.info-text { color: #64748b; font-size: 13px; margin: 4px 0 0; }
.block-title { font-size: 14px; color: #334155; margin: 16px 0 8px; }
.empty { color: #64748b; font-size: 13px; margin: 8px 0; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #e2e8f0; }
th { color: #64748b; font-weight: 500; }
.nowrap { white-space: nowrap; }
.row-action { text-align: right; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.filters select, .filters input { flex: 1 1 200px; min-width: 0; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge.ok { background: #ecfdf5; color: #047857; }
.badge.warn { background: #fffbeb; color: #b45309; }
.badge.bad { background: #fef2f2; color: #b91c1c; }
.badge.info { background: #eff6ff; color: #1d4ed8; }
.pager { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; color: #64748b; font-size: 13px; flex-wrap: wrap; }
.pager div { display: flex; gap: 6px; }
button.mini { font-size: 12px; padding: 4px 10px; background: white; border: 1px solid #e2e8f0; color: #475569; border-radius: 6px; cursor: pointer; }
button.mini:hover:not(:disabled) { background: #f8fafc; }
button.mini:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
