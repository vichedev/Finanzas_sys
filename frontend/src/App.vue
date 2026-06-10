<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { Component } from 'vue';
import { useAuthStore, type ModuleName } from './stores/auth';
import { useBrandingStore } from './stores/branding';
import { useRoute, useRouter } from 'vue-router';
import ToastHost from './components/ToastHost.vue';
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
  Settings,
  ShieldCheck,
  LogOut,
  Building2,
  Menu,
  X
} from 'lucide-vue-next';

const auth = useAuthStore();
const branding = useBrandingStore();
const router = useRouter();
const route = useRoute();

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

const drawerOpen = ref(false);

onMounted(() => {
  if (auth.isAuthenticated) auth.refreshSession();
});

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
  { heading: 'Tu dinero', items: [item('/accounts', Landmark, 'Cuentas', 'accounts'), item('/cards', CreditCard, 'Tarjetas', 'cards')] },
  { heading: 'Compromisos', items: [item('/debts', HandCoins, 'Deudas y cobros', 'debts'), item('/recurrings', Repeat, 'Pagos recurrentes', 'recurrings')] },
  { heading: 'Facturación', items: [item('/invoices', FileText, 'Facturas e IVA', 'invoices')] },
  { heading: 'Análisis', items: [item('/reports', BarChart3, 'Reportes', 'reports'), item('/documents', FolderOpen, 'Documentos')] }
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

watch(
  () => route.fullPath,
  () => {
    drawerOpen.value = false;
  }
);
</script>

<template>
  <div v-if="auth.isAuthenticated" class="app-shell">
    <div v-if="drawerOpen" class="drawer-backdrop" @click="drawerOpen = false" />

    <aside class="sidebar" :class="{ 'is-open': drawerOpen }">
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
        <button class="icon-btn drawer-close" aria-label="Cerrar menú" @click="drawerOpen = false">
          <X :size="18" />
        </button>
      </div>

      <nav>
        <template v-if="auth.isSuper">
          <RouterLink :to="superItem.to" class="nav-item" :class="{ 'is-active': isActive(superItem) }">
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
              :class="{ 'is-active': isActive(it) }"
            >
              <component :is="it.icon" class="nav-icon" :size="18" :stroke-width="2" />
              <span>{{ it.label }}</span>
            </RouterLink>
          </div>
          <div class="nav-group">
            <p class="nav-group-title">Cuenta</p>
            <RouterLink :to="settingsItem.to" class="nav-item" :class="{ 'is-active': isActive(settingsItem) }">
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
        <button class="hamburger" aria-label="Abrir menú" @click="drawerOpen = true">
          <Menu :size="20" />
        </button>
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
