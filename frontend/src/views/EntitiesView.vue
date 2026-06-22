<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { http } from '../api/http';
import { Scale, Landmark, CreditCard, TrendingUp, TrendingDown, Building2, User, Plus, Pencil, Trash2, X } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import AppModal from '../components/AppModal.vue';
import { useFormat } from '../composables/useFormat';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import type { EntityKind } from '../types';

const { formatMoney } = useFormat();
const toast = useToast();
const { confirm } = useConfirm();

interface Entity { id: number; name: string; kind: EntityKind; taxId?: string | null; notes?: string | null; _count?: { accounts: number; cards: number } }
interface Account { id: number; name: string; type: string; currentBalance: number | string; entityId?: number | null; bankName?: string | null }
interface Card { id: number; name: string; type: 'CREDIT' | 'DEBIT'; currentBalance: number | string; creditLimit?: number | string | null; entityId?: number | null; bankName?: string | null }

const entities = ref<Entity[]>([]);
const accounts = ref<Account[]>([]);
const cards = ref<Card[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const [e, a, c] = await Promise.all([
      http.get<Entity[]>('/entities'),
      http.get<Account[]>('/accounts'),
      http.get<Card[]>('/cards')
    ]);
    entities.value = e.data; accounts.value = a.data; cards.value = c.data;
  } finally { loading.value = false; }
}
onMounted(load);

const num = (v: unknown) => Number(v ?? 0);

interface Group {
  entity: Entity;
  accounts: Account[];
  cards: Card[];
  liquid: number;
  cardDebt: number;
  net: number;
}

// Análisis: solo entidades que tienen cuentas/tarjetas asignadas.
const groups = computed<Group[]>(() => {
  const list: Group[] = entities.value.map((entity) => {
    const accs = accounts.value.filter((a) => a.entityId === entity.id);
    const crds = cards.value.filter((c) => c.entityId === entity.id);
    let liquid = 0, cardDebt = 0;
    for (const a of accs) liquid += num(a.currentBalance);
    for (const c of crds) {
      if (c.type === 'CREDIT') cardDebt += Math.max(0, num(c.currentBalance));
      else liquid += num(c.currentBalance);
    }
    return { entity, accounts: accs, cards: crds, liquid, cardDebt, net: liquid - cardDebt };
  }).filter((g) => g.accounts.length || g.cards.length);
  return list.sort((a, b) => b.net - a.net);
});

const personalGroups = computed(() => groups.value.filter((g) => g.entity.kind === 'PERSONAL'));
const businessGroups = computed(() => groups.value.filter((g) => g.entity.kind === 'BUSINESS'));

const totals = computed(() => {
  const sum = (arr: Group[]) => arr.reduce((a, g) => ({ liquid: a.liquid + g.liquid, cardDebt: a.cardDebt + g.cardDebt, net: a.net + g.net }), { liquid: 0, cardDebt: 0, net: 0 });
  return { all: sum(groups.value), personal: sum(personalGroups.value), business: sum(businessGroups.value) };
});
const topEntity = computed(() => groups.value[0] || null);
const netTotalAbs = computed(() => groups.value.reduce((a, g) => a + Math.abs(g.net), 0) || 1);
const sharePct = (g: Group) => Math.round((Math.abs(g.net) / netTotalAbs.value) * 100);
// Cuentas/tarjetas sin razón social (para avisar).
const unassignedCount = computed(() =>
  accounts.value.filter((a) => !a.entityId).length + cards.value.filter((c) => !c.entityId).length
);

// ---- Gestión del catálogo (tabla + modal) ----
const modalOpen = ref(false);
const editingId = ref<number | null>(null);
const form = ref<{ name: string; kind: EntityKind; taxId: string; notes: string }>({ name: '', kind: 'PERSONAL', taxId: '', notes: '' });
const saving = ref(false);

function openNew() { editingId.value = null; form.value = { name: '', kind: 'PERSONAL', taxId: '', notes: '' }; modalOpen.value = true; }
function openEdit(e: Entity) { editingId.value = e.id; form.value = { name: e.name, kind: e.kind, taxId: e.taxId || '', notes: e.notes || '' }; modalOpen.value = true; }

async function save() {
  if (form.value.name.trim().length < 2) { toast.error('El nombre es obligatorio (mínimo 2 caracteres).'); return; }
  saving.value = true;
  try {
    const payload = { name: form.value.name.trim(), kind: form.value.kind, taxId: form.value.taxId.trim() || null, notes: form.value.notes.trim() || null };
    if (editingId.value !== null) { await http.put(`/entities/${editingId.value}`, payload); toast.success('Razón social actualizada.'); }
    else { await http.post('/entities', payload); toast.success('Razón social creada.'); }
    modalOpen.value = false;
    await load();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    toast.error(err?.response?.data?.message ?? 'No se pudo guardar.');
  } finally { saving.value = false; }
}

async function remove(e: Entity) {
  const used = (e._count?.accounts ?? 0) + (e._count?.cards ?? 0);
  if (!(await confirm({ message: `¿Eliminar la razón social "${e.name}"?${used ? ` ${used} cuenta(s)/tarjeta(s) quedarán sin asignar.` : ''}`, danger: true, confirmText: 'Eliminar' }))) return;
  try { await http.delete(`/entities/${e.id}`); toast.success('Razón social eliminada.'); await load(); }
  catch { toast.error('No se pudo eliminar.'); }
}
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Razones sociales" subtitle="Define tus entidades y consolida los saldos de cada una.">
      <template #actions>
        <button type="button" class="ent-new" @click="openNew"><Plus :size="16" /> Nueva razón social</button>
      </template>
    </PageHeader>

    <p v-if="loading" class="dash-loading">Cargando…</p>

    <template v-else>
      <!-- Catálogo gestionable -->
      <PanelCard title="Catálogo de razones sociales" :hint="`${entities.length} definida${entities.length === 1 ? '' : 's'}`">
        <div v-if="!entities.length" class="empty-state">
          <div class="empty-state-illustration"><Scale :size="36" /></div>
          <strong>Aún no defines razones sociales</strong>
          <p>Crea una (Personal o Empresarial) y luego asígnala a tus cuentas y tarjetas.</p>
        </div>
        <table v-else class="recent-table">
          <thead>
            <tr><th>Razón social</th><th class="center">Naturaleza</th><th>RUC / Cédula</th><th class="center">Cuentas</th><th class="center">Tarjetas</th><th class="center">Acciones</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in entities" :key="e.id">
              <td><strong>{{ e.name }}</strong><div v-if="e.notes"><small class="hint">{{ e.notes }}</small></div></td>
              <td class="center"><span class="ent-pill" :class="e.kind === 'BUSINESS' ? 'is-biz' : 'is-per'">{{ e.kind === 'BUSINESS' ? 'Empresarial' : 'Personal' }}</span></td>
              <td><small class="hint">{{ e.taxId || '—' }}</small></td>
              <td class="center">{{ e._count?.accounts ?? 0 }}</td>
              <td class="center">{{ e._count?.cards ?? 0 }}</td>
              <td class="center">
                <div class="row-actions" style="justify-content:center">
                  <button type="button" class="ghost mini" @click="openEdit(e)"><Pencil :size="14" /></button>
                  <button type="button" class="ghost mini danger" @click="remove(e)"><Trash2 :size="14" /></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </PanelCard>

      <!-- Resumen global (solo entidades con cuentas/tarjetas) -->
      <div v-if="groups.length" class="ent-kpis">
        <div class="ent-kpi">
          <span class="ent-kpi-label"><Scale :size="15" /> Patrimonio neto total</span>
          <strong class="ent-kpi-value" :class="totals.all.net >= 0 ? 'pos' : 'neg'">{{ formatMoney(totals.all.net) }}</strong>
          <small>Liquidez − deuda de tarjetas</small>
        </div>
        <div class="ent-kpi">
          <span class="ent-kpi-label"><TrendingUp :size="15" /> Liquidez disponible</span>
          <strong class="ent-kpi-value pos">{{ formatMoney(totals.all.liquid) }}</strong>
          <small>Cuentas + tarjetas de débito</small>
        </div>
        <div class="ent-kpi">
          <span class="ent-kpi-label"><TrendingDown :size="15" /> Deuda de tarjetas</span>
          <strong class="ent-kpi-value neg">{{ formatMoney(totals.all.cardDebt) }}</strong>
          <small>Saldo usado en crédito</small>
        </div>
        <div class="ent-kpi">
          <span class="ent-kpi-label"><User :size="15" /> Personal · <Building2 :size="15" /> Empresa</span>
          <strong class="ent-kpi-value">{{ formatMoney(totals.personal.net) }} · {{ formatMoney(totals.business.net) }}</strong>
          <small>Patrimonio neto por naturaleza</small>
        </div>
      </div>

      <PanelCard v-if="groups.length" title="Análisis">
        <ul class="ent-insights">
          <li v-if="topEntity"><strong>{{ topEntity.entity.name }}</strong> concentra el mayor patrimonio neto (<strong :class="topEntity.net >= 0 ? 'pos' : 'neg'">{{ formatMoney(topEntity.net) }}</strong>, ~{{ sharePct(topEntity) }}% del total).</li>
          <li v-if="totals.all.cardDebt > 0">La deuda de tarjetas es <strong class="neg">{{ Math.round((totals.all.cardDebt / (totals.all.liquid || 1)) * 100) }}%</strong> de tu liquidez.</li>
          <li v-if="businessGroups.length && personalGroups.length">{{ personalGroups.length }} entidad(es) personal(es) y {{ businessGroups.length }} empresarial(es) con saldos.</li>
          <li v-if="unassignedCount" class="warn">Hay <strong>{{ unassignedCount }}</strong> cuenta(s)/tarjeta(s) sin razón social. Asígnalas en Cuentas o Tarjetas para incluirlas.</li>
        </ul>
      </PanelCard>

      <template v-for="section in [{ title: 'Personal', icon: User, items: personalGroups }, { title: 'Empresarial', icon: Building2, items: businessGroups }]" :key="section.title">
        <div v-if="section.items.length" class="ent-section">
          <h2 class="ent-section-title"><component :is="section.icon" :size="18" /> {{ section.title }}</h2>
          <div class="ent-grid">
            <div v-for="g in section.items" :key="g.entity.id" class="ent-card">
              <div class="ent-card-head">
                <span class="ent-card-name">{{ g.entity.name }}</span>
                <span class="ent-card-net" :class="g.net >= 0 ? 'pos' : 'neg'">{{ formatMoney(g.net) }}</span>
              </div>
              <div class="ent-card-bars">
                <div class="ent-bar"><span>Liquidez</span><strong class="pos">{{ formatMoney(g.liquid) }}</strong></div>
                <div class="ent-bar"><span>Deuda tarjetas</span><strong class="neg">{{ formatMoney(g.cardDebt) }}</strong></div>
              </div>
              <div class="ent-card-detail">
                <div v-for="a in g.accounts" :key="'a' + a.id" class="ent-line">
                  <span><Landmark :size="13" /> {{ a.name }}<small v-if="a.bankName"> · {{ a.bankName }}</small></span>
                  <span :class="num(a.currentBalance) >= 0 ? 'pos' : 'neg'">{{ formatMoney(a.currentBalance) }}</span>
                </div>
                <div v-for="c in g.cards" :key="'c' + c.id" class="ent-line">
                  <span><CreditCard :size="13" /> {{ c.name }}<small> · {{ c.type === 'CREDIT' ? 'Crédito' : 'Débito' }}</small></span>
                  <span :class="c.type === 'CREDIT' ? 'neg' : 'pos'">{{ formatMoney(c.currentBalance) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <p v-if="entities.length && !groups.length" class="hint" style="margin-top:12px">
        Tienes razones sociales definidas pero ninguna tiene cuentas o tarjetas asignadas todavía. Asígnalas en <strong>Cuentas</strong> y <strong>Tarjetas</strong> para ver el análisis.
      </p>
    </template>

    <!-- Modal crear/editar razón social -->
    <AppModal :open="modalOpen" :title="editingId !== null ? 'Editar razón social' : 'Nueva razón social'" @close="modalOpen = false">
      <div class="ent-form">
        <div class="field">
          <label for="ent-name">Nombre <span class="required-mark">*</span></label>
          <input id="ent-name" v-model="form.name" maxlength="120" placeholder="ej. GROUPMAAT S.A.S, Personal" />
        </div>
        <div class="field">
          <label for="ent-kind">Naturaleza <span class="required-mark">*</span></label>
          <select id="ent-kind" v-model="form.kind">
            <option value="PERSONAL">Personal</option>
            <option value="BUSINESS">Empresarial</option>
          </select>
        </div>
        <div class="field">
          <label for="ent-tax">RUC / Cédula</label>
          <input id="ent-tax" v-model="form.taxId" maxlength="40" placeholder="Opcional" />
        </div>
        <div class="field">
          <label for="ent-notes">Notas</label>
          <input id="ent-notes" v-model="form.notes" maxlength="300" placeholder="Opcional" />
        </div>
      </div>
      <template #footer>
        <button type="button" class="ghost" @click="modalOpen = false"><X :size="16" /> Cancelar</button>
        <button type="button" :disabled="saving" @click="save"><Plus :size="16" /> {{ saving ? 'Guardando…' : (editingId !== null ? 'Guardar' : 'Crear') }}</button>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.ent-new { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border: none; border-radius: 10px; background: var(--color-primary, #2563eb); color: #fff; font-weight: 600; cursor: pointer; }
.ent-pill { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; }
.ent-pill.is-per { background: #eef2ff; color: #4338ca; }
.ent-pill.is-biz { background: #ecfeff; color: #0e7490; }
.row-actions { display: flex; gap: 6px; }
.row-actions button.mini { background: #fff; border: 1px solid #e2e8f0; color: #475569; cursor: pointer; border-radius: 6px; padding: 5px 8px; }
.row-actions button.mini.danger { color: #dc2626; border-color: #fecaca; }
.ent-form { display: flex; flex-direction: column; gap: 12px; }
.ent-form .field { display: flex; flex-direction: column; gap: 4px; }
.ent-form label { font-size: 13px; font-weight: 600; color: #334155; }
.ent-form input, .ent-form select { padding: 8px 10px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; font: inherit; color: #334155; }
.ent-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 16px 0; }
.ent-kpi { background: var(--color-surface, #fff); border: 1px solid var(--color-border, #e2e8f0); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
.ent-kpi-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .03em; }
.ent-kpi-value { font-size: 22px; font-weight: 800; color: #0f172a; }
.ent-kpi small { font-size: 11px; color: #94a3b8; }
.ent-insights { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.ent-insights li { font-size: 14px; color: #334155; line-height: 1.45; }
.ent-insights li.warn { color: #b45309; }
.ent-section { margin-top: 18px; }
.ent-section-title { display: inline-flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; color: #334155; margin: 0 0 10px; }
.ent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.ent-card { background: var(--color-surface, #fff); border: 1px solid var(--color-border, #e2e8f0); border-radius: 14px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.ent-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.ent-card-name { font-weight: 700; color: #0f172a; }
.ent-card-net { font-weight: 800; font-size: 17px; }
.ent-card-bars { display: flex; gap: 16px; padding: 8px 0; border-top: 1px dashed #e2e8f0; border-bottom: 1px dashed #e2e8f0; margin-bottom: 8px; }
.ent-bar { display: flex; flex-direction: column; gap: 2px; }
.ent-bar span { font-size: 11px; color: #94a3b8; }
.ent-bar strong { font-size: 14px; }
.ent-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; padding: 3px 0; color: #475569; }
.ent-line > span:first-child { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.ent-line small { color: #94a3b8; }
.pos { color: var(--color-success-text, #047857); }
.neg { color: var(--color-danger-text, #b91c1c); }
</style>
