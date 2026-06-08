<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { Landmark, Pencil, Trash2, Plus, X } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import FormField from '../components/FormField.vue';
import AppButton from '../components/AppButton.vue';
import DataTable, { type Column } from '../components/DataTable.vue';
import { useCrud } from '../composables/useCrud';
import { useFormat } from '../composables/useFormat';
import { useEntitiesStore } from '../stores/entities';
import { accountsApi } from '../api/accounts';
import {
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPE_ICON,
  ACCOUNT_TYPE_OPTIONS,
  BANK_KIND_LABEL,
  bankFullLabel
} from '../constants/domain';
import type { Account, AccountPayload } from '../types';

const { formatMoney } = useFormat();
const entities = useEntitiesStore();
const activeBanks = computed(() => entities.activeBanks);

const crud = useCrud<Account, AccountPayload>({
  service: accountsApi,
  emptyForm: () => ({ name: '', type: 'CASH', bankId: null, initialBalance: 0 }),
  toForm: (a) => ({
    name: a.name,
    type: a.type,
    bankId: a.bankId,
    initialBalance: Number(a.initialBalance)
  }),
  toPayload: (f) => ({
    name: f.name.trim(),
    type: f.type,
    bankId: f.type === 'BANK' || f.type === 'DEBIT' ? f.bankId || null : null,
    initialBalance: Number(f.initialBalance) || 0
  }),
  validate: (f) => (f.name.trim() ? null : 'El nombre de la cuenta es obligatorio.'),
  labels: {
    created: 'Cuenta creada correctamente.',
    updated: 'Cuenta actualizada.',
    removed: 'Cuenta eliminada.',
    loadError: 'No se pudieron cargar las cuentas.',
    saveError: 'No se pudo guardar la cuenta.',
    removeError: 'No se pudo eliminar la cuenta.'
  }
});
const { rows, form, editingId, saving, save, startEdit, cancelEdit, remove, load } = crud;

const showBankFields = computed(() => form.value.type === 'BANK' || form.value.type === 'DEBIT');
const selectedBank = computed(() => activeBanks.value.find((b) => b.id === form.value.bankId) || null);

const columns: Column<Account>[] = [
  { key: 'name', label: 'Cuenta', width: '22%' },
  { key: 'bank', label: 'Banco / Detalle', width: '18%' },
  { key: 'initial', label: 'Saldo inicial', align: 'center', width: '12%' },
  { key: 'current', label: 'Saldo actual', align: 'center', width: '12%' },
  { key: 'variation', label: 'Variación', align: 'center', width: '12%' },
  { key: 'status', label: 'Estado', align: 'center', width: '9%' }
];

function variation(initial: number | string, current: number | string) {
  const a = Number(initial ?? 0);
  const b = Number(current ?? 0);
  const diff = b - a;
  const pct = a !== 0 ? (diff / Math.abs(a)) * 100 : b !== 0 ? 100 : 0;
  return { diff, pct };
}
function balanceClass(v: number | string) {
  const n = Number(v ?? 0);
  return n > 0 ? 'pos' : n < 0 ? 'neg' : '';
}

async function onSave() {
  await save();
  entities.invalidate('accounts');
}
async function onRemove(item: Account) {
  await remove(
    item,
    `Eliminar la cuenta "${item.name}"? Esto la marcará inactiva. Sus movimientos NO se eliminan.`
  );
  entities.invalidate('accounts');
}

onMounted(() => Promise.all([load(), entities.ensureBanks()]));
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Cuentas" subtitle="Efectivo, bancos, billeteras y dinero por cobrar." />

    <div class="stack">
      <PanelCard :title="editingId !== null ? 'Editar cuenta' : 'Nueva cuenta'">
        <form class="form" @submit.prevent="onSave">
          <div class="form-grid">
            <FormField label="Nombre de la cuenta" required html-for="acc-name" hint="Cómo prefieras identificarla.">
              <input id="acc-name" v-model="form.name" required maxlength="80" placeholder="ej. Cuenta Pichincha sueldo" />
            </FormField>

            <FormField label="Tipo de cuenta" required html-for="acc-type" hint="Para reportes y filtros.">
              <select id="acc-type" v-model="form.type" required>
                <option v-for="o in ACCOUNT_TYPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </FormField>

            <FormField v-if="showBankFields" label="Banco" html-for="acc-bank">
              <select id="acc-bank" v-model.number="form.bankId">
                <option :value="null">— Selecciona un banco —</option>
                <option v-for="b in activeBanks" :key="b.id" :value="b.id">{{ bankFullLabel(b) }}</option>
              </select>
              <small v-if="!activeBanks.length" class="hint warn-hint">
                Sin bancos. Ve a <strong>Configuración → Bancos</strong>.
              </small>
              <small v-else-if="selectedBank" class="hint">{{ bankFullLabel(selectedBank) }}</small>
              <small v-else class="hint">Selecciona del catálogo.</small>
            </FormField>
          </div>

          <div class="form-footer">
            <FormField label="Saldo inicial (USD)" html-for="acc-initial" hint="Saldo de partida." narrow>
              <input id="acc-initial" v-model.number="form.initialBalance" type="number" step="0.01" placeholder="0.00" />
            </FormField>
            <div class="form-actions">
              <AppButton v-if="editingId !== null" variant="ghost" @click="cancelEdit">
                <template #icon><X :size="16" /></template>Cancelar
              </AppButton>
              <AppButton type="submit" :loading="saving">
                <template #icon><component :is="editingId !== null ? Pencil : Plus" :size="16" /></template>
                {{ editingId !== null ? 'Guardar cambios' : 'Crear cuenta' }}
              </AppButton>
            </div>
          </div>
        </form>
      </PanelCard>

      <PanelCard title="Listado" :hint="`${rows.length} cuenta${rows.length === 1 ? '' : 's'}`">
        <DataTable
          :columns="columns"
          :rows="rows"
          :empty="{
            icon: Landmark,
            title: 'Aún no tienes cuentas registradas',
            text: 'Crea tu primera cuenta para empezar a registrar movimientos.'
          }"
        >
          <template #cell-name="{ row }">
            <span class="acc-icon-tbl">{{ ACCOUNT_TYPE_ICON[row.type] }}</span>
            <strong>{{ row.name }}</strong>
            <div><small class="hint">{{ ACCOUNT_TYPE_LABEL[row.type] }}</small></div>
          </template>

          <template #cell-bank="{ row }">
            <template v-if="row.bank">
              <div>🏦 {{ row.bank.name }}</div>
              <small class="hint">
                {{ row.bank.accountKind ? BANK_KIND_LABEL[row.bank.accountKind] : '' }}
                {{ row.bank.accountKind && row.bank.accountNumber ? ' · ' : '' }}
                {{ row.bank.accountNumber ? '****' + row.bank.accountNumber.slice(-4) : '' }}
                {{ !row.bank.accountKind && !row.bank.accountNumber ? 'Sin tipo / n°' : '' }}
              </small>
            </template>
            <template v-else-if="row.bankName">
              <div>{{ row.bankName }}</div>
              <small class="hint">{{ row.accountNumber || 'Sin n°' }}</small>
            </template>
            <small v-else class="hint">—</small>
          </template>

          <template #cell-initial="{ row }">{{ formatMoney(row.initialBalance) }}</template>

          <template #cell-current="{ row }">
            <span :class="balanceClass(row.currentBalance)">{{ formatMoney(row.currentBalance) }}</span>
          </template>

          <template #cell-variation="{ row }">
            <span :class="balanceClass(variation(row.initialBalance, row.currentBalance).diff)">
              {{ formatMoney(variation(row.initialBalance, row.currentBalance).diff) }}
            </span>
            <br /><small class="hint">{{ variation(row.initialBalance, row.currentBalance).pct.toFixed(1) }}%</small>
          </template>

          <template #cell-status="{ row }">
            <span class="cat-pill" :class="row.isActive ? 'badge-active' : 'badge-inactive'">
              {{ row.isActive ? 'Activa' : 'Inactiva' }}
            </span>
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
  </section>
</template>

<style scoped>
.acc-icon-tbl { font-size: 18px; margin-right: 6px; }
.pos { color: var(--color-success-text); font-weight: 600; }
.neg { color: var(--color-danger-text); font-weight: 600; }
.badge-active { background: #ecfdf5; color: #047857; }
.badge-inactive { background: #fef2f2; color: #b91c1c; }
.warn-hint { color: var(--color-warning-text); }
</style>
