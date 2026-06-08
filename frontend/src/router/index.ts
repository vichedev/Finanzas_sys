import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore, type ModuleName } from '../stores/auth';
import LoginView from '../views/LoginView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    { path: '/register', redirect: '/login' },
    { path: '/admin/users', redirect: '/settings' },
    {
      path: '/select-tenant',
      name: 'select-tenant',
      component: () => import('../views/TenantSelectorView.vue'),
      meta: { public: true }
    },
    { path: '/super-admin', redirect: '/settings?section=super-admin' },
    { path: '/', component: () => import('../views/DashboardView.vue'), meta: { auth: true } },
    { path: '/movements', component: () => import('../views/MovementsView.vue'), meta: { auth: true, module: 'movements' as ModuleName } },
    { path: '/accounts', component: () => import('../views/AccountsView.vue'), meta: { auth: true, module: 'accounts' as ModuleName } },
    { path: '/cards', component: () => import('../views/CardsView.vue'), meta: { auth: true, module: 'cards' as ModuleName } },
    { path: '/debts', component: () => import('../views/DebtsView.vue'), meta: { auth: true, module: 'debts' as ModuleName } },
    { path: '/recurrings', component: () => import('../views/RecurringsView.vue'), meta: { auth: true, module: 'recurrings' as ModuleName } },
    { path: '/invoices', component: () => import('../views/InvoicesView.vue'), meta: { auth: true, module: 'invoices' as ModuleName } },
    { path: '/reports', component: () => import('../views/ReportsView.vue'), meta: { auth: true, module: 'reports' as ModuleName } },
    { path: '/settings', component: () => import('../views/SettingsView.vue'), meta: { auth: true } }
  ]
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.auth && !auth.isAuthenticated) return '/login';
  if (to.meta.requiresSuper && !auth.isSuper) return '/';
  const requiredModule = to.meta.module as ModuleName | undefined;
  if (requiredModule && !auth.canRead(requiredModule)) return '/';
  if (to.path === '/login' && auth.isAuthenticated) {
    return auth.isSuper ? '/settings?section=super-admin' : '/';
  }
  // Super admin sin tenant: redirige TODAS las rutas data (dashboard, movements, etc.) a la gestión de empresas
  if (auth.isSuper && to.meta.auth && to.path !== '/settings') {
    return '/settings?section=super-admin';
  }
});
