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
      this.banks = await banksApi.list();
      this.loaded.banks = true;
      return this.banks;
    },
    async ensureAccounts(force = false) {
      if (this.loaded.accounts && !force) return this.accounts;
      this.accounts = await accountsApi.list();
      this.loaded.accounts = true;
      return this.accounts;
    },
    async ensureCategories(force = false) {
      if (this.loaded.categories && !force) return this.categories;
      this.categories = await categoriesApi.list();
      this.loaded.categories = true;
      return this.categories;
    },
    async ensureWallets(force = false) {
      if (this.loaded.wallets && !force) return this.wallets;
      this.wallets = await walletsApi.list();
      this.loaded.wallets = true;
      return this.wallets;
    },
    /** Marca un catálogo como obsoleto para que la próxima lectura lo recargue. */
    invalidate(key: CatalogKey) {
      this.loaded[key] = false;
    }
  }
});
