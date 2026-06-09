<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Component } from 'vue';
import { useRoute } from 'vue-router';
import { http } from '../api/http';
import { ArrowLeftRight, Pencil, Trash2, Plus, X, Wallet, ShoppingCart, ShoppingBag, Banknote } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import AppButton from '../components/AppButton.vue';
import PickerField from '../components/PickerField.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import { useToast } from '../composables/useToast';
import { useFormat } from '../composables/useFormat';

type MovementType = 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'WITHDRAWAL' | 'PURCHASE';
type ExpenseKind = 'FIXED' | 'VARIABLE' | 'NON_ACCOUNTABLE';
type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'DEPOSIT' | 'DEBIT_CARD' | 'CREDIT_CARD' | 'WALLET' | 'OTHER';

interface Account { id: number; name: string; type?: string; bankName?: string | null }
interface Card { id: number; name: string }
interface Wallet { id: number; name: string; provider?: string | null; isActive?: boolean }
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
  accountId: number | null; cardId: number | null; walletId: number | null; categoryId: number | null;
  fromBankId: number | null; toBankId: number | null;
  vendor: string | null; isCredit: boolean; dueDate: string | null; commission: number | string | null;
  familyMember: string | null; notes: string | null;
  account?: Account | null; card?: Card | null; wallet?: Wallet | null; category?: Category | null;
  fromBank?: Bank | null; toBank?: Bank | null;
}

const route = useRoute();
const toast = useToast();
const { formatMoney } = useFormat();
const now = new Date();
const todayStr = now.toISOString().slice(0, 10);

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
  type: 'EXPENSE' as MovementType,
  expenseKind: (filterExpenseKind.value ?? 'VARIABLE') as ExpenseKind,
  amount: 0, movementDate: todayStr,
  description: '', paymentMethod: 'CASH' as PaymentMethod,
  accountId: null as number | null, cardId: null as number | null,
  walletId: null as number | null,
  categoryId: null as number | null,
  fromBankId: null as number | null, toBankId: null as number | null,
  vendor: '', isCredit: false, dueDate: '',
  commission: 0,
  familyMember: '', notes: ''
});
const form = ref(buildEmptyForm());

const PAYMENT_LABEL: Record<PaymentMethod, string> = { CASH: 'Efectivo', BANK_TRANSFER: 'Transferencia bancaria', DEPOSIT: 'Depósito', DEBIT_CARD: 'Tarjeta de débito', CREDIT_CARD: 'Tarjeta de crédito', WALLET: 'Billetera digital', OTHER: 'Otro' };
const TYPE_ICON: Record<MovementType, string> = { INCOME: '💵', EXPENSE: '🛒', TRANSFER: '🔁', WITHDRAWAL: '🏧', PURCHASE: '🛍️' };

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
const yearOptions = computed<number[]>(() => { const y = now.getFullYear(); return [y - 5, y - 4, y - 3, y - 2, y - 1, y, y + 1]; });

const isWithdrawal = computed(() => form.value.type === 'WITHDRAWAL');
const isTransfer = computed(() => form.value.type === 'TRANSFER');
// Interbancaria = transferencia con banco origen y destino DISTINTOS.
const isInterbankTransfer = computed(() =>
  isTransfer.value && !!form.value.fromBankId && !!form.value.toBankId && form.value.fromBankId !== form.value.toBankId
);
const isPurchase = computed(() => form.value.type === 'PURCHASE');
const isCreditPurchase = computed(() => isPurchase.value && form.value.isCredit);
const showVendor = computed(() => isPurchase.value);
const showCreditToggle = computed(() => isPurchase.value);
const showDueDate = computed(() => isCreditPurchase.value);
const showPaymentMethod = computed(() => !isWithdrawal.value && !isCreditPurchase.value);
const showAccount = computed(() => {
  if (isWithdrawal.value) return true;
  if (isCreditPurchase.value) return false;
  return ['CASH', 'BANK_TRANSFER', 'DEPOSIT', 'DEBIT_CARD'].includes(form.value.paymentMethod);
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
const accountOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Sin cuenta vinculada', icon: '∅' },
  ...accounts.value.map((a) => ({
    value: a.id,
    label: a.name,
    sublabel: a.bankName || ACCOUNT_TYPE_LABEL[a.type || ''] || undefined,
    icon: accountIcon(a.type)
  }))
]);
const cardOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Sin tarjeta', icon: '∅' },
  ...cards.value.map((c) => ({ value: c.id, label: c.name, icon: '💳' }))
]);
const bankOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Ninguno', icon: '∅' },
  ...activeBanks.value.map((b) => ({ value: b.id, label: b.name, sublabel: bankSubLabel(b), icon: '🏦' }))
]);
const walletOptions = computed<PickOpt[]>(() => [
  { value: null, label: 'Sin billetera', icon: '∅' },
  ...wallets.value.filter((w) => w.isActive !== false).map((w) => ({ value: w.id, label: w.name, sublabel: w.provider || undefined, icon: '👛' }))
]);

// Sección "dinero": sólo se muestra si algún campo de pago/cuenta aplica.
const showMoneySection = computed(() =>
  showPaymentMethod.value || showAccount.value || showCard.value || showWallet.value || showFromBank.value || showToBank.value
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

function tabCount(key: TabKey): number {
  return key === 'ALL' ? rows.value.length : kindStats.value[key].count;
}
function tabSum(key: TabKey): number {
  return key === 'ALL' ? 0 : kindStats.value[key].sum;
}
function setTab(key: TabKey) {
  activeTab.value = key;
  if (key !== 'ALL') {
    form.value.type = 'EXPENSE';
    form.value.expenseKind = key;
  }
}

// Filas mostradas según la pestaña activa
const displayRows = computed(() =>
  activeTab.value === 'ALL'
    ? rows.value
    : rows.value.filter((r) => r.type === 'EXPENSE' && r.expenseKind === activeTab.value)
);

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

function formatDate(v: string) { if (!v) return ''; const d = new Date(v); return Number.isNaN(d.getTime()) ? v : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }
function signedAmount(item: Movement) {
  const a = Number(item.amount ?? 0);
  if (item.type === 'INCOME') return { text: `+${formatMoney(a)}`, cls: 'pos' };
  if (item.type === 'EXPENSE' || item.type === 'WITHDRAWAL') return { text: `-${formatMoney(a)}`, cls: 'neg' };
  if (item.type === 'PURCHASE') return { text: (item.isCredit ? '' : '-') + formatMoney(a), cls: item.isCredit ? '' : 'neg' };
  return { text: formatMoney(a), cls: '' };
}
function accountOrCardLabel(item: Movement) { if (item.card) return `💳 ${item.card.name}`; if (item.wallet) return `👛 ${item.wallet.name}`; if (item.account) return `🏦 ${item.account.name}`; return '—'; }
function setType(t: MovementType) { form.value.type = t; }

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

async function save() {
  if (form.value.description.trim().length < 2) { toast.error('La descripción es obligatoria (mínimo 2 caracteres).'); return; }
  if (!(Number(form.value.amount) > 0)) { toast.error('El monto debe ser mayor a 0.'); return; }
  saving.value = true;
  try {
    let effectivePaymentMethod: PaymentMethod = form.value.paymentMethod;
    if (isWithdrawal.value) effectivePaymentMethod = 'BANK_TRANSFER';
    if (isCreditPurchase.value) effectivePaymentMethod = 'OTHER';
    const payload = {
      type: form.value.type,
      expenseKind: form.value.type === 'EXPENSE' ? form.value.expenseKind : null,
      amount: Number(form.value.amount), movementDate: form.value.movementDate,
      description: form.value.description.trim(), paymentMethod: effectivePaymentMethod,
      accountId: showAccount.value ? form.value.accountId || null : null,
      cardId: showCard.value ? form.value.cardId || null : null,
      walletId: showWallet.value ? form.value.walletId || null : null,
      categoryId: isWithdrawal.value ? null : (form.value.categoryId || null),
      fromBankId: showFromBank.value ? form.value.fromBankId || null : null,
      toBankId: showToBank.value ? form.value.toBankId || null : null,
      vendor: isPurchase.value ? (form.value.vendor.trim() || null) : null,
      isCredit: isPurchase.value ? !!form.value.isCredit : false,
      dueDate: isCreditPurchase.value && form.value.dueDate ? form.value.dueDate : null,
      commission: isInterbankTransfer.value ? (Number(form.value.commission) || null) : null,
      familyMember: isWithdrawal.value ? null : (form.value.familyMember.trim() || null),
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
    form.value = { type: keepType, expenseKind: keepKind, amount: 0, movementDate: keepDate, description: '', paymentMethod: keepPm, accountId: null, cardId: null, walletId: null, categoryId: null, fromBankId: null, toBankId: null, vendor: '', isCredit: false, dueDate: '', commission: 0, familyMember: '', notes: '' };
    editingId.value = null;
    await load();
  } catch { toast.error('No se pudo registrar el movimiento.'); }
  finally { saving.value = false; }
}

function startEdit(item: Movement) {
  editingId.value = item.id;
  form.value = {
    type: item.type,
    expenseKind: (item.expenseKind ?? 'VARIABLE') as ExpenseKind,
    amount: Number(item.amount),
    movementDate: String(item.movementDate).slice(0, 10),
    description: item.description,
    paymentMethod: item.paymentMethod,
    accountId: item.accountId,
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
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  editingId.value = null;
  form.value = buildEmptyForm();
}

async function removeRow(item: Movement) {
  if (!confirm(`Eliminar el movimiento "${item.description}" (${formatMoney(item.amount)})? Se revertirá el saldo en la cuenta/tarjeta afectada.`)) return;
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
        <select v-model.number="month" class="period-select" @change="load">
          <option v-for="m in MONTHS" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
        <select v-model.number="year" class="period-select" @change="load">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}</option>
        </select>
      </template>
    </PageHeader>

    <div class="stack">
      <PanelCard :title="editingId !== null ? 'Editar movimiento' : 'Nuevo movimiento'">
        <form class="form mov-form" @submit.prevent="save">
          <!-- Paso 1: tipo de movimiento (selector visual) -->
          <div class="form-section">
            <p class="form-section-title"><span class="step-num">1</span> ¿Qué quieres registrar?</p>
            <div class="type-picker">
              <button
                v-for="t in TYPE_OPTIONS"
                :key="t.value"
                type="button"
                class="type-card"
                :class="['tc-' + t.accent, { active: form.type === t.value }]"
                @click="setType(t.value)"
              >
                <span class="type-card-icon"><component :is="t.icon" :size="20" :stroke-width="2.2" /></span>
                <span class="type-card-label">{{ t.label }}</span>
                <span class="type-card-desc">{{ t.desc }}</span>
              </button>
            </div>
          </div>

          <!-- Paso 2: detalle -->
          <div class="form-section">
            <p class="form-section-title"><span class="step-num">2</span> Detalle</p>
            <div class="form-grid">
              <div class="field">
                <label for="mv-desc">Descripción<span class="required-mark">*</span></label>
                <input id="mv-desc" v-model="form.description" minlength="2" maxlength="120" required placeholder="ej. Compra supermercado, Pago Netflix" />
                <small class="hint">En qué se gastó o de dónde vino.</small>
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

            <!-- Método de pago: selector visual (chips) -->
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

            <!-- Cuenta / tarjeta / bancos / billetera: selectores elegantes en modal -->
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
                <PickerField
                  v-model="form.toBankId"
                  :options="bankOptions"
                  title="Banco destino"
                  placeholder="Elige banco destino"
                />
                <small class="hint">A dónde llegó el dinero.</small>
              </div>
              <div v-if="showAccount" class="field">
                <label>{{ isWithdrawal ? 'Cuenta bancaria' : 'Cuenta' }} <span v-if="isWithdrawal" class="required-mark">*</span></label>
                <PickerField
                  v-model="form.accountId"
                  :options="accountOptions"
                  title="Selecciona una cuenta"
                  placeholder="Elige una cuenta"
                  empty-text="No tienes cuentas. Créalas en la sección Cuentas."
                />
                <small class="hint">{{ isWithdrawal ? 'Cuenta de la que sale el efectivo.' : 'Cuenta que se afecta.' }}</small>
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
              <div v-if="showCard" class="field">
                <label>Tarjeta</label>
                <PickerField
                  v-model="form.cardId"
                  :options="cardOptions"
                  title="Selecciona una tarjeta"
                  placeholder="Elige una tarjeta"
                  empty-text="No tienes tarjetas. Créalas en la sección Tarjetas."
                />
              </div>
            </div>
            <p v-if="(showFromBank || showToBank) && activeBanks.length === 0" class="hint warn-hint">
              No tienes bancos cargados todavía. Agrégalos en <strong>Configuración → Bancos</strong>.
            </p>

            <!-- Comisión: solo en transferencias interbancarias (bancos distintos) -->
            <div v-if="isInterbankTransfer" class="interbank-block">
              <div class="interbank-head">
                <span class="interbank-ic">🔀</span>
                <div>
                  <strong>Transferencia interbancaria</strong>
                  <small>Entre bancos distintos; suele tener comisión.</small>
                </div>
              </div>
              <div class="field field-narrow interbank-commission">
                <label for="mv-commission">Comisión cobrada (USD)</label>
                <input id="mv-commission" v-model.number="form.commission" type="number" step="0.01" min="0" placeholder="0.00" />
                <small class="hint">Se registra como costo del mes (la transferencia en sí no cambia tu patrimonio).</small>
              </div>
            </div>
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
                <div class="mov-final-actions">
                  <AppButton v-if="editingId !== null" variant="ghost" @click="cancelEdit">
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
      </PanelCard>

      <PanelCard>
        <div class="mov-tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.key"
            type="button"
            class="mov-tab"
            :class="{ active: activeTab === t.key }"
            role="tab"
            :aria-selected="activeTab === t.key"
            @click="setTab(t.key)"
          >
            <span class="mov-tab-top">
              <span class="mov-tab-label">{{ t.label }}</span>
              <span class="mov-tab-count">{{ tabCount(t.key) }}</span>
            </span>
            <span class="mov-tab-sum">{{ t.key === 'ALL' ? 'registros' : formatMoney(tabSum(t.key)) }}</span>
          </button>
        </div>

        <div class="panel-header">
          <h2>
            {{ activeTab === 'ALL' ? 'Movimientos del mes' : 'Gastos ' + (TABS.find(t => t.key === activeTab)?.label || '').toLowerCase() }}
          </h2>
          <span class="panel-hint">{{ MONTHS.find(m => m.value === month)?.label }} {{ year }} · {{ displayRows.length }} registro{{ displayRows.length === 1 ? '' : 's' }}</span>
        </div>

        <div v-if="!displayRows.length" class="empty-state">
          <div class="empty-state-illustration"><ArrowLeftRight :size="36" /></div>
          <strong>
            {{ activeTab === 'ALL'
              ? 'Aún no hay movimientos este mes'
              : 'No hay ' + ('Gastos ' + (TABS.find(t => t.key === activeTab)?.label || '')).toLowerCase() + ' este mes' }}
          </strong>
          <p>Registra tu primer ingreso o gasto desde el formulario de arriba.</p>
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
              <tr v-for="item in displayRows" :key="item.id">
                <td class="center col-date">{{ formatDate(item.movementDate) }}</td>
                <td class="col-concept">
                  <span style="margin-right: 6px">{{ TYPE_ICON[item.type] }}</span>
                  <strong>{{ item.description }}</strong>
                  <span v-if="item.type === 'PURCHASE' && item.isCredit" class="cat-pill" style="margin-left:6px;background:#fff7ed;color:#b45309">Fiada</span>
                  <span v-if="item.type === 'EXPENSE' && item.expenseKind" class="cat-pill" style="margin-left:6px;background:#eef2ff;color:#4338ca">{{ EXPENSE_KIND_LABEL[item.expenseKind] }}</span>
                  <div v-if="item.vendor"><small class="hint">🏪 {{ item.vendor }}{{ item.dueDate ? ' · paga ' + formatDate(item.dueDate) : '' }}</small></div>
                  <div v-if="item.familyMember"><small class="hint">👤 {{ item.familyMember }}</small></div>
                </td>
                <td class="center col-cat">
                  <span v-if="item.category" class="cat-pill" :style="item.category.color ? { background: `${item.category.color}22`, color: item.category.color } : {}">{{ item.category.icon ? item.category.icon + ' ' : '' }}{{ item.category.name }}</span>
                  <small v-else class="hint">Sin categoría</small>
                </td>
                <td class="center col-method">{{ PAYMENT_LABEL[item.paymentMethod] }}</td>
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
                    <button type="button" class="ghost mini" :disabled="editingId === item.id" @click="startEdit(item)">
                      <Pencil :size="14" />
                    </button>
                    <button type="button" class="ghost mini danger" @click="removeRow(item)">
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
  </section>
</template>

<style scoped>
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

.field-wide { grid-column: 1 / -1; }
.amount-field input { font-size: var(--text-xl); font-weight: 700; height: 48px; }
.warn-hint { color: var(--color-warning-text); margin-top: var(--space-2); }

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
.mov-tab-sum { font-size: 12px; color: #64748b; font-weight: 500; }
.mov-tab.active .mov-tab-sum { color: var(--color-primary-active); }
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
