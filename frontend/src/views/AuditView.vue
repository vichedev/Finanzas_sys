<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { History, RefreshCw } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import DataTable, { type Column } from '../components/DataTable.vue';
import AppButton from '../components/AppButton.vue';
import { auditApi } from '../api/audit';
import type { AuditEntry } from '../types';

const rows = ref<AuditEntry[]>([]);
const loading = ref(false);
const entityFilter = ref('');
const actionFilter = ref('');

const ENTITY_LABEL: Record<string, string> = {
  movement: 'Movimiento', account: 'Cuenta', card: 'Tarjeta', bank: 'Banco', budget: 'Presupuesto', recurring: 'Recurrente'
};
const ACTION_LABEL: Record<string, string> = { CREATE: 'Creó', UPDATE: 'Editó', DELETE: 'Eliminó' };
const ACTION_CLASS: Record<string, string> = { CREATE: 'a-create', UPDATE: 'a-update', DELETE: 'a-delete' };

const ENTITY_OPTIONS = Object.entries(ENTITY_LABEL).map(([value, label]) => ({ value, label }));

const columns: Column<AuditEntry>[] = [
  { key: 'createdAt', label: 'Fecha', width: '18%' },
  { key: 'userEmail', label: 'Usuario', width: '22%' },
  { key: 'action', label: 'Acción', align: 'center', width: '12%' },
  { key: 'entity', label: 'Tipo', align: 'center', width: '14%' },
  { key: 'summary', label: 'Detalle', width: '34%' }
];

function fmtDate(v: string) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' });
}

async function load() {
  loading.value = true;
  try {
    rows.value = await auditApi.list({
      entity: entityFilter.value || undefined,
      action: actionFilter.value || undefined,
      limit: 200
    });
  } finally { loading.value = false; }
}

const count = computed(() => rows.value.length);

onMounted(load);
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Auditoría" subtitle="Registro de cambios: quién creó, editó o eliminó qué y cuándo." />

    <PanelCard title="Actividad reciente" :hint="`${count} registro${count === 1 ? '' : 's'}`">
      <div class="audit-filters">
        <select v-model="entityFilter" @change="load">
          <option value="">Todos los tipos</option>
          <option v-for="o in ENTITY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <select v-model="actionFilter" @change="load">
          <option value="">Todas las acciones</option>
          <option value="CREATE">Creaciones</option>
          <option value="UPDATE">Ediciones</option>
          <option value="DELETE">Eliminaciones</option>
        </select>
        <AppButton variant="ghost" :loading="loading" @click="load"><template #icon><RefreshCw :size="15" /></template>Actualizar</AppButton>
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        :empty="{ icon: History, title: 'Sin actividad registrada', text: 'Los cambios que hagas en el sistema aparecerán aquí.' }"
      >
        <template #cell-createdAt="{ row }"><small>{{ fmtDate(row.createdAt) }}</small></template>
        <template #cell-userEmail="{ row }"><small class="hint">{{ row.userEmail || '—' }}</small></template>
        <template #cell-action="{ row }">
          <span class="cat-pill" :class="ACTION_CLASS[row.action]">{{ ACTION_LABEL[row.action] || row.action }}</span>
        </template>
        <template #cell-entity="{ row }">{{ ENTITY_LABEL[row.entity] || row.entity }}</template>
        <template #cell-summary="{ row }"><small>{{ row.summary || '—' }}</small></template>
      </DataTable>
    </PanelCard>
  </section>
</template>

<style scoped>
.audit-filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.audit-filters select { padding: 8px 10px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; background: #fff; }
.a-create { background: #ecfdf5; color: #047857; }
.a-update { background: #eff6ff; color: #1d4ed8; }
.a-delete { background: #fef2f2; color: #b91c1c; }
</style>
