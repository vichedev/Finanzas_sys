<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { PiggyBank, Trash2, Plus, X, Pencil } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import FormField from '../components/FormField.vue';
import AppButton from '../components/AppButton.vue';
import DataTable, { type Column } from '../components/DataTable.vue';
import { useFormat } from '../composables/useFormat';
import { useToast } from '../composables/useToast';
import { useEntitiesStore } from '../stores/entities';
import { budgetsApi } from '../api/budgets';
import type { Budget } from '../types';

const { formatMoney } = useFormat();
const entities = useEntitiesStore();

interface CatLike { id: number; name: string; type?: string; icon?: string | null }
const categories = computed<CatLike[]>(() => entities.categories as unknown as CatLike[]);
// Categorías de gasto primero (los presupuestos limitan gastos).
const expenseCategories = computed(() => {
  const list = categories.value;
  const onlyExpense = list.filter((c) => c.type === 'EXPENSE');
  return onlyExpense.length ? onlyExpense : list;
});

const budgets = ref<Budget[]>([]);
const period = ref<{ year: number; month: number }>({ year: 0, month: 0 });
const form = ref<{ id: number | null; categoryId: number | null; amount: number | null }>({ id: null, categoryId: null, amount: null });
const saving = ref(false);
const toast = useToast();

const monthLabel = computed(() => {
  if (!period.value.year) return '';
  const d = new Date(Date.UTC(period.value.year, period.value.month - 1, 1));
  return d.toLocaleDateString('es-EC', { month: 'long', year: 'numeric', timeZone: 'UTC' });
});

const columns: Column<Budget>[] = [
  { key: 'categoryName', label: 'Categoría', width: '26%' },
  { key: 'amount', label: 'Límite mensual', align: 'center', width: '16%' },
  { key: 'spent', label: 'Gastado', align: 'center', width: '16%' },
  { key: 'remaining', label: 'Restante', align: 'center', width: '16%' },
  { key: 'pct', label: 'Consumo', align: 'center', width: '20%' }
];

function sev(pct: number) { if (pct >= 100) return 'high'; if (pct >= 80) return 'mid'; return 'low'; }

async function load() {
  const res = await budgetsApi.list();
  budgets.value = res.budgets;
  period.value = { year: res.year, month: res.month };
}

async function save() {
  if (!form.value.categoryId) { toast.error('Selecciona una categoría.'); return; }
  if (!form.value.amount || form.value.amount <= 0) { toast.error('Ingresa un límite mayor a 0.'); return; }
  saving.value = true;
  try {
    const wasEdit = form.value.id !== null;
    await budgetsApi.save({ categoryId: form.value.categoryId, amount: form.value.amount });
    toast.success(wasEdit ? 'Presupuesto actualizado.' : 'Presupuesto creado.');
    form.value = { id: null, categoryId: null, amount: null };
    await load();
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } };
    toast.error(e?.response?.data?.message ?? 'No se pudo guardar el presupuesto.');
  } finally { saving.value = false; }
}

function startEdit(row: Budget) {
  form.value = { id: row.id, categoryId: row.categoryId, amount: row.amount };
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}
function cancelEdit() { form.value = { id: null, categoryId: null, amount: null }; }

async function remove(row: Budget) {
  if (!confirm(`Eliminar el presupuesto de "${row.categoryName}"?`)) return;
  try { await budgetsApi.remove(row.id); toast.success('Presupuesto eliminado.'); await load(); }
  catch { toast.error('No se pudo eliminar el presupuesto.'); }
}

onMounted(() => Promise.all([load(), entities.ensureCategories(true)]));
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Presupuestos" :subtitle="`Límites de gasto por categoría · ${monthLabel}`" />

    <div class="stack">
      <PanelCard :title="form.id !== null ? 'Editar presupuesto' : 'Nuevo presupuesto'">
        <form class="form" @submit.prevent="save">
          <div class="form-grid">
            <FormField label="Categoría" required html-for="bud-cat" hint="Sobre qué categoría aplica el límite.">
              <select id="bud-cat" v-model.number="form.categoryId">
                <option :value="null">— Selecciona —</option>
                <option v-for="c in expenseCategories" :key="c.id" :value="c.id">{{ c.icon ? c.icon + ' ' : '' }}{{ c.name }}</option>
              </select>
              <small v-if="!categories.length" class="hint warn-hint">Sin categorías. Créalas en <strong>Configuración → Categorías</strong>.</small>
            </FormField>
            <FormField label="Límite mensual (USD)" required html-for="bud-amt" hint="Cuánto planeas gastar como máximo.">
              <input id="bud-amt" v-model.number="form.amount" type="number" step="0.01" min="0" placeholder="0.00" />
            </FormField>
          </div>
          <div class="form-actions">
            <AppButton v-if="form.id !== null" variant="ghost" @click="cancelEdit"><template #icon><X :size="16" /></template>Cancelar</AppButton>
            <AppButton type="submit" :loading="saving">
              <template #icon><component :is="form.id !== null ? Pencil : Plus" :size="16" /></template>
              {{ form.id !== null ? 'Guardar cambios' : 'Crear presupuesto' }}
            </AppButton>
          </div>
        </form>
      </PanelCard>

      <PanelCard title="Presupuestos del mes" :hint="`${budgets.length} categoría${budgets.length === 1 ? '' : 's'}`">
        <DataTable
          :columns="columns"
          :rows="budgets"
          :empty="{ icon: PiggyBank, title: 'Sin presupuestos', text: 'Crea un límite por categoría para controlar tus gastos del mes.' }"
        >
          <template #cell-categoryName="{ row }"><strong>{{ row.categoryName }}</strong></template>
          <template #cell-amount="{ row }">{{ formatMoney(row.amount) }}</template>
          <template #cell-spent="{ row }"><span class="neg">{{ formatMoney(row.spent) }}</span></template>
          <template #cell-remaining="{ row }">
            <span :class="row.remaining >= 0 ? 'pos' : 'neg'">{{ formatMoney(row.remaining) }}</span>
          </template>
          <template #cell-pct="{ row }">
            <div class="bud-bar"><div class="bud-fill" :class="`sev-${sev(row.pct)}`" :style="{ width: Math.min(100, row.pct) + '%' }"></div></div>
            <small class="hint" :class="{ 'over': row.pct >= 100 }">{{ row.pct }}%<template v-if="row.pct >= 100"> · excedido</template></small>
          </template>
          <template #actions="{ row }">
            <AppButton variant="ghost" mini @click="startEdit(row)"><template #icon><Pencil :size="14" /></template></AppButton>
            <AppButton variant="ghost" mini danger @click="remove(row)"><template #icon><Trash2 :size="14" /></template></AppButton>
          </template>
        </DataTable>
      </PanelCard>
    </div>
  </section>
</template>

<style scoped>
.pos { color: var(--color-success-text); font-weight: 600; }
.neg { color: var(--color-danger-text); font-weight: 600; }
.warn-hint { color: var(--color-warning-text); }
.bud-bar { width: 100%; height: 7px; background: #e5e7eb; border-radius: 999px; overflow: hidden; margin: 4px 0 2px; }
.bud-fill { height: 100%; border-radius: 999px; transition: width 0.25s ease; }
.bud-fill.sev-low { background: #10b981; }
.bud-fill.sev-mid { background: #f59e0b; }
.bud-fill.sev-high { background: #ef4444; }
small.over { color: var(--color-danger-text); font-weight: 700; }
</style>
