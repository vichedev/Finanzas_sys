<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Bar } from 'vue-chartjs';
import {
  Chart as ChartJS,
  Title,
  Tooltip,
  Legend,
  BarElement,
  CategoryScale,
  LinearScale
} from 'chart.js';
import { FileText, Pencil, Trash2, Plus, X, ArrowUpRight, ArrowDownLeft } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import FormField from '../components/FormField.vue';
import AppButton from '../components/AppButton.vue';
import DataTable, { type Column } from '../components/DataTable.vue';
import TabBar from '../components/TabBar.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import { useCrud } from '../composables/useCrud';
import { useFormat } from '../composables/useFormat';
import { useEntitiesStore } from '../stores/entities';
import { invoicesApi } from '../api/invoices';
import type { Invoice, InvoiceKind, InvoiceStatus, InvoicePayload } from '../types';

ChartJS.register(Title, Tooltip, Legend, BarElement, CategoryScale, LinearScale);

const { formatMoney } = useFormat();
const entities = useEntitiesStore();
const accounts = computed(() => entities.accounts);

// Etiqueta de cuenta: "Nombre · Banco · ****1234" (igual que en otras secciones).
function accountLabel(a: { name: string; bankName?: string | null; accountNumber?: string | null }): string {
  const parts = [a.name];
  if (a.bankName) parts.push(a.bankName);
  if (a.accountNumber) parts.push(`****${a.accountNumber.slice(-4)}`);
  return parts.join(' · ');
}

const STATUS_LABEL: Record<InvoiceStatus, string> = { ISSUED: 'Emitida', PAID: 'Pagada', VOID: 'Anulada' };
const KIND_LABEL: Record<InvoiceKind, string> = { SALE: 'Venta', PURCHASE: 'Compra' };
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MONTH_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, '0');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---- Pestaña principal: registro vs dashboard ----
type MainTab = 'invoices' | 'dashboard';
const MAIN_TABS: { value: MainTab; label: string }[] = [
  { value: 'invoices', label: '📝 Registrar facturas' },
  { value: 'dashboard', label: '📊 Dashboard IVA' }
];
const mainTab = ref<MainTab>('invoices');

// ---- Filtro del listado (todas / ventas / compras) ----
type InvoiceTab = 'ALL' | 'SALE' | 'PURCHASE';
const TABS: { value: InvoiceTab; label: string }[] = [
  { value: 'ALL', label: 'Todas' },
  { value: 'SALE', label: 'Ventas (emitidas)' },
  { value: 'PURCHASE', label: 'Compras (recibidas)' }
];
const activeTab = ref<InvoiceTab>('ALL');

// ---- Período tributario seleccionado (controla resumen IVA + dashboard) ----
const now = new Date();
const period = ref({ year: now.getFullYear(), month: now.getMonth() + 1 });
const yearOptions = computed(() => {
  const y = now.getFullYear();
  return [y - 2, y - 1, y, y + 1];
});

// ---- CRUD genérico (igual que Cuentas) ----
const crud = useCrud<Invoice, InvoicePayload>({
  service: invoicesApi,
  emptyForm: (): InvoicePayload => ({
    kind: 'SALE',
    status: 'ISSUED',
    number: '',
    counterparty: '',
    counterpartyTaxId: '',
    issueDate: todayISO(),
    netAmount: 0,
    vatRate: 15,
    accountId: null,
    description: '',
    notes: ''
  }),
  toForm: (i): InvoicePayload => ({
    kind: i.kind,
    status: i.status,
    number: i.number || '',
    counterparty: i.counterparty,
    counterpartyTaxId: i.counterpartyTaxId || '',
    issueDate: String(i.issueDate).slice(0, 10),
    netAmount: Number(i.netAmount),
    vatRate: Number(i.vatRate),
    accountId: i.accountId ?? null,
    description: i.description || '',
    notes: i.notes || ''
  }),
  toPayload: (f): InvoicePayload => ({
    kind: f.kind,
    status: f.status,
    number: (f.number || '').trim() || null,
    counterparty: f.counterparty.trim(),
    counterpartyTaxId: (f.counterpartyTaxId || '').trim() || null,
    issueDate: f.issueDate,
    netAmount: Number(f.netAmount) || 0,
    vatRate: Number(f.vatRate),
    accountId: f.accountId || null,
    description: (f.description || '').trim() || null,
    notes: (f.notes || '').trim() || null
  }),
  validate: (f) => {
    if (!f.counterparty.trim()) return f.kind === 'SALE' ? 'El cliente es obligatorio.' : 'El proveedor es obligatorio.';
    if (!(Number(f.netAmount) > 0)) return 'El valor neto debe ser mayor a 0.';
    return null;
  },
  labels: {
    created: 'Factura registrada correctamente.',
    updated: 'Factura actualizada.',
    removed: 'Factura eliminada.',
    loadError: 'No se pudieron cargar las facturas.',
    saveError: 'No se pudo guardar la factura.',
    removeError: 'No se pudo eliminar la factura.'
  }
});
const { rows, form, editingId, saving, lastSaved, save, startEdit, cancelEdit, remove, load } = crud;

const attachRef = ref<{ flush: (id: number) => Promise<void>; reset: () => void; hasPending: () => boolean } | null>(null);
async function onSave() {
  const wasNew = editingId.value === null;
  await save();
  if (wasNew && lastSaved.value && attachRef.value?.hasPending()) {
    await attachRef.value.flush(lastSaved.value.id);
  }
}

// Cálculo en vivo del IVA/total del formulario
const formVat = computed(() => round2(Number(form.value.netAmount || 0) * (Number(form.value.vatRate || 0) / 100)));
const formTotal = computed(() => round2(Number(form.value.netAmount || 0) + formVat.value));

// ---- Helpers de período (robustos a zona horaria: usamos la cadena YYYY-MM) ----
const ym = (iso: string) => String(iso).slice(0, 7); // "YYYY-MM"
const periodKey = computed(() => `${period.value.year}-${pad2(period.value.month)}`);

const validRows = computed(() => rows.value.filter((r) => r.status !== 'VOID'));

// ---- Resumen de IVA del mes seleccionado ----
const summary = computed(() => {
  let salesNet = 0, salesVat = 0, salesCount = 0;
  let purchasesNet = 0, purchasesVat = 0, purchasesCount = 0;
  for (const r of validRows.value) {
    if (ym(r.issueDate) !== periodKey.value) continue;
    if (r.kind === 'SALE') {
      salesNet += Number(r.netAmount); salesVat += Number(r.vatAmount); salesCount++;
    } else {
      purchasesNet += Number(r.netAmount); purchasesVat += Number(r.vatAmount); purchasesCount++;
    }
  }
  const netVat = round2(salesVat - purchasesVat);
  const pay = new Date(period.value.year, period.value.month, 1); // mes siguiente
  return {
    sales: { net: salesNet, vat: salesVat, total: round2(salesNet + salesVat), count: salesCount },
    purchases: { net: purchasesNet, vat: purchasesVat, total: round2(purchasesNet + purchasesVat), count: purchasesCount },
    vatToPay: netVat > 0 ? netVat : 0,
    vatCredit: netVat < 0 ? round2(-netVat) : 0,
    paymentLabel: `${MONTHS[pay.getMonth()]} ${pay.getFullYear()}`
  };
});

// ---- Serie mensual (12 meses terminando en el período seleccionado) ----
const monthlySeries = computed(() => {
  const buckets: Array<{ key: string; label: string; salesNet: number; salesVat: number; purchasesNet: number; purchasesVat: number }> = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(period.value.year, period.value.month - 1 - i, 1);
    buckets.push({
      key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
      label: `${MONTH_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
      salesNet: 0, salesVat: 0, purchasesNet: 0, purchasesVat: 0
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const r of validRows.value) {
    const b = byKey.get(ym(r.issueDate));
    if (!b) continue;
    if (r.kind === 'SALE') { b.salesNet += Number(r.netAmount); b.salesVat += Number(r.vatAmount); }
    else { b.purchasesNet += Number(r.netAmount); b.purchasesVat += Number(r.vatAmount); }
  }
  return buckets.map((b) => ({
    ...b,
    salesTotal: round2(b.salesNet + b.salesVat),
    vatToPay: Math.max(0, round2(b.salesVat - b.purchasesVat))
  }));
});

const chartData = computed(() => ({
  labels: monthlySeries.value.map((b) => b.label),
  datasets: [
    { label: 'Facturado en ventas', backgroundColor: '#3b82f6', borderRadius: 4, data: monthlySeries.value.map((b) => b.salesTotal) },
    { label: 'IVA a pagar', backgroundColor: '#ef4444', borderRadius: 4, data: monthlySeries.value.map((b) => b.vatToPay) }
  ]
}));
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { position: 'bottom' as const } },
  scales: { y: { beginAtZero: true, ticks: { callback: (v: number | string) => '$' + v } } }
};

// Totales anuales (los 12 meses mostrados)
const yearTotals = computed(() => monthlySeries.value.reduce(
  (acc, b) => {
    acc.salesTotal += b.salesTotal;
    acc.vatToPay += b.vatToPay;
    return acc;
  },
  { salesTotal: 0, vatToPay: 0 }
));

// ---- Listado filtrado por pestaña ----
const visibleRows = computed(() =>
  activeTab.value === 'ALL' ? rows.value : rows.value.filter((r) => r.kind === activeTab.value)
);

const columns: Column<Invoice>[] = [
  { key: 'kind', label: 'Tipo', align: 'center', width: '10%' },
  { key: 'doc', label: 'Factura / Contraparte', width: '30%' },
  { key: 'date', label: 'Fecha', align: 'center', width: '12%' },
  { key: 'net', label: 'Neto', align: 'center', width: '12%' },
  { key: 'vat', label: 'IVA', align: 'center', width: '12%' },
  { key: 'total', label: 'Total', align: 'center', width: '12%' },
  { key: 'status', label: 'Estado', align: 'center', width: '10%' }
];

function kindBadgeClass(kind: InvoiceKind) { return ['cat-pill', `kind-${kind.toLowerCase()}`]; }
function statusBadgeClass(status: InvoiceStatus) { return ['cat-pill', `status-${status.toLowerCase()}`]; }
function fmtDate(value: string) {
  const ds = String(value).slice(0, 10).split('-');
  return ds.length === 3 ? `${ds[2]}/${ds[1]}/${ds[0]}` : '—';
}

function onRemove(item: Invoice) {
  const label = item.number ? `factura ${item.number}` : `factura de ${item.counterparty}`;
  return remove(item, `Eliminar la ${label}? Esta acción no se puede deshacer.`);
}

onMounted(() => Promise.all([load(), entities.ensureAccounts()]));
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Facturas e IVA" subtitle="Registra tus facturas de ventas y compras, y calcula el IVA a pagar al SRI." />

    <TabBar :tabs="MAIN_TABS" v-model="mainTab" />

    <!-- =================== TAB: REGISTRAR FACTURAS =================== -->
    <div v-show="mainTab === 'invoices'" class="stack">
      <!-- Formulario -->
      <PanelCard :title="editingId !== null ? 'Editar factura' : 'Nueva factura'">
        <form class="form" @submit.prevent="onSave">
          <div class="form-grid">
            <FormField label="Tipo" required html-for="inv-kind"
                       :hint="form.kind === 'SALE' ? 'Tú emites la factura (IVA cobrado).' : 'Recibes la factura de un proveedor (IVA crédito).'">
              <select id="inv-kind" v-model="form.kind" required>
                <option value="SALE">Venta (emitida)</option>
                <option value="PURCHASE">Compra (recibida)</option>
              </select>
            </FormField>

            <FormField label="Nº de factura" html-for="inv-number" hint="Número o autorización SRI. Opcional.">
              <input id="inv-number" v-model="form.number" maxlength="60" placeholder="ej. 001-001-000001234" />
            </FormField>

            <FormField :label="form.kind === 'SALE' ? 'Cliente' : 'Proveedor'" required html-for="inv-counterparty">
              <input id="inv-counterparty" v-model="form.counterparty" required maxlength="160"
                     :placeholder="form.kind === 'SALE' ? 'ej. Comercial XYZ S.A.' : 'ej. Distribuidora ABC'" />
            </FormField>

            <FormField label="RUC / Cédula" html-for="inv-ruc" hint="Opcional.">
              <input id="inv-ruc" v-model="form.counterpartyTaxId" maxlength="20" placeholder="ej. 1790012345001" />
            </FormField>

            <FormField label="Fecha de emisión" required html-for="inv-date" hint="Define el período tributario.">
              <input id="inv-date" v-model="form.issueDate" type="date" required />
            </FormField>

            <FormField label="Cuenta relacionada" html-for="inv-account" hint="Solo referencia. No afecta el saldo.">
              <select id="inv-account" v-model.number="form.accountId">
                <option :value="null">Sin cuenta vinculada</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ accountLabel(a) }}</option>
              </select>
            </FormField>

            <FormField label="Tarifa IVA" required html-for="inv-vatrate">
              <select id="inv-vatrate" v-model.number="form.vatRate" required>
                <option :value="15">15% (gravado)</option>
                <option :value="0">0% (exento / no objeto)</option>
              </select>
            </FormField>

            <FormField label="Estado" html-for="inv-status">
              <select id="inv-status" v-model="form.status">
                <option value="ISSUED">Emitida</option>
                <option value="PAID">Pagada</option>
                <option value="VOID">Anulada (no cuenta para IVA)</option>
              </select>
            </FormField>
          </div>

          <FormField label="Descripción" html-for="inv-desc">
            <input id="inv-desc" v-model="form.description" maxlength="200" placeholder="ej. Servicios de consultoría mayo" />
          </FormField>

          <!-- Resumen del cálculo en vivo -->
          <div class="calc-summary">
            <div class="calc-item">
              <small>Valor neto (USD) <span class="required-mark">*</span></small>
              <input v-model.number="form.netAmount" type="number" step="0.01" min="0" required class="calc-input" />
            </div>
            <div class="calc-item">
              <small>IVA ({{ form.vatRate }}%)</small>
              <strong>{{ formatMoney(formVat) }}</strong>
            </div>
            <div class="calc-item calc-total">
              <small>Total con IVA</small>
              <strong>{{ formatMoney(formTotal) }}</strong>
            </div>
          </div>

          <FormField label="Notas" html-for="inv-notes">
            <textarea id="inv-notes" v-model="form.notes" rows="2" placeholder="Observaciones…"></textarea>
          </FormField>

          <FormField label="Comprobante">
            <AttachmentUploader ref="attachRef" entity-type="INVOICE" :entity-id="editingId" />
          </FormField>

          <div class="form-actions">
            <AppButton v-if="editingId !== null" variant="ghost" @click="cancelEdit">
              <template #icon><X :size="16" /></template>Cancelar
            </AppButton>
            <AppButton type="submit" :loading="saving">
              <template #icon><component :is="editingId !== null ? Pencil : Plus" :size="16" /></template>
              {{ editingId !== null ? 'Guardar cambios' : 'Registrar factura' }}
            </AppButton>
          </div>
        </form>
      </PanelCard>

      <!-- Listado -->
      <PanelCard title="Listado" :hint="`${visibleRows.length} factura${visibleRows.length === 1 ? '' : 's'}`">
        <TabBar :tabs="TABS" v-model="activeTab" />
        <DataTable
          :columns="columns"
          :rows="visibleRows"
          :empty="{ icon: FileText, title: 'Sin facturas', text: 'Registra tu primera factura usando el formulario de arriba.' }"
        >
          <template #cell-kind="{ row }">
            <span :class="kindBadgeClass(row.kind)">
              <component :is="row.kind === 'SALE' ? ArrowUpRight : ArrowDownLeft" :size="12" />
              {{ KIND_LABEL[row.kind] }}
            </span>
          </template>

          <template #cell-doc="{ row }">
            <strong>{{ row.number || 'Sin número' }}</strong>
            <div><small class="hint">{{ row.counterparty }}<template v-if="row.counterpartyTaxId"> · {{ row.counterpartyTaxId }}</template></small></div>
            <div v-if="row.description"><small class="hint">{{ row.description }}</small></div>
          </template>

          <template #cell-date="{ row }">{{ fmtDate(row.issueDate) }}</template>
          <template #cell-net="{ row }">{{ formatMoney(row.netAmount) }}</template>
          <template #cell-vat="{ row }">
            {{ formatMoney(row.vatAmount) }}
            <div><small class="hint">{{ Number(row.vatRate) }}%</small></div>
          </template>
          <template #cell-total="{ row }"><strong>{{ formatMoney(row.total) }}</strong></template>
          <template #cell-status="{ row }">
            <span :class="statusBadgeClass(row.status)">{{ STATUS_LABEL[row.status] }}</span>
          </template>

          <template #actions="{ row }">
            <AppButton variant="ghost" mini :disabled="editingId === row.id" @click="startEdit(row)">
              <template #icon><Pencil :size="14" /></template>
            </AppButton>
            <AppButton variant="ghost" mini danger @click="onRemove(row)">
              <template #icon><Trash2 :size="14" /></template>
            </AppButton>
          </template>
        </DataTable>
      </PanelCard>
    </div>

    <!-- =================== TAB: DASHBOARD IVA =================== -->
    <div v-show="mainTab === 'dashboard'">
    <!-- Período seleccionado (controla el resumen y el dashboard) -->
    <PanelCard title="Liquidación de IVA">
      <template #actions>
        <div class="period-picker">
          <select v-model.number="period.month" aria-label="Mes">
            <option v-for="(m, i) in MONTHS" :key="i" :value="i + 1">{{ m }}</option>
          </select>
          <select v-model.number="period.year" aria-label="Año">
            <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}</option>
          </select>
        </div>
      </template>

      <div class="vat-grid">
        <div class="vat-card">
          <span class="vat-label">IVA cobrado (ventas)</span>
          <strong class="vat-value pos">{{ formatMoney(summary.sales.vat) }}</strong>
          <small>{{ summary.sales.count }} factura(s) · neto {{ formatMoney(summary.sales.net) }}</small>
        </div>
        <div class="vat-op">−</div>
        <div class="vat-card">
          <span class="vat-label">IVA crédito (compras)</span>
          <strong class="vat-value neg">{{ formatMoney(summary.purchases.vat) }}</strong>
          <small>{{ summary.purchases.count }} factura(s) · neto {{ formatMoney(summary.purchases.net) }}</small>
        </div>
        <div class="vat-op">=</div>
        <div class="vat-card vat-result" :class="summary.vatToPay > 0 ? 'to-pay' : 'credit'">
          <span class="vat-label">{{ summary.vatToPay > 0 ? 'IVA a pagar' : 'Crédito a favor' }}</span>
          <strong class="vat-value">{{ formatMoney(summary.vatToPay > 0 ? summary.vatToPay : summary.vatCredit) }}</strong>
          <small v-if="summary.vatToPay > 0">Se declara y paga en <strong>{{ summary.paymentLabel }}</strong></small>
          <small v-else>Se traslada al siguiente período</small>
        </div>
      </div>
    </PanelCard>

    <!-- Dashboard mensual de facturación -->
    <PanelCard title="Facturación mensual" :hint="`Últimos 12 meses · hasta ${MONTHS[period.month - 1]} ${period.year}`">
      <div class="month-kpis">
        <div class="mini-kpi">
          <span class="mini-kpi-label">Facturado en ventas (12 m)</span>
          <strong class="mini-kpi-value">{{ formatMoney(yearTotals.salesTotal) }}</strong>
        </div>
        <div class="mini-kpi">
          <span class="mini-kpi-label">IVA a pagar acumulado (12 m)</span>
          <strong class="mini-kpi-value">{{ formatMoney(yearTotals.vatToPay) }}</strong>
        </div>
      </div>

      <div class="chart-wrap">
        <Bar :data="chartData" :options="chartOptions" />
      </div>

      <div class="table-scroll month-table-wrap">
        <table class="recent-table">
          <thead>
            <tr>
              <th>Mes</th>
              <th class="center">Ventas (neto)</th>
              <th class="center">IVA ventas</th>
              <th class="center">Compras (neto)</th>
              <th class="center">IVA compras</th>
              <th class="center">IVA a pagar</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in monthlySeries" :key="b.key">
              <td><strong>{{ b.label }}</strong></td>
              <td class="center">{{ formatMoney(b.salesNet) }}</td>
              <td class="center">{{ formatMoney(b.salesVat) }}</td>
              <td class="center">{{ formatMoney(b.purchasesNet) }}</td>
              <td class="center">{{ formatMoney(b.purchasesVat) }}</td>
              <td class="center"><strong :class="{ 'to-pay-text': b.vatToPay > 0 }">{{ formatMoney(b.vatToPay) }}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </PanelCard>
    </div>
  </section>
</template>

<style scoped>
.required-mark { color: #ef4444; font-weight: 700; }
.period-picker { display: flex; gap: 8px; }
.period-picker select { padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 8px; background: white; }

/* Liquidación de IVA */
.vat-grid { display: flex; align-items: stretch; gap: 12px; flex-wrap: wrap; }
.vat-card { flex: 1; min-width: 180px; display: flex; flex-direction: column; gap: 2px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
.vat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
.vat-value { font-size: 22px; color: #0f172a; }
.vat-value.pos { color: #047857; }
.vat-value.neg { color: #b45309; }
.vat-card small { color: #64748b; font-size: 11px; }
.vat-op { display: flex; align-items: center; font-size: 24px; font-weight: 700; color: #94a3b8; }
.vat-result.to-pay { background: #fef2f2; border-color: #fecaca; }
.vat-result.to-pay .vat-value { color: #dc2626; }
.vat-result.credit { background: #ecfdf5; border-color: #a7f3d0; }
.vat-result.credit .vat-value { color: #047857; }

/* Dashboard mensual */
.month-kpis { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 12px; }
.mini-kpi { display: flex; flex-direction: column; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 12px; min-width: 180px; }
.mini-kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
.mini-kpi-value { font-size: 16px; margin-top: 2px; color: #0f172a; }
.chart-wrap { height: 280px; margin-bottom: 12px; }
.month-table-wrap { margin-top: 4px; }
.to-pay-text { color: #dc2626; }

/* Cálculo en vivo del formulario */
.calc-summary { display: flex; gap: 12px; align-items: flex-end; padding: 12px 14px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 12px; margin: 14px 0; flex-wrap: wrap; }
.calc-item { display: flex; flex-direction: column; gap: 4px; }
.calc-item small { color: #64748b; font-size: 12px; }
.calc-item strong { font-size: 16px; color: #0f172a; }
.calc-input { width: 140px; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; }
.calc-total strong { color: #2563eb; font-size: 18px; }

/* Badges */
.cat-pill.kind-sale { background: #ecfdf5; color: #047857; display: inline-flex; align-items: center; gap: 3px; }
.cat-pill.kind-purchase { background: #fff7ed; color: #c2410c; display: inline-flex; align-items: center; gap: 3px; }
.cat-pill.status-issued { background: #eff6ff; color: #1d4ed8; }
.cat-pill.status-paid { background: #ecfdf5; color: #047857; }
.cat-pill.status-void { background: #f1f5f9; color: #64748b; }
</style>
