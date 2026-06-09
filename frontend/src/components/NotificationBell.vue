<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Bell, CheckCheck, Mail, Trash2, X } from 'lucide-vue-next';
import { notificationsApi, type Notification } from '../api/notifications';

const router = useRouter();
const open = ref(false);
const items = ref<Notification[]>([]);
const unread = ref(0);
const loading = ref(false);
const emailPref = ref(true);

const TYPE_ICON: Record<string, string> = {
  MOVEMENT_CREATED: '🔁',
  PAYMENT_DUE: '⏰',
  VAT_DUE: '🧾',
  LOW_BALANCE: '⚠️'
};

const badge = computed(() => (unread.value > 99 ? '99+' : String(unread.value)));

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - d);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `hace ${days} d`;
  const date = new Date(iso);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

async function refreshCount() {
  try { unread.value = await notificationsApi.unreadCount(); } catch { /* silencioso */ }
}

async function loadList() {
  loading.value = true;
  try {
    items.value = await notificationsApi.list();
    unread.value = items.value.filter((n) => !n.isRead).length;
  } catch { /* silencioso */ } finally {
    loading.value = false;
  }
}

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    await loadList();
    try { emailPref.value = await notificationsApi.getEmailPref(); } catch { /* */ }
  }
}

async function onClickItem(n: Notification) {
  if (!n.isRead) {
    n.isRead = true;
    unread.value = Math.max(0, unread.value - 1);
    notificationsApi.markRead(n.id).catch(() => {});
  }
  open.value = false;
  if (n.link) router.push(n.link);
}

async function markAll() {
  items.value.forEach((n) => (n.isRead = true));
  unread.value = 0;
  try { await notificationsApi.markAllRead(); } catch { /* */ }
}

async function removeItem(n: Notification, e: Event) {
  e.stopPropagation();
  items.value = items.value.filter((x) => x.id !== n.id);
  if (!n.isRead) unread.value = Math.max(0, unread.value - 1);
  notificationsApi.remove(n.id).catch(() => {});
}

async function toggleEmail() {
  emailPref.value = !emailPref.value;
  try { await notificationsApi.setEmailPref(emailPref.value); } catch { emailPref.value = !emailPref.value; }
}

function onDocClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (!el.closest('.notif-wrap')) open.value = false;
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  refreshCount();
  timer = setInterval(() => { if (open.value) loadList(); else refreshCount(); }, 30_000);
  document.addEventListener('click', onDocClick);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  document.removeEventListener('click', onDocClick);
});
</script>

<template>
  <div class="notif-wrap">
    <button type="button" class="notif-bell icon-btn" aria-label="Notificaciones" @click="toggle">
      <Bell :size="18" />
      <span v-if="unread > 0" class="notif-badge">{{ badge }}</span>
    </button>

    <transition name="notif-pop">
      <div v-if="open" class="notif-panel">
        <header class="notif-head">
          <strong>Notificaciones</strong>
          <div class="notif-head-actions">
            <button type="button" class="notif-link" :title="emailPref ? 'Correos activados' : 'Correos desactivados'" @click="toggleEmail">
              <Mail :size="14" /> {{ emailPref ? 'Correo: on' : 'Correo: off' }}
            </button>
            <button type="button" class="notif-link" :disabled="!unread" @click="markAll">
              <CheckCheck :size="14" /> Marcar leídas
            </button>
          </div>
        </header>

        <div class="notif-list">
          <p v-if="loading && !items.length" class="notif-empty">Cargando…</p>
          <p v-else-if="!items.length" class="notif-empty">
            <span class="notif-empty-ic"><Bell :size="28" /></span>
            No tienes notificaciones.
          </p>
          <button
            v-for="n in items"
            :key="n.id"
            type="button"
            class="notif-item"
            :class="{ unread: !n.isRead }"
            @click="onClickItem(n)"
          >
            <span class="notif-item-ic">{{ TYPE_ICON[n.type] || '🔔' }}</span>
            <span class="notif-item-body">
              <span class="notif-item-title">{{ n.title }}</span>
              <span class="notif-item-text">{{ n.body }}</span>
              <span class="notif-item-time">{{ timeAgo(n.createdAt) }}</span>
            </span>
            <span class="notif-item-del" title="Eliminar" @click="removeItem(n, $event)"><Trash2 :size="14" /></span>
            <span v-if="!n.isRead" class="notif-dot" aria-hidden="true"></span>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.notif-wrap { position: relative; }
.notif-bell { position: relative; }
.notif-badge {
  position: absolute; top: -4px; right: -4px;
  min-width: 18px; height: 18px; padding: 0 5px;
  display: grid; place-items: center;
  background: #ef4444; color: #fff;
  font-size: 10.5px; font-weight: 700;
  border-radius: 999px; border: 2px solid var(--color-surface, #fff);
}

.notif-panel {
  position: absolute; top: calc(100% + 8px); right: 0;
  width: 360px; max-width: calc(100vw - 24px);
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(15,23,42,.14);
  z-index: 50;
  overflow: hidden;
}
.notif-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 14px; border-bottom: 1px solid var(--color-border, #e2e8f0);
}
.notif-head strong { font-size: 14px; color: #0f172a; }
.notif-head-actions { display: flex; gap: 6px; }
.notif-link {
  display: inline-flex; align-items: center; gap: 4px;
  background: transparent; border: none; cursor: pointer;
  font-size: 11.5px; font-weight: 600; color: #4f46e5; padding: 4px 6px; border-radius: 6px;
}
.notif-link:hover:not(:disabled) { background: #eef2ff; }
.notif-link:disabled { color: #cbd5e1; cursor: not-allowed; }

.notif-list { max-height: 420px; overflow-y: auto; }
.notif-empty { text-align: center; color: #94a3b8; font-size: 13px; padding: 28px 16px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.notif-empty-ic { color: #cbd5e1; }

.notif-item {
  position: relative;
  width: 100%; text-align: left;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 14px;
  background: transparent; border: none; border-bottom: 1px solid #f1f5f9;
  cursor: pointer;
}
.notif-item:hover { background: #f8fafc; }
.notif-item.unread { background: #f5f7ff; }
.notif-item.unread:hover { background: #eef2ff; }
.notif-item-ic { font-size: 18px; line-height: 1.2; flex-shrink: 0; }
.notif-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.notif-item-title { font-size: 13px; font-weight: 700; color: #0f172a; }
.notif-item-text { font-size: 12.5px; color: #475569; }
.notif-item-time { font-size: 11px; color: #94a3b8; margin-top: 2px; }
.notif-item-del { flex-shrink: 0; color: #cbd5e1; padding: 2px; border-radius: 6px; }
.notif-item-del:hover { color: #ef4444; background: #fef2f2; }
.notif-dot { position: absolute; top: 14px; right: 8px; width: 8px; height: 8px; border-radius: 999px; background: #4f46e5; }

.notif-pop-enter-active, .notif-pop-leave-active { transition: opacity .14s ease, transform .14s ease; }
.notif-pop-enter-from, .notif-pop-leave-to { opacity: 0; transform: translateY(-6px); }
</style>
