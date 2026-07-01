<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { Bar, Doughnut } from 'vue-chartjs';
import {
  Chart as ChartJS,
  Title,
  Tooltip,
  Legend,
  BarElement,
  CategoryScale,
  LinearScale,
  ArcElement
} from 'chart.js';
import { http } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useFormat } from '../composables/useFormat';
import { periodOptions as periodOpts, MONTH_NAMES, START_YEAR, START_MONTH } from '../composables/usePeriod';
import OnboardingGuide from '../components/OnboardingGuide.vue';
import PageHeader from '../components/PageHeader.vue';
import {
  TrendingUp,
  TrendingDown,
  Scale,
  Wallet,
  Banknote,
  CreditCard,
  ReceiptText,
  Repeat,
  Landmark,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  ChevronRight,
  PieChart,
  BarChart3
} from 'lucide-vue-next';

ChartJS.register(Title, Tooltip, Legend, BarElement, CategoryScale, LinearScale, ArcElement);

type Kpis = {
  income: number;
  expense: number;
  balance: number;
  prevIncome: number;
  prevExpense: number;
  prevBalance: number;
  debtTotal: number;
  debtCount: number;
};

type SeriesPoint = { key: string; label: string; income: number; expense: number };

type CategoryRow = { categoryId: number | null; name: string; color: string; amount: number };

type MovementKind = 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'WITHDRAWAL' | 'PURCHASE' | 'CARD_PAYMENT' | 'ADJUSTMENT';
type Movement = {
  id: number;
  date: string;
  description: string;
  type: MovementKind;
  paymentMethod: string;
  isCredit?: boolean;
  amount: number;
  category: { id: number; name: string; color: string | null } | null;
  account: { id: number; name: string; type: string } | null;
  card: { id: number; name: string; type: string } | null;
};

type AccountRow = { id: number; name: string; type: string; bankName: string | null; currentBalance: number };
type CardRow = { id: number; name: string; type: string; bankName: string | null; last4: string | null; creditLimit: number | null; currentBalance: number; cutoffDay: number | null; paymentDueDay: number | null; available: number | null };
type DebtsBlock = { payable: { total: number; count: number }; receivable: { total: number; count: number }; loan: { total: number; count: number }; activeCount: number; activeTotal: number };

type DashboardPayload = {
  period: { year: number; month: number; label: string };
  kpis: Kpis;
  monthlySeries: SeriesPoint[];
  expenseByCategory: CategoryRow[];
  recentMovements: Movement[];
  accounts: AccountRow[];
  cards: CardRow[];
  debts: DebtsBlock;
  recurring: { monthlyEstimated: number; activeCount: number };
};

const auth = useAuthStore();
const userFirstName = computed(() => {
  const full = auth.user?.name || '';
  return full.split(' ')[0] || 'usuario';
});
const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
});

const now = new Date();
const year = ref(now.getFullYear());
const month = ref(now.getMonth() + 1);
const data = ref<DashboardPayload | null>(null);
const loading = ref(true);
const error = ref('');

// Período unificado (desde mayo 2026 hasta el mes actual).
const periodOptions = computed(() => periodOpts());

const selectedPeriod = computed({
  get: () => `${year.value}-${month.value}`,
  set: (val: string) => {
    const [y, m] = val.split('-').map(Number);
    year.value = y;
    month.value = m;
    load();
  }
});

const { formatMoney } = useFormat();

function pctChange(curr: number, prev: number) {
  if (!prev) return curr ? 100 : 0;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

const incomeChange = computed(() => data.value ? pctChange(data.value.kpis.income, data.value.kpis.prevIncome) : 0);
const expenseChange = computed(() => data.value ? pctChange(data.value.kpis.expense, data.value.kpis.prevExpense) : 0);
const balanceChange = computed(() => data.value ? pctChange(data.value.kpis.balance, data.value.kpis.prevBalance) : 0);

const prevLabel = computed(() => {
  const ref = new Date(Date.UTC(year.value, month.value - 2, 1));
  return `${MONTH_NAMES[ref.getUTCMonth()]} ${ref.getUTCFullYear()}`;
});

const totalExpenseCategoryAmount = computed(() => (data.value?.expenseByCategory || []).reduce((acc, c) => acc + c.amount, 0));

// --- Vista del gráfico: mensual (últimos meses) o semanal (mes en curso) ---
const chartMode = ref<'monthly' | 'weekly'>('monthly');
const monthMovements = ref<{ date: string; type: string; amount: number; isCredit?: boolean }[]>([]);

// Desglose semanal del mes seleccionado (semanas por día: 1-7, 8-14, 15-21, 22-28, 29+).
const weeklySeries = computed(() => {
  const weeks = [
    { label: 'Sem 1', sub: '1–7', income: 0, expense: 0 },
    { label: 'Sem 2', sub: '8–14', income: 0, expense: 0 },
    { label: 'Sem 3', sub: '15–21', income: 0, expense: 0 },
    { label: 'Sem 4', sub: '22–28', income: 0, expense: 0 },
    { label: 'Sem 5', sub: '29–31', income: 0, expense: 0 }
  ];
  for (const m of monthMovements.value) {
    const day = new Date(m.date).getUTCDate();
    const idx = Math.min(4, Math.floor((day - 1) / 7));
    const amt = Number(m.amount || 0);
    if (m.type === 'INCOME') weeks[idx].income += amt;
    else if (m.type === 'EXPENSE' || m.type === 'WITHDRAWAL') weeks[idx].expense += amt;
    else if (m.type === 'PURCHASE' && !m.isCredit) weeks[idx].expense += amt;
  }
  return weeks;
});
const topExpenseWeek = computed(() => weeklySeries.value.slice().sort((a, b) => b.expense - a.expense)[0] || null);
const hasWeeklyData = computed(() => weeklySeries.value.some((w) => w.income > 0 || w.expense > 0));

const barChartData = computed(() => {
  if (chartMode.value === 'weekly') {
    const w = weeklySeries.value;
    return {
      labels: w.map((x) => `${x.label} (${x.sub})`),
      datasets: [
        { label: 'Ingresos', data: w.map((x) => x.income), backgroundColor: '#16a34a', borderRadius: 6 },
        { label: 'Gastos', data: w.map((x) => x.expense), backgroundColor: '#ef4444', borderRadius: 6 }
      ]
    };
  }
  return {
    labels: (data.value?.monthlySeries || []).map((p) => p.label),
    datasets: [
      { label: 'Ingresos', data: (data.value?.monthlySeries || []).map((p) => p.income), backgroundColor: '#16a34a', borderRadius: 6 },
      { label: 'Gastos', data: (data.value?.monthlySeries || []).map((p) => p.expense), backgroundColor: '#ef4444', borderRadius: 6 }
    ]
  };
});
const chartHasData = computed(() => chartMode.value === 'weekly' ? hasWeeklyData.value : hasMonthlyData.value);

const barChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { position: 'top' as const, align: 'start' as const, labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle' as const, color: '#475569' } },
    tooltip: { callbacks: { label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) => ` ${ctx.dataset.label}: ${formatMoney(ctx.parsed.y ?? 0)}` } }
  },
  scales: {
    x: { grid: { display: false }, ticks: { color: '#64748b', maxRotation: 0, autoSkip: true } },
    y: {
      beginAtZero: true,
      suggestedMax: 100,
      grid: { color: '#e2e8f0' },
      ticks: {
        color: '#64748b',
        precision: 0,
        callback: (v: number | string) => {
          const n = Number(v);
          if (n >= 1000) return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
          return `$${n.toLocaleString('en-US')}`;
        }
      }
    }
  }
};

const hasMonthlyData = computed(() => {
  const series = data.value?.monthlySeries || [];
  return series.some((p) => Number(p.income) > 0 || Number(p.expense) > 0);
});

// --- Comparativa Ingresos vs Gastos (últimos meses de monthlySeries) ---
// No mostramos meses anteriores al inicio del sistema (mayo 2026): el histórico arranca ahí.
const comparison = computed(() =>
  (data.value?.monthlySeries || [])
    .filter((p) => {
      const [y, m] = String(p.key).split('-').map(Number);
      return y > START_YEAR || (y === START_YEAR && m >= START_MONTH);
    })
    .map((p) => {
      const income = Number(p.income || 0);
      const expense = Number(p.expense || 0);
      const balance = income - expense;
      const savings = income > 0 ? (balance / income) * 100 : 0;
      return { label: p.label, income, expense, balance, savings };
    })
);
const comparisonMax = computed(() =>
  Math.max(1, ...comparison.value.map((r) => Math.max(r.income, r.expense)))
);
const comparisonTotals = computed(() => {
  const c = comparison.value;
  const income = c.reduce((a, r) => a + r.income, 0);
  const expense = c.reduce((a, r) => a + r.expense, 0);
  const balance = income - expense;
  const months = c.length || 1;
  const savings = income > 0 ? (balance / income) * 100 : 0;
  return { income, expense, balance, savings, avgIncome: income / months, avgExpense: expense / months, months: c.length };
});
const barPct = (v: number) => `${Math.min(100, (v / comparisonMax.value) * 100)}%`;

const doughnutData = computed(() => ({
  labels: (data.value?.expenseByCategory || []).map((c) => c.name),
  datasets: [{
    data: (data.value?.expenseByCategory || []).map((c) => c.amount),
    backgroundColor: (data.value?.expenseByCategory || []).map((c) => c.color),
    borderWidth: 0,
    cutout: '70%'
  }]
}));

const doughnutOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } }
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [{ data: payload }, mv] = await Promise.all([
      http.get<DashboardPayload>('/dashboard', { params: { year: year.value, month: month.value } }),
      http.get<{ movementDate: string; type: string; amount: number | string; isCredit?: boolean }[]>('/movements', { params: { year: year.value, month: month.value } })
    ]);
    data.value = payload;
    monthMovements.value = (mv.data || []).map((m) => ({ date: m.movementDate, type: m.type, amount: Number(m.amount || 0), isCredit: m.isCredit }));
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Error cargando el dashboard';
  } finally {
    loading.value = false;
  }
}

// Refresco en tiempo real: al volver a la pestaña/ventana, recarga el dashboard.
let lastRefresh = 0;
function onFocusRefresh() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const t = Date.now();
  if (t - lastRefresh < 4000) return;
  lastRefresh = t;
  load();
}

onMounted(() => {
  load();
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocusRefresh);
    document.addEventListener('visibilitychange', onFocusRefresh);
  }
});
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', onFocusRefresh);
    document.removeEventListener('visibilitychange', onFocusRefresh);
  }
});

const PAYMENT_LABEL: Record<string, string> = {
  CASH: 'Efectivo',
  BANK_TRANSFER: 'Banco',
  DEBIT_CARD: 'Débito',
  CREDIT_CARD: 'Tarjeta de crédito',
  WALLET: 'Billetera',
  OTHER: 'Otro'
};

const ACCOUNT_LABEL: Record<string, string> = {
  CASH: 'Efectivo',
  BANK: 'Banco',
  WALLET: 'Billetera',
  DEBIT: 'Débito',
  RECEIVABLE: 'Por cobrar'
};

function paymentLabel(method: string) { return PAYMENT_LABEL[method] || method; }

// --- Coherencia por tipo de movimiento (igual que la tabla de Movimientos) ---
const TYPE_ICON: Record<string, string> = { INCOME: '💵', EXPENSE: '🛒', TRANSFER: '🔁', WITHDRAWAL: '🏧', PURCHASE: '🛍️', CARD_PAYMENT: '💳', ADJUSTMENT: '⚖️' };
const TYPE_LABEL: Record<string, string> = { INCOME: 'Ingreso', EXPENSE: 'Gasto', TRANSFER: 'Transferencia', WITHDRAWAL: 'Retiro', PURCHASE: 'Compra', CARD_PAYMENT: 'Pago de tarjeta', ADJUSTMENT: 'Ajuste' };
function methodCell(row: Movement): string {
  if (row.type === 'WITHDRAWAL') return 'Retiro de efectivo';
  if (row.type === 'TRANSFER') return 'Transferencia entre cuentas';
  if (row.type === 'CARD_PAYMENT') return 'Pago de tarjeta';
  if (row.type === 'ADJUSTMENT') return 'Ajuste de saldo';
  return PAYMENT_LABEL[row.paymentMethod] || row.paymentMethod;
}
function rowAmount(row: Movement): { text: string; cls: string } {
  const m = formatMoney(row.amount);
  if (row.type === 'INCOME') return { text: `+${m}`, cls: 'pos' };
  if (row.type === 'EXPENSE' || row.type === 'WITHDRAWAL' || row.type === 'CARD_PAYMENT') return { text: `-${m}`, cls: 'neg' };
  if (row.type === 'PURCHASE') return { text: (row.isCredit ? '' : '-') + m, cls: row.isCredit ? '' : 'neg' };
  if (row.type === 'ADJUSTMENT') return { text: (row.isCredit ? '+' : '-') + m, cls: row.isCredit ? 'pos' : 'neg' };
  return { text: m, cls: '' }; // TRANSFER
}
function accountTypeLabel(type: string) { return ACCOUNT_LABEL[type] || type; }
const { formatDate } = useFormat();
function formatChange(value: number) {
  const sign = value >= 0 ? '↑' : '↓';
  return `${sign} ${Math.abs(value).toFixed(1)}%`;
}
function pctOfTotal(amount: number) {
  const total = totalExpenseCategoryAmount.value;
  if (!total) return '0.0%';
  return `${((amount / total) * 100).toFixed(1)}%`;
}
function accountIcon(type: string) {
  if (type === 'CASH') return '💵';
  if (type === 'BANK') return '🏦';
  if (type === 'WALLET') return '👛';
  if (type === 'DEBIT') return '💳';
  if (type === 'RECEIVABLE') return '🧾';
  return '🏷️';
}
</script>

<template>
  <section class="dashboard">
    <PageHeader :title="`${greeting}, ${userFirstName} 👋`" :subtitle="`Así están tus finanzas en ${MONTH_NAMES[month - 1]} ${year}.`">
      <template #actions>
        <select v-model="selectedPeriod" class="period-select" aria-label="Período">
          <option v-for="opt in periodOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </template>
    </PageHeader>

    <OnboardingGuide />

    <p v-if="loading" class="dash-loading">Cargando dashboard...</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-else-if="data">
      <div class="quick-grid">
        <RouterLink to="/debts?kind=RECEIVABLE" class="quick-card quick-receivable">
          <div class="quick-icon"><Banknote /></div>
          <div class="quick-body">
            <small>Por cobrar</small>
            <strong>{{ formatMoney(data.debts.receivable.total) }}</strong>
            <span>{{ data.debts.receivable.count }} pendiente{{ data.debts.receivable.count === 1 ? '' : 's' }}</span>
          </div>
          <span class="quick-arrow"><ChevronRight :size="18" /></span>
        </RouterLink>

        <RouterLink to="/debts?kind=PAYABLE" class="quick-card quick-payable">
          <div class="quick-icon"><ReceiptText /></div>
          <div class="quick-body">
            <small>Por pagar</small>
            <strong>{{ formatMoney(data.debts.payable.total) }}</strong>
            <span>{{ data.debts.payable.count }} pendiente{{ data.debts.payable.count === 1 ? '' : 's' }}</span>
          </div>
          <span class="quick-arrow"><ChevronRight :size="18" /></span>
        </RouterLink>

        <RouterLink to="/debts?kind=LOAN" class="quick-card quick-loan">
          <div class="quick-icon"><Landmark /></div>
          <div class="quick-body">
            <small>Préstamos activos</small>
            <strong>{{ formatMoney(data.debts.loan.total) }}</strong>
            <span>{{ data.debts.loan.count }} préstamo{{ data.debts.loan.count === 1 ? '' : 's' }}</span>
          </div>
          <span class="quick-arrow"><ChevronRight :size="18" /></span>
        </RouterLink>

        <RouterLink to="/recurrings" class="quick-card quick-recurring">
          <div class="quick-icon"><Repeat /></div>
          <div class="quick-body">
            <small>Pagos automáticos</small>
            <strong>{{ formatMoney(data.recurring.monthlyEstimated) }} / mes</strong>
            <span>{{ data.recurring.activeCount }} programado{{ data.recurring.activeCount === 1 ? '' : 's' }}</span>
          </div>
          <span class="quick-arrow"><ChevronRight :size="18" /></span>
        </RouterLink>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-card-top">
            <div class="kpi-icon kpi-icon-income">
              <TrendingUp />
            </div>
            <span class="kpi-trend" :class="{ up: incomeChange >= 0, down: incomeChange < 0 }">
              <ArrowUp v-if="incomeChange >= 0" :size="12" />
              <ArrowDown v-else :size="12" />
              {{ Math.abs(incomeChange).toFixed(1) }}%
            </span>
          </div>
          <span class="kpi-label">Ingresos del mes</span>
          <strong class="kpi-value income">{{ formatMoney(data.kpis.income) }}</strong>
          <span class="kpi-trend muted"><small>vs. {{ prevLabel }}</small></span>
        </div>

        <div class="kpi-card">
          <div class="kpi-card-top">
            <div class="kpi-icon kpi-icon-expense">
              <TrendingDown />
            </div>
            <span class="kpi-trend" :class="{ up: expenseChange < 0, down: expenseChange >= 0 }">
              <ArrowDown v-if="expenseChange < 0" :size="12" />
              <ArrowUp v-else :size="12" />
              {{ Math.abs(expenseChange).toFixed(1) }}%
            </span>
          </div>
          <span class="kpi-label">Gastos del mes</span>
          <strong class="kpi-value expense">{{ formatMoney(data.kpis.expense) }}</strong>
          <span class="kpi-trend muted"><small>vs. {{ prevLabel }}</small></span>
        </div>

        <div class="kpi-card">
          <div class="kpi-card-top">
            <div class="kpi-icon kpi-icon-balance">
              <Scale />
            </div>
            <span class="kpi-trend" :class="{ up: balanceChange >= 0, down: balanceChange < 0 }">
              <ArrowUp v-if="balanceChange >= 0" :size="12" />
              <ArrowDown v-else :size="12" />
              {{ Math.abs(balanceChange).toFixed(1) }}%
            </span>
          </div>
          <span class="kpi-label">Balance del mes</span>
          <strong class="kpi-value balance">{{ formatMoney(data.kpis.balance) }}</strong>
          <span class="kpi-trend muted"><small>vs. {{ prevLabel }}</small></span>
        </div>

        <div class="kpi-card">
          <div class="kpi-card-top">
            <div class="kpi-icon kpi-icon-debt">
              <ReceiptText />
            </div>
            <span class="kpi-trend muted">
              {{ data.kpis.debtCount }} obligación{{ data.kpis.debtCount === 1 ? '' : 'es' }}
            </span>
          </div>
          <span class="kpi-label">Deudas activas</span>
          <strong class="kpi-value debt">{{ formatMoney(data.kpis.debtTotal) }}</strong>
          <span class="kpi-trend muted"><small>Total pendiente</small></span>
        </div>
      </div>

      <div class="panel compare-panel">
        <div class="panel-header">
          <h2>Comparativa Ingresos vs Gastos</h2>
          <span class="panel-hint">Últimos {{ comparisonTotals.months }} meses</span>
        </div>

        <div v-if="!hasMonthlyData" class="empty-state">
          <div class="empty-state-illustration"><BarChart3 :size="36" /></div>
          <strong>Sin datos para comparar</strong>
          <p>Registra ingresos y gastos para ver el análisis.</p>
        </div>

        <template v-else>
          <div class="table-scroll">
            <table class="recent-table compare-table">
              <thead>
                <tr>
                  <th>Mes</th>
                  <th class="right">Ingresos</th>
                  <th class="right">Gastos</th>
                  <th class="compare-bar-col">Proporción</th>
                  <th class="right">Balance</th>
                  <th class="right">Ahorro</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in comparison" :key="r.label">
                  <td><strong>{{ r.label }}</strong></td>
                  <td class="right pos">{{ formatMoney(r.income) }}</td>
                  <td class="right neg">{{ formatMoney(r.expense) }}</td>
                  <td class="compare-bar-col">
                    <div class="bar-pair">
                      <div class="bar-track"><div class="bar-fill income" :style="{ width: barPct(r.income) }"></div></div>
                      <div class="bar-track"><div class="bar-fill expense" :style="{ width: barPct(r.expense) }"></div></div>
                    </div>
                  </td>
                  <td class="right" :class="r.balance >= 0 ? 'pos' : 'neg'"><strong>{{ formatMoney(r.balance) }}</strong></td>
                  <td class="right">
                    <span class="savings-pill" :class="r.savings >= 0 ? 'is-pos' : 'is-neg'">{{ r.savings.toFixed(0) }}%</span>
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr class="totals-row">
                  <td><strong>Totales</strong></td>
                  <td class="right pos"><strong>{{ formatMoney(comparisonTotals.income) }}</strong></td>
                  <td class="right neg"><strong>{{ formatMoney(comparisonTotals.expense) }}</strong></td>
                  <td></td>
                  <td class="right" :class="comparisonTotals.balance >= 0 ? 'pos' : 'neg'"><strong>{{ formatMoney(comparisonTotals.balance) }}</strong></td>
                  <td class="right"><strong>{{ comparisonTotals.savings.toFixed(0) }}%</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </template>
      </div>

      <div class="row-2">
        <div class="panel">
          <div class="panel-header">
            <h2>{{ chartMode === 'weekly' ? 'Resumen semanal' : 'Resumen mensual' }}</h2>
            <div class="panel-header-actions">
              <div class="chart-toggle" role="tablist">
                <button type="button" :class="{ on: chartMode === 'monthly' }" @click="chartMode = 'monthly'">Mensual</button>
                <button type="button" :class="{ on: chartMode === 'weekly' }" @click="chartMode = 'weekly'">Semanal</button>
              </div>
              <RouterLink to="/reports" class="link">Ver reportes <ChevronRight :size="14" /></RouterLink>
            </div>
          </div>
          <p v-if="chartMode === 'weekly' && topExpenseWeek && topExpenseWeek.expense > 0" class="chart-note">
            Mayor gasto: <strong>{{ topExpenseWeek.label }}</strong> ({{ topExpenseWeek.sub }}) con <strong class="neg">{{ formatMoney(topExpenseWeek.expense) }}</strong>.
          </p>
          <div class="chart-bar">
            <Bar v-if="chartHasData" :data="barChartData" :options="barChartOptions" />
            <div v-else class="empty-state">
              <div class="empty-state-illustration"><BarChart3 :size="36" /></div>
              <strong>{{ chartMode === 'weekly' ? 'Sin datos este mes' : 'Sin datos en los últimos meses' }}</strong>
              <p>Registra ingresos y gastos para ver tu evolución.</p>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2>Gastos por categoría</h2>
          </div>
          <div v-if="data.expenseByCategory.length === 0" class="empty-state">
            <div class="empty-state-illustration"><PieChart :size="36" /></div>
            <strong>Aún no hay gastos este mes</strong>
            <p>Cuando registres gastos verás aquí la distribución por categoría.</p>
          </div>
          <div v-else class="donut-row">
            <div class="donut-wrap">
              <Doughnut :data="doughnutData" :options="doughnutOptions" />
              <div class="donut-center">
                <small>Total</small>
                <strong>{{ formatMoney(totalExpenseCategoryAmount) }}</strong>
              </div>
            </div>
            <ul class="donut-legend">
              <li v-for="cat in data.expenseByCategory.slice(0, 6)" :key="cat.name">
                <span class="legend-dot" :style="{ background: cat.color }"></span>
                <span class="legend-name">{{ cat.name }}</span>
                <span class="legend-amount">{{ formatMoney(cat.amount) }}</span>
                <span class="legend-pct">{{ pctOfTotal(cat.amount) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div class="row-full">
        <div class="panel">
          <div class="panel-header">
            <h2>Movimientos recientes</h2>
            <RouterLink to="/movements" class="link">Ver todos los movimientos <ChevronRight :size="14" /></RouterLink>
          </div>
          <div v-if="data.recentMovements.length === 0" class="empty-state">
            <div class="empty-state-illustration"><ArrowRight :size="36" /></div>
            <strong>Sin movimientos este mes</strong>
            <p>Registra ingresos o gastos para verlos aquí.</p>
          </div>
          <table v-else class="recent-table">
            <thead>
              <tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Método</th><th class="right">Monto</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in data.recentMovements" :key="row.id">
                <td>{{ formatDate(row.date) }}</td>
                <td><span class="concept-icon">{{ TYPE_ICON[row.type] || '•' }}</span>{{ row.description }}</td>
                <td>
                  <span class="cat-pill" :style="row.category?.color ? { background: `${row.category.color}22`, color: row.category.color } : {}">
                    {{ row.category?.name || TYPE_LABEL[row.type] || 'Sin categoría' }}
                  </span>
                </td>
                <td>{{ methodCell(row) }}</td>
                <td class="right" :class="rowAmount(row).cls">{{ rowAmount(row).text }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.row-full { margin-bottom: var(--space-5); }
.chart-toggle { display: inline-flex; gap: 2px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 999px; padding: 3px; }
.chart-toggle button { border: none !important; background: transparent !important; color: #64748b !important; font-weight: 600; font-size: 12.5px; padding: 6px 16px; border-radius: 999px; cursor: pointer; box-shadow: none !important; transition: background .12s ease, color .12s ease; }
.chart-toggle button:hover { color: #334155 !important; }
.chart-toggle button.on { background: #fff !important; color: var(--color-primary, #2563eb) !important; box-shadow: 0 1px 2px rgba(15,23,42,.12) !important; }
.chart-note { margin: 0 0 8px; font-size: 12.5px; color: #64748b; }
.panel-header-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.compare-panel { margin-bottom: 1rem; }

.compare-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.compare-kpi { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: 12px; background: #f8fafc; border: 1px solid #e2e8f0; }
.compare-kpi small { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; }
.compare-kpi strong { font-size: 20px; color: #0f172a; line-height: 1.2; }
.compare-kpi > span { font-size: 11px; color: #94a3b8; }
.compare-kpi.income strong { color: #16a34a; }
.compare-kpi.expense strong { color: #ef4444; }
.compare-kpi.is-pos strong { color: #16a34a; }
.compare-kpi.is-neg strong { color: #ef4444; }

.table-scroll { overflow-x: auto; }
.compare-table .right { text-align: right; }
.compare-bar-col { width: 26%; min-width: 150px; }
.bar-pair { display: flex; flex-direction: column; gap: 4px; }
.bar-track { background: #eef2f7; border-radius: 4px; height: 8px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
.bar-fill.income { background: #16a34a; }
.bar-fill.expense { background: #ef4444; }

.savings-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.savings-pill.is-pos { background: #dcfce7; color: #15803d; }
.savings-pill.is-neg { background: #fee2e2; color: #b91c1c; }

.compare-table tfoot .totals-row td { background: #f8fafc; border-top: 2px solid #e2e8f0; }

@media (max-width: 720px) {
  .compare-kpis { grid-template-columns: repeat(2, 1fr); }
}
</style>
