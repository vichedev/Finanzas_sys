import { defineStore } from 'pinia';
import { http } from '../api/http';

export type ModuleName = 'movements' | 'accounts' | 'cards' | 'debts' | 'recurrings' | 'invoices' | 'reports';
export type PermissionLevel = 'edit' | 'view' | 'none';
export type Permissions = Record<ModuleName, PermissionLevel>;

export type AuthKind = 'super' | 'tenant';

export interface TenantInfo {
  id: string;
  slug: string;
  legalName: string;
  logoUrl?: string | null;
}

export type AuthUser = {
  id: number | string;
  name: string;
  email: string;
  currency?: string;
  role: 'SUPERADMIN' | 'ADMIN' | 'CLIENT' | 'SUPER_ADMIN' | string;
  permissions?: Permissions;
};

const DEFAULT_PERMS: Permissions = {
  movements: 'edit', accounts: 'edit', cards: 'edit',
  debts: 'edit', recurrings: 'edit', invoices: 'edit', reports: 'view'
};

function safeUser(raw: string | null): AuthUser | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.id !== undefined && typeof parsed.email === 'string') {
      const r = parsed.role;
      const role =
        r === 'SUPER_ADMIN' ? 'SUPER_ADMIN'
        : r === 'SUPERADMIN' ? 'SUPERADMIN'
        : r === 'ADMIN' ? 'ADMIN'
        : r === 'CLIENT' ? 'CLIENT'
        : r ?? 'CLIENT';
      const permissions = { ...DEFAULT_PERMS, ...(parsed.permissions || {}) };
      return { ...parsed, role, permissions } as AuthUser;
    }
  } catch { /* ignore */ }
  return null;
}

function safeTenant(raw: string | null): TenantInfo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && typeof parsed.slug === 'string') {
      return parsed as TenantInfo;
    }
  } catch { /* ignore */ }
  return null;
}

function safeKind(raw: string | null): AuthKind | null {
  return raw === 'super' || raw === 'tenant' ? raw : null;
}

interface AuthState {
  token: string;
  kind: AuthKind | null;
  user: AuthUser | null;
  tenant: TenantInfo | null;
  pendingTenants: TenantInfo[] | null;
  pendingToken: string | null;
  pendingSuperAvailable: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: localStorage.getItem('finanzas_token') || '',
    kind: safeKind(localStorage.getItem('finanzas_kind')),
    user: safeUser(localStorage.getItem('finanzas_user')),
    tenant: safeTenant(localStorage.getItem('finanzas_tenant')),
    pendingTenants: null,
    pendingToken: null,
    pendingSuperAvailable: false
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token),
    isSuper: (state) =>
      state.kind === 'super' || state.user?.role === 'SUPER_ADMIN',
    // Dentro de un tenant, ADMIN_EMPRESA (nuevo) y ADMIN/SUPERADMIN (legacy)
    // se consideran admin. SUPER_ADMIN de plataforma NO es admin de tenant.
    isAdmin: (state) =>
      state.kind !== 'super' &&
      (state.user?.role === 'ADMIN_EMPRESA' ||
       state.user?.role === 'ADMIN' ||
       state.user?.role === 'SUPERADMIN'),
    isSuperAdmin: (state) =>
      state.kind !== 'super' && state.user?.role === 'SUPERADMIN',
    perms: (state): Permissions => state.user?.permissions ?? DEFAULT_PERMS
  },
  actions: {
    /**
     * Devuelve { needsSelection: true } cuando el usuario pertenece a varios
     * tenants y debe elegir uno antes de tener un token final.
     */
    async login(email: string, password: string): Promise<{ needsSelection: boolean }> {
      const { data } = await http.post('/auth/login', { email, password });

      // Respuesta pending: el backend devuelve { pending: true, token, tenants, superAvailable? }
      if (data?.pending) {
        this.pendingToken = data.token;
        this.pendingTenants = Array.isArray(data.tenants) ? data.tenants : [];
        this.pendingSuperAvailable = !!data.superAvailable;
        // No persistimos pending en localStorage: si recarga, vuelve a /login.
        return { needsSelection: true };
      }

      // user puede venir con kind=super | kind=tenant
      const kind = (data?.user?.kind ?? 'tenant') as AuthKind;
      this.setSession({
        token: data.token,
        kind,
        user: data.user,
        tenant: data.user?.tenant ?? data.tenant ?? null
      });
      return { needsSelection: false };
    },

    /** choice: 'super' | tenantId */
    async selectOption(choice: string) {
      if (!this.pendingToken) throw new Error('No hay opción pendiente que seleccionar');
      const { data } = await http.post(
        '/auth/select-tenant',
        { choice },
        { headers: { Authorization: `Bearer ${this.pendingToken}` } }
      );
      const kind = (data?.user?.kind ?? (choice === 'super' ? 'super' : 'tenant')) as AuthKind;
      this.setSession({
        token: data.token,
        kind,
        user: data.user,
        tenant: data.user?.tenant ?? data.tenant ?? null
      });
      this.pendingToken = null;
      this.pendingTenants = null;
      this.pendingSuperAvailable = false;
    },

    /** Alias por compatibilidad */
    async selectTenant(tenantId: string) {
      return this.selectOption(tenantId);
    },

    setSession(opts: { token: string; kind: AuthKind; user: AuthUser; tenant: TenantInfo | null }) {
      const role = opts.user?.role;
      const normalizedRole =
        role === 'SUPER_ADMIN' ? 'SUPER_ADMIN'
        : role === 'SUPERADMIN' ? 'SUPERADMIN'
        : role === 'ADMIN' ? 'ADMIN'
        : role === 'CLIENT' ? 'CLIENT'
        : role;
      const user: AuthUser = {
        ...opts.user,
        role: normalizedRole as AuthUser['role'],
        permissions: { ...DEFAULT_PERMS, ...(opts.user.permissions || {}) }
      };

      this.token = opts.token;
      this.kind = opts.kind;
      this.user = user;
      this.tenant = opts.tenant;

      localStorage.setItem('finanzas_token', opts.token);
      localStorage.setItem('finanzas_kind', opts.kind);
      localStorage.setItem('finanzas_user', JSON.stringify(user));
      if (opts.tenant) {
        localStorage.setItem('finanzas_tenant', JSON.stringify(opts.tenant));
      } else {
        localStorage.removeItem('finanzas_tenant');
      }
    },

    logout() {
      this.token = '';
      this.kind = null;
      this.user = null;
      this.tenant = null;
      this.pendingToken = null;
      this.pendingTenants = null;
      this.pendingSuperAvailable = false;
      localStorage.removeItem('finanzas_token');
      localStorage.removeItem('finanzas_kind');
      localStorage.removeItem('finanzas_user');
      localStorage.removeItem('finanzas_tenant');
    },

    async refreshSession() {
      if (!this.token) return;
      // El super-admin no necesita el /auth/me de tenant (no tiene permisos
      // por módulo). Si lo necesita en el futuro, se añade /auth/me-super.
      if (this.kind === 'super') return;
      try {
        const { data } = await http.get<{
          id: number | string; name: string; email: string; currency?: string;
          role: string; permissions?: Permissions;
          tenant?: TenantInfo;
        }>('/auth/me');
        // Conservar el rol tal cual viene (multitenant: ADMIN_EMPRESA / USUARIO_EMPRESA;
        // legacy: SUPERADMIN / ADMIN / CLIENT). No degradar a CLIENT.
        const merged: AuthUser = {
          id: data.id, name: data.name, email: data.email,
          currency: data.currency || 'USD',
          role: data.role as AuthUser['role'],
          permissions: { ...DEFAULT_PERMS, ...(data.permissions || {}) }
        };
        this.user = merged;
        localStorage.setItem('finanzas_user', JSON.stringify(merged));
        if (data.tenant) {
          this.tenant = data.tenant;
          localStorage.setItem('finanzas_tenant', JSON.stringify(data.tenant));
        }
      } catch {
        /* no rompemos sesión por un fallo de red puntual */
      }
    },

    canRead(mod: ModuleName): boolean {
      if (this.isSuper) return true;
      if (this.isAdmin) return true;
      const lvl = this.perms[mod];
      return lvl === 'edit' || lvl === 'view';
    },
    canWrite(mod: ModuleName): boolean {
      if (this.isSuper) return true;
      if (this.isAdmin) return true;
      return this.perms[mod] === 'edit';
    }
  }
});
