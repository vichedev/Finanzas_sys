<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type { Component } from 'vue';
import { useAuthStore, type ModuleName } from './stores/auth';
import { useBrandingStore } from './stores/branding';
import { useEntitiesStore } from './stores/entities';
import { http } from './api/http';
import { useRoute, useRouter } from 'vue-router';
import ToastHost from './components/ToastHost.vue';
import ConfirmHost from './components/ConfirmHost.vue';
import NotificationBell from './components/NotificationBell.vue';
import {
  LayoutDashboard,
  ArrowLeftRight,
  CreditCard,
  Landmark,
  HandCoins,
  Repeat,
  FileText,
  FolderOpen,
  BarChart3,
  PiggyBank,
  History,
  Settings,
  ShieldCheck,
  LogOut,
  Building2,
  Scale,
  Menu
} from 'lucide-vue-next';

const auth = useAuthStore();
const branding = useBrandingStore();
const entities = useEntitiesStore();
const router = useRouter();
const route = useRoute();

// Genera los movimientos recurrentes vencidos (idempotente en el backend).
function runRecurrings() {
  if (!auth.isAuthenticated || auth.isSuper) return;
  http.post('/recurrings/run').catch(() => { /* best-effort */ });
}

// Sincronización en tiempo real al volver a la pestaña/ventana (sin recargar).
let lastRefresh = 0;
function onFocusRefresh() {
  if (!auth.isAuthenticated || auth.isSuper) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const t = Date.now();
  if (t - lastRefresh < 5000) return; // throttle
  lastRefresh = t;
  entities.refreshLoaded();
}

// Identidad: empresa → carga del servidor; super-admin → look por defecto;
// sin sesión (login) → identidad recordada de la última empresa usada.
watch(() => auth.isAuthenticated, (v) => {
  if (v) {
    if (auth.isSuper) branding.reset();
    else branding.load();
  } else {
    branding.loadPersisted();
  }
}, { immediate: true });

// Estado del sidebar: expandido (icono + texto) o colapsado (solo iconos).
// Por defecto colapsado en pantallas pequeñas; la preferencia se recuerda.
const STORED_COLLAPSED = typeof localStorage !== 'undefined' ? localStorage.getItem('finanzas_sidebar_collapsed') : null;
const collapsed = ref(
  STORED_COLLAPSED !== null ? STORED_COLLAPSED === '1' : (typeof window !== 'undefined' && window.innerWidth <= 1024)
);

function toggleSidebar() {
  collapsed.value = !collapsed.value;
  try { localStorage.setItem('finanzas_sidebar_collapsed', collapsed.value ? '1' : '0'); } catch { /* ignore */ }
}
function collapseSidebar() { collapsed.value = true; }

// En móvil, al navegar se cierra el sidebar superpuesto.
watch(() => route.fullPath, () => {
  if (typeof window !== 'undefined' && window.innerWidth <= 768) collapsed.value = true;
});

onMounted(() => {
  if (auth.isAuthenticated) {
    auth.refreshSession();
    runRecurrings();
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocusRefresh);
    document.addEventListener('visibilitychange', onFocusRefresh);
  }
});
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', onFocusRefresh);
    document.removeEventListener('visibilitychange', onFocusRefresh);
  }
});

// Al iniciar sesión (login → autenticado), genera recurrentes vencidos.
watch(() => auth.isAuthenticated, (v, prev) => { if (v && !prev) runRecurrings(); });

function logout() {
  auth.logout();
  router.push('/login');
}

type NavItem = { to: string; icon: Component; label: string; path: string; module?: ModuleName };
type NavGroup = { heading: string; items: NavItem[] };

function item(to: string, icon: Component, label: string, module?: ModuleName): NavItem {
  return { to, icon, label, path: to.split('?')[0], module };
}

const groups: NavGroup[] = [
  { heading: 'Principal', items: [item('/', LayoutDashboard, 'Resumen'), item('/movements', ArrowLeftRight, 'Movimientos', 'movements')] },
  { heading: 'Tu dinero', items: [item('/accounts', Landmark, 'Cuentas', 'accounts'), item('/cards', CreditCard, 'Tarjetas', 'cards'), item('/entities', Scale, 'Razones sociales', 'accounts'), item('/statements', FileText, 'Estados de cuenta', 'accounts')] },
  { heading: 'Compromisos', items: [item('/debts', HandCoins, 'Deudas y cobros', 'debts'), item('/recurrings', Repeat, 'Pagos recurrentes', 'recurrings'), item('/budgets', PiggyBank, 'Presupuestos', 'movements')] },
  { heading: 'Facturación', items: [item('/invoices', FileText, 'Facturas e IVA', 'invoices')] },
  { heading: 'Análisis', items: [item('/reports', BarChart3, 'Reportes', 'reports'), item('/audit', History, 'Auditoría', 'reports'), item('/documents', FolderOpen, 'Documentos')] }
];

const settingsItem = item('/settings', Settings, 'Configuración');
const superItem = item('/settings?section=super-admin', Building2, 'Empresas');

const visibleGroups = computed(() =>
  groups
    .map((g) => ({ heading: g.heading, items: g.items.filter((it) => !it.module || auth.canRead(it.module)) }))
    .filter((g) => g.items.length)
);

function isActive(it: NavItem): boolean {
  if (it.path === '/') return route.path === '/';
  return route.path === it.path || route.path.startsWith(it.path + '/');
}

const allItems = computed<NavItem[]>(() =>
  auth.isSuper ? [superItem] : [...groups.flatMap((g) => g.items), settingsItem]
);
const pageTitle = computed(() => allItems.value.find(isActive)?.label ?? (auth.isSuper ? 'Empresas' : 'Finanzas'));

const initials = computed(() => {
  const n = auth.user?.name?.trim() || auth.user?.email || '?';
  return (
    n
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
});
const roleLabel = computed(() => (auth.isSuper ? 'Super Admin' : auth.isAdmin ? 'Administrador' : 'Usuario'));

</script>

<template>
  <div v-if="auth.isAuthenticated" class="app-shell" :class="{ 'is-collapsed': collapsed }">
    <div v-if="!collapsed" class="sb-backdrop" @click="collapseSidebar" />
    <aside class="sidebar">
      <div class="sidebar-top">
        <div class="brand">
          <img
            v-if="!auth.isSuper && branding.logoUrl"
            class="tenant-logo-img"
            :src="branding.logoUrl"
            :alt="branding.title"
          />
          <img
            v-else-if="!auth.isSuper && auth.tenant?.logoUrl"
            class="tenant-logo-img"
            :src="auth.tenant.logoUrl"
            :alt="auth.tenant.legalName"
          />
          <div v-else class="logo">$</div>
          <div class="brand-text">
            <strong>{{ auth.isSuper ? 'Super Admin' : (branding.systemTitle || auth.tenant?.legalName || 'Finanzas') }}</strong>
            <small>{{ auth.isSuper ? 'Plataforma' : branding.subtitleText }}</small>
          </div>
        </div>
        <button class="icon-btn drawer-close" aria-label="Cerrar menú" @click="toggleSidebar">
          <Menu :size="18" />
        </button>
      </div>

      <nav>
        <template v-if="auth.isSuper">
          <RouterLink :to="superItem.to" class="nav-item" :title="superItem.label" :class="{ 'is-active': isActive(superItem) }">
            <component :is="superItem.icon" class="nav-icon" :size="18" :stroke-width="2" />
            <span>{{ superItem.label }}</span>
          </RouterLink>
        </template>
        <template v-else>
          <div v-for="g in visibleGroups" :key="g.heading" class="nav-group">
            <p class="nav-group-title">{{ g.heading }}</p>
            <RouterLink
              v-for="it in g.items"
              :key="it.to"
              :to="it.to"
              class="nav-item"
              :title="it.label"
              :class="{ 'is-active': isActive(it) }"
            >
              <component :is="it.icon" class="nav-icon" :size="18" :stroke-width="2" />
              <span>{{ it.label }}</span>
            </RouterLink>
          </div>
          <div class="nav-group">
            <p class="nav-group-title">Cuenta</p>
            <RouterLink :to="settingsItem.to" class="nav-item" :title="settingsItem.label" :class="{ 'is-active': isActive(settingsItem) }">
              <component :is="settingsItem.icon" class="nav-icon" :size="18" :stroke-width="2" />
              <span>{{ settingsItem.label }}</span>
            </RouterLink>
          </div>
        </template>
      </nav>

      <div class="sidebar-user">
        <div class="su-avatar">{{ initials }}</div>
        <div class="su-info">
          <strong>{{ auth.user?.name || auth.user?.email }}</strong>
          <small>{{ roleLabel }}</small>
        </div>
        <button class="icon-btn" aria-label="Cerrar sesión" title="Cerrar sesión" @click="logout">
          <LogOut :size="16" />
        </button>
      </div>
    </aside>

    <div class="app-main">
      <header class="topbar">
        <h1 class="topbar-title">{{ pageTitle }}</h1>
        <div class="topbar-right">
          <NotificationBell v-if="!auth.isSuper" />
          <span class="topbar-chip">
            <ShieldCheck :size="14" />
            {{ auth.isSuper ? 'Plataforma' : auth.tenant?.legalName || 'Finanzas' }}
          </span>
        </div>
      </header>

      <main class="main-content">
        <RouterView />
      </main>
    </div>
  </div>
  <RouterView v-else />
  <ToastHost />
  <ConfirmHost />
</template>

<style scoped>
.tenant-logo-img {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  object-fit: contain;
  background: var(--color-surface-3, #232838);
  flex-shrink: 0;
}
</style>
