<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Landmark, Pencil, Trash2, Plus, X, Scale } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import FormField from '../components/FormField.vue';
import AppButton from '../components/AppButton.vue';
import AppModal from '../components/AppModal.vue';
import DataTable, { type Column } from '../components/DataTable.vue';
import { http } from '../api/http';
import { useCrud } from '../composables/useCrud';
import { useFormat } from '../composables/useFormat';
import { useEntitiesStore } from '../stores/entities';
import { accountsApi } from '../api/accounts';
import {
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPE_ICON,
  ACCOUNT_TYPE_OPTIONS,
  BANK_KIND_LABEL
} from '../constants/domain';
import type { Account, AccountPayload } from '../types';

const { formatMoney } = useFormat();
const entities = useEntitiesStore();
const activeBanks = computed(() => entities.activeBanks);

const crud = useCrud<Account, AccountPayload>({
  service: accountsApi,
  emptyForm: () => ({ name: '', type: 'CASH', holder: '', entityName: '', entityKind: 'PERSONAL' as const, accountKind: null, accountNumber: '', bankId: null, initialBalance: 0 }),
  toForm: (a) => ({
    name: a.name,
    type: a.type,
    holder: a.holder ?? '',
    entityName: a.entityName ?? '',
    entityKind: a.entityKind ?? 'PERSONAL',
    accountKind: a.accountKind ?? null,
    accountNumber: a.accountNumber ?? '',
    bankId: a.bankId,
    initialBalance: Number(a.initialBalance)
  }),
  toPayload: (f) => {
    const isBank = f.type === 'BANK' || f.type === 'DEBIT';
    return {
      name: f.name.trim(),
      type: f.type,
      holder: (f.holder || '').trim() || null,
      entityName: (f.entityName || '').trim() || null,
      entityKind: f.entityKind || 'PERSONAL',
      accountKind: isBank ? (f.accountKind || null) : null,
      accountNumber: isBank ? ((f.accountNumber || '').trim() || null) : null,
      bankId: isBank ? (f.bankId || null) : null,
      initialBalance: Number(f.initialBalance) || 0
    };
  },
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
const { rows, form, editingId, saving, save, startEdit, cancelEdit, load } = crud;
// Sugerencias de razón social ya usadas (para autocompletar y mantener consistencia).
const entityNameOptions = computed(() => [...new Set(rows.value.map((a) => a.entityName?.trim()).filter(Boolean) as string[])]);

const showBankFields = computed(() => form.value.type === 'BANK' || form.value.type === 'DEBIT');

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
async function onRemove(item: Account, force = false) {
  if (!force && !confirm(`Eliminar la cuenta "${item.name}"? Esto la marcará inactiva. Sus movimientos NO se eliminan.`)) return;
  try {
    await http.delete(`/accounts/${item.id}`, { params: force ? { force: 1 } : undefined });
    await load();
    entities.invalidate('accounts');
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { message?: string; code?: string } } };
    if (e?.response?.status === 409 && e.response.data?.code === 'NONZERO_BALANCE') {
      if (confirm(e.response.data.message || 'La cuenta tiene saldo. ¿Marcar inactiva igual?')) await onRemove(item, true);
      return;
    }
    alert('No se pudo eliminar la cuenta.');
  }
}

// ---- Conciliación de saldo ----
const reconcileOpen = ref(false);
const reconcileAcc = ref<Account | null>(null);
const reconcileForm = ref<{ realBalance: number | null; notes: string }>({ realBalance: null, notes: '' });
const reconcileErr = ref('');
const reconciling = ref(false);

function openReconcile(item: Account) {
  reconcileAcc.value = item;
  reconcileForm.value = { realBalance: Number(item.currentBalance), notes: '' };
  reconcileErr.value = '';
  reconcileOpen.value = true;
}
async function submitReconcile() {
  reconcileErr.value = '';
  if (!reconcileAcc.value) return;
  if (reconcileForm.value.realBalance === null || Number.isNaN(reconcileForm.value.realBalance)) {
    reconcileErr.value = 'Ingresa el saldo real.'; return;
  }
  reconciling.value = true;
  try {
    await http.post(`/accounts/${reconcileAcc.value.id}/reconcile`, {
      realBalance: reconcileForm.value.realBalance,
      notes: reconcileForm.value.notes.trim() || null
    });
    reconcileOpen.value = false;
    await load();
    entities.invalidate('accounts');
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } };
    reconcileErr.value = e?.response?.data?.message ?? 'No se pudo conciliar.';
  } finally { reconciling.value = false; }
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

            <FormField label="Titular de la cuenta" html-for="acc-holder" hint="A nombre de quién está.">
              <input id="acc-holder" v-model="form.holder" maxlength="120" placeholder="ej. Juan Pérez" />
            </FormField>

            <FormField label="Razón social / Entidad" html-for="acc-entity" hint="Para agrupar en 'Razones sociales'.">
              <input id="acc-entity" v-model="form.entityName" maxlength="120" list="entity-names" placeholder="ej. Personal, GROUPMAAT S.A.S" />
              <datalist id="entity-names">
                <option v-for="n in entityNameOptions" :key="n" :value="n" />
              </datalist>
            </FormField>

            <FormField label="Naturaleza" html-for="acc-entkind" hint="¿Personal o de empresa?">
              <select id="acc-entkind" v-model="form.entityKind">
                <option value="PERSONAL">Personal</option>
                <option value="BUSINESS">Empresarial</option>
              </select>
            </FormField>

            <FormField label="Tipo / Naturaleza" required html-for="acc-type" hint="Efectivo, banco, billetera…">
              <select id="acc-type" v-model="form.type" required>
                <option v-for="o in ACCOUNT_TYPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </FormField>

            <FormField v-if="showBankFields" label="Banco" html-for="acc-bank">
              <select id="acc-bank" v-model.number="form.bankId">
                <option :value="null">— Selecciona un banco —</option>
                <option v-for="b in activeBanks" :key="b.id" :value="b.id">{{ b.name }}</option>
              </select>
              <small v-if="!activeBanks.length" class="hint warn-hint">
                Sin bancos. Ve a <strong>Configuración → Bancos</strong>.
              </small>
            </FormField>

            <FormField v-if="showBankFields" label="Tipo de cuenta" html-for="acc-kind" hint="Ahorros o corriente.">
              <select id="acc-kind" v-model="form.accountKind">
                <option :value="null">— Sin especificar —</option>
                <option value="SAVINGS">Ahorros</option>
                <option value="CHECKING">Corriente</option>
              </select>
            </FormField>

            <FormField v-if="showBankFields" label="Número de cuenta" html-for="acc-num" hint="Se mostrarán solo los últimos 4 dígitos.">
              <input id="acc-num" v-model="form.accountNumber" maxlength="40" inputmode="numeric" placeholder="ej. 2200123456" />
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
            <div><small class="hint">{{ ACCOUNT_TYPE_LABEL[row.type] }}<template v-if="row.holder"> · 👤 {{ row.holder }}</template></small></div>
          </template>

          <template #cell-bank="{ row }">
            <template v-if="row.bankName || row.bank">
              <div>🏦 {{ row.bank?.name || row.bankName }}</div>
              <small class="hint">
                {{ row.accountKind ? BANK_KIND_LABEL[row.accountKind] : '' }}
                {{ row.accountKind && row.accountNumber ? ' · ' : '' }}
                {{ row.accountNumber ? '****' + row.accountNumber.slice(-4) : '' }}
                {{ !row.accountKind && !row.accountNumber ? 'Sin tipo / n°' : '' }}
              </small>
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
            <AppButton variant="ghost" mini title="Conciliar saldo" @click="openReconcile(row)">
              <template #icon><Scale :size="14" /></template>
            </AppButton>
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

    <AppModal :open="reconcileOpen" :title="`Conciliar saldo${reconcileAcc ? ' · ' + reconcileAcc.name : ''}`" @close="reconcileOpen = false">
      <div class="recon-body">
        <p class="recon-hint">
          Ajusta el saldo del sistema al saldo real (el de tu banco/efectivo). Se creará un movimiento de ajuste con la diferencia.
          <template v-if="reconcileAcc"><br />Saldo en el sistema: <strong>{{ formatMoney(reconcileAcc.currentBalance) }}</strong>.</template>
        </p>
        <FormField label="Saldo real (USD)" html-for="recon-real" hint="El saldo correcto que debería tener la cuenta.">
          <input id="recon-real" v-model.number="reconcileForm.realBalance" type="number" step="0.01" placeholder="0.00" />
        </FormField>
        <FormField label="Notas" html-for="recon-notes">
          <input id="recon-notes" v-model="reconcileForm.notes" maxlength="300" placeholder="Motivo del ajuste (opcional)" />
        </FormField>
        <p v-if="reconcileErr" class="error">{{ reconcileErr }}</p>
      </div>
      <template #footer>
        <AppButton variant="ghost" @click="reconcileOpen = false"><template #icon><X :size="16" /></template>Cancelar</AppButton>
        <AppButton :loading="reconciling" @click="submitReconcile"><template #icon><Scale :size="16" /></template>Conciliar</AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.acc-icon-tbl { font-size: 18px; margin-right: 6px; }
.pos { color: var(--color-success-text); font-weight: 600; }
.neg { color: var(--color-danger-text); font-weight: 600; }
.badge-active { background: #ecfdf5; color: #047857; }
.badge-inactive { background: #fef2f2; color: #b91c1c; }
.warn-hint { color: var(--color-warning-text); }
.recon-body { display: flex; flex-direction: column; gap: 12px; }
.recon-hint { font-size: 13px; color: #6b7280; margin: 0; }
</style>
