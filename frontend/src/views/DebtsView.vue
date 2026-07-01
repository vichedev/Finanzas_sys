<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { http } from '../api/http';
import { HandCoins, FileText, UserCheck, Pencil, Trash2, Plus, X, Wallet } from 'lucide-vue-next';
import TabBar from '../components/TabBar.vue';
import PageHeader from '../components/PageHeader.vue';
import AppModal from '../components/AppModal.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import { useFormat } from '../composables/useFormat';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';

type DebtKind = 'PAYABLE' | 'RECEIVABLE' | 'LOAN';
type DebtStatus = 'OPEN' | 'PARTIAL' | 'PAID' | 'CANCELED';

interface DebtRow {
  id: number;
  name: string;
  counterparty?: string | null;
  kind: DebtKind;
  status: DebtStatus;
  principal: number;
  balance: number;
  interestRate?: number | null;
  dueDate?: string | null;
  accountId?: number | null;
  notes?: string | null;
  cutoffDay?: number | null;
  paymentDay?: number | null;
  installmentAmount?: number | null;
  installmentDueDay?: number | null;
  termMonths?: number | null;
  totalToPay?: number | null;
}

interface AccountRef { id: number; name: string; holder?: string | null; bankName?: string | null; accountNumber?: string | null }
interface CardRef { id: number; name: string; type?: string | null; bankName?: string | null; last4?: string | null }

const route = useRoute();

const KIND_META: Record<string, { title: string; subtitle: string; defaultKind: DebtKind; emptyMessage: string }> = {
  RECEIVABLE: { title: 'Cuentas por cobrar', subtitle: 'Dinero que te deben terceros.', defaultKind: 'RECEIVABLE', emptyMessage: 'No tienes cuentas por cobrar registradas.' },
  PAYABLE: { title: 'Cuentas por pagar', subtitle: 'Compromisos pendientes con terceros.', defaultKind: 'PAYABLE', emptyMessage: 'Aún no tienes deudas registradas.' },
  LOAN: { title: 'Préstamos', subtitle: 'Préstamos formales activos con cuotas y plazos.', defaultKind: 'LOAN', emptyMessage: 'No tienes préstamos registrados.' },
  ALL: { title: 'Deudas y cobros', subtitle: 'Todas las cuentas por pagar, por cobrar y préstamos.', defaultKind: 'PAYABLE', emptyMessage: 'Aún no has registrado ningún movimiento.' }
};

const KIND_LABEL: Record<DebtKind, string> = { PAYABLE: 'Por pagar', RECEIVABLE: 'Por cobrar', LOAN: 'Préstamo' };
const STATUS_LABEL: Record<DebtStatus, string> = { OPEN: 'Abierta', PARTIAL: 'Parcial', PAID: 'Pagada', CANCELED: 'Cancelada' };

const kindFilter = computed(() => {
  const raw = (route.query.kind as string | undefined) || 'ALL';
  return KIND_META[raw] ? raw : 'ALL';
});
const meta = computed(() => KIND_META[kindFilter.value]);

const router = useRouter();
type DebtTab = 'ALL' | 'RECEIVABLE' | 'PAYABLE' | 'LOAN';
const DEBT_TABS: { value: DebtTab; label: string }[] = [
  { value: 'ALL', label: 'Todas' },
  { value: 'RECEIVABLE', label: 'Por cobrar' },
  { value: 'PAYABLE', label: 'Por pagar' },
  { value: 'LOAN', label: 'Préstamos' }
];
const activeTab = computed<DebtTab>({
  get: () => kindFilter.value as DebtTab,
  set: (v) => router.replace({ query: v === 'ALL' ? {} : { kind: v } })
});

const rows = ref<DebtRow[]>([]);
const accounts = ref<AccountRef[]>([]);
const cards = ref<CardRef[]>([]);
const toast = useToast();
const { confirm } = useConfirm();
const saving = ref(false);
const editingId = ref<number | null>(null);

const buildEmptyForm = () => ({
  kind: 'PAYABLE' as DebtKind,
  name: '',
  counterparty: '',
  principal: 0,
  interestRate: null as number | null,
  cutoffDay: null as number | null,
  paymentDay: null as number | null,
  accountId: null as number | null,
  notes: '',
  installmentAmount: null as number | null,
  termMonths: null as number | null,
  totalToPay: null as number | null
});
const form = ref(buildEmptyForm());

// Etiqueta de cuenta: "Nombre · Banco · ****1234"
function accountLabel(a: AccountRef): string {
  const parts = [a.name];
  if (a.bankName) parts.push(a.bankName);
  if (a.accountNumber) parts.push(`****${a.accountNumber.slice(-4)}`);
  return parts.join(' · ');
}

const { formatMoney } = useFormat();

const visibleRows = computed(() =>
  kindFilter.value === 'ALL' ? rows.value : rows.value.filter((row) => row.kind === kindFilter.value)
);
const pendingRows = computed(() => visibleRows.value.filter((r) => r.status === 'OPEN' || r.status === 'PARTIAL'));
const totalPrincipal = computed(() => visibleRows.value.reduce((acc, r) => acc + Number(r.principal || 0), 0));
const totalBalance = computed(() => visibleRows.value.reduce((acc, r) => acc + Number(r.balance || 0), 0));
const totalMonthlyInstallment = computed(() => visibleRows.value
  .filter((r) => r.kind === 'LOAN' && (r.status === 'OPEN' || r.status === 'PARTIAL'))
  .reduce((acc, r) => acc + Number(r.installmentAmount || 0), 0));

// Próxima ocurrencia de un día del mes (1-31) a partir de hoy (clamp a fin de mes).
function nextOccurrence(day: number, from: Date): Date {
  const clampDay = (y: number, m: number) => Math.min(day, new Date(y, m + 1, 0).getDate());
  let y = from.getFullYear(), m = from.getMonth();
  let d = new Date(y, m, clampDay(y, m));
  if (d < from) { m += 1; if (m > 11) { m = 0; y += 1; } d = new Date(y, m, clampDay(y, m)); }
  return d;
}

const nextDueLabel = computed(() => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates = pendingRows.value
    .filter((r) => r.paymentDay)
    .map((r) => nextOccurrence(r.paymentDay as number, today))
    .sort((a, b) => a.getTime() - b.getTime());
  if (!dates.length) return 'Sin día de pago';
  const next = dates[0];
  const diff = Math.round((next.getTime() - today.getTime()) / 86400000);
  const human = `${String(next.getDate()).padStart(2, '0')}/${String(next.getMonth() + 1).padStart(2, '0')}/${next.getFullYear()}`;
  if (diff === 0) return `Hoy (${human})`;
  return `${human} (${diff} d)`;
});

function progressPct(row: DebtRow): number {
  const principal = Number(row.principal || 0);
  const balance = Number(row.balance || 0);
  if (principal <= 0) return 0;
  const paid = Math.max(0, principal - balance);
  return Math.min(100, Math.round((paid / principal) * 100));
}

const computedTotalToPay = computed(() => {
  const ia = Number(form.value.installmentAmount || 0);
  const tm = Number(form.value.termMonths || 0);
  return ia > 0 && tm > 0 ? ia * tm : 0;
});

const computedInterestPortion = computed(() => {
  const total = Number(form.value.totalToPay || computedTotalToPay.value);
  const principal = Number(form.value.principal || 0);
  return total > principal ? total - principal : 0;
});

function kindBadgeClass(kind: DebtKind) { return ['cat-pill', `kind-${kind.toLowerCase()}`]; }
function statusBadgeClass(status: DebtStatus) { return ['cat-pill', `status-${status.toLowerCase()}`]; }

function resetForm() {
  form.value = { ...buildEmptyForm(), kind: meta.value.defaultKind };
}

async function load() {
  try {
    const [debtsRes, accountsRes, cardsRes] = await Promise.all([http.get('/debts'), http.get('/accounts'), http.get('/cards')]);
    rows.value = debtsRes.data;
    accounts.value = accountsRes.data;
    cards.value = cardsRes.data;
    if (!form.value.name && form.value.principal === 0) form.value.kind = meta.value.defaultKind;
  } catch {
    toast.error('No se pudieron cargar los registros. Intenta nuevamente.');
  }
}

async function save() {
  if (!form.value.name.trim() || !form.value.principal) {
    toast.error('El concepto y el monto principal son obligatorios.');
    return;
  }
  saving.value = true;
  try {
    const isLoan = form.value.kind === 'LOAN';
    const payload = {
      kind: form.value.kind,
      name: form.value.name.trim(),
      counterparty: form.value.counterparty.trim() || null,
      principal: form.value.principal,
      interestRate: isLoan ? form.value.interestRate ?? null : null,
      cutoffDay: form.value.cutoffDay ?? null,
      paymentDay: form.value.paymentDay ?? null,
      accountId: form.value.accountId || null,
      notes: form.value.notes.trim() || null,
      installmentAmount: isLoan ? form.value.installmentAmount ?? null : null,
      // El día de la cuota del préstamo = día de pago general.
      installmentDueDay: isLoan ? (form.value.paymentDay ?? null) : null,
      termMonths: isLoan ? form.value.termMonths ?? null : null,
      totalToPay: isLoan ? (form.value.totalToPay ?? computedTotalToPay.value) || null : null
    };
    if (editingId.value !== null) {
      await http.put(`/debts/${editingId.value}`, payload);
      toast.success('Registro actualizado.');
    } else {
      await http.post('/debts', payload);
      toast.success('Registro guardado correctamente.');
    }
    resetForm();
    editingId.value = null;
    await load();
  } catch {
    toast.error('No se pudo guardar el registro.');
  } finally {
    saving.value = false;
  }
}

function startEdit(item: DebtRow) {
  editingId.value = item.id;
  form.value = {
    kind: item.kind,
    name: item.name,
    counterparty: item.counterparty || '',
    principal: Number(item.principal),
    interestRate: item.interestRate !== null && item.interestRate !== undefined ? Number(item.interestRate) : null,
    cutoffDay: item.cutoffDay ?? null,
    paymentDay: item.paymentDay ?? item.installmentDueDay ?? null,
    accountId: item.accountId ?? null,
    notes: item.notes || '',
    installmentAmount: item.installmentAmount !== null && item.installmentAmount !== undefined ? Number(item.installmentAmount) : null,
    termMonths: item.termMonths ?? null,
    totalToPay: item.totalToPay !== null && item.totalToPay !== undefined ? Number(item.totalToPay) : null
  };
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  editingId.value = null;
  resetForm();
}

async function removeRow(item: DebtRow) {
  if (!(await confirm({ message: `¿Eliminar el registro "${item.name}"? Esta acción no se puede deshacer.`, danger: true, confirmText: 'Eliminar' }))) return;
  try {
    await http.delete(`/debts/${item.id}`);
    toast.success('Registro eliminado.');
    if (editingId.value === item.id) cancelEdit();
    await load();
  } catch { toast.error('No se pudo eliminar el registro.'); }
}

// ---- Registrar pago/abono a una deuda ----
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const payOpen = ref(false);
const payDebt = ref<DebtRow | null>(null);
type PaySource = 'account' | 'card';
const payForm = ref<{ source: PaySource; accountId: number | null; cardId: number | null; amount: number | null; payDate: string; notes: string }>(
  { source: 'account', accountId: null, cardId: null, amount: null, payDate: '', notes: '' }
);
const paying = ref(false);
const payAttachRef = ref<{ flush: (id: number) => Promise<void>; reset: () => void; hasPending: () => boolean } | null>(null);
const payBalance = computed(() => Math.max(0, Number(payDebt.value?.balance ?? 0)));
function cardLabel(c: CardRef): string {
  const parts = [c.name];
  if (c.type) parts.push(c.type === 'CREDIT' ? 'Crédito' : 'Débito');
  if (c.bankName) parts.push(c.bankName);
  if (c.last4) parts.push(`****${c.last4}`);
  return parts.join(' · ');
}
function openPay(item: DebtRow) {
  payDebt.value = item;
  payForm.value = { source: 'account', accountId: accounts.value[0]?.id ?? null, cardId: cards.value[0]?.id ?? null, amount: payBalance.value || null, payDate: todayYmd(), notes: '' };
  payAttachRef.value?.reset();
  payOpen.value = true;
}
async function submitPay() {
  if (!payDebt.value) return;
  if (!payForm.value.amount || payForm.value.amount <= 0) { toast.error('Ingresa un monto válido.'); return; }
  if (payForm.value.amount > payBalance.value) { toast.error(`No puedes abonar más de lo pendiente (${formatMoney(payBalance.value)}).`); return; }
  if (!payForm.value.payDate) { toast.error('Selecciona la fecha del pago.'); return; }
  const fromCard = payForm.value.source === 'card';
  if (fromCard && !payForm.value.cardId) { toast.error('Elige la tarjeta con la que pagas.'); return; }
  paying.value = true;
  try {
    const { data } = await http.post<{ movementId: number }>(`/debts/${payDebt.value.id}/pay`, {
      amount: payForm.value.amount,
      accountId: fromCard ? null : (payForm.value.accountId || null),
      cardId: fromCard ? (payForm.value.cardId || null) : null,
      movementDate: payForm.value.payDate,
      notes: payForm.value.notes.trim() || null
    });
    // Sube el comprobante adjunto (si lo hay) al gasto generado.
    if (data?.movementId && payAttachRef.value?.hasPending()) {
      try { await payAttachRef.value.flush(data.movementId); } catch { /* el pago ya quedó registrado */ }
    }
    payOpen.value = false;
    toast.success('Pago registrado. Se generó un gasto y se actualizó el saldo.');
    await load();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    toast.error(err?.response?.data?.message ?? 'No se pudo registrar el pago.');
  } finally { paying.value = false; }
}

const saveLabel = computed(() => {
  switch (form.value.kind) {
    case 'RECEIVABLE': return 'Registrar cobro';
    case 'LOAN': return 'Registrar préstamo';
    case 'PAYABLE': return 'Registrar deuda';
    default: return 'Registrar';
  }
});

const emptyIcon = computed(() => {
  switch (kindFilter.value) {
    case 'RECEIVABLE': return HandCoins;
    case 'PAYABLE': return FileText;
    case 'LOAN': return UserCheck;
    default: return FileText;
  }
});
const emptyTitle = computed(() => {
  switch (kindFilter.value) {
    case 'RECEIVABLE': return 'Sin cuentas por cobrar';
    case 'PAYABLE': return 'Sin cuentas por pagar';
    case 'LOAN': return 'Sin préstamos activos';
    default: return 'Sin registros';
  }
});
const emptyHint = computed(() => {
  switch (kindFilter.value) {
    case 'RECEIVABLE': return 'Registra dinero que te deben.';
    case 'PAYABLE': return 'Registra deudas pendientes que tienes.';
    case 'LOAN': return 'Registra préstamos con cuotas y plazo.';
    default: return 'Crea el primero arriba.';
  }
});

watch(kindFilter, () => {
  if (!form.value.name && form.value.principal === 0) form.value.kind = meta.value.defaultKind;
});

onMounted(load);
</script>

<template>
  <section class="dashboard">
    <PageHeader :title="meta.title" :subtitle="meta.subtitle">
      <template #actions>
        <div class="kpi-strip">
          <div class="mini-kpi">
            <span class="mini-kpi-label">Saldo pendiente</span>
            <strong class="mini-kpi-value">{{ formatMoney(totalBalance) }}</strong>
          </div>
          <div class="mini-kpi">
            <span class="mini-kpi-label">Registros pendientes</span>
            <strong class="mini-kpi-value">{{ pendingRows.length }}</strong>
          </div>
          <div v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'" class="mini-kpi">
            <span class="mini-kpi-label">Cuota mensual total</span>
            <strong class="mini-kpi-value">{{ formatMoney(totalMonthlyInstallment) }}</strong>
          </div>
          <div class="mini-kpi">
            <span class="mini-kpi-label">Próximo vencimiento</span>
            <strong class="mini-kpi-value">{{ nextDueLabel }}</strong>
          </div>
        </div>
      </template>
    </PageHeader>

    <TabBar :tabs="DEBT_TABS" v-model="activeTab" />


    <div class="stack">
      <div class="panel">
        <div class="panel-header"><h2>{{ editingId !== null ? 'Editar registro' : 'Nuevo registro' }}</h2></div>
        <form class="form" @submit.prevent="save">
          <div class="form-grid">
            <div class="field">
              <label for="dbt-kind">Tipo de registro <span class="required-mark">*</span></label>
              <select id="dbt-kind" v-model="form.kind" required>
                <option value="PAYABLE">Por pagar</option>
                <option value="RECEIVABLE">Por cobrar</option>
                <option value="LOAN">Préstamo</option>
              </select>
              <small class="hint">
                {{ form.kind === 'PAYABLE' ? 'Tú debes a alguien.' : form.kind === 'RECEIVABLE' ? 'Alguien te debe a ti.' : 'Préstamo formal con cuotas y plazo.' }}
              </small>
            </div>

            <div class="field">
              <label for="dbt-name">Concepto / Nombre <span class="required-mark">*</span></label>
              <input id="dbt-name" v-model="form.name" required maxlength="120"
                     placeholder="ej. Préstamo Banco Pacífico cuota 5/12" />
              <small class="hint">Cómo se mostrará en el listado.</small>
            </div>

            <div class="field">
              <label for="dbt-counterparty">Persona o institución</label>
              <input id="dbt-counterparty" v-model="form.counterparty" maxlength="120"
                     placeholder="ej. Banco Pacífico, Juan Pérez" />
              <small class="hint">A quién le debes o quién te debe.</small>
            </div>

            <div class="field">
              <label for="dbt-account">Cuenta relacionada</label>
              <select id="dbt-account" v-model="form.accountId">
                <option :value="null">Sin cuenta vinculada</option>
                <option v-for="item in accounts" :key="item.id" :value="item.id">{{ accountLabel(item) }}</option>
              </select>
              <small class="hint">Cuenta afectada al pagar o recibir.</small>
            </div>

            <div class="field">
              <label for="dbt-cutoff">Día de corte (1-31)</label>
              <input id="dbt-cutoff" v-model.number="form.cutoffDay" type="number" min="1" max="31" placeholder="ej. 5" />
              <small class="hint">Día en que cierra el período.</small>
            </div>

            <div class="field">
              <label for="dbt-payday">Día de pago (1-31)</label>
              <input id="dbt-payday" v-model.number="form.paymentDay" type="number" min="1" max="31" placeholder="ej. 20" />
              <small class="hint">Día límite para pagar/cobrar.</small>
            </div>
          </div>

          <template v-if="form.kind === 'LOAN'">
            <div class="loan-section">
              <div class="loan-section-header">
                <span class="loan-icon">🏦</span>
                <div>
                  <strong>Detalles del préstamo</strong>
                  <small>Define cuota, plazo y total a pagar. El día de pago se toma del campo general de arriba.</small>
                </div>
              </div>

              <div class="form-grid">
                <div class="field">
                  <label for="dbt-installment">Cuota mensual (USD) <span class="required-mark">*</span></label>
                  <input id="dbt-installment" v-model.number="form.installmentAmount" type="number" step="0.01" min="0.01"
                         placeholder="ej. 250.00" />
                  <small class="hint">Monto que pagas cada mes.</small>
                </div>

                <div class="field">
                  <label for="dbt-term">Plazo (meses) <span class="required-mark">*</span></label>
                  <input id="dbt-term" v-model.number="form.termMonths" type="number" min="1" max="600"
                         placeholder="ej. 24" />
                  <small class="hint">Número de cuotas.</small>
                </div>

                <div class="field">
                  <label for="dbt-rate">Tasa de interés anual (%)</label>
                  <input id="dbt-rate" v-model.number="form.interestRate" type="number" step="0.01" min="0" max="100"
                         placeholder="ej. 12.5" />
                  <small class="hint">Opcional.</small>
                </div>

                <div class="field">
                  <label for="dbt-total">Valor total a pagar (USD)</label>
                  <input id="dbt-total" v-model.number="form.totalToPay" type="number" step="0.01" min="0"
                         :placeholder="computedTotalToPay > 0 ? `Calculado: ${formatMoney(computedTotalToPay)}` : 'ej. 6000.00'" />
                  <small class="hint">Si lo dejas vacío se calcula automáticamente.</small>
                </div>
              </div>

              <div v-if="computedTotalToPay > 0 || form.totalToPay" class="loan-summary">
                <div><small>Cuota</small><strong>{{ formatMoney(form.installmentAmount || 0) }}</strong></div>
                <div><small>×</small><strong>{{ form.termMonths || 0 }} meses</strong></div>
                <div><small>=</small><strong>{{ formatMoney(form.totalToPay || computedTotalToPay) }}</strong></div>
                <div v-if="computedInterestPortion > 0"><small>Intereses</small><strong class="due-warning">{{ formatMoney(computedInterestPortion) }}</strong></div>
              </div>
            </div>
          </template>

          <div class="field">
            <label for="dbt-notes">Notas</label>
            <textarea id="dbt-notes" v-model="form.notes" rows="3"
                      placeholder="Términos del acuerdo, garantías, observaciones…"></textarea>
            <small class="hint">Opcional.</small>
          </div>

          <div class="form-footer">
            <div class="field field-narrow">
              <label for="dbt-principal">Monto principal (USD) <span class="required-mark">*</span></label>
              <input id="dbt-principal" v-model.number="form.principal" type="number" step="0.01" min="0.01" required />
              <small class="hint">Capital inicial sin intereses.</small>
            </div>
            <div class="form-actions">
              <button v-if="editingId !== null" type="button" class="ghost" @click="cancelEdit">
                <X :size="14" /> Cancelar
              </button>
              <button type="submit" :disabled="saving">
                <component :is="editingId !== null ? Pencil : Plus" :size="14" />
                {{ saving ? 'Guardando…' : (editingId !== null ? 'Guardar cambios' : saveLabel) }}
              </button>
            </div>
          </div>
        </form>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Listado</h2>
          <span class="panel-hint">{{ visibleRows.length }} registro{{ visibleRows.length === 1 ? '' : 's' }}</span>
        </div>
        <div class="table-scroll">
          <table class="recent-table debts-table">
            <thead>
              <tr>
                <th class="col-name">Concepto</th>
                <th class="center col-kind">Tipo</th>
                <th class="center col-money">Principal</th>
                <th class="center col-money">Saldo</th>
                <th class="center col-progress">Avance</th>
                <th v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'" class="center col-money">Cuota mensual</th>
                <th v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'" class="center col-term">Día / Plazo</th>
                <th v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'" class="center col-money">Total a pagar</th>
                <th class="center col-due">Corte / Pago</th>
                <th class="center col-status">Estado</th>
                <th class="center col-acts">Acciones</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in visibleRows" :key="item.id">
                <td class="col-name">
                  <strong>{{ item.name }}</strong>
                  <br /><small class="hint">{{ item.counterparty || 'Sin contraparte' }}</small>
                  <br v-if="item.notes" /><small v-if="item.notes" class="hint-msg" :title="item.notes">{{ (item.notes || '').slice(0, 60) }}{{ (item.notes || '').length > 60 ? '…' : '' }}</small>
                </td>
                <td class="center col-kind"><span :class="kindBadgeClass(item.kind)">{{ KIND_LABEL[item.kind] }}</span></td>
                <td class="center col-money">{{ formatMoney(item.principal) }}</td>
                <td class="center col-money" :class="{ neg: Number(item.balance) > 0 }">{{ formatMoney(item.balance) }}</td>
                <td class="center col-progress">
                  <div class="progress-bar" :title="`${progressPct(item)}% pagado`">
                    <div class="progress-bar-fill" :style="{ width: progressPct(item) + '%' }"></div>
                  </div>
                  <small class="hint">{{ progressPct(item) }}% pagado</small>
                </td>
                <td v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'" class="center col-money">
                  <template v-if="item.kind === 'LOAN' && item.installmentAmount">
                    <strong>{{ formatMoney(item.installmentAmount) }}</strong>
                    <br /><small class="hint">por mes</small>
                  </template>
                  <template v-else>—</template>
                </td>
                <td v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'" class="center col-term">
                  <template v-if="item.kind === 'LOAN' && (item.installmentDueDay || item.termMonths)">
                    <div v-if="item.installmentDueDay"><strong>Día {{ item.installmentDueDay }}</strong> <small class="hint">de cada mes</small></div>
                    <div v-if="item.termMonths"><small class="hint">{{ item.termMonths }} cuotas</small></div>
                  </template>
                  <template v-else>—</template>
                </td>
                <td v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'" class="center col-money">
                  <template v-if="item.kind === 'LOAN' && item.totalToPay">
                    {{ formatMoney(item.totalToPay) }}
                    <br /><small v-if="item.interestRate" class="hint">{{ item.interestRate }}% anual</small>
                  </template>
                  <template v-else-if="item.kind === 'LOAN' && item.installmentAmount && item.termMonths">
                    {{ formatMoney(Number(item.installmentAmount) * Number(item.termMonths)) }}
                  </template>
                  <template v-else>—</template>
                </td>
                <td class="center col-due">
                  <template v-if="item.cutoffDay || item.paymentDay">
                    <div v-if="item.cutoffDay"><small class="hint">Corte:</small> <strong>Día {{ item.cutoffDay }}</strong></div>
                    <div v-if="item.paymentDay"><small class="hint">Pago:</small> <strong>Día {{ item.paymentDay }}</strong></div>
                  </template>
                  <span v-else class="hint">—</span>
                </td>
                <td class="center col-status"><span :class="statusBadgeClass(item.status)">{{ STATUS_LABEL[item.status] }}</span></td>
                <td class="center col-acts">
                  <div class="row-actions" style="justify-content: center">
                    <button v-if="Number(item.balance) > 0" type="button" class="ghost mini pay" @click="openPay(item)" aria-label="Registrar pago" title="Registrar pago / abono">
                      <Wallet :size="14" />
                    </button>
                    <button type="button" class="ghost mini" @click="startEdit(item)" :disabled="editingId === item.id" aria-label="Editar">
                      <Pencil :size="14" />
                    </button>
                    <button type="button" class="ghost mini danger" @click="removeRow(item)" aria-label="Eliminar">
                      <Trash2 :size="14" />
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="!visibleRows.length">
                <td :colspan="kindFilter === 'LOAN' || kindFilter === 'ALL' ? 11 : 8">
                  <div class="empty-state">
                    <div class="empty-state-illustration">
                      <component :is="emptyIcon" :size="36" />
                    </div>
                    <strong>{{ emptyTitle }}</strong>
                    <p>{{ emptyHint }}</p>
                  </div>
                </td>
              </tr>
            </tbody>
            <tfoot v-if="visibleRows.length">
              <tr class="totals-row">
                <td colspan="2"><strong>Totales</strong></td>
                <td class="center"><strong>{{ formatMoney(totalPrincipal) }}</strong></td>
                <td class="center"><strong>{{ formatMoney(totalBalance) }}</strong></td>
                <td></td>
                <td v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'" class="center"><strong>{{ formatMoney(totalMonthlyInstallment) }}</strong></td>
                <td v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'"></td>
                <td v-if="kindFilter === 'LOAN' || kindFilter === 'ALL'"></td>
                <td colspan="3"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>

    <AppModal :open="payOpen" :title="`Registrar pago${payDebt ? ' · ' + payDebt.name : ''}`" @close="payOpen = false">
      <div class="pay-body">
        <p class="pay-hint">
          Se descuenta del saldo de la deuda y se registra un <strong>gasto</strong> (salida de dinero).
          <template v-if="payDebt"><br />Saldo pendiente: <strong>{{ formatMoney(payBalance) }}</strong>.</template>
        </p>
        <div class="field">
          <label for="dpay-amt">Monto del pago (USD) <span class="required-mark">*</span></label>
          <input id="dpay-amt" v-model.number="payForm.amount" type="number" step="0.01" min="0" :max="payBalance" placeholder="0.00" />
          <small class="hint">Máximo {{ formatMoney(payBalance) }} (lo pendiente).</small>
        </div>
        <div class="field">
          <label>¿Con qué pagas?</label>
          <div class="pay-source">
            <button type="button" class="pay-source-btn" :class="{ active: payForm.source === 'account' }" @click="payForm.source = 'account'">🏦 Cuenta</button>
            <button type="button" class="pay-source-btn" :class="{ active: payForm.source === 'card' }" @click="payForm.source = 'card'">💳 Tarjeta</button>
          </div>
        </div>
        <div v-if="payForm.source === 'account'" class="field">
          <label for="dpay-acc">Cuenta de origen</label>
          <select id="dpay-acc" v-model.number="payForm.accountId">
            <option :value="null">Sin cuenta (no afecta saldos)</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ accountLabel(a) }}</option>
          </select>
          <small class="hint">Si la eliges, se descuenta de esa cuenta.</small>
        </div>
        <div v-else class="field">
          <label for="dpay-card">Tarjeta</label>
          <select id="dpay-card" v-model.number="payForm.cardId">
            <option :value="null">— Selecciona la tarjeta —</option>
            <option v-for="c in cards" :key="c.id" :value="c.id">{{ cardLabel(c) }}</option>
          </select>
          <small v-if="cards.length" class="hint">Se registra el gasto usando esta tarjeta.</small>
          <small v-else class="hint">No tienes tarjetas. Créalas en la sección Tarjetas.</small>
        </div>
        <div class="field">
          <label for="dpay-date">Fecha del pago <span class="required-mark">*</span></label>
          <input id="dpay-date" v-model="payForm.payDate" type="date" min="2026-05-01" :max="todayYmd()" />
          <small class="hint">Con esta fecha aparece el gasto en Movimientos.</small>
        </div>
        <div class="field">
          <label>Comprobante</label>
          <AttachmentUploader ref="payAttachRef" entity-type="MOVEMENT" :entity-id="null" />
        </div>
        <div class="field">
          <label for="dpay-notes">Notas</label>
          <input id="dpay-notes" v-model="payForm.notes" type="text" maxlength="500" placeholder="Opcional" />
        </div>
      </div>
      <template #footer>
        <button type="button" class="ghost" @click="payOpen = false"><X :size="16" /> Cancelar</button>
        <button type="button" @click="submitPay" :disabled="paying || payBalance <= 0"><Wallet :size="16" /> {{ paying ? 'Procesando…' : 'Registrar pago' }}</button>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.kpi-strip { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 0.5rem; }
.mini-kpi { display: flex; flex-direction: column; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 12px; min-width: 140px; }
.mini-kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
.mini-kpi-value { font-size: 14px; margin-top: 2px; color: #0f172a; }
.row-actions button.mini.pay { color: #047857; border-color: #a7f3d0; }
.row-actions button.mini.pay:hover { background: #ecfdf5; }
.pay-body { display: flex; flex-direction: column; gap: 12px; }
.pay-hint { margin: 0; font-size: 13px; color: #64748b; }
.pay-body .field { display: flex; flex-direction: column; gap: 4px; }
.pay-body label { font-size: 13px; font-weight: 600; color: #334155; }
.pay-body input, .pay-body select { padding: 8px 10px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; font: inherit; color: #334155; }
.pay-body .hint { font-size: 12px; color: #94a3b8; }
/* Selector de origen del pago: cuenta o tarjeta (control segmentado) */
.pay-source { display: flex; gap: 4px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 12px; padding: 4px; }
.pay-source-btn {
  flex: 1;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  padding: 10px 16px;
  border: none !important; background: transparent !important; box-shadow: none !important;
  border-radius: 9px; font-weight: 600; font-size: 14px; color: #64748b !important;
  cursor: pointer; transition: background .12s ease, color .12s ease;
}
.pay-source-btn:hover { color: #334155 !important; }
.pay-source-btn.active {
  background: #fff !important;
  color: var(--color-primary, #2563eb) !important;
  box-shadow: 0 1px 2px rgba(15,23,42,.12) !important;
}

.required-mark { color: #ef4444; font-weight: 700; }

.loan-section { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 14px; }
.loan-section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.loan-icon { font-size: 22px; }
.loan-section-header strong { display: block; color: #0f172a; }
.loan-section-header small { color: #64748b; font-size: 12px; }
.loan-summary { display: flex; gap: 12px; align-items: center; padding: 10px 12px; background: #ecfdf5; border-radius: 8px; flex-wrap: wrap; }
.loan-summary > div { display: flex; flex-direction: column; }
.loan-summary small { color: #64748b; font-size: 11px; }
.loan-summary strong { font-size: 14px; color: #0f172a; }

.progress-bar { width: 100%; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; min-width: 80px; }
.progress-bar-fill { height: 100%; background: linear-gradient(90deg, #2563eb, #22d3ee); transition: width 0.3s ease; }

.due-warning { color: #f59e0b; font-weight: 600; }
.due-overdue { color: #ef4444; font-weight: 700; }

.cat-pill.kind-payable { background: #fff7ed; color: #c2410c; }
.cat-pill.kind-receivable { background: #ecfdf5; color: #047857; }
.cat-pill.kind-loan { background: #f5f3ff; color: #7c3aed; }
.cat-pill.status-open, .cat-pill.status-partial { background: #eff6ff; color: #1d4ed8; }
.cat-pill.status-paid { background: #ecfdf5; color: #047857; }
.cat-pill.status-canceled { background: #f1f5f9; color: #64748b; }

.table-scroll { overflow-x: auto; }
.totals-row td { background: #f8fafc; border-top: 2px solid #e2e8f0; }
.recent-table .neg { color: #ef4444; }

/* Anchos de columna en tabla de Deudas */
.debts-table { table-layout: fixed; }
.debts-table .col-name     { width: 22%; }
.debts-table .col-kind     { width: 8%; }
.debts-table .col-money    { width: 10%; }
.debts-table .col-progress { width: 10%; }
.debts-table .col-term     { width: 9%; }
.debts-table .col-due      { width: 11%; }
.debts-table .col-status   { width: 8%; }
.debts-table .col-acts     { width: 9%; }
@media (max-width: 1000px) {
  .debts-table { table-layout: auto; }
  .debts-table .col-name,
  .debts-table .col-kind,
  .debts-table .col-money,
  .debts-table .col-progress,
  .debts-table .col-term,
  .debts-table .col-due,
  .debts-table .col-status,
  .debts-table .col-acts { width: auto; }
}
.row-actions { display: flex; gap: 4px; justify-content: flex-end; }
.row-actions button.mini { background: white; border: 1px solid #e2e8f0; color: #475569; border-radius: 6px; cursor: pointer; }
.row-actions button.mini:hover:not(:disabled) { background: #f8fafc; }
.row-actions button.mini:disabled { opacity: 0.4; cursor: not-allowed; }
.row-actions button.mini.danger { color: #dc2626; border-color: #fecaca; }
.row-actions button.mini.danger:hover { background: #fef2f2; }
</style>
