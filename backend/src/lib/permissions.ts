export const MODULES = ['movements', 'accounts', 'cards', 'debts', 'recurrings', 'invoices', 'reports'] as const;
export type ModuleName = typeof MODULES[number];
export type PermissionLevel = 'edit' | 'view' | 'none';

export type Permissions = Record<ModuleName, PermissionLevel>;

export const DEFAULT_PERMISSIONS: Permissions = {
  movements: 'edit',
  accounts: 'edit',
  cards: 'edit',
  debts: 'edit',
  recurrings: 'edit',
  invoices: 'edit',
  reports: 'view'
};

export const READONLY_PERMISSIONS: Permissions = {
  movements: 'view',
  accounts: 'view',
  cards: 'view',
  debts: 'view',
  recurrings: 'view',
  invoices: 'view',
  reports: 'view'
};

export function normalizePermissions(input: unknown): Permissions {
  const out = { ...DEFAULT_PERMISSIONS };
  if (input && typeof input === 'object') {
    for (const m of MODULES) {
      const v = (input as Record<string, unknown>)[m];
      if (v === 'edit' || v === 'view' || v === 'none') out[m] = v;
    }
  }
  return out;
}

export function canRead(perms: Permissions, mod: ModuleName): boolean {
  return perms[mod] === 'edit' || perms[mod] === 'view';
}

export function canWrite(perms: Permissions, mod: ModuleName): boolean {
  return perms[mod] === 'edit';
}
