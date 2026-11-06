// =====================================================
// Catálogos compartidos (bancos, cuentas, categorías).
// Se cargan una vez y se reutilizan entre vistas; al crear/editar
// uno de estos en cualquier pantalla, se invalida y se recarga.
// =====================================================
import { defineStore } from 'pinia';
import { banksApi } from '../api/banks';
import { accountsApi } from '../api/accounts';
import { categoriesApi } from '../api/categories';
import { walletsApi } from '../api/wallets';
import type { Account, Bank, Category, Wallet } from '../types';

type CatalogKey = 'banks' | 'accounts' | 'categories' | 'wallets';

interface EntitiesState {
  banks: Bank[];
  accounts: Account[];
  categories: Category[];
  wallets: Wallet[];
  loaded: Record<CatalogKey, boolean>;
}

// Promesas en curso por catálogo. Si dos vistas montan a la vez y ambas piden el
// mismo catálogo antes de que termine la primera, `loaded` sigue en false para las
// dos y se disparaban DOS peticiones iguales. Compartiendo la promesa en vuelo,
// la segunda espera a la primera: una sola petición por catálogo.
const inFlight: Partial<Record<CatalogKey, Promise<unknown>>> = {};

function share<T>(key: CatalogKey, run: () => Promise<T>): Promise<T> {
  const pending = inFlight[key];
  if (pending) return pending as Promise<T>;
  const p = run().finally(() => { delete inFlight[key]; });
  inFlight[key] = p;
  return p;
}

export const useEntitiesStore = defineStore('entities', {
  state: (): EntitiesState => ({
    banks: [],
    accounts: [],
    categories: [],
    wallets: [],
    loaded: { banks: false, accounts: false, categories: false, wallets: false }
  }),
  getters: {
    activeBanks: (s): Bank[] => s.banks.filter((b) => b.isActive !== false),
    activeWallets: (s): Wallet[] => s.wallets.filter((w) => w.isActive !== false)
  },
  actions: {
    async ensureBanks(force = false) {
      if (this.loaded.banks && !force) return this.banks;
      await share('banks', async () => {
        this.banks = await banksApi.list();
        this.loaded.banks = true;
      });
      return this.banks;
    },
    async ensureAccounts(force = false) {
      if (this.loaded.accounts && !force) return this.accounts;
      await share('accounts', async () => {
        this.accounts = await accountsApi.list();
        this.loaded.accounts = true;
      });
      return this.accounts;
    },
    async ensureCategories(force = false) {
      if (this.loaded.categories && !force) return this.categories;
      await share('categories', async () => {
        this.categories = await categoriesApi.list();
        this.loaded.categories = true;
      });
      return this.categories;
    },
    async ensureWallets(force = false) {
      if (this.loaded.wallets && !force) return this.wallets;
      await share('wallets', async () => {
        this.wallets = await walletsApi.list();
        this.loaded.wallets = true;
      });
      return this.wallets;
    },
    /** Marca un catálogo como obsoleto para que la próxima lectura lo recargue. */
    invalidate(key: CatalogKey) {
      this.loaded[key] = false;
    },
    /**
     * Re-descarga (en paralelo) todos los catálogos que ya estaban cargados.
     * Se usa para refrescar al volver a la pestaña sin recargar la página.
     */
    async refreshLoaded() {
      const tasks: Promise<unknown>[] = [];
      if (this.loaded.banks) tasks.push(this.ensureBanks(true));
      if (this.loaded.accounts) tasks.push(this.ensureAccounts(true));
      if (this.loaded.categories) tasks.push(this.ensureCategories(true));
      if (this.loaded.wallets) tasks.push(this.ensureWallets(true));
      await Promise.all(tasks).catch(() => { /* refresco best-effort */ });
    }
  }
});
