<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { FileDown, FileSpreadsheet, TrendingUp, TrendingDown, Scale, BarChart3 } from 'lucide-vue-next';
import { http } from '../api/http';
import { useFormat } from '../composables/useFormat';
import { periodOptions as periodOpts } from '../composables/usePeriod';
import PageHeader from '../components/PageHeader.vue';

type CategoryRow = { type: string; categoryName: string; amount: number };
type Summary = { year: number; month: number; income: number; expense: number; balance: number; byCategory: CategoryRow[] };

const now = new Date();
const year = ref(now.getFullYear());
const month = ref(now.getMonth() + 1);
const summary = ref<Summary | null>(null);
const loading = ref(true);
const downloadingPdf = ref(false);
const downloadError = ref('');

const periodOptions = computed(() => periodOpts());
const selectedPeriod = computed({
  get: () => `${year.value}-${month.value}`,
  set: (val: string) => { const [y, m] = val.split('-').map(Number); year.value = y; month.value = m; load(); }
});

const { formatMoney } = useFormat();

const incomeRows = computed(() => summary.value?.byCategory.filter((row) => row.type === 'INCOME') ?? []);
const expenseRows = computed(() => summary.value?.byCategory.filter((row) => row.type === 'EXPENSE') ?? []);

async function load() {
  loading.value = true;
  const { data } = await http.get<Summary>('/movements/monthly-summary', { params: { year: year.value, month: month.value } });
  summary.value = data;
  loading.value = false;
}

async function downloadPdf() {
  downloadError.value = '';
  downloadingPdf.value = true;
  try {
    const response = await http.get('/reports/monthly.pdf', {
      params: { year: year.value, month: month.value },
      responseType: 'blob'
    });
    const blob = new Blob([response.data], { type: 'application/pdf' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte-${year.value}-${String(month.value).padStart(2, '0')}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    downloadError.value = err?.response?.data?.message || 'No se pudo descargar el PDF.';
  } finally {
    downloadingPdf.value = false;
  }
}

const downloadingXlsx = ref(false);
async function downloadXlsx() {
  downloadError.value = '';
  downloadingXlsx.value = true;
  try {
    const response = await http.get('/reports/monthly.xlsx', {
      params: { year: year.value, month: month.value },
      responseType: 'blob'
    });
    const blob = new Blob([response.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte-${year.value}-${String(month.value).padStart(2, '0')}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    downloadError.value = err?.response?.data?.message || 'No se pudo descargar el Excel.';
  } finally {
    downloadingXlsx.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Reportes" subtitle="Resumen mensual por categoría.">
      <template #actions>
        <select v-model="selectedPeriod" class="period-select" aria-label="Período">
          <option v-for="opt in periodOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <div class="export-group">
          <button type="button" class="ghost" :disabled="loading || downloadingPdf || downloadingXlsx || !summary" @click="downloadPdf">
            <FileDown :size="16" />
            {{ downloadingPdf ? 'Generando…' : 'PDF' }}
          </button>
          <button type="button" class="ghost" :disabled="loading || downloadingPdf || downloadingXlsx || !summary" @click="downloadXlsx">
            <FileSpreadsheet :size="16" />
            {{ downloadingXlsx ? 'Generando…' : 'Excel' }}
          </button>
        </div>
      </template>
    </PageHeader>

    <p v-if="downloadError" class="error">{{ downloadError }}</p>
    <p v-if="loading" class="dash-loading">Cargando...</p>

    <template v-else-if="summary">
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-card-top">
            <div class="kpi-icon kpi-icon-income"><TrendingUp :size="22" /></div>
          </div>
          <span class="kpi-label">Ingresos del mes</span>
          <strong class="kpi-value income">{{ formatMoney(summary.income) }}</strong>
        </div>
        <div class="kpi-card">
          <div class="kpi-card-top">
            <div class="kpi-icon kpi-icon-expense"><TrendingDown :size="22" /></div>
          </div>
          <span class="kpi-label">Gastos del mes</span>
          <strong class="kpi-value expense">{{ formatMoney(summary.expense) }}</strong>
        </div>
        <div class="kpi-card">
          <div class="kpi-card-top">
            <div class="kpi-icon kpi-icon-balance"><Scale :size="22" /></div>
          </div>
          <span class="kpi-label">Balance del mes</span>
          <strong class="kpi-value balance">{{ formatMoney(summary.balance) }}</strong>
        </div>
      </div>

      <div class="row-2">
        <div class="panel">
          <div class="panel-header"><h2>Ingresos por categoría</h2></div>
          <table class="recent-table">
            <thead><tr><th>Categoría</th><th class="right">Monto</th></tr></thead>
            <tbody>
              <tr v-for="row in incomeRows" :key="'i-' + row.categoryName"><td>{{ row.categoryName }}</td><td class="right pos">{{ formatMoney(row.amount) }}</td></tr>
              <tr v-if="!incomeRows.length"><td colspan="2">
                <div class="empty-state">
                  <div class="empty-state-illustration"><TrendingUp :size="32" /></div>
                  <strong>Sin ingresos en el mes</strong>
                  <p>Cuando registres ingresos aparecerán agrupados aquí.</p>
                </div>
              </td></tr>
            </tbody>
          </table>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>Gastos por categoría</h2></div>
          <table class="recent-table">
            <thead><tr><th>Categoría</th><th class="right">Monto</th></tr></thead>
            <tbody>
              <tr v-for="row in expenseRows" :key="'e-' + row.categoryName"><td>{{ row.categoryName }}</td><td class="right neg">{{ formatMoney(row.amount) }}</td></tr>
              <tr v-if="!expenseRows.length"><td colspan="2">
                <div class="empty-state">
                  <div class="empty-state-illustration"><TrendingDown :size="32" /></div>
                  <strong>Sin gastos en el mes</strong>
                  <p>Cuando registres gastos aparecerán agrupados aquí.</p>
                </div>
              </td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.export-group { display: inline-flex; gap: 8px; }
@media (max-width: 600px) {
  .export-group { flex: 1; }
  .export-group .ghost { flex: 1; padding: 0 12px; }
}
</style>
