<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { http } from '../api/http';
import { Repeat, Pencil, Trash2, Plus, X } from 'lucide-vue-next';
import { useFormat } from '../composables/useFormat';
import { useToast } from '../composables/useToast';

type RecurringType = 'INCOME' | 'EXPENSE' | 'TRANSFER';
type RecurringStatus = 'ACTIVE' | 'PAUSED' | 'FINISHED';
type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'DEBIT_CARD' | 'CREDIT_CARD' | 'WALLET' | 'OTHER';

interface Category { id: number; name: string }
interface Account { id: number; name: string; bankName?: string | null; accountNumber?: string | null }
interface RecurringRow {
  id: number; name: string; type: RecurringType; amount: number;
  frequency: Frequency; status: RecurringStatus; nextRunDate: string; endDate?: string | null;
  paymentMethod: PaymentMethod; categoryId?: number | null; accountId?: number | null; notes?: string | null;
  category?: { id: number; name: string } | null;
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const rows = ref<RecurringRow[]>([]);
const categories = ref<Category[]>([]);
const accounts = ref<Account[]>([]);
const acctLabel = (a: Account) => [a.name, a.bankName, a.accountNumber ? '****' + a.accountNumber.slice(-4) : ''].filter(Boolean).join(' · ');
const saving = ref(false);
const toast = useToast();
const editingId = ref<number | null>(null);

const emptyForm = () => ({
  name: '', type: 'EXPENSE' as RecurringType, amount: 0,
  frequency: 'MONTHLY' as Frequency, nextRunDate: today(), endDate: '',
  paymentMethod: 'CASH' as PaymentMethod, categoryId: null as number | null, accountId: null as number | null, notes: ''
});
const form = ref(emptyForm());

const FREQ_LABEL: Record<Frequency, string> = { DAILY: 'cada día', WEEKLY: 'cada semana', MONTHLY: 'cada mes', YEARLY: 'cada año' };
const FREQ_HINT: Record<Frequency, string> = {
  DAILY: 'Diaria',
  WEEKLY: 'Semanal',
  MONTHLY: 'Mensual',
  YEARLY: 'Anual'
};
const PAYMENT_LABEL: Record<PaymentMethod, string> = { CASH: 'Efectivo', BANK_TRANSFER: 'Transferencia', DEBIT_CARD: 'Tarjeta débito', CREDIT_CARD: 'Tarjeta crédito', WALLET: 'Billetera', OTHER: 'Otro' };
const STATUS_LABEL: Record<RecurringStatus, string> = { ACTIVE: 'Activa', PAUSED: 'Pausada', FINISHED: 'Finalizada' };
const TYPE_LABEL: Record<RecurringType, string> = { INCOME: 'Ingreso', EXPENSE: 'Gasto', TRANSFER: 'Transferencia' };

const { formatMoney, formatDate } = useFormat();

function monthlyFactor(f: Frequency) { return f === 'DAILY' ? 30 : f === 'WEEKLY' ? 4.3333 : f === 'MONTHLY' ? 1 : 1 / 12; }
function monthlyImpact(r: RecurringRow) { return Number(r.amount || 0) * monthlyFactor(r.frequency); }

const activeRows = computed(() => rows.value.filter((r) => r.status === 'ACTIVE'));
const totalMonthlyIncome = computed(() => activeRows.value.filter((r) => r.type === 'INCOME').reduce((a, r) => a + monthlyImpact(r), 0));
const totalMonthlyExpense = computed(() => activeRows.value.filter((r) => r.type === 'EXPENSE').reduce((a, r) => a + monthlyImpact(r), 0));
const monthlyNet = computed(() => totalMonthlyIncome.value - totalMonthlyExpense.value);

function amountSign(r: RecurringRow) { if (r.type === 'INCOME') return `+${formatMoney(r.amount)}`; if (r.type === 'EXPENSE') return `-${formatMoney(r.amount)}`; return formatMoney(r.amount); }

async function load() {
  try {
    const [r, c, a] = await Promise.all([http.get('/recurrings'), http.get('/categories'), http.get('/accounts')]);
    rows.value = r.data; categories.value = c.data; accounts.value = a.data;
  } catch { toast.error('No se pudieron cargar las reglas recurrentes.'); }
}

async function save() {
  if (!form.value.name.trim() || !form.value.amount) { toast.error('Nombre y monto son obligatorios.'); return; }
  saving.value = true;
  try {
    const payload = { ...form.value, categoryId: form.value.categoryId || null, accountId: form.value.accountId || null, endDate: form.value.endDate || null, notes: form.value.notes || null };
    if (editingId.value !== null) {
      await http.put(`/recurrings/${editingId.value}`, payload);
      toast.success('Regla actualizada.');
    } else {
      await http.post('/recurrings', payload);
      toast.success('Regla guardada.');
    }
    form.value = emptyForm();
    editingId.value = null;
    await load();
  } catch { toast.error('No se pudo guardar la regla recurrente.'); }
  finally { saving.value = false; }
}

function startEdit(r: RecurringRow) {
  editingId.value = r.id;
  form.value = {
    name: r.name,
    type: r.type === 'TRANSFER' ? 'EXPENSE' : r.type as RecurringType,
    amount: Number(r.amount),
    frequency: r.frequency,
    nextRunDate: r.nextRunDate ? r.nextRunDate.slice(0, 10) : today(),
    endDate: r.endDate ? String(r.endDate).slice(0, 10) : '',
    paymentMethod: r.paymentMethod,
    categoryId: r.categoryId ?? null,
    accountId: r.accountId ?? null,
    notes: r.notes || ''
  };
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  editingId.value = null;
  form.value = emptyForm();
}

async function removeRow(r: RecurringRow) {
  if (!confirm(`Eliminar la regla "${r.name}"? Esta acción no se puede deshacer.`)) return;
  try {
    await http.delete(`/recurrings/${r.id}`);
    toast.success('Regla eliminada.');
    if (editingId.value === r.id) cancelEdit();
    await load();
  } catch { toast.error('No se pudo eliminar la regla.'); }
}

onMounted(load);
</script>

<template>
  <section class="dashboard">
    <header class="dash-header">
      <div class="dash-header-left">
        <h1>Pagos / cobros recurrentes</h1>
        <p>Pagos automáticos que se repiten.</p>
      </div>
      <div class="kpi-strip">
        <div class="mini-kpi"><span class="mini-kpi-label">Ingresos mensuales</span><strong class="mini-kpi-value pos">+{{ formatMoney(totalMonthlyIncome) }}</strong></div>
        <div class="mini-kpi"><span class="mini-kpi-label">Gastos mensuales</span><strong class="mini-kpi-value neg">-{{ formatMoney(totalMonthlyExpense) }}</strong></div>
        <div class="mini-kpi"><span class="mini-kpi-label">Balance neto</span><strong class="mini-kpi-value" :class="monthlyNet >= 0 ? 'pos' : 'neg'">{{ formatMoney(monthlyNet) }}</strong></div>
      </div>
    </header>

    <div class="stack">
      <div class="panel">
        <div class="panel-header"><h2>{{ editingId !== null ? 'Editar regla recurrente' : 'Nueva regla recurrente' }}</h2></div>
        <form class="form" @submit.prevent="save">
          <div class="form-grid">
            <div class="field">
              <label for="rec-name">Nombre / Concepto <span class="required-mark">*</span></label>
              <input id="rec-name" v-model="form.name" required maxlength="120" placeholder="ej. Suscripción Netflix, Sueldo mensual" />
              <small class="hint">Cómo se mostrará en cada movimiento.</small>
            </div>

            <div class="field">
              <label>Tipo <span class="required-mark">*</span></label>
              <div class="type-toggle">
                <button type="button" class="type-toggle-btn type-income" :class="{ active: form.type === 'INCOME' }" @click="form.type = 'INCOME'">💵 Ingreso</button>
                <button type="button" class="type-toggle-btn type-expense" :class="{ active: form.type === 'EXPENSE' }" @click="form.type = 'EXPENSE'">🛒 Gasto</button>
              </div>
              <small class="hint">Ingreso suma, gasto resta.</small>
            </div>

            <div class="field">
              <label for="rec-freq">Frecuencia <span class="required-mark">*</span></label>
              <select id="rec-freq" v-model="form.frequency" required>
                <option value="DAILY">Diaria</option>
                <option value="WEEKLY">Semanal</option>
                <option value="MONTHLY">Mensual</option>
                <option value="YEARLY">Anual</option>
              </select>
              <small class="hint">{{ FREQ_HINT[form.frequency] }}</small>
            </div>

            <div class="field">
              <label for="rec-next">Fecha máxima de pago <span class="required-mark">*</span></label>
              <input id="rec-next" v-model="form.nextRunDate" type="date" required />
              <small class="hint">Día límite en que se debe pagar/cobrar.</small>
            </div>

            <div class="field">
              <label for="rec-pm">Método de pago <span class="required-mark">*</span></label>
              <select id="rec-pm" v-model="form.paymentMethod" required>
                <option v-for="(label, value) in PAYMENT_LABEL" :key="value" :value="value">{{ label }}</option>
              </select>
              <small class="hint">Cómo se ejecuta habitualmente.</small>
            </div>

            <div class="field">
              <label for="rec-cat">Categoría</label>
              <select id="rec-cat" v-model="form.categoryId">
                <option :value="null">Sin categoría</option>
                <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <small class="hint">Opcional, agrupa reportes.</small>
            </div>

            <div class="field">
              <label for="rec-acct">Cuenta afectada</label>
              <select id="rec-acct" v-model="form.accountId">
                <option :value="null">Sin cuenta (efectivo)</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ acctLabel(a) }}</option>
              </select>
              <small class="hint">Si la eliges, cada cobro/pago generado {{ form.type === 'INCOME' ? 'sumará' : 'restará' }} su saldo automáticamente.</small>
            </div>
          </div>

          <div class="field">
            <label for="rec-notes">Notas</label>
            <textarea id="rec-notes" v-model="form.notes" rows="2" placeholder="Detalles adicionales, número de contrato…"></textarea>
            <small class="hint">Opcional.</small>
          </div>

          <div class="form-footer">
            <div class="field field-narrow">
              <label for="rec-amount">Monto (USD) <span class="required-mark">*</span></label>
              <input id="rec-amount" v-model.number="form.amount" type="number" step="0.01" min="0.01" required />
              <small class="hint">Monto por cada ocurrencia.</small>
            </div>
            <div class="form-actions">
              <button v-if="editingId !== null" type="button" class="ghost" @click="cancelEdit">
                <X :size="14" /> Cancelar
              </button>
              <button type="submit" :disabled="saving">
                <component :is="editingId !== null ? Pencil : Plus" :size="14" />
                {{ saving ? 'Guardando…' : (editingId !== null ? 'Guardar cambios' : 'Registrar recurrente') }}
              </button>
            </div>
          </div>
        </form>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Reglas activas</h2>
          <span class="panel-hint">{{ rows.length }} regla{{ rows.length === 1 ? '' : 's' }}</span>
        </div>
        <div class="table-scroll">
          <table class="recent-table rec-table">
            <thead>
              <tr>
                <th class="col-name">Concepto</th>
                <th class="col-type center">Tipo</th>
                <th class="col-amount center">Monto</th>
                <th class="col-freq center">Frecuencia</th>
                <th class="col-next center">Fecha máxima de pago</th>
                <th class="col-status center">Estado</th>
                <th class="col-actions center">Acciones</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in rows" :key="item.id">
                <td>
                  <strong>{{ item.name }}</strong>
                  <div><small class="hint">{{ item.category?.name || 'Sin categoría' }} · {{ PAYMENT_LABEL[item.paymentMethod] }}</small></div>
                </td>
                <td class="center"><span class="cat-pill" :class="`type-${item.type.toLowerCase()}`">{{ TYPE_LABEL[item.type] }}</span></td>
                <td class="center" :class="item.type === 'INCOME' ? 'pos' : 'neg'">{{ amountSign(item) }}</td>
                <td class="center">{{ FREQ_LABEL[item.frequency] }}</td>
                <td class="center">{{ formatDate(item.nextRunDate) }}</td>
                <td class="center"><span class="cat-pill" :class="`status-${item.status.toLowerCase()}`">{{ STATUS_LABEL[item.status] }}</span></td>
                <td class="center">
                  <div class="row-actions">
                    <button type="button" class="ghost mini" @click="startEdit(item)" :disabled="editingId === item.id" aria-label="Editar">
                      <Pencil :size="14" />
                    </button>
                    <button type="button" class="ghost mini danger" @click="removeRow(item)" aria-label="Eliminar">
                      <Trash2 :size="14" />
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="7">
                  <div class="empty-state">
                    <div class="empty-state-illustration"><Repeat :size="36" /></div>
                    <strong>Sin pagos recurrentes</strong>
                    <p>Configura pagos automáticos como Netflix, gimnasio o renta.</p>
                  </div>
                </td>
              </tr>
            </tbody>
            <tfoot v-if="rows.length">
              <tr class="totals-row">
                <td colspan="2"><strong>Totales mensuales</strong></td>
                <td class="center pos"><strong>+{{ formatMoney(totalMonthlyIncome) }}</strong></td>
                <td colspan="2" class="center neg"><strong>-{{ formatMoney(totalMonthlyExpense) }}</strong></td>
                <td colspan="2" class="center" :class="monthlyNet >= 0 ? 'pos' : 'neg'"><strong>Neto: {{ formatMoney(monthlyNet) }}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.kpi-strip { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 0.5rem; }
.mini-kpi { display: flex; flex-direction: column; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 12px; min-width: 160px; }
.mini-kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
.mini-kpi-value { font-size: 14px; margin-top: 2px; }
.required-mark { color: #ef4444; font-weight: 700; }
.type-toggle { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.type-toggle-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 11px 12px;
  border: 1.5px solid var(--color-border);
  background: var(--color-surface);
  border-radius: 10px;
  font-weight: 600; font-size: 14px;
  color: var(--color-text-soft);
  cursor: pointer;
  transition: border-color .15s ease, background .15s ease, color .15s ease, transform .12s ease;
}
.type-toggle-btn:hover { border-color: var(--color-border-strong); background: var(--color-surface-2); transform: translateY(-1px); }
.type-toggle-btn.type-income.active { background: var(--color-success-soft); border-color: var(--color-success-text); color: var(--color-success-text); }
.type-toggle-btn.type-expense.active { background: var(--color-danger-soft); border-color: var(--color-danger-text); color: var(--color-danger-text); }
.recent-table .pos { color: var(--color-success-text); font-weight: 600; }
.recent-table .neg { color: #ef4444; font-weight: 600; }
.cat-pill.type-income { background: #ecfdf5; color: #047857; }
.cat-pill.type-expense { background: #fef2f2; color: #b91c1c; }
.cat-pill.type-transfer { background: #f5f3ff; color: #7c3aed; }
.cat-pill.status-active { background: #ecfdf5; color: #047857; }
.cat-pill.status-paused { background: #fef3c7; color: #92400e; }
.cat-pill.status-finished { background: #f1f5f9; color: #64748b; }
.totals-row td { background: #f8fafc; border-top: 2px solid #e2e8f0; }
.table-scroll { overflow-x: auto; }
.row-actions { display: flex; gap: 4px; justify-content: flex-end; }
.row-actions button.mini { background: white; border: 1px solid #e2e8f0; color: #475569; border-radius: 6px; cursor: pointer; }
.row-actions button.mini:hover:not(:disabled) { background: #f8fafc; }
.row-actions button.mini:disabled { opacity: 0.4; cursor: not-allowed; }
.row-actions button.mini.danger { color: #dc2626; border-color: #fecaca; }
.row-actions button.mini.danger:hover { background: #fef2f2; }

.rec-table { table-layout: fixed; width: 100%; }
.rec-table .col-name { width: 22%; }
.rec-table .col-type { width: 11%; }
.rec-table .col-amount { width: 11%; }
.rec-table .col-freq { width: 12%; }
.rec-table .col-next { width: 12%; }
.rec-table .col-end { width: 11%; }
.rec-table .col-status { width: 10%; }
.rec-table .col-actions { width: 11%; }
.rec-table td, .rec-table th { overflow: hidden; text-overflow: ellipsis; }
.rec-table .row-actions { justify-content: center; }

@media (max-width: 1000px) {
  .rec-table { table-layout: auto; }
  .rec-table .col-name,
  .rec-table .col-type,
  .rec-table .col-amount,
  .rec-table .col-freq,
  .rec-table .col-next,
  .rec-table .col-end,
  .rec-table .col-status,
  .rec-table .col-actions { width: auto; }
}
</style>
