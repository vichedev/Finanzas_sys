<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { Component } from 'vue';
import { useRoute } from 'vue-router';
import { http } from '../api/http';
import { ArrowLeftRight, Pencil, Trash2, Plus, X, Wallet, ShoppingCart, ShoppingBag, Banknote, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import AppButton from '../components/AppButton.vue';
import PickerField from '../components/PickerField.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import AppModal from '../components/AppModal.vue';
import AttachmentViewer from '../components/AttachmentViewer.vue';
import { START_YEAR, START_MONTH, yearOptions as periodYears } from '../composables/usePeriod';
import { attachmentsApi, type AttachmentMeta } from '../api/attachments';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import { useFormat } from '../composables/useFormat';

type MovementType = 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'WITHDRAWAL' | 'PURCHASE' | 'CARD_PAYMENT' | 'ADJUSTMENT';
type ExpenseKind = 'FIXED' | 'VARIABLE' | 'NON_ACCOUNTABLE';
type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'DEPOSIT' | 'DEBIT_CARD' | 'CREDIT_CARD' | 'WALLET' | 'OTHER';

interface Account { id: number; name: string; type?: string; holder?: string | null; accountKind?: string | null; bankId?: number | null; bankName?: string | null; accountNumber?: string | null }
interface Card { id: number; name: string; type?: string | null; bankName?: string | null; last4?: string | null }
interface Wallet { id: number; name: string; provider?: string | null; isActive?: boolean; accountIds?: number[] }
interface Category { id: number; name: string; color?: string | null; icon?: string | null }
type BankAccountKind = 'SAVINGS' | 'CHECKING';
interface Bank { id: number; name: string; accountNumber?: string | null; accountKind?: BankAccountKind | null; isActive?: boolean }
const BANK_KIND_SHORT: Record<BankAccountKind, string> = { SAVINGS: 'Ahorros', CHECKING: 'Corriente' };
function bankOptionLabel(b: Bank): string {
  const parts: string[] = [b.name];
  if (b.accountKind) parts.push(BANK_KIND_SHORT[b.accountKind]);
  if (b.accountNumber) parts.push(`****${b.accountNumber.slice(-4)}`);
  return parts.join(' · ');
}
interface Movement {
  id: number; type: MovementType; expenseKind: ExpenseKind | null; amount: number | string;
  movementDate: string; description: string; paymentMethod: PaymentMethod;
  accountId: number | null; toAccountId: number | null; cardId: number | null; walletId: number | null; categoryId: number | null;
  fromBankId: number | null; toBankId: number | null;
  vendor: string | null; isCredit: boolean; dueDate: string | null; commission: number | string | null;
  familyMember: string | null; notes: string | null;
  account?: Account | null; toAccount?: Account | null; card?: Card | null; wallet?: Wallet | null; category?: Category | null;
  fromBank?: Bank | null; toBank?: Bank | null;
}

const route = useRoute();
const toast = useToast();
const { confirm } = useConfirm();
const { formatMoney } = useFormat();
const now = new Date();
// "Hoy" en fecha LOCAL del usuario (no UTC) para que el default del input sea correcto.
const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const VALID_EXPENSE_KINDS: ExpenseKind[] = ['FIXED', 'VARIABLE', 'NON_ACCOUNTABLE'];
const EXPENSE_KIND_LABEL: Record<ExpenseKind, string> = {
  FIXED: 'Gasto fijo',
  VARIABLE: 'Gasto variable',
  NON_ACCOUNTABLE: 'Gasto no contable'
};
const EXPENSE_KIND_HINT: Record<ExpenseKind, string> = {
  FIXED: 'Sale el mismo monto cada mes (arriendo, internet, suscripción).',
  VARIABLE: 'Monto cambia mes a mes (supermercado, combustible, salidas).',
  NON_ACCOUNTABLE: 'Gasto puntual o difícil de presupuestar; queda fuera del presupuesto fijo.'
};
const EXPENSE_KIND_OPTIONS: { value: ExpenseKind; label: string }[] = [
  { value: 'FIXED', label: 'Fijo' },
  { value: 'VARIABLE', label: 'Variable' },
  { value: 'NON_ACCOUNTABLE', label: 'No contable' }
];

// Selector visual de tipo de movimiento (reemplaza el dropdown).
const TYPE_OPTIONS: { value: MovementType; icon: Component; label: string; desc: string; accent: string }[] = [
  { value: 'INCOME', icon: Wallet, label: 'Ingreso', desc: 'Entra dinero', accent: 'income' },
  { value: 'EXPENSE', icon: ShoppingCart, label: 'Gasto', desc: 'Sale dinero', accent: 'expense' },
  { value: 'PURCHASE', icon: ShoppingBag, label: 'Compra', desc: 'Pagada o fiada', accent: 'purchase' },
  { value: 'TRANSFER', icon: ArrowLeftRight, label: 'Transferencia', desc: 'Entre cuentas', accent: 'transfer' },
  { value: 'WITHDRAWAL', icon: Banknote, label: 'Retiro', desc: 'Sacar efectivo', accent: 'withdrawal' }
];

// --- Tabs de subtipo de gasto (filtro en cliente, con conteos) ---
type TabKey = 'ALL' | ExpenseKind;
const TABS: { key: TabKey; label: string }[] = [
  { key: 'ALL', label: 'Todos' },
  { key: 'FIXED', label: 'Fijos' },
  { key: 'VARIABLE', label: 'Variables' },
  { key: 'NON_ACCOUNTABLE', label: 'No contables' }
];
function initialTab(): TabKey {
  const v = route.query.expenseKind;
  if (typeof v === 'string' && (VALID_EXPENSE_KINDS as string[]).includes(v)) return v as ExpenseKind;
  return 'ALL';
}
const activeTab = ref<TabKey>(initialTab());
const filterExpenseKind = computed<ExpenseKind | null>(() =>
  activeTab.value === 'ALL' ? null : activeTab.value
);

const rows = ref<Movement[]>([]);
const accounts = ref<Account[]>([]);
const cards = ref<Card[]>([]);
const wallets = ref<Wallet[]>([]);
const categories = ref<Category[]>([]);
const banks = ref<Bank[]>([]);
const year = ref(now.getFullYear());
const month = ref(now.getMonth() + 1);
const saving = ref(false);
const editingId = ref<number | null>(null);
const attachRef = ref<{ flush: (id: number) => Promise<void>; reset: () => void; hasPending: () => boolean } | null>(null);

const buildEmptyForm = () => ({
  type: 'INCOME' as MovementType,
  expenseKind: (filterExpenseKind.value ?? 'VARIABLE') as ExpenseKind,
  amount: 0, movementDate: todayStr,
  description: '', paymentMethod: 'CASH' as PaymentMethod,
  accountId: null as number | null, toAccountId: null as number | null, cardId: null as number | null,
  walletId: null as number | null,
  categoryId: null as number | null,
  fromBankId: null as number | null, toBankId: null as number | null,
  vendor: '', isCredit: false, dueDate: '',
  commission: 0,
  familyMember: '', notes: ''
});
const form = ref(buildEmptyForm());

const PAYMENT_LABEL: Record<PaymentMethod, string> = { CASH: 'Efectivo', BANK_TRANSFER: 'Transferencia bancaria', DEPOSIT: 'Depósito', DEBIT_CARD: 'Tarjeta de débito', CREDIT_CARD: 'Tarjeta de crédito', WALLET: 'Billetera digital', OTHER: 'Otro' };
const TYPE_ICON: Record<MovementType, string> = { INCOME: '💵', EXPENSE: '🛒', TRANSFER: '🔁', WITHDRAWAL: '🏧', PURCHASE: '🛍️', CARD_PAYMENT: '💳', ADJUSTMENT: '⚖️' };
const TYPE_LABEL: Record<MovementType, string> = { INCOME: 'Ingreso', EXPENSE: 'Gasto', TRANSFER: 'Transferencia', WITHDRAWAL: 'Retiro', PURCHASE: 'Compra', CARD_PAYMENT: 'Pago de tarjeta', ADJUSTMENT: 'Ajuste' };
const TYPE_PILL: Record<MovementType, string> = {
  INCOME: 'background:#ecfdf5;color:#047857',
  EXPENSE: 'background:#fef2f2;color:#b91c1c',
  TRANSFER: 'background:#eff6ff;color:#1d4ed8',
  WITHDRAWAL: 'background:#fff7ed;color:#b45309',
  PURCHASE: 'background:#faf5ff;color:#7e22ce',
  CARD_PAYMENT: 'background:#ecfeff;color:#0e7490',
  ADJUSTMENT: 'background:#f1f5f9;color:#475569'
};
// Etiqueta del método/naturaleza coherente con el tipo de movimiento.
function methodCell(item: Movement): string {
  if (item.type === 'WITHDRAWAL') return 'Retiro de efectivo';
  if (item.type === 'TRANSFER') return 'Transferencia entre cuentas';
  if (item.type === 'CARD_PAYMENT') return 'Pago de tarjeta';
  if (item.type === 'ADJUSTMENT') return 'Ajuste de saldo';
  return PAYMENT_LABEL[item.paymentMethod] || '—';
}

// Método de pago como selector visual de chips (más intuitivo que un dropdown).
const PAYMENT_OPTIONS: { value: PaymentMethod; label: string; icon: string }[] = [
  { value: 'CASH', label: 'Efectivo', icon: '💵' },
  { value: 'BANK_TRANSFER', label: 'Transferencia', icon: '🏦' },
  { value: 'DEPOSIT', label: 'Depósito', icon: '🧾' },
  { value: 'DEBIT_CARD', label: 'T. Débito', icon: '💳' },
  { value: 'CREDIT_CARD', label: 'T. Crédito', icon: '💳' },
  { value: 'WALLET', label: 'Billetera', icon: '👛' },
  { value: 'OTHER', label: 'Otro', icon: '•' }
];

const ACCOUNT_TYPE_LABEL: Record<string, string> = { CASH: 'Efectivo', BANK: 'Banco', WALLET: 'Billetera', DEBIT: 'Débito', RECEIVABLE: 'Por cobrar' };
function accountIcon(type?: string) {
  switch (type) {
    case 'CASH': return '💵';
    case 'BANK': return '🏦';
    case 'WALLET': return '👛';
    case 'DEBIT': return '💳';
    case 'RECEIVABLE': return '🧾';
    default: return '🏦';
  }
}
function bankSubLabel(b: Bank): string | undefined {
  const parts: string[] = [];
  if (b.accountKind) parts.push(BANK_KIND_SHORT[b.accountKind]);
  if (b.accountNumber) parts.push(`****${b.accountNumber.slice(-4)}`);
  return parts.length ? parts.join(' · ') : undefined;
}

const MONTHS = [
  { value: 1, label: 'Enero' }, { value: 2, label: 'Febrero' }, { value: 3, label: 'Marzo' },
  { value: 4, label: 'Abril' }, { value: 5, label: 'Mayo' }, { value: 6, label: 'Junio' },
  { value: 7, label: 'Julio' }, { value: 8, label: 'Agosto' }, { value: 9, label: 'Septiembre' },
  { value: 10, label: 'Octubre' }, { value: 11, label: 'Noviembre' }, { value: 12, label: 'Diciembre' }
];
// Tope de período (mayo 2026) compartido con el resto de vistas (composables/usePeriod).
const yearOptions = computed<number[]>(() => periodYears());
// Meses disponibles según el año: en el año de inicio, solo desde mayo.
const monthOptions = computed(() =>
  year.value <= START_YEAR ? MONTHS.filter((m) => m.value >= START_MONTH) : MONTHS
);

const isWithdrawal = computed(() => form.value.type === 'WITHDRAWAL');
const isTransfer = computed(() => form.value.type === 'TRANSFER');
const isPurchase = computed(() => form.value.type === 'PURCHASE');
const isCreditPurchase = computed(() => isPurchase.value && form.value.isCredit);
const showVendor = computed(() => isPurchase.value);
const showCreditToggle = computed(() => isPurchase.value);
const showDueDate = computed(() => isCreditPurchase.value);
const showPaymentMethod = computed(() => !isWithdrawal.value && !isCreditPurchase.value);
const showAccount = computed(() => isWithdrawal.value); // cuenta de la que sale el efectivo
// Cuenta opcional para ingreso/gasto: si se elige, mueve el saldo de esa cuenta.
// Solo con métodos que tocan una cuenta bancaria (no efectivo/tarjeta/billetera).
const showOptionalAccount = computed(() =>
  ['INCOME', 'EXPENSE'].includes(form.value.type) &&
  ['BANK_TRANSFER', 'DEPOSIT'].includes(form.value.paymentMethod)
);
const accountMap = computed(() => new Map(accounts.value.map((a) => [a.id, a])));
// Interbancaria = transferencia entre cuentas de bancos DISTINTOS.
const isInterbankTransfer = computed(() => {
  if (!isTransfer.value) return false;
  const o = form.value.accountId != null ? accountMap.value.get(form.value.accountId) : null;
  const d = form.value.toAccountId != null ? accountMap.value.get(form.value.toAccountId) : null;
  return !!(o?.bankId && d?.bankId && o.bankId !== d.bankId);
});
// Comisión: en transferencias entre cuentas de bancos distintos, o en movimientos
// pagados por banco/depósito cuando el banco origen y destino son diferentes.
const showCommission = computed(() => {
  if (isTransfer.value) return isInterbankTransfer.value;
  return showFromBank.value && showToBank.value
    && !!form.value.fromBankId && !!form.value.toBankId
    && form.value.fromBankId !== form.value.toBankId;
});
const showCard = computed(() => {
  if (isWithdrawal.value) return false;
  if (isCreditPurchase.value) return false;
  return ['DEBIT_CARD', 'CREDIT_CARD'].includes(form.value.paymentMethod);
});
const showWallet = computed(() => {
  if (isWithdrawal.value) return false;
  if (isCreditPurchase.value) return false;
  return form.value.paymentMethod === 'WALLET';
});
const showFromBank = computed(() => {
  if (isWithdrawal.value) return true;
  if (isCreditPurchase.value) return false;
  return ['BANK_TRANSFER', 'DEPOSIT'].includes(form.value.paymentMethod);
});
const showToBank = computed(() => !isWithdrawal.value && !isCreditPurchase.value && ['BANK_TRANSFER', 'DEPOSIT'].includes(form.value.paymentMethod));
const activeBanks = computed(() => banks.value.filter((b) => b.isActive !== false));

// Opciones para los selectores en modal (PickerField)
type PickOpt = { value: number | null; label: string; sublabel?: string; icon?: string };
function accountSubLabel(a: Account): string | undefined {
  const parts: string[] = [];
  if (a.holder) parts.push(a.holder);
  if (a.bankName) parts.push(a.bankName);
  if (a.accountNumber) parts.push(`****${a.accountNumber.slice(-4)}`);
  if (!parts.length) parts.push(ACCOUNT_TYPE_LABEL[a.type || ''] || '');
  return parts.filter(Boolean).join(' · ') || undefined;
}
const accountOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Sin cuenta', icon: '∅' },
  ...accounts.value.map((a) => ({ value: a.id, label: a.name, sublabel: accountSubLabel(a), icon: accountIcon(a.type) }))
]);
const CARD_TYPE_LABEL: Record<string, string> = { CREDIT: 'Crédito', DEBIT: 'Débito' };
function cardSubLabel(c: Card): string | undefined {
  const parts: string[] = [];
  if (c.type) parts.push(CARD_TYPE_LABEL[c.type] || c.type);
  if (c.bankName) parts.push(c.bankName);
  if (c.last4) parts.push(`****${c.last4}`);
  return parts.join(' · ') || undefined;
}
// Solo las tarjetas del tipo elegido: débito → DEBIT, crédito → CREDIT.
const wantedCardType = computed<string | null>(() =>
  form.value.paymentMethod === 'CREDIT_CARD' ? 'CREDIT'
    : form.value.paymentMethod === 'DEBIT_CARD' ? 'DEBIT' : null
);
const cardsOfType = computed<Card[]>(() => {
  const want = wantedCardType.value;
  return want ? cards.value.filter((c) => (c.type || '').toUpperCase() === want) : cards.value;
});
const cardOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Sin tarjeta', icon: '∅' },
  ...cardsOfType.value.map((c) => ({ value: c.id, label: c.name, sublabel: cardSubLabel(c), icon: '💳' }))
]);
const cardEmptyText = computed(() =>
  wantedCardType.value === 'DEBIT' ? 'No tienes tarjetas de débito. Créalas en la sección Tarjetas.'
    : wantedCardType.value === 'CREDIT' ? 'No tienes tarjetas de crédito. Créalas en la sección Tarjetas.'
      : 'No tienes tarjetas. Créalas en la sección Tarjetas.'
);
// Si cambia el tipo de tarjeta y la elegida ya no corresponde, se limpia.
watch(() => form.value.paymentMethod, () => {
  if (!showCard.value) return;
  if (form.value.cardId != null && !cardsOfType.value.some((c) => c.id === form.value.cardId)) {
    form.value.cardId = null;
  }
});
const bankOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Ninguno', icon: '∅' },
  ...activeBanks.value.map((b) => ({ value: b.id, label: b.name, sublabel: bankSubLabel(b), icon: '🏦' }))
]);
const walletOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Sin billetera', icon: '∅' },
  ...wallets.value.filter((w) => w.isActive !== false).map((w) => ({ value: w.id, label: w.name, sublabel: w.provider || undefined, icon: '👛' }))
]);
// Billetera seleccionada y sus cuentas de banco de respaldo (configuradas en Ajustes).
const selectedWallet = computed(() => wallets.value.find((w) => w.id === form.value.walletId) || null);
const walletBackingAccounts = computed<Account[]>(() => {
  const ids = selectedWallet.value?.accountIds ?? [];
  return accounts.value.filter((a) => ids.includes(a.id));
});
const showWalletAccount = computed(() => showWallet.value && form.value.walletId != null);
const walletAccountOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Sin cuenta de respaldo', icon: '∅' },
  ...walletBackingAccounts.value.map((a) => ({ value: a.id, label: a.name, sublabel: accountSubLabel(a), icon: accountIcon(a.type) }))
]);
// Si cambia la billetera, descarta la cuenta de respaldo que ya no pertenezca a ella.
watch(() => form.value.walletId, () => {
  if (!showWallet.value) return;
  const ids = selectedWallet.value?.accountIds ?? [];
  if (form.value.accountId != null && !ids.includes(form.value.accountId)) form.value.accountId = null;
});

// Sección "dinero": sólo se muestra si algún campo de pago/cuenta aplica.
const showMoneySection = computed(() =>
  isTransfer.value || showPaymentMethod.value || showAccount.value || showOptionalAccount.value || showCard.value || showWallet.value || showFromBank.value || showToBank.value
);
const moneySectionTitle = computed(() => {
  if (isWithdrawal.value) return 'Retiro de efectivo';
  if (form.value.type === 'TRANSFER') return 'Origen y destino';
  if (form.value.type === 'INCOME') return '¿Dónde entró el dinero?';
  return '¿Cómo se pagó?';
});

// Conteo y total por subtipo de gasto (sobre TODO el mes)
const kindStats = computed(() => {
  const stat: Record<ExpenseKind, { count: number; sum: number }> = {
    FIXED: { count: 0, sum: 0 },
    VARIABLE: { count: 0, sum: 0 },
    NON_ACCOUNTABLE: { count: 0, sum: 0 }
  };
  for (const r of rows.value) {
    if (r.type !== 'EXPENSE' || !r.expenseKind) continue;
    const s = stat[r.expenseKind];
    if (!s) continue;
    s.count += 1;
    s.sum += Number(r.amount ?? 0);
  }
  return stat;
});

const expenseRowsAll = computed(() => rows.value.filter((r) => r.type === 'EXPENSE'));
function tabCount(key: TabKey): number {
  return key === 'ALL' ? expenseRowsAll.value.length : kindStats.value[key].count;
}
function tabSum(key: TabKey): number {
  return key === 'ALL'
    ? expenseRowsAll.value.reduce((a, r) => a + Number(r.amount ?? 0), 0)
    : kindStats.value[key].sum;
}
function setTab(key: TabKey) {
  activeTab.value = key;
  resetTableAccountFilters();
  // Estas pestañas SIEMPRE viven dentro de Gastos: "Todos" = todos los gastos.
  typeFilter.value = 'EXPENSE';
  if (key !== 'ALL') {
    form.value.type = 'EXPENSE';
    form.value.expenseKind = key;
  }
}

// ---- Filtros de la tabla ----
// El tipo de la tabla lo dirige el selector "¿Qué quieres registrar?" (form.type) y las
// pestañas de subtipo de gasto. typeFilter='ALL' solo cuando se elige "Todos".
// Arranca enfocado en Ingresos, salvo que la URL pida un subtipo de gasto (?expenseKind=...),
// en cuyo caso el tipo en vista debe ser Gasto para que el subtipo tenga sentido.
const typeFilter = ref<'ALL' | MovementType>(initialTab() === 'ALL' ? 'INCOME' : 'EXPENSE');
const accountFilter = ref<number | null>(null);   // cuenta (ingreso/gasto/compra/retiro)
const originFilter = ref<number | null>(null);     // cuenta de origen (transferencias)
const destFilter = ref<number | null>(null);       // cuenta de destino (transferencias)
const filterBankId = ref<number | null>(null);     // banco del retiro (retiros)
const categoryFilter = ref<number | null>(null);   // categoría (ingreso/gasto/compra)
const paymentFilter = ref<string>('');             // método de pago ('' = todos)
const dateFrom = ref('');
const dateTo = ref('');
const ymd = (v: unknown) => String(v).slice(0, 10);
const acctOptLabel = (a: Account) => [a.name, a.bankName, a.accountNumber ? '****' + a.accountNumber.slice(-4) : ''].filter(Boolean).join(' · ');

// Cuentas del banco elegido (filtro de retiro).
const filterAccounts = computed<Account[]>(() =>
  filterBankId.value ? accounts.value.filter((a) => a.bankId === filterBankId.value) : accounts.value
);
// Las categorías ya no se separan por tipo: el filtro muestra todas.
const filterCategories = computed(() => categories.value as Array<{ id: number; name: string; icon?: string | null }>);
// Tipos que muestran filtros de categoría y método de pago.
const showCatPayFilters = computed(() => ['INCOME', 'EXPENSE', 'PURCHASE'].includes(typeFilter.value));

function resetTableAccountFilters() {
  accountFilter.value = null; originFilter.value = null; destFilter.value = null; filterBankId.value = null;
  categoryFilter.value = null; paymentFilter.value = '';
}
const hasActiveFilters = computed(() =>
  accountFilter.value != null || originFilter.value != null || destFilter.value != null ||
  filterBankId.value != null || categoryFilter.value != null || !!paymentFilter.value ||
  !!dateFrom.value || !!dateTo.value
);
function clearFilters() {
  resetTableAccountFilters();
  dateFrom.value = ''; dateTo.value = '';
}
// Al cambiar el banco del filtro de retiro, limpia la cuenta si ya no pertenece a ese banco.
watch(filterBankId, (bankId) => {
  if (bankId != null && accountFilter.value != null) {
    const acc = accountMap.value.get(accountFilter.value);
    if (acc && acc.bankId !== bankId) accountFilter.value = null;
  }
});

// Filas mostradas según tipo (selector de arriba) + subtipo de gasto + cuenta(s)/banco + fechas
const displayRows = computed(() => {
  let list = rows.value;
  if (typeFilter.value !== 'ALL') list = list.filter((r) => r.type === typeFilter.value);
  // El subtipo (Fijos/Variables/No contables) SOLO aplica dentro de Gastos. Si el tipo en vista
  // no es gasto (p. ej. Ingresos), un activeTab heredado dejaría la tabla vacía: lo ignoramos.
  if (activeTab.value !== 'ALL' && (typeFilter.value === 'EXPENSE' || typeFilter.value === 'ALL')) {
    list = list.filter((r) => r.type === 'EXPENSE' && r.expenseKind === activeTab.value);
  }
  if (typeFilter.value === 'TRANSFER') {
    if (originFilter.value != null) list = list.filter((r) => r.accountId === originFilter.value);
    if (destFilter.value != null) list = list.filter((r) => r.toAccountId === destFilter.value);
  } else if (typeFilter.value === 'WITHDRAWAL') {
    if (filterBankId.value != null) list = list.filter((r) => r.fromBankId === filterBankId.value);
    if (accountFilter.value != null) list = list.filter((r) => r.accountId === accountFilter.value);
  } else if (accountFilter.value != null) {
    const id = accountFilter.value;
    list = list.filter((r) => r.accountId === id || r.toAccountId === id);
  }
  if (categoryFilter.value != null) list = list.filter((r) => r.categoryId === categoryFilter.value);
  if (paymentFilter.value) list = list.filter((r) => r.paymentMethod === paymentFilter.value);
  if (dateFrom.value) list = list.filter((r) => ymd(r.movementDate) >= dateFrom.value);
  if (dateTo.value) list = list.filter((r) => ymd(r.movementDate) <= dateTo.value);
  return list;
});

const TYPE_FILTER_LABEL: Record<string, string> = { INCOME: 'Ingresos', EXPENSE: 'Gastos', PURCHASE: 'Compras', TRANSFER: 'Transferencias', WITHDRAWAL: 'Retiros', CARD_PAYMENT: 'Pagos de tarjeta', ADJUSTMENT: 'Ajustes' };
const tableTitle = computed(() => {
  if (activeTab.value !== 'ALL') return 'Gastos ' + (TABS.find((t) => t.key === activeTab.value)?.label || '').toLowerCase();
  if (typeFilter.value !== 'ALL') return TYPE_FILTER_LABEL[typeFilter.value] || 'Movimientos';
  return 'Movimientos del mes';
});

// Vuelve a la vista "Todos" (no toca el formulario, solo la tabla).
function viewAll() { typeFilter.value = 'ALL'; activeTab.value = 'ALL'; resetTableAccountFilters(); }
// Vista dedicada a los pagos de tarjeta (se registran desde Tarjetas; aquí se ven y se eliminan).
function viewCardPayments() { typeFilter.value = 'CARD_PAYMENT'; activeTab.value = 'ALL'; resetTableAccountFilters(); }

// ---- Resumen adaptativo: cada tipo muestra SOLO sus tarjetas relevantes ----
const num = (r: Movement) => Number(r.amount || 0);
const sumOf = (arr: Movement[], f: (r: Movement) => number = num) => arr.reduce((a, r) => a + f(r), 0);
const rowsOfType = (t: MovementType) => rows.value.filter((r) => r.type === t);
const monthTotals = computed(() => {
  let income = 0, expense = 0;
  for (const r of rows.value) {
    const a = num(r);
    if (r.type === 'INCOME') income += a;
    else if (r.type === 'EXPENSE' || r.type === 'WITHDRAWAL') expense += a;
    else if (r.type === 'PURCHASE' && !r.isCredit) expense += a;
    expense += Number(r.commission || 0);
  }
  return { income, expense, balance: income - expense };
});

interface SumCard { key: string; label: string; value: string; badge?: number; clickable?: boolean; active?: boolean; accent?: 'pos' | 'neg' | ''; onClick?: () => void }
const summaryCards = computed<SumCard[]>(() => {
  const tf = typeFilter.value;
  if (tf === 'EXPENSE') {
    return TABS.map((t) => ({
      key: t.key, label: t.label, badge: tabCount(t.key),
      value: formatMoney(tabSum(t.key)),
      clickable: true, active: activeTab.value === t.key, accent: 'neg',
      onClick: () => setTab(t.key)
    }));
  }
  if (tf === 'INCOME') {
    const r = rowsOfType('INCOME');
    return [
      { key: 'sum', label: 'Ingresos del mes', value: formatMoney(sumOf(r)), accent: 'pos' },
      { key: 'cnt', label: 'Registros', value: String(r.length) }
    ];
  }
  if (tf === 'PURCHASE') {
    const r = rowsOfType('PURCHASE');
    const paid = r.filter((x) => !x.isCredit), fiada = r.filter((x) => x.isCredit);
    return [
      { key: 'tot', label: 'Compras del mes', value: formatMoney(sumOf(r)) },
      { key: 'paid', label: 'Pagadas', value: formatMoney(sumOf(paid)), accent: 'neg' },
      { key: 'fiada', label: 'Fiadas (por pagar)', value: formatMoney(sumOf(fiada)), accent: '' }
    ];
  }
  if (tf === 'TRANSFER') {
    const r = rowsOfType('TRANSFER');
    return [
      { key: 'cnt', label: 'Transferencias', value: String(r.length) },
      { key: 'tot', label: 'Total transferido', value: formatMoney(sumOf(r)) },
      { key: 'com', label: 'Comisiones', value: formatMoney(sumOf(r, (x) => Number(x.commission || 0))), accent: 'neg' }
    ];
  }
  if (tf === 'WITHDRAWAL') {
    const r = rowsOfType('WITHDRAWAL');
    return [
      { key: 'tot', label: 'Retirado del mes', value: formatMoney(sumOf(r)), accent: 'neg' },
      { key: 'cnt', label: 'Retiros', value: String(r.length) }
    ];
  }
  if (tf === 'CARD_PAYMENT' || tf === 'ADJUSTMENT') {
    const r = rowsOfType(tf);
    return [
      { key: 'tot', label: TYPE_FILTER_LABEL[tf], value: formatMoney(sumOf(r)) },
      { key: 'cnt', label: 'Registros', value: String(r.length) }
    ];
  }
  // ALL → panorama del mes
  return [
    { key: 'all', label: 'Movimientos', value: 'registros', badge: rows.value.length },
    { key: 'inc', label: 'Ingresos', value: formatMoney(monthTotals.value.income), accent: 'pos' },
    { key: 'exp', label: 'Gastos', value: formatMoney(monthTotals.value.expense), accent: 'neg' },
    { key: 'bal', label: 'Balance', value: formatMoney(monthTotals.value.balance), accent: monthTotals.value.balance >= 0 ? 'pos' : 'neg' }
  ];
});

// Cuentas filtradas por el banco del retiro: solo cuentas de ESE banco.
const withdrawalAccountOptions = computed<PickOpt[]>(() => {
  const bankId = form.value.fromBankId;
  const list = bankId ? accounts.value.filter((a) => a.bankId === bankId) : accounts.value;
  return [
    { value: null, label: 'Sin cuenta', icon: '∅' },
    ...list.map((a) => ({ value: a.id, label: a.name, sublabel: accountSubLabel(a), icon: accountIcon(a.type) }))
  ];
});
// Si cambia el banco del retiro y la cuenta elegida no pertenece a él, se limpia.
watch(() => form.value.fromBankId, (bankId) => {
  if (!isWithdrawal.value || bankId == null) return;
  const acc = form.value.accountId != null ? accountMap.value.get(form.value.accountId) : null;
  if (acc && acc.bankId !== bankId) form.value.accountId = null;
});

const totals = computed(() => {
  let income = 0, expense = 0;
  for (const r of displayRows.value) {
    const a = Number(r.amount ?? 0);
    if (r.type === 'INCOME') income += a;
    else if (r.type === 'EXPENSE' || r.type === 'WITHDRAWAL') expense += a;
    else if (r.type === 'PURCHASE' && !r.isCredit) expense += a;
    expense += Number(r.commission ?? 0); // la comisión siempre es un costo
  }
  return { income, expense, balance: income - expense };
});

// Las fechas se guardan como medianoche UTC (date-only). Se muestran con componentes UTC
// para no retroceder un día en zonas horarias negativas (ej. America/Guayaquil -05).
function formatDate(v: string) { if (!v) return ''; const d = new Date(v); return Number.isNaN(d.getTime()) ? v : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; }
function signedAmount(item: Movement) {
  const a = Number(item.amount ?? 0);
  if (item.type === 'INCOME') return { text: `+${formatMoney(a)}`, cls: 'pos' };
  if (item.type === 'EXPENSE' || item.type === 'WITHDRAWAL') return { text: `-${formatMoney(a)}`, cls: 'neg' };
  if (item.type === 'PURCHASE') return { text: (item.isCredit ? '' : '-') + formatMoney(a), cls: item.isCredit ? '' : 'neg' };
  if (item.type === 'CARD_PAYMENT') return { text: `-${formatMoney(a)}`, cls: 'neg' };
  if (item.type === 'ADJUSTMENT') return { text: (item.isCredit ? '+' : '-') + formatMoney(a), cls: item.isCredit ? 'pos' : 'neg' };
  return { text: formatMoney(a), cls: '' };
}
function accountOrCardLabel(item: Movement) {
  if (item.type === 'TRANSFER' && (item.account || item.toAccount)) return `${item.account?.name || '?'} → ${item.toAccount?.name || '?'}`;
  if (item.card) return `💳 ${item.card.name}`;
  if (item.wallet) return `👛 ${item.wallet.name}`;
  if (item.account) return `🏦 ${item.account.name}`;
  return '—';
}
function setType(t: MovementType) {
  form.value.type = t;
  // El selector de arriba también filtra la tabla por ese tipo.
  typeFilter.value = t;
  activeTab.value = 'ALL';
  resetTableAccountFilters();
}

// ---- Modal del formulario de registro ----
const formModalOpen = ref(false);
const modalTitle = computed(() =>
  editingId.value !== null ? 'Editar movimiento' : `Nuevo ${(TYPE_LABEL[form.value.type] || 'movimiento').toLowerCase()}`
);
// Abre el modal con un movimiento nuevo del tipo elegido.
function openForm(t: MovementType) {
  editingId.value = null;
  form.value = buildEmptyForm();
  setType(t);
  attachRef.value?.reset();
  formModalOpen.value = true;
}
function closeForm() {
  formModalOpen.value = false;
  cancelEdit();
}

// ---- Selector de tipo: elegir marca el tipo y muestra debajo el botón para registrar ----
const selectedType = ref<MovementType | null>(null);
function pickType(t: MovementType) { selectedType.value = t; }
function registerSelected() { if (selectedType.value) openForm(selectedType.value); }
const selectedTypeLabel = computed(() =>
  selectedType.value ? `Registrar ${ADD_LABEL[selectedType.value]}` : ''
);

// ---- Botón contextual "Agregar nuevo …" en la zona de la tabla ----
// El texto y el tipo que abre el modal siguen al tipo que se está viendo en la tabla.
const ADD_LABEL: Record<MovementType, string> = {
  INCOME: 'nuevo ingreso', EXPENSE: 'nuevo gasto', PURCHASE: 'nueva compra',
  TRANSFER: 'nueva transferencia', WITHDRAWAL: 'nuevo retiro',
  CARD_PAYMENT: 'movimiento', ADJUSTMENT: 'movimiento'
};
// Si la tabla muestra un tipo editable, ese; si es "Todos" u otro no editable, ingreso por defecto.
const tableAddType = computed<MovementType>(() =>
  typeFilter.value !== 'ALL' && FORM_TYPES.includes(typeFilter.value as MovementType)
    ? (typeFilter.value as MovementType)
    : 'INCOME'
);
// Los pagos de tarjeta/ajustes no se registran aquí → sin botón de agregar.
const canAddForTable = computed(() =>
  typeFilter.value === 'ALL' || FORM_TYPES.includes(typeFilter.value as MovementType)
);
const tableAddLabel = computed(() =>
  typeFilter.value === 'ALL' ? 'Registrar movimiento' : `Agregar ${ADD_LABEL[tableAddType.value]}`
);

// ---- Selector de tipo dentro de los filtros (filtros inteligentes) ----
// Cambiar el tipo aquí reconfigura los filtros: p. ej. Transferencia muestra origen y destino.
const TYPE_FILTER_OPTIONS: { value: 'ALL' | MovementType; label: string }[] = [
  { value: 'ALL', label: 'Todos' },
  { value: 'INCOME', label: 'Ingresos' },
  { value: 'EXPENSE', label: 'Gastos' },
  { value: 'PURCHASE', label: 'Compras' },
  { value: 'TRANSFER', label: 'Transferencias' },
  { value: 'WITHDRAWAL', label: 'Retiros' },
  { value: 'CARD_PAYMENT', label: 'Pagos de tarjeta' }
];
function onTypeFilterChange() {
  activeTab.value = 'ALL';
  resetTableAccountFilters();
}

// ---- Modal de detalle (click en la fila) ----
const detailOpen = ref(false);
const detailItem = ref<Movement | null>(null);
const detailAttachments = ref<AttachmentMeta[]>([]);
const detailLoadingAtt = ref(false);
const viewerOpen = ref(false);
const viewerAtt = ref<AttachmentMeta | null>(null);

async function openDetail(item: Movement) {
  detailItem.value = item;
  detailOpen.value = true;
  detailAttachments.value = [];
  detailLoadingAtt.value = true;
  try { detailAttachments.value = await attachmentsApi.list('MOVEMENT', item.id); }
  catch { /* sin comprobantes */ }
  finally { detailLoadingAtt.value = false; }
}
function openAttachment(att: AttachmentMeta) { viewerAtt.value = att; viewerOpen.value = true; }
function editFromDetail() {
  if (!detailItem.value) return;
  const it = detailItem.value;
  detailOpen.value = false;
  startEdit(it);
}
function fmtBank(b?: Bank | null): string {
  if (!b) return '';
  const parts = [b.name];
  if (b.accountKind) parts.push(b.accountKind === 'SAVINGS' ? 'Ahorros' : 'Corriente');
  if (b.accountNumber) parts.push(`****${b.accountNumber.slice(-4)}`);
  return parts.join(' · ');
}
function fmtAccount(a?: Account | null): string {
  if (!a) return '';
  const parts = [a.name];
  if (a.holder) parts.push(a.holder);
  if (a.bankName) parts.push(a.bankName);
  if (a.accountNumber) parts.push(`****${a.accountNumber.slice(-4)}`);
  return parts.join(' · ');
}
const fileSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

async function load() {
  try {
    const params: Record<string, string | number> = { year: year.value, month: month.value };
    const [m, a, c, cat, b, w] = await Promise.all([
      http.get<Movement[]>('/movements', { params }),
      http.get<Account[]>('/accounts'), http.get<Card[]>('/cards'), http.get<Category[]>('/categories'),
      http.get<Bank[]>('/banks'), http.get<Wallet[]>('/wallets')
    ]);
    rows.value = m.data; accounts.value = a.data; cards.value = c.data; categories.value = cat.data;
    banks.value = b.data; wallets.value = w.data;
  } catch { toast.error('No se pudieron cargar los movimientos.'); }
}

// ---- Navegación de período (mes/año) ----
const periodLabel = computed(() => `${MONTHS.find((m) => m.value === month.value)?.label ?? ''} ${year.value}`);
const isCurrentMonth = computed(() => month.value === now.getMonth() + 1 && year.value === now.getFullYear());
// No se puede retroceder antes del período de inicio (mayo 2026).
const atStartPeriod = computed(() => year.value <= START_YEAR && month.value <= START_MONTH);
function prevMonth() {
  if (atStartPeriod.value) return;
  if (month.value === 1) { month.value = 12; year.value -= 1; }
  else month.value -= 1;
  load();
}
function nextMonth() {
  if (month.value === 12) { month.value = 1; year.value += 1; }
  else month.value += 1;
  load();
}
function goCurrentMonth() {
  month.value = now.getMonth() + 1;
  year.value = now.getFullYear();
  load();
}
// Si al cambiar de año el mes queda fuera del rango permitido, se ajusta al mínimo.
watch(year, () => {
  if (year.value <= START_YEAR && month.value < START_MONTH) { month.value = START_MONTH; }
  load();
});

async function save() {
  if (form.value.description.trim().length < 2) { toast.error('El detalle es obligatorio (mínimo 2 caracteres).'); return; }
  if (!(Number(form.value.amount) > 0)) { toast.error('El monto debe ser mayor a 0.'); return; }
  if (isTransfer.value) {
    if (!form.value.accountId || !form.value.toAccountId) { toast.error('Elige la cuenta de origen y la de destino.'); return; }
    if (form.value.accountId === form.value.toAccountId) { toast.error('La cuenta de origen y la de destino deben ser distintas.'); return; }
  }
  if (isWithdrawal.value && !form.value.accountId) { toast.error('Elige la cuenta de la que sale el efectivo.'); return; }
  saving.value = true;
  try {
    let effectivePaymentMethod: PaymentMethod = form.value.paymentMethod;
    if (isWithdrawal.value || isTransfer.value) effectivePaymentMethod = 'BANK_TRANSFER';
    if (isCreditPurchase.value) effectivePaymentMethod = 'OTHER';
    const payload = {
      type: form.value.type,
      expenseKind: form.value.type === 'EXPENSE' ? form.value.expenseKind : null,
      amount: Number(form.value.amount), movementDate: form.value.movementDate,
      description: form.value.description.trim(), paymentMethod: effectivePaymentMethod,
      accountId: isTransfer.value ? (form.value.accountId || null) : ((showAccount.value || showOptionalAccount.value || showWalletAccount.value) ? form.value.accountId || null : null),
      toAccountId: isTransfer.value ? (form.value.toAccountId || null) : null,
      cardId: !isTransfer.value && showCard.value ? form.value.cardId || null : null,
      walletId: !isTransfer.value && showWallet.value ? form.value.walletId || null : null,
      categoryId: (isWithdrawal.value || isTransfer.value) ? null : (form.value.categoryId || null),
      fromBankId: !isTransfer.value && showFromBank.value ? form.value.fromBankId || null : null,
      toBankId: !isTransfer.value && showToBank.value ? form.value.toBankId || null : null,
      vendor: isPurchase.value ? (form.value.vendor.trim() || null) : null,
      isCredit: isPurchase.value ? !!form.value.isCredit : false,
      dueDate: isCreditPurchase.value && form.value.dueDate ? form.value.dueDate : null,
      commission: showCommission.value ? (Number(form.value.commission) || null) : null,
      familyMember: form.value.familyMember.trim() || null,
      notes: form.value.notes.trim() || null
    };
    if (editingId.value !== null) {
      await http.put(`/movements/${editingId.value}`, payload);
      toast.success('Movimiento actualizado.');
    } else {
      const { data: created } = await http.post<{ id: number }>('/movements', payload);
      if (attachRef.value?.hasPending()) await attachRef.value.flush(created.id);
      toast.success('Movimiento registrado.');
    }
    const keepType = form.value.type, keepDate = form.value.movementDate, keepPm = form.value.paymentMethod, keepKind = form.value.expenseKind;
    form.value = { type: keepType, expenseKind: keepKind, amount: 0, movementDate: keepDate, description: '', paymentMethod: keepPm, accountId: null, toAccountId: null, cardId: null, walletId: null, categoryId: null, fromBankId: null, toBankId: null, vendor: '', isCredit: false, dueDate: '', commission: 0, familyMember: '', notes: '' };
    editingId.value = null;
    formModalOpen.value = false;
    await load();
  } catch { toast.error('No se pudo registrar el movimiento.'); }
  finally { saving.value = false; }
}

// Tipos que el formulario de "Nuevo movimiento" sabe editar. Los pagos de tarjeta
// (y ajustes) se generan desde otra pantalla y NO deben editarse aquí: el formulario
// perdería el vínculo con la tarjeta y descuadraría los saldos. Se corrigen borrándolos.
const FORM_TYPES: MovementType[] = ['INCOME', 'EXPENSE', 'TRANSFER', 'WITHDRAWAL', 'PURCHASE'];
const canEditInForm = (item: Movement) => FORM_TYPES.includes(item.type);

function startEdit(item: Movement) {
  if (!canEditInForm(item)) {
    toast.error('Un pago de tarjeta no se edita aquí. Para corregirlo, elimínalo (se revierte el saldo) y vuelve a registrarlo desde Tarjetas.');
    return;
  }
  editingId.value = item.id;
  form.value = {
    type: item.type,
    expenseKind: (item.expenseKind ?? 'VARIABLE') as ExpenseKind,
    amount: Number(item.amount),
    movementDate: String(item.movementDate).slice(0, 10),
    description: item.description,
    paymentMethod: item.paymentMethod,
    accountId: item.accountId,
    toAccountId: item.toAccountId,
    cardId: item.cardId,
    walletId: item.walletId,
    categoryId: item.categoryId,
    fromBankId: item.fromBankId,
    toBankId: item.toBankId,
    vendor: item.vendor || '',
    isCredit: !!item.isCredit,
    dueDate: item.dueDate ? String(item.dueDate).slice(0, 10) : '',
    commission: item.commission != null ? Number(item.commission) : 0,
    familyMember: item.familyMember || '',
    notes: item.notes || ''
  };
  formModalOpen.value = true;
}

function cancelEdit() {
  editingId.value = null;
  form.value = buildEmptyForm();
}

async function removeRow(item: Movement) {
  const msg = item.type === 'CARD_PAYMENT'
    ? `¿Eliminar este pago de tarjeta (${formatMoney(item.amount)})? Se devolverá el dinero a la cuenta de origen y se restaurará el saldo usado de la tarjeta.`
    : `Eliminar el movimiento "${item.description}" (${formatMoney(item.amount)})? Se revertirá el saldo en la cuenta/tarjeta afectada.`;
  if (!(await confirm({ message: msg, danger: true, confirmText: 'Eliminar' }))) return;
  try {
    await http.delete(`/movements/${item.id}`);
    toast.success('Movimiento eliminado y saldo revertido.');
    if (editingId.value === item.id) cancelEdit();
    await load();
  } catch { toast.error('No se pudo eliminar el movimiento.'); }
}

onMounted(load);
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Movimientos" subtitle="Ingresos, gastos y transferencias del mes.">
      <template #actions>
        <div class="period-nav" role="group" aria-label="Mes a consultar">
          <button type="button" class="icon-btn period-arrow" title="Mes anterior" aria-label="Mes anterior" :disabled="atStartPeriod" @click="prevMonth">
            <ChevronLeft :size="18" :stroke-width="2.4" />
          </button>
          <div class="period-center">
            <CalendarDays :size="15" class="period-icon" />
            <select v-model.number="month" class="period-select" aria-label="Mes" @change="load">
              <option v-for="m in monthOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <select v-model.number="year" class="period-select period-select-year" aria-label="Año">
              <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}</option>
            </select>
          </div>
          <button type="button" class="icon-btn period-arrow" title="Mes siguiente" aria-label="Mes siguiente" @click="nextMonth">
            <ChevronRight :size="18" :stroke-width="2.4" />
          </button>
        </div>
        <button v-if="!isCurrentMonth" type="button" class="mini period-today" @click="goCurrentMonth">
          <CalendarDays :size="14" /> Hoy
        </button>
      </template>
    </PageHeader>

    <div class="stack">
      <!-- Disparador: elegir el tipo lo marca y muestra debajo el botón para registrar -->
      <PanelCard title="Registrar movimiento">
        <p class="mov-trigger-hint">Elige qué quieres registrar y pulsa el botón para completar el detalle.</p>
        <div class="type-picker">
          <button
            v-for="t in TYPE_OPTIONS"
            :key="t.value"
            type="button"
            class="type-card"
            :class="['tc-' + t.accent, { active: selectedType === t.value }]"
            @click="pickType(t.value)"
          >
            <span class="type-card-icon"><component :is="t.icon" :size="20" :stroke-width="2.2" /></span>
            <span class="type-card-label">{{ t.label }}</span>
            <span class="type-card-desc">{{ t.desc }}</span>
          </button>
        </div>
        <div v-if="selectedType" class="type-picker-cta">
          <AppButton @click="registerSelected">
            <template #icon><Plus :size="16" /></template>{{ selectedTypeLabel }}
          </AppButton>
        </div>
      </PanelCard>

      <AppModal :open="formModalOpen" :title="modalTitle" max-width="780px" @close="closeForm">
        <form id="mov-form" class="form mov-form" @submit.prevent="save">
          <!-- Cambiar de tipo sin cerrar -->
          <div class="mov-type-switch">
            <button
              v-for="t in TYPE_OPTIONS"
              :key="t.value"
              type="button"
              class="mov-type-chip"
              :class="['tc-' + t.accent, { active: form.type === t.value }]"
              @click="setType(t.value)"
            >
              <component :is="t.icon" :size="15" :stroke-width="2.2" /> {{ t.label }}
            </button>
          </div>

          <!-- Paso 2: detalle -->
          <div class="form-section">
            <p class="form-section-title"><span class="step-num">2</span> Detalle</p>
            <div class="form-grid">
              <div class="field">
                <label for="mv-desc">Detalle<span class="required-mark">*</span></label>
                <input id="mv-desc" v-model="form.description" minlength="2" maxlength="120" required
                       :placeholder="isTransfer ? 'ej. Transferí $X a la cuenta de Juan' : 'ej. Compra supermercado, Pago Netflix'" />
                <small class="hint">{{ isTransfer ? 'Describe la transferencia.' : 'En qué se gastó o de dónde vino.' }}</small>
              </div>
              <div class="field">
                <label for="mv-date">Fecha <span class="required-mark">*</span></label>
                <input id="mv-date" v-model="form.movementDate" type="date" required />
              </div>
              <div v-if="!isWithdrawal" class="field">
                <label for="mv-cat">Categoría</label>
                <select id="mv-cat" v-model.number="form.categoryId">
                  <option :value="null">— Sin categoría —</option>
                  <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
                </select>
                <small class="hint">Para reportes y filtros.</small>
              </div>

              <div v-if="form.type === 'EXPENSE'" class="field field-wide">
                <label>Subtipo de gasto <span class="required-mark">*</span></label>
                <div class="seg-toggle seg-3">
                  <button
                    v-for="k in EXPENSE_KIND_OPTIONS"
                    :key="k.value"
                    type="button"
                    class="seg-toggle-btn"
                    :class="{ active: form.expenseKind === k.value }"
                    @click="form.expenseKind = k.value"
                  >{{ k.label }}</button>
                </div>
                <small class="hint">{{ EXPENSE_KIND_HINT[form.expenseKind] }}</small>
              </div>

              <div v-if="showVendor" class="field">
                <label for="mv-vendor">Proveedor</label>
                <input id="mv-vendor" v-model="form.vendor" maxlength="120" placeholder="ej. Supermaxi, Farmacia" />
              </div>
              <div v-if="showCreditToggle" class="field">
                <label>Forma de pago de la compra <span class="required-mark">*</span></label>
                <div class="seg-toggle">
                  <button type="button" class="seg-toggle-btn" :class="{ active: !form.isCredit }" @click="form.isCredit = false">Pagada</button>
                  <button type="button" class="seg-toggle-btn" :class="{ active: form.isCredit }" @click="form.isCredit = true">Fiada</button>
                </div>
                <small class="hint">{{ form.isCredit ? 'La pagas después; no afecta saldos ahora.' : 'Pago al momento; elige método abajo.' }}</small>
              </div>
              <div v-if="!isWithdrawal && !isCreditPurchase" class="field">
                <label for="mv-family">Quién paga</label>
                <input id="mv-family" v-model="form.familyMember" maxlength="80" placeholder="ej. María, Juan" />
                <small class="hint">Opcional. Persona involucrada.</small>
              </div>
            </div>

            <!-- Promesa de pago (compra fiada) -->
            <div v-if="isCreditPurchase" class="promise-block">
              <div class="promise-head">
                <span class="promise-ic">🤝</span>
                <div>
                  <strong>Promesa de pago</strong>
                  <small>Detalla cuándo y quién pagará esta compra fiada.</small>
                </div>
              </div>
              <div class="form-grid">
                <div class="field">
                  <label for="mv-due">¿Qué día se pagará? <span class="required-mark">*</span></label>
                  <input id="mv-due" v-model="form.dueDate" type="date" :required="isCreditPurchase" />
                  <small class="hint">Fecha en que se saldará la deuda.</small>
                </div>
                <div class="field">
                  <label for="mv-promise-who">¿Quién pagará?</label>
                  <input id="mv-promise-who" v-model="form.familyMember" maxlength="80" placeholder="ej. María, Juan, yo mismo" />
                  <small class="hint">Persona que se compromete a pagar.</small>
                </div>
              </div>
            </div>
          </div>

          <!-- Paso 3: dinero / pago -->
          <div v-if="showMoneySection" class="form-section">
            <p class="form-section-title"><span class="step-num">3</span> {{ moneySectionTitle }}</p>

            <!-- TRANSFERENCIA: cuenta de origen + cuenta de destino -->
            <template v-if="isTransfer">
              <div class="form-grid picker-grid">
                <div class="field">
                  <label>Cuenta de origen <span class="required-mark">*</span></label>
                  <PickerField
                    v-model="form.accountId"
                    :options="accountOptions"
                    title="Cuenta de origen"
                    placeholder="Elige la cuenta de origen"
                    empty-text="No tienes cuentas. Créalas en la sección Cuentas."
                  />
                  <small class="hint">De qué cuenta sale el dinero.</small>
                </div>
                <div class="field">
                  <label>Cuenta de destino <span class="required-mark">*</span></label>
                  <PickerField
                    v-model="form.toAccountId"
                    :options="accountOptions"
                    title="Cuenta de destino"
                    placeholder="Elige la cuenta de destino"
                    empty-text="No tienes cuentas. Créalas en la sección Cuentas."
                  />
                  <small class="hint">A qué cuenta llega el dinero.</small>
                </div>
              </div>

              <!-- Aviso interbancario (la comisión se ingresa bajo el Monto) -->
              <div v-if="isInterbankTransfer" class="interbank-block">
                <div class="interbank-head">
                  <span class="interbank-ic">🔀</span>
                  <div>
                    <strong>Transferencia interbancaria</strong>
                    <small>Las cuentas son de bancos distintos; ingresa la comisión bajo el Monto.</small>
                  </div>
                </div>
              </div>
            </template>

            <!-- OTROS MOVIMIENTOS: método de pago + instrumentos -->
            <template v-else>
              <div v-if="showPaymentMethod" class="field">
                <label>Método de pago <span class="required-mark">*</span></label>
                <div class="pay-picker">
                  <button
                    v-for="p in PAYMENT_OPTIONS"
                    :key="p.value"
                    type="button"
                    class="pay-chip"
                    :class="{ active: form.paymentMethod === p.value }"
                    @click="form.paymentMethod = p.value"
                  >
                    <span class="pay-chip-ic">{{ p.icon }}</span>
                    <span class="pay-chip-label">{{ p.label }}</span>
                  </button>
                </div>
              </div>

              <div class="form-grid picker-grid">
                <div v-if="showFromBank" class="field">
                  <label>🏦 {{ isWithdrawal ? 'Banco del retiro' : 'Banco origen' }} <span v-if="isWithdrawal" class="required-mark">*</span></label>
                  <PickerField
                    v-model="form.fromBankId"
                    :options="bankOptions"
                    :title="isWithdrawal ? 'Banco del retiro' : 'Banco origen'"
                    :placeholder="isWithdrawal ? 'Elige el banco' : 'Elige el banco origen'"
                    empty-text="No tienes bancos. Agrégalos en Configuración → Bancos."
                  />
                  <small class="hint">{{ isWithdrawal ? 'Banco del que retiras.' : 'Desde dónde salió el dinero.' }}</small>
                </div>
                <div v-if="showToBank" class="field">
                  <label>🏦 Banco destino</label>
                  <PickerField v-model="form.toBankId" :options="bankOptions" title="Banco destino" placeholder="Elige banco destino" />
                  <small class="hint">A dónde llegó el dinero.</small>
                </div>
                <div v-if="showAccount" class="field">
                  <label>Cuenta bancaria <span class="required-mark">*</span></label>
                  <PickerField
                    v-model="form.accountId"
                    :options="withdrawalAccountOptions"
                    title="Selecciona una cuenta"
                    :placeholder="form.fromBankId ? 'Elige una cuenta de ese banco' : 'Elige una cuenta'"
                    empty-text="No tienes cuentas de ese banco. Créalas en la sección Cuentas."
                  />
                  <small class="hint">{{ form.fromBankId ? 'Solo cuentas del banco elegido arriba.' : 'Elige primero el banco del retiro.' }}</small>
                </div>
                <div v-if="isWithdrawal" class="field">
                  <label for="mv-withdrawer">👤 Quién retiró</label>
                  <input id="mv-withdrawer" v-model="form.familyMember" type="text" maxlength="80" placeholder="ej. Juan Pérez" />
                  <small class="hint">Persona que hizo el retiro.</small>
                </div>
                <div v-if="showOptionalAccount" class="field">
                  <label>🏦 Cuenta afectada <small class="opt-tag">(opcional)</small></label>
                  <PickerField
                    v-model="form.accountId"
                    :options="accountOptions"
                    title="Selecciona una cuenta"
                    placeholder="Sin cuenta"
                    empty-text="No tienes cuentas. Créalas en la sección Cuentas."
                  />
                  <small class="hint">Si la eliges, {{ form.type === 'INCOME' ? 'suma' : 'resta' }} el saldo de esa cuenta.</small>
                </div>
                <div v-if="showWallet" class="field">
                  <label>👛 Billetera digital</label>
                  <PickerField
                    v-model="form.walletId"
                    :options="walletOptions"
                    title="Selecciona una billetera"
                    placeholder="Elige una billetera"
                    empty-text="No tienes billeteras. Agrégalas en Configuración → Billeteras digitales."
                  />
                  <small class="hint">Payphone, PayPal, Takenos, etc.</small>
                </div>
                <div v-if="showWalletAccount" class="field">
                  <label>🏦 Cuenta de banco que la respalda</label>
                  <PickerField
                    v-model="form.accountId"
                    :options="walletAccountOptions"
                    title="Cuenta de respaldo"
                    placeholder="Sin cuenta de respaldo"
                    :empty-text="`${selectedWallet?.name || 'Esta billetera'} no tiene cuentas ligadas. Agrégalas en Configuración → Billeteras digitales.`"
                  />
                  <small v-if="walletBackingAccounts.length" class="hint">
                    {{ form.type === 'INCOME' ? 'Suma' : 'Resta' }} el saldo de esta cuenta (la billetera se respalda en ella).
                  </small>
                  <small v-else class="hint warn-hint">
                    Liga cuentas a «{{ selectedWallet?.name }}» en <strong>Configuración → Billeteras digitales</strong> para elegir aquí cuál la respalda.
                  </small>
                </div>
                <div v-if="showCard" class="field">
                  <label>{{ wantedCardType === 'DEBIT' ? 'Tarjeta de débito' : wantedCardType === 'CREDIT' ? 'Tarjeta de crédito' : 'Tarjeta' }}</label>
                  <PickerField
                    v-model="form.cardId"
                    :options="cardOptions"
                    title="Selecciona una tarjeta"
                    placeholder="Elige una tarjeta"
                    :empty-text="cardEmptyText"
                  />
                </div>
              </div>
              <p v-if="(showFromBank || showToBank) && activeBanks.length === 0" class="hint warn-hint">
                No tienes bancos cargados todavía. Agrégalos en <strong>Configuración → Bancos</strong>.
              </p>
            </template>
          </div>

          <!-- Notas (izquierda) · Monto + acción (derecha) -->
          <div class="form-section">
            <div class="field">
              <label>Comprobante</label>
              <AttachmentUploader ref="attachRef" entity-type="MOVEMENT" :entity-id="editingId" />
            </div>
            <div class="mov-final-grid">
              <div class="field mov-final-notes">
                <label for="mv-notes">Notas</label>
                <textarea id="mv-notes" v-model="form.notes" maxlength="500" placeholder="Detalles adicionales, número de factura, etc."></textarea>
              </div>
              <div class="mov-final-right">
                <div class="field amount-field">
                  <label for="mv-amount">Monto (USD) <span class="required-mark">*</span></label>
                  <input id="mv-amount" v-model.number="form.amount" type="number" step="0.01" min="0.01" required placeholder="0.00" />
                </div>
                <div v-if="showCommission" class="field commission-field">
                  <label for="mv-commission">💸 Comisión interbancaria (USD)</label>
                  <input id="mv-commission" v-model.number="form.commission" type="number" step="0.01" min="0" placeholder="0.00" />
                  <small class="hint">Valor extra cobrado por transferir entre bancos distintos.</small>
                </div>
                <div class="mov-final-actions">
                  <AppButton variant="ghost" @click="closeForm">
                    <template #icon><X :size="16" /></template>Cancelar
                  </AppButton>
                  <AppButton type="submit" :loading="saving">
                    <template #icon><component :is="editingId !== null ? Pencil : Plus" :size="16" /></template>
                    {{ editingId !== null ? 'Guardar cambios' : 'Registrar movimiento' }}
                  </AppButton>
                </div>
              </div>
            </div>
          </div>
        </form>
      </AppModal>

      <PanelCard>
        <div class="mov-section-head">
          <span class="mov-section-title">{{ typeFilter === 'ALL' ? 'Resumen del mes' : TYPE_FILTER_LABEL[typeFilter] || 'Resumen' }}</span>
          <div class="mov-section-actions">
            <button v-if="typeFilter !== 'CARD_PAYMENT'" type="button" class="ghost mini" @click="viewCardPayments">
              💳 Pagos de tarjeta
            </button>
            <button v-if="typeFilter !== 'ALL'" type="button" class="ghost mini view-all" @click="viewAll">
              ← Ver todos
            </button>
          </div>
        </div>
        <div class="mov-tabs" :class="{ 'is-static': typeFilter !== 'EXPENSE' }" role="tablist">
          <button
            v-for="c in summaryCards"
            :key="c.key"
            type="button"
            class="mov-tab"
            :class="{ active: c.active, 'is-readonly': !c.clickable }"
            role="tab"
            :aria-selected="!!c.active"
            :disabled="!c.clickable"
            @click="c.onClick && c.onClick()"
          >
            <span class="mov-tab-top">
              <span class="mov-tab-label">{{ c.label }}</span>
              <span v-if="c.badge != null" class="mov-tab-count">{{ c.badge }}</span>
            </span>
            <span class="mov-tab-sum" :class="c.accent">{{ c.value }}</span>
          </button>
        </div>

        <!-- Filtros de la tabla (la tabla muestra el tipo seleccionado arriba) -->
        <div class="mov-filters">
          <div class="mov-filter-row">
            <!-- Tipo: reconfigura los demás filtros (transferencia → origen/destino, retiro → banco/cuenta) -->
            <label class="acc-filter acc-filter-type">
              <span>Tipo:</span>
              <select v-model="typeFilter" @change="onTypeFilterChange">
                <option v-for="t in TYPE_FILTER_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </label>
            <!-- Transferencias: origen + destino -->
            <template v-if="typeFilter === 'TRANSFER'">
              <label class="acc-filter">
                <span>Origen:</span>
                <select v-model.number="originFilter">
                  <option :value="null">Cualquiera</option>
                  <option v-for="a in accounts" :key="a.id" :value="a.id">{{ acctOptLabel(a) }}</option>
                </select>
              </label>
              <label class="acc-filter">
                <span>Destino:</span>
                <select v-model.number="destFilter">
                  <option :value="null">Cualquiera</option>
                  <option v-for="a in accounts" :key="a.id" :value="a.id">{{ acctOptLabel(a) }}</option>
                </select>
              </label>
            </template>
            <!-- Retiros: banco del retiro + cuenta de ese banco -->
            <template v-else-if="typeFilter === 'WITHDRAWAL'">
              <label class="acc-filter">
                <span>Banco:</span>
                <select v-model.number="filterBankId">
                  <option :value="null">Todos los bancos</option>
                  <option v-for="b in activeBanks" :key="b.id" :value="b.id">{{ b.name }}</option>
                </select>
              </label>
              <label class="acc-filter">
                <span>Cuenta:</span>
                <select v-model.number="accountFilter">
                  <option :value="null">{{ filterBankId ? 'Todas de ese banco' : 'Todas las cuentas' }}</option>
                  <option v-for="a in filterAccounts" :key="a.id" :value="a.id">{{ acctOptLabel(a) }}</option>
                </select>
              </label>
            </template>
            <!-- Resto: una cuenta -->
            <label v-else class="acc-filter">
              <span>Cuenta:</span>
              <select v-model.number="accountFilter">
                <option :value="null">Todas las cuentas</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ acctOptLabel(a) }}</option>
              </select>
            </label>
            <!-- Categoría y método (ingreso/gasto/compra) -->
            <template v-if="showCatPayFilters">
              <label class="acc-filter">
                <span>Categoría:</span>
                <select v-model.number="categoryFilter">
                  <option :value="null">Todas</option>
                  <option v-for="c in filterCategories" :key="c.id" :value="c.id">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
                </select>
              </label>
              <label class="acc-filter">
                <span>Método:</span>
                <select v-model="paymentFilter">
                  <option value="">Todos</option>
                  <option v-for="(label, key) in PAYMENT_LABEL" :key="key" :value="key">{{ label }}</option>
                </select>
              </label>
            </template>
            <span class="filter-sep" aria-hidden="true"></span>
            <span class="filter-range-tag">Dentro del mes:</span>
            <label class="acc-filter"><span>Desde:</span><input type="date" v-model="dateFrom" /></label>
            <label class="acc-filter"><span>Hasta:</span><input type="date" v-model="dateTo" /></label>
            <button v-if="hasActiveFilters" type="button" class="ghost mini clear-filters" @click="clearFilters">
              <X :size="13" /> Limpiar
            </button>
          </div>
          <p class="mov-filter-hint">
            Mostrando <strong>{{ periodLabel }}</strong>. Para ver otro mes usa el selector de arriba ◀ ▶.
          </p>
        </div>

        <div class="panel-header">
          <h2>{{ tableTitle }}</h2>
          <div class="panel-header-right">
            <span class="panel-hint">{{ MONTHS.find(m => m.value === month)?.label }} {{ year }} · {{ displayRows.length }} registro{{ displayRows.length === 1 ? '' : 's' }}</span>
            <AppButton v-if="canAddForTable" mini @click="openForm(tableAddType)">
              <template #icon><Plus :size="15" /></template>{{ tableAddLabel }}
            </AppButton>
          </div>
        </div>

        <div v-if="!displayRows.length" class="empty-state">
          <div class="empty-state-illustration"><ArrowLeftRight :size="36" /></div>
          <strong v-if="hasActiveFilters">No hay movimientos con esos filtros</strong>
          <strong v-else-if="typeFilter !== 'ALL' || activeTab !== 'ALL'">Aún no tienes {{ tableTitle.toLowerCase() }} en {{ periodLabel }}</strong>
          <strong v-else>Aún no hay movimientos en {{ periodLabel }}</strong>
          <p v-if="hasActiveFilters">Cambia o limpia los filtros para ver más.</p>
          <p v-else-if="typeFilter === 'CARD_PAYMENT'">Los pagos de tarjeta se registran desde <strong>Tarjetas → Pagar tarjeta</strong>. Aquí los verás y podrás eliminarlos (se revierte el saldo). Prueba con otro mes con el selector ◀ ▶.</p>
          <p v-else>Prueba con otro mes (selector ◀ ▶ arriba), o registra el primero con el botón de abajo.</p>
          <AppButton v-if="canAddForTable" @click="openForm(tableAddType)">
            <template #icon><Plus :size="16" /></template>{{ tableAddLabel }}
          </AppButton>
        </div>

        <div v-else class="table-scroll">
          <table class="recent-table mov-table">
            <thead>
              <tr>
                <th class="center col-date">Fecha</th>
                <th class="col-concept">Concepto</th>
                <th class="center col-cat">Categoría</th>
                <th class="center col-method">Método</th>
                <th class="center col-acct">Cuenta / Tarjeta</th>
                <th class="center col-banks">Bancos</th>
                <th class="center col-amount">Monto</th>
                <th class="col-notes">Notas</th>
                <th class="center col-acts">Acciones</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in displayRows" :key="item.id" class="clickable-row" @click="openDetail(item)">
                <td class="center col-date">{{ formatDate(item.movementDate) }}</td>
                <td class="col-concept">
                  <span style="margin-right: 6px">{{ TYPE_ICON[item.type] }}</span>
                  <strong>{{ item.description }}</strong>
                  <span class="cat-pill" style="margin-left:6px" :style="TYPE_PILL[item.type]">{{ TYPE_LABEL[item.type] }}</span>
                  <span v-if="item.type === 'PURCHASE' && item.isCredit" class="cat-pill" style="margin-left:6px;background:#fff7ed;color:#b45309">Fiada</span>
                  <span v-if="item.type === 'EXPENSE' && item.expenseKind" class="cat-pill" style="margin-left:6px;background:#eef2ff;color:#4338ca">{{ EXPENSE_KIND_LABEL[item.expenseKind] }}</span>
                  <div v-if="item.vendor"><small class="hint">🏪 {{ item.vendor }}{{ item.dueDate ? ' · paga ' + formatDate(item.dueDate) : '' }}</small></div>
                  <div v-if="item.familyMember"><small class="hint">👤 {{ item.familyMember }}</small></div>
                </td>
                <td class="center col-cat">
                  <span v-if="item.category" class="cat-pill" :style="item.category.color ? { background: `${item.category.color}22`, color: item.category.color } : {}">{{ item.category.icon ? item.category.icon + ' ' : '' }}{{ item.category.name }}</span>
                  <small v-else class="hint">Sin categoría</small>
                </td>
                <td class="center col-method">{{ methodCell(item) }}</td>
                <td class="center col-acct">{{ accountOrCardLabel(item) }}</td>
                <td class="center col-banks">
                  <div v-if="item.fromBank"><small class="hint">Desde:</small> 🏦 {{ bankOptionLabel(item.fromBank) }}</div>
                  <div v-if="item.toBank"><small class="hint">Hacia:</small> 🏦 {{ bankOptionLabel(item.toBank) }}</div>
                  <div v-if="Number(item.commission)"><small class="hint" style="color:#b45309">💸 Comisión: {{ formatMoney(item.commission) }}</small></div>
                  <small v-if="!item.fromBank && !item.toBank && !Number(item.commission)" class="hint">—</small>
                </td>
                <td class="center col-amount" :class="signedAmount(item).cls">{{ signedAmount(item).text }}</td>
                <td class="col-notes"><span v-if="item.notes" :title="item.notes" class="notes-cell">{{ item.notes }}</span><small v-else class="hint">—</small></td>
                <td class="center col-acts">
                  <div class="row-actions" style="justify-content: center">
                    <button
                      type="button"
                      class="ghost mini"
                      :disabled="editingId === item.id || !canEditInForm(item)"
                      :title="canEditInForm(item) ? 'Editar' : 'Para corregir un pago de tarjeta, elimínalo y vuelve a registrarlo'"
                      @click.stop="startEdit(item)"
                    >
                      <Pencil :size="14" />
                    </button>
                    <button type="button" class="ghost mini danger" title="Eliminar (revierte el saldo)" @click.stop="removeRow(item)">
                      <Trash2 :size="14" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="totals-row">
                <td colspan="6"><strong>Totales del mes</strong></td>
                <td class="center">
                  <div class="pos">+{{ formatMoney(totals.income) }}</div>
                  <div class="neg">-{{ formatMoney(totals.expense) }}</div>
                  <div :class="totals.balance >= 0 ? 'pos' : 'neg'"><strong>{{ formatMoney(totals.balance) }}</strong></div>
                </td>
                <td colspan="2"><small class="hint">Ingresos · Gastos · Balance</small></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </PanelCard>
    </div>

    <!-- Modal de detalle del movimiento -->
    <AppModal :open="detailOpen" :title="detailItem ? `${TYPE_ICON[detailItem.type]} ${TYPE_LABEL[detailItem.type]}` : 'Detalle'" max-width="600px" @close="detailOpen = false">
      <div v-if="detailItem" class="mv-detail">
        <div class="mv-detail-amount" :class="signedAmount(detailItem).cls">{{ signedAmount(detailItem).text }}</div>
        <p class="mv-detail-desc">{{ detailItem.description }}</p>

        <dl class="mv-detail-grid">
          <div class="dl-row"><dt>Tipo</dt><dd><span class="cat-pill" :style="TYPE_PILL[detailItem.type]">{{ TYPE_LABEL[detailItem.type] }}</span></dd></div>
          <div class="dl-row"><dt>Fecha</dt><dd>{{ formatDate(detailItem.movementDate) }}</dd></div>
          <div class="dl-row"><dt>Método</dt><dd>{{ methodCell(detailItem) }}</dd></div>
          <div v-if="detailItem.type === 'EXPENSE' && detailItem.expenseKind" class="dl-row"><dt>Subtipo</dt><dd>{{ EXPENSE_KIND_LABEL[detailItem.expenseKind] }}</dd></div>
          <div v-if="detailItem.category" class="dl-row"><dt>Categoría</dt><dd><span class="cat-pill" :style="detailItem.category.color ? { background: `${detailItem.category.color}22`, color: detailItem.category.color } : {}">{{ detailItem.category.icon ? detailItem.category.icon + ' ' : '' }}{{ detailItem.category.name }}</span></dd></div>

          <div v-if="detailItem.type === 'TRANSFER'" class="dl-row"><dt>Cuenta origen</dt><dd>🏦 {{ fmtAccount(detailItem.account) || '—' }}</dd></div>
          <div v-if="detailItem.type === 'TRANSFER'" class="dl-row"><dt>Cuenta destino</dt><dd>🏦 {{ fmtAccount(detailItem.toAccount) || '—' }}</dd></div>
          <div v-else-if="detailItem.account" class="dl-row"><dt>Cuenta afectada</dt><dd>🏦 {{ fmtAccount(detailItem.account) }}</dd></div>

          <div v-if="detailItem.card" class="dl-row"><dt>Tarjeta</dt><dd>💳 {{ detailItem.card.name }}</dd></div>
          <div v-if="detailItem.wallet" class="dl-row"><dt>Billetera</dt><dd>👛 {{ detailItem.wallet.name }}</dd></div>
          <div v-if="detailItem.fromBank" class="dl-row"><dt>Banco origen</dt><dd>🏦 {{ fmtBank(detailItem.fromBank) }}</dd></div>
          <div v-if="detailItem.toBank" class="dl-row"><dt>Banco destino</dt><dd>🏦 {{ fmtBank(detailItem.toBank) }}</dd></div>
          <div v-if="Number(detailItem.commission)" class="dl-row"><dt>Comisión</dt><dd style="color:#b45309">💸 {{ formatMoney(detailItem.commission) }}</dd></div>

          <div v-if="detailItem.vendor" class="dl-row"><dt>Proveedor</dt><dd>🏪 {{ detailItem.vendor }}</dd></div>
          <div v-if="detailItem.type === 'PURCHASE'" class="dl-row"><dt>Forma</dt><dd>{{ detailItem.isCredit ? 'Fiada (pago posterior)' : 'Pagada al momento' }}</dd></div>
          <div v-if="detailItem.dueDate" class="dl-row"><dt>Vence / paga</dt><dd>{{ formatDate(detailItem.dueDate) }}</dd></div>
          <div v-if="detailItem.familyMember" class="dl-row"><dt>{{ detailItem.type === 'WITHDRAWAL' ? 'Quién retiró' : 'Quién paga' }}</dt><dd>👤 {{ detailItem.familyMember }}</dd></div>
        </dl>

        <div v-if="detailItem.notes" class="mv-detail-notes">
          <strong>Notas</strong>
          <p>{{ detailItem.notes }}</p>
        </div>

        <div class="mv-detail-att">
          <strong>Comprobantes</strong>
          <p v-if="detailLoadingAtt" class="hint">Cargando…</p>
          <p v-else-if="!detailAttachments.length" class="hint">Sin comprobantes adjuntos.</p>
          <ul v-else class="att-list">
            <li v-for="att in detailAttachments" :key="att.id">
              <button type="button" class="att-chip" @click="openAttachment(att)">
                📎 {{ att.filename }} <small class="hint">· {{ fileSize(att.size) }}</small>
              </button>
            </li>
          </ul>
        </div>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="detailOpen = false"><template #icon><X :size="16" /></template>Cerrar</AppButton>
        <small v-if="detailItem && !canEditInForm(detailItem)" class="hint" style="align-self:center">
          Para corregir un pago de tarjeta, ciérralo y elimínalo desde la tabla (se revierte el saldo).
        </small>
        <AppButton v-if="detailItem && canEditInForm(detailItem)" @click="editFromDetail"><template #icon><Pencil :size="16" /></template>Editar</AppButton>
      </template>
    </AppModal>

    <AttachmentViewer :open="viewerOpen" :attachment="viewerAtt" @close="viewerOpen = false" />
  </section>
</template>

<style scoped>
/* Fila clicable → abre detalle */
.clickable-row { cursor: pointer; transition: background 0.12s ease; }
.clickable-row:hover { background: var(--color-surface-2, #f8fafc); }

/* Modal de detalle */
.mv-detail { display: flex; flex-direction: column; gap: 14px; }
.mv-detail-amount { font-size: 28px; font-weight: 800; }
.mv-detail-amount.pos { color: var(--color-success-text, #047857); }
.mv-detail-amount.neg { color: var(--color-danger-text, #b91c1c); }
.mv-detail-desc { margin: 0; font-size: 16px; font-weight: 600; color: #1f2937; }
.mv-detail-grid { margin: 0; display: flex; flex-direction: column; gap: 0; border-top: 1px solid #eef0f4; }
.dl-row { display: grid; grid-template-columns: 140px 1fr; gap: 10px; padding: 9px 0; border-bottom: 1px solid #eef0f4; align-items: center; }
.dl-row dt { margin: 0; color: #6b7280; font-size: 13px; }
.dl-row dd { margin: 0; font-weight: 600; color: #1f2937; font-size: 14px; }
.mv-detail-notes p { margin: 4px 0 0; color: #374151; white-space: pre-wrap; }
.mv-detail-att .att-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.att-chip { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; cursor: pointer; text-align: left; width: 100%; font-weight: 600; color: #334155; }
.att-chip:hover { background: #eff6ff; border-color: #bfdbfe; }
@media (max-width: 540px) { .dl-row { grid-template-columns: 110px 1fr; } }

/* Secciones del formulario (divulgación progresiva) */
.mov-form { gap: var(--space-2); }
.form-section { padding: var(--space-2) 0; }
.form-section + .form-section { border-top: 1px solid var(--color-border-soft); padding-top: var(--space-4); margin-top: var(--space-2); }
.form-section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: 700;
  color: var(--color-text-soft);
  margin-bottom: var(--space-3);
  letter-spacing: -0.01em;
}
.step-num {
  width: 22px; height: 22px;
  display: grid; place-items: center;
  border-radius: var(--radius-full);
  background: var(--color-primary-soft);
  color: var(--color-primary-active);
  font-size: 12px;
  font-weight: 700;
}

/* Selector visual de tipo (tarjetas con icono en chip de color) */
.mov-trigger-hint { margin: 0 0 12px; font-size: 13px; color: #64748b; }
/* Switch de tipo dentro del modal */
.mov-type-switch { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.mov-type-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border: 1.5px solid var(--color-border, #e2e8f0); border-radius: 999px;
  background: #fff; color: #475569; font-weight: 600; font-size: 13px; cursor: pointer;
  transition: all .12s ease;
}
.mov-type-chip:hover { border-color: #bfdbfe; background: #f8fbff; }
.mov-type-chip.active { background: var(--color-primary, #2563eb); border-color: var(--color-primary, #2563eb); color: #fff; }
.type-picker {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-3);
}
.type-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: var(--space-4) var(--space-3);
  border: 1.5px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-xl);
  cursor: pointer;
  text-align: center;
  transition: border-color var(--t-fast), box-shadow var(--t-fast), background var(--t-fast), transform var(--t-fast);
}
.type-card:hover { border-color: var(--color-border-strong); transform: translateY(-2px); box-shadow: var(--shadow-sm); }
.type-card-icon {
  width: 46px; height: 46px;
  border-radius: 13px;
  display: grid; place-items: center;
  background: var(--color-surface-3);
  color: var(--color-text-soft);
  transition: transform var(--t-fast);
}
.type-card:hover .type-card-icon { transform: scale(1.05); }
.tc-income .type-card-icon     { background: var(--color-success-soft); color: var(--color-success-text); }
.tc-expense .type-card-icon    { background: var(--color-danger-soft);  color: var(--color-danger-text); }
.tc-purchase .type-card-icon   { background: var(--color-warning-soft); color: var(--color-warning-text); }
.tc-transfer .type-card-icon   { background: var(--color-primary-soft); color: var(--color-primary-active); }
.tc-withdrawal .type-card-icon { background: var(--color-accent-soft);  color: var(--color-accent-text); }
.type-card-label { font-size: var(--text-sm); font-weight: 700; color: var(--color-text); letter-spacing: -0.01em; }
.type-card-desc { font-size: 11px; color: var(--color-text-muted); }
.type-card.active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  box-shadow: var(--shadow-focus);
}
.type-card.active .type-card-label { color: var(--color-primary-active); }
@media (max-width: 720px) {
  .type-picker { grid-template-columns: repeat(2, 1fr); }
}
/* Botón para registrar el tipo elegido (aparece bajo el selector) */
.type-picker-cta { display: flex; justify-content: flex-end; margin-top: var(--space-4); }
.type-picker-cta :deep(button) { font-weight: 700; }
@media (max-width: 720px) {
  .type-picker-cta { justify-content: stretch; }
  .type-picker-cta :deep(button) { width: 100%; justify-content: center; }
}

.field-wide { grid-column: 1 / -1; }
.amount-field input { font-size: var(--text-xl); font-weight: 700; height: 48px; }
.commission-field { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 10px; padding: 8px 10px; }
.commission-field label { color: #b45309; }
.warn-hint { color: var(--color-warning-text); margin-top: var(--space-2); }

.opt-tag { font-weight: 400; color: #9ca3af; }
.panel-header-right { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.acc-filter { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #64748b; font-weight: 600; }
.acc-filter select { padding: 6px 10px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; background: #fff; font-weight: 500; color: #334155; max-width: 220px; }
.acc-filter input[type="date"] { padding: 6px 10px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; background: #fff; font-weight: 500; color: #334155; }
/* El selector de Tipo dirige el resto de filtros → algo más marcado. */
.acc-filter-type span { color: var(--color-text, #1f2937); }
.acc-filter-type select { font-weight: 600; color: #1f2937; border-color: #cbd5e1; }

/* Navegador de período (mes/año) en la cabecera */
.period-nav {
  display: inline-flex; align-items: center; gap: 2px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e2e8f0);
  border-radius: 12px;
  padding: 4px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}
.period-center {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 0 4px;
}
.period-icon { color: var(--color-primary, #2563eb); flex: none; }
/* Selects integrados, sin borde, dentro de la píldora */
.period-nav .period-select {
  border: none; box-shadow: none; outline: none;
  min-width: auto; height: 34px; padding: 0 4px 0 6px;
  font-weight: 700; color: var(--color-text, #1e293b);
  border-radius: 8px; background: transparent; cursor: pointer;
  appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 4px center; padding-right: 18px;
}
.period-nav .period-select:hover { background-color: #f1f5f9; }
.period-nav .period-select:focus-visible { background-color: #eff6ff; box-shadow: var(--shadow-focus); }
.period-select-year { color: var(--color-text-soft, #475569); font-weight: 600; }
/* Flechas: limpias dentro de la píldora (anulan el estilo base de .icon-btn) */
.period-nav .period-arrow {
  width: 32px; height: 32px; flex: none;
  border: none; border-radius: 8px; background: transparent;
  color: var(--color-text-soft, #64748b);
}
.period-nav .period-arrow:hover {
  background: #eff6ff; border-color: transparent; color: var(--color-primary, #2563eb);
}
.period-nav .period-arrow:active { background: #dbeafe; }
.period-nav .period-arrow:disabled { opacity: .3; cursor: not-allowed; }
.period-nav .period-arrow:disabled:hover { background: transparent; color: var(--color-text-soft, #64748b); }
/* Botón "Hoy" (escapa del estilo teal global vía .mini) */
.period-today {
  display: inline-flex; align-items: center; gap: 5px;
  height: 40px; padding: 0 14px;
  border: 1px solid var(--color-border, #e2e8f0); border-radius: 12px;
  background: #fff; color: var(--color-primary, #2563eb); font-weight: 700; font-size: 13px;
  cursor: pointer; transition: background .12s ease, border-color .12s ease;
}
.period-today:hover { background: #eff6ff; border-color: #bfdbfe; }

/* Separación visual entre filtros de atributo y filtros de fecha dentro del mes */
.filter-sep { width: 1px; align-self: stretch; min-height: 24px; background: var(--color-border, #e2e8f0); margin: 0 2px; }
.filter-range-tag { font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .03em; }
.mov-filter-hint { margin: 2px 0 0; font-size: 12px; color: #94a3b8; }
.mov-filter-hint strong { color: #475569; }
@media (max-width: 640px) { .filter-sep { display: none; } }

/* Filtros inteligentes de la tabla */
.mov-filters { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.mov-type-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.mov-type-chip { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--color-border, #e2e8f0); background: #fff; color: #475569; font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.12s ease; }
.mov-type-chip:hover { background: #f8fafc; }
.mov-type-chip.active { background: var(--color-primary, #2563eb); color: #fff; border-color: var(--color-primary, #2563eb); }
.mov-filter-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.clear-filters { display: inline-flex; align-items: center; gap: 4px; color: #dc2626; border-color: #fecaca; }
/* Método de pago: chips visuales */
.pay-picker { display: flex; flex-wrap: wrap; gap: 8px; }
.pay-chip {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 15px;
  border: 1.5px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius-full, 999px);
  cursor: pointer;
  font-size: 13.5px; font-weight: 600;
  color: var(--color-text-soft);
  transition: border-color .15s ease, background .15s ease, color .15s ease, transform .12s ease;
}
.pay-chip:hover { border-color: var(--color-border-strong); background: var(--color-surface-2); transform: translateY(-1px); }
.pay-chip.active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  color: var(--color-primary-active);
  box-shadow: var(--shadow-focus, 0 0 0 3px rgba(37,99,235,.12));
}
.pay-chip-ic { font-size: 15px; line-height: 1; }

/* Rejilla de pickers (cuenta / tarjeta / bancos) */
.picker-grid { margin-top: var(--space-4); }

/* Promesa de pago (compra fiada) */
.promise-block {
  margin-top: var(--space-3);
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 12px;
  padding: 14px 16px;
}
.promise-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.promise-ic { font-size: 22px; }
.promise-head strong { display: block; color: #92400e; font-size: 14px; }
.promise-head small { color: #b45309; font-size: 12px; }

/* Comisión por transferencia interbancaria */
.interbank-block { margin-top: var(--space-3); background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 14px 16px; }
.interbank-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.interbank-ic { font-size: 20px; }
.interbank-head strong { display: block; font-size: 14px; color: #1e40af; }
.interbank-head small { color: #2563eb; font-size: 12px; }
.interbank-commission { max-width: 260px; }

/* Layout final: Notas (izquierda) · Monto + botón (derecha) */
.mov-final-grid { display: grid; grid-template-columns: 1fr 300px; gap: var(--space-5); align-items: stretch; }
.mov-final-notes { display: flex; flex-direction: column; }
.mov-final-notes textarea { flex: 1; min-height: 120px; resize: vertical; }
.mov-final-right { display: flex; flex-direction: column; gap: var(--space-3); }
.mov-final-actions { display: flex; flex-direction: column; align-items: stretch; gap: var(--space-2); }
.mov-final-actions :deep(button) { width: 100%; justify-content: center; }
@media (max-width: 720px) {
  .mov-final-grid { grid-template-columns: 1fr; }
}

.recent-table .pos { color: var(--color-success-text); font-weight: 600; }
.recent-table .neg { color: var(--color-danger-text); font-weight: 600; }
.totals-row td { background: var(--color-surface-2); border-top: 2px solid var(--color-border); padding-top: 12px; }
.notes-cell { display: inline-block; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; cursor: help; }
.table-scroll { overflow-x: auto; }

/* Tabs de subtipo de gasto con conteo + total */
.mov-tabs {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 18px;
}
.mov-tab {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.mov-tab:hover { border-color: #bfdbfe; background: #f8fbff; }
.mov-tab.active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  box-shadow: 0 1px 2px rgba(37,99,235,.12), 0 2px 6px rgba(37,99,235,.08);
}
.mov-tab-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}
.mov-tab-label {
  font-size: 13.5px;
  font-weight: 600;
  color: #475569;
  letter-spacing: -0.01em;
}
.mov-tab.active .mov-tab-label { color: var(--color-primary-active); }
.mov-tab-count {
  min-width: 26px;
  height: 22px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #334155;
  background: #f1f5f9;
  border-radius: 999px;
}
.mov-tab.active .mov-tab-count { color: #fff; background: var(--color-primary); }
.mov-tab-sum { font-size: 12px; color: #64748b; font-weight: 600; }
.mov-tab.active .mov-tab-sum { color: var(--color-primary-active); }
.mov-tab-sum.pos { color: var(--color-success-text, #047857); }
.mov-tab-sum.neg { color: var(--color-danger-text, #b91c1c); }
/* Tarjetas de solo lectura (resúmenes que no filtran) */
.mov-tab.is-readonly { cursor: default; opacity: 1; }
.mov-tab.is-readonly:hover { background: #fff; box-shadow: none; }
.mov-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.mov-section-actions { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mov-section-title { font-size: 13px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }
.view-all { display: inline-flex; align-items: center; gap: 4px; color: var(--color-primary, #2563eb); border-color: #bfdbfe; font-weight: 600; }
@media (max-width: 720px) {
  .mov-tabs { grid-template-columns: repeat(2, 1fr); }
}

/* Toggle segmentado (Pagada/Fiada y subtipo de gasto) */
.seg-toggle { display: inline-flex; background: var(--color-surface-3); border-radius: 10px; padding: 4px; gap: 2px; border: 1px solid var(--color-border); }
.seg-toggle.seg-3 { display: flex; }
.seg-toggle.seg-3 .seg-toggle-btn { flex: 1; }
.seg-toggle button.seg-toggle-btn {
  background: transparent;
  color: var(--color-text-muted);
  border: none;
  height: 34px;
  padding: 0 16px;
  border-radius: 7px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  letter-spacing: -0.005em;
}
.seg-toggle button.seg-toggle-btn:hover:not(.active) { color: var(--color-text); }
.seg-toggle button.seg-toggle-btn.active {
  background: white;
  color: var(--color-text);
  box-shadow: 0 1px 2px rgba(15,23,42,0.08), 0 1px 3px rgba(15,23,42,0.04);
}

/* Anchos de columna en tabla de Movimientos */
.mov-table { table-layout: fixed; }
.mov-table .col-date    { width: 9%; }
.mov-table .col-concept { width: 20%; }
.mov-table .col-cat     { width: 11%; }
.mov-table .col-method  { width: 10%; }
.mov-table .col-acct    { width: 11%; }
.mov-table .col-banks   { width: 12%; }
.mov-table .col-amount  { width: 9%; }
.mov-table .col-notes   { width: 10%; }
.mov-table .col-acts    { width: 8%; }
@media (max-width: 1100px) {
  .mov-table { table-layout: auto; }
  .mov-table .col-date,
  .mov-table .col-concept,
  .mov-table .col-cat,
  .mov-table .col-method,
  .mov-table .col-acct,
  .mov-table .col-banks,
  .mov-table .col-amount,
  .mov-table .col-notes,
  .mov-table .col-acts { width: auto; }
}
.row-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.row-actions button.mini { background: white; border: 1px solid #e2e8f0; color: #475569; cursor: pointer; font-weight: 600; }
.row-actions button.mini:hover:not(:disabled) { background: #f8fafc; }
.row-actions button.mini:disabled { opacity: 0.4; cursor: not-allowed; }
.row-actions button.mini.danger { color: #dc2626; border-color: #fecaca; }
.row-actions button.mini.danger:hover { background: #fef2f2; }
</style>
