<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
import { FileText, Pencil, Trash2, Plus, X, ArrowUpRight, ArrowDownLeft, Upload } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import FormField from '../components/FormField.vue';
import AppButton from '../components/AppButton.vue';
import DataTable, { type Column } from '../components/DataTable.vue';
import TabBar from '../components/TabBar.vue';
import AttachmentUploader from '../components/AttachmentUploader.vue';
import InvoiceImportModal from '../components/InvoiceImportModal.vue';
import { http } from '../api/http';
import { useCrud } from '../composables/useCrud';
import { useConfirm } from '../composables/useConfirm';
import { useFormat } from '../composables/useFormat';
import { usePermissions } from '../composables/usePermissions';
import { yearOptions as periodYears, monthsForYear, START_YEAR, START_MONTH } from '../composables/usePeriod';
import { useEntitiesStore } from '../stores/entities';
import { invoicesApi } from '../api/invoices';
import type { Invoice, InvoiceKind, InvoiceStatus, InvoicePayload } from '../types';

ChartJS.register(Title, Tooltip, Legend, BarElement, CategoryScale, LinearScale);

const { formatMoney } = useFormat();
const { alert } = useConfirm();
const { canWrite } = usePermissions('invoices');
const entities = useEntitiesStore();
const accounts = computed(() => entities.accounts);
const entityList = ref<{ id: number; name: string; kind: 'PERSONAL' | 'BUSINESS' }[]>([]);
async function loadEntities() { entityList.value = (await http.get<typeof entityList.value>('/entities')).data; }

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
const yearOptions = computed(() => periodYears(new Date(), periodStart.value.year));
// Meses válidos según el año (en el año de inicio, solo desde el mes de inicio).
const monthOptions = computed(() => monthsForYear(period.value.year, periodStart.value.year, periodStart.value.month));
// Si al cambiar de año el mes queda fuera del rango permitido, se ajusta al mínimo válido.
watch(() => period.value.year, () => {
  if (!monthOptions.value.some((m) => m.value === period.value.month)) {
    period.value.month = monthOptions.value[0]?.value ?? period.value.month;
  }
});

// ---- CRUD genérico (igual que Cuentas) ----
const crud = useCrud<Invoice, InvoicePayload>({
  service: invoicesApi,
  // El 409 explica qué dato del comprobante está bloqueado.
  onSaveError: async (err) => {
    const response = (err as { response?: { status?: number; data?: { message?: unknown } } }).response;
    const message = response?.data?.message;
    if (response?.status !== 409 || typeof message !== 'string' || !message) return false;
    await alert(message, 'No se pudo guardar');
    return true;
  },
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
    entityId: null,
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
    entityId: i.entityId ?? null,
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
    entityId: f.entityId || null,
    description: (f.description || '').trim() || null,
    notes: (f.notes || '').trim() || null
  }),
  validate: (f) => {
    if (!f.counterparty.trim()) return f.kind === 'SALE' ? 'El cliente es obligatorio.' : 'El proveedor es obligatorio.';
    // El neto de un comprobante importado no se edita: exigirlo impediría cambiar el resto.
    if (!editingImported.value && !(Number(f.netAmount) > 0)) return 'El valor neto debe ser mayor a 0.';
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
// (una factura importada muestra lo guardado: su IVA y total salen del comprobante, no de neto × tarifa)
const editingInvoice = computed(() => (editingId.value === null ? null : rows.value.find((r) => r.id === editingId.value) ?? null));
const editingImported = computed(() => editingInvoice.value?.source === 'SRI_XML');
const importedInvoice = computed(() => (editingImported.value ? editingInvoice.value : null));
const formVat = computed(() => importedInvoice.value
  ? Number(importedInvoice.value.vatAmount)
  : round2(Number(form.value.netAmount || 0) * (Number(form.value.vatRate || 0) / 100)));
const formTotal = computed(() => importedInvoice.value
  ? Number(importedInvoice.value.total)
  : round2(Number(form.value.netAmount || 0) + formVat.value));
const hasManyRates = (i: Invoice | null) => (i?.vatLines?.length ?? 0) > 1;
// Tarifas de comprobantes antiguos (12 %, 5 %…) que el selector no ofrece.
const importedRateOutOfList = computed(() => editingImported.value && ![0, 15].includes(Number(form.value.vatRate)));

// ---- Helpers de período (robustos a zona horaria: usamos la cadena YYYY-MM) ----
const ym = (iso: string) => String(iso).slice(0, 7); // "YYYY-MM"
const periodKey = computed(() => `${period.value.year}-${pad2(period.value.month)}`);

// Normalmente desde mayo 2026, pero una factura importada puede ser anterior y debe poder liquidarse.
const periodStart = computed(() => {
  let oldest = `${START_YEAR}-${pad2(START_MONTH)}`;
  for (const r of rows.value) {
    const key = ym(r.issueDate);
    if (/^\d{4}-\d{2}$/.test(key) && key < oldest) oldest = key;
  }
  return { year: Number(oldest.slice(0, 4)), month: Number(oldest.slice(5, 7)) };
});
// Si se elimina la factura más antigua, el período elegido puede quedar fuera del rango.
watch(periodStart, (start) => {
  if (period.value.year < start.year || (period.value.year === start.year && period.value.month < start.month)) {
    period.value = { year: start.year, month: start.month };
  }
});

const validRows = computed(() => rows.value.filter((r) => r.status !== 'VOID'));

// ---- Resumen de IVA del mes seleccionado ----
const summary = computed(() => {
  let salesNet = 0, salesVat = 0, salesTotal = 0, salesCount = 0;
  let purchasesNet = 0, purchasesVat = 0, purchasesTotal = 0, purchasesCount = 0;
  for (const r of validRows.value) {
    if (ym(r.issueDate) !== periodKey.value) continue;
    if (r.kind === 'SALE') {
      salesNet += Number(r.netAmount); salesVat += Number(r.vatAmount); salesTotal += Number(r.total); salesCount++;
    } else {
      purchasesNet += Number(r.netAmount); purchasesVat += Number(r.vatAmount); purchasesTotal += Number(r.total); purchasesCount++;
    }
  }
  const pay = new Date(period.value.year, period.value.month, 1); // mes siguiente
  return {
    sales: { net: salesNet, vat: salesVat, total: round2(salesTotal), count: salesCount },
    purchases: { net: purchasesNet, vat: purchasesVat, total: round2(purchasesTotal), count: purchasesCount },
    // Se liquida por razón social: el crédito de una no compensa lo que debe otra.
    vatToPay: round2(vatByEntity.value.reduce((sum, e) => sum + e.vatToPay, 0)),
    vatCredit: round2(vatByEntity.value.reduce((sum, e) => sum + e.vatCredit, 0)),
    paymentLabel: `${MONTHS[pay.getMonth()]} ${pay.getFullYear()}`
  };
});

// IVA del período desglosado por razón social (cuánto declara/paga cada entidad).
const vatByEntity = computed(() => {
  const map = new Map<number, { name: string; salesVat: number; purchasesVat: number }>();
  for (const r of validRows.value) {
    if (ym(r.issueDate) !== periodKey.value) continue;
    const key = r.entity?.id ?? -1;
    let row = map.get(key);
    if (!row) { row = { name: r.entity?.name ?? 'Sin razón social', salesVat: 0, purchasesVat: 0 }; map.set(key, row); }
    if (r.kind === 'SALE') row.salesVat += Number(r.vatAmount); else row.purchasesVat += Number(r.vatAmount);
  }
  return [...map.values()].map((e) => {
    const net = round2(e.salesVat - e.purchasesVat);
    return { name: e.name, salesVat: round2(e.salesVat), purchasesVat: round2(e.purchasesVat), vatToPay: net > 0 ? net : 0, vatCredit: net < 0 ? round2(-net) : 0 };
  }).sort((a, b) => b.vatToPay - a.vatToPay);
});

// ---- Serie mensual (12 meses terminando en el período seleccionado) ----
// Lo facturado sale del total guardado: neto + IVA no recoge los otros cargos de un comprobante.
const monthlySeries = computed(() => {
  const buckets: Array<{ key: string; label: string; salesNet: number; salesVat: number; salesGross: number; purchasesNet: number; purchasesVat: number }> = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(period.value.year, period.value.month - 1 - i, 1);
    const y = d.getFullYear(), mo = d.getMonth() + 1;
    // No mostrar meses anteriores al inicio (mayo 2026 o la factura más antigua).
    if (y < periodStart.value.year || (y === periodStart.value.year && mo < periodStart.value.month)) continue;
    buckets.push({
      key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
      label: `${MONTH_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
      salesNet: 0, salesVat: 0, salesGross: 0, purchasesNet: 0, purchasesVat: 0
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const balances = new Map<string, Map<number, number>>(); // por mes y razón social
  for (const r of validRows.value) {
    const b = byKey.get(ym(r.issueDate));
    if (!b) continue;
    const entityKey = r.entity?.id ?? -1;
    const monthBalances = balances.get(b.key) ?? new Map<number, number>();
    balances.set(b.key, monthBalances);
    monthBalances.set(entityKey, (monthBalances.get(entityKey) ?? 0) + (r.kind === 'SALE' ? 1 : -1) * Number(r.vatAmount));
    if (r.kind === 'SALE') { b.salesNet += Number(r.netAmount); b.salesVat += Number(r.vatAmount); b.salesGross += Number(r.total); }
    else { b.purchasesNet += Number(r.netAmount); b.purchasesVat += Number(r.vatAmount); }
  }
  return buckets.map((b) => ({
    ...b,
    salesTotal: round2(b.salesGross),
    vatToPay: round2([...(balances.get(b.key)?.values() ?? [])].reduce((sum, net) => sum + Math.max(0, round2(net)), 0))
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

// ---- Importación desde XML del SRI ----
const importOpen = ref(false);
const accountOptions = computed(() => accounts.value.map((a) => ({ id: a.id, label: accountLabel(a) })));

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

// Deep-link: /invoices?open=<id> abre esa factura (desde el lector de correo).
const route = useRoute();
const router = useRouter();
async function openInvoiceFromQuery() {
  const raw = route.query.open;
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!id) return;
  const q = { ...route.query }; delete q.open;
  router.replace({ query: q });
  const row = rows.value.find((r) => r.id === id);
  if (!row) return;
  startEdit(row);
  await nextTick();
  document.getElementById('inv-number')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

onMounted(async () => {
  await Promise.all([load(), loadEntities(), entities.ensureAccounts()]);
  await openInvoiceFromQuery();
});
watch(() => route.query.open, () => { openInvoiceFromQuery(); });
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Facturas e IVA" subtitle="Registra tus facturas de ventas y compras, y calcula el IVA a pagar al SRI.">
      <template v-if="canWrite()" #actions>
        <AppButton @click="importOpen = true">
          <template #icon><Upload :size="16" /></template>Subir XML
        </AppButton>
      </template>
    </PageHeader>

    <TabBar :tabs="MAIN_TABS" v-model="mainTab" />

    <!-- =================== TAB: REGISTRAR FACTURAS =================== -->
    <div v-show="mainTab === 'invoices'" class="stack">
      <!-- Formulario -->
      <PanelCard :title="editingId !== null ? 'Editar factura' : 'Nueva factura'">
        <form class="form" @submit.prevent="onSave">
          <p v-if="editingImported" class="imported-note">Datos del comprobante: no se editan</p>
          <div class="form-grid">
            <FormField label="Tipo" required html-for="inv-kind"
                       :hint="form.kind === 'SALE' ? 'Tú emites la factura (IVA cobrado).' : 'Recibes la factura de un proveedor (IVA crédito).'">
              <select id="inv-kind" v-model="form.kind" required :disabled="editingImported">
                <option value="SALE">Venta (emitida)</option>
                <option value="PURCHASE">Compra (recibida)</option>
              </select>
            </FormField>

            <FormField label="Nº de factura" html-for="inv-number" hint="Número o autorización SRI. Opcional.">
              <input id="inv-number" v-model="form.number" :disabled="editingImported" maxlength="60" placeholder="ej. 001-001-000001234" />
            </FormField>

            <FormField :label="form.kind === 'SALE' ? 'Cliente' : 'Proveedor'" required html-for="inv-counterparty">
              <input id="inv-counterparty" v-model="form.counterparty" required maxlength="160"
                     :placeholder="form.kind === 'SALE' ? 'ej. Comercial XYZ S.A.' : 'ej. Distribuidora ABC'" />
            </FormField>

            <FormField label="RUC / Cédula" html-for="inv-ruc" hint="Opcional.">
              <input id="inv-ruc" v-model="form.counterpartyTaxId" :disabled="editingImported" maxlength="20" placeholder="ej. 1790012345001" />
            </FormField>

            <FormField label="Fecha de emisión" required html-for="inv-date" hint="Define el período tributario.">
              <input id="inv-date" v-model="form.issueDate" type="date" required :disabled="editingImported" />
            </FormField>

            <FormField label="Cuenta relacionada" html-for="inv-account" hint="Solo referencia. No afecta el saldo.">
              <select id="inv-account" v-model.number="form.accountId">
                <option :value="null">Sin cuenta vinculada</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ accountLabel(a) }}</option>
              </select>
            </FormField>

            <FormField label="Razón social" html-for="inv-entity" hint="Para saber el IVA por entidad.">
              <select id="inv-entity" v-model.number="form.entityId">
                <option :value="null">Sin razón social</option>
                <option v-for="e in entityList" :key="e.id" :value="e.id">{{ e.name }}</option>
              </select>
            </FormField>

            <FormField label="Tarifa IVA" required html-for="inv-vatrate">
              <select id="inv-vatrate" v-model.number="form.vatRate" required :disabled="editingImported">
                <option v-if="importedRateOutOfList" :value="form.vatRate">{{ form.vatRate }}%</option>
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
              <input v-model.number="form.netAmount" type="number" step="0.01" min="0" required class="calc-input" :disabled="editingImported" />
            </div>
            <div class="calc-item">
              <small>{{ hasManyRates(importedInvoice) ? 'IVA' : `IVA (${form.vatRate}%)` }}</small>
              <strong>{{ formatMoney(formVat) }}</strong>
            </div>
            <div v-if="importedInvoice && Number(importedInvoice.discount || 0) !== 0" class="calc-item">
              <small>Descuento</small>
              <strong>{{ formatMoney(importedInvoice.discount) }}</strong>
            </div>
            <div v-if="importedInvoice && Number(importedInvoice.otherCharges || 0) !== 0" class="calc-item">
              <small>Otros cargos</small>
              <strong>{{ formatMoney(importedInvoice.otherCharges) }}</strong>
            </div>
            <div class="calc-item calc-total">
              <small>{{ importedInvoice ? 'Total del comprobante' : 'Total con IVA' }}</small>
              <strong>{{ formatMoney(formTotal) }}</strong>
            </div>
          </div>
          <ul v-if="importedInvoice && hasManyRates(importedInvoice)" class="vat-breakdown">
            <li v-for="(line, i) in importedInvoice.vatLines" :key="i">
              {{ Number(line.rate) }}%: base {{ formatMoney(line.base) }}, IVA {{ formatMoney(line.vat) }}
            </li>
          </ul>

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
            <span v-if="row.source === 'SRI_XML'" class="source-tag" :title="row.accessKey ? `Clave de acceso: ${row.accessKey}` : undefined">XML SRI</span>
            <div><small class="hint">{{ row.counterparty }}<template v-if="row.counterpartyTaxId"> · {{ row.counterpartyTaxId }}</template></small></div>
            <div v-if="row.description"><small class="hint">{{ row.description }}</small></div>
          </template>

          <template #cell-date="{ row }">{{ fmtDate(row.issueDate) }}</template>
          <template #cell-net="{ row }">{{ formatMoney(row.netAmount) }}</template>
          <template #cell-vat="{ row }">
            {{ formatMoney(row.vatAmount) }}
            <div><small class="hint">{{ hasManyRates(row) ? 'Varias tarifas' : `${Number(row.vatRate)}%` }}</small></div>
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
            <option v-for="m in monthOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
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
          <small v-if="summary.vatToPay > 0 && summary.vatCredit > 0" class="vat-note">
            Hay {{ formatMoney(summary.vatCredit) }} de crédito en otra razón social o sin razón social: no reduce este pago.
          </small>
        </div>
      </div>

      <div v-if="vatByEntity.length" class="vat-entities" style="margin-top:16px">
        <h3 style="font-size:14px;font-weight:700;color:#334155;margin:0 0 8px">IVA por razón social — {{ MONTHS[period.month - 1] }} {{ period.year }}</h3>
        <table class="recent-table">
          <thead>
            <tr><th>Razón social</th><th class="right">IVA ventas</th><th class="right">IVA compras</th><th class="right">IVA a pagar</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in vatByEntity" :key="e.name">
              <td><strong>{{ e.name }}</strong></td>
              <td class="right pos">{{ formatMoney(e.salesVat) }}</td>
              <td class="right neg">{{ formatMoney(e.purchasesVat) }}</td>
              <td class="right"><strong :class="e.vatToPay > 0 ? 'neg' : 'pos'">{{ e.vatToPay > 0 ? formatMoney(e.vatToPay) : (e.vatCredit > 0 ? '−' + formatMoney(e.vatCredit) : formatMoney(0)) }}</strong></td>
            </tr>
          </tbody>
        </table>
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

    <InvoiceImportModal
      v-if="canWrite()"
      :open="importOpen"
      :entities="entityList"
      :accounts="accountOptions"
      @close="importOpen = false"
      @imported="load"
    />
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
.vat-card small.vat-note { display: block; margin-top: 4px; }
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

/* Facturas importadas desde XML */
.imported-note { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: #64748b; }
.vat-breakdown { list-style: none; margin: -6px 0 14px; padding: 0 14px; font-size: 12px; color: #64748b; }
.source-tag { margin-left: 6px; padding: 1px 6px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 10px; font-weight: 600; color: #64748b; white-space: nowrap; }

/* Badges */
.cat-pill.kind-sale { background: #ecfdf5; color: #047857; display: inline-flex; align-items: center; gap: 3px; }
.cat-pill.kind-purchase { background: #fff7ed; color: #c2410c; display: inline-flex; align-items: center; gap: 3px; }
.cat-pill.status-issued { background: #eff6ff; color: #1d4ed8; }
.cat-pill.status-paid { background: #ecfdf5; color: #047857; }
.cat-pill.status-void { background: #f1f5f9; color: #64748b; }
</style>
