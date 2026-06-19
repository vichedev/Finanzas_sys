<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { http } from '../api/http';
import { Scale, Landmark, CreditCard, TrendingUp, TrendingDown, Building2, User } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import { useFormat } from '../composables/useFormat';
import type { EntityKind } from '../types';

const { formatMoney } = useFormat();

interface Account { id: number; name: string; type: string; currentBalance: number | string; entityName?: string | null; entityKind?: EntityKind; bankName?: string | null; isActive?: boolean }
interface Card { id: number; name: string; type: 'CREDIT' | 'DEBIT'; currentBalance: number | string; creditLimit?: number | string | null; entityName?: string | null; entityKind?: EntityKind; bankName?: string | null; isActive?: boolean }

const accounts = ref<Account[]>([]);
const cards = ref<Card[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const [a, c] = await Promise.all([http.get<Account[]>('/accounts'), http.get<Card[]>('/cards')]);
    accounts.value = a.data; cards.value = c.data;
  } finally { loading.value = false; }
}
onMounted(load);

const num = (v: unknown) => Number(v ?? 0);
const UNASSIGNED = 'Sin razón social';

interface Group {
  name: string;
  kind: EntityKind;
  accounts: Account[];
  cards: Card[];
  liquid: number;      // dinero disponible (cuentas + tarjetas de débito)
  cardDebt: number;    // deuda en tarjetas de crédito (saldo usado)
  net: number;         // patrimonio neto = liquid - cardDebt
}

// Agrupa cuentas y tarjetas por razón social.
const groups = computed<Group[]>(() => {
  const map = new Map<string, Group>();
  const ensure = (name: string, kind: EntityKind): Group => {
    const key = name || UNASSIGNED;
    let g = map.get(key);
    if (!g) { g = { name: key, kind, accounts: [], cards: [], liquid: 0, cardDebt: 0, net: 0 }; map.set(key, g); }
    return g;
  };
  for (const a of accounts.value) {
    const g = ensure(a.entityName?.trim() || UNASSIGNED, a.entityKind || 'PERSONAL');
    g.accounts.push(a);
    g.liquid += num(a.currentBalance);
  }
  for (const c of cards.value) {
    const g = ensure(c.entityName?.trim() || UNASSIGNED, c.entityKind || 'PERSONAL');
    g.cards.push(c);
    if (c.type === 'CREDIT') g.cardDebt += Math.max(0, num(c.currentBalance));
    else g.liquid += num(c.currentBalance);
  }
  const list = [...map.values()];
  for (const g of list) g.net = g.liquid - g.cardDebt;
  // Orden: por patrimonio neto desc, dejando "Sin razón social" al final.
  return list.sort((x, y) => (x.name === UNASSIGNED ? 1 : y.name === UNASSIGNED ? -1 : y.net - x.net));
});

const personalGroups = computed(() => groups.value.filter((g) => g.kind === 'PERSONAL'));
const businessGroups = computed(() => groups.value.filter((g) => g.kind === 'BUSINESS'));

const totals = computed(() => {
  const sum = (arr: Group[]) => arr.reduce((a, g) => ({ liquid: a.liquid + g.liquid, cardDebt: a.cardDebt + g.cardDebt, net: a.net + g.net }), { liquid: 0, cardDebt: 0, net: 0 });
  return { all: sum(groups.value), personal: sum(personalGroups.value), business: sum(businessGroups.value) };
});

// Análisis: entidad con más patrimonio y su participación.
const topEntity = computed(() => groups.value.filter((g) => g.name !== UNASSIGNED).slice().sort((a, b) => b.net - a.net)[0] || null);
const netTotalAbs = computed(() => groups.value.reduce((a, g) => a + Math.abs(g.net), 0) || 1);
const sharePct = (g: Group) => Math.round((Math.abs(g.net) / netTotalAbs.value) * 100);
const hasUnassigned = computed(() => groups.value.some((g) => g.name === UNASSIGNED));
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Razones sociales" subtitle="Consolidado de saldos por entidad: personal y empresarial." />

    <p v-if="loading" class="dash-loading">Cargando…</p>

    <template v-else>
      <!-- Resumen global -->
      <div class="ent-kpis">
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
          <span class="ent-kpi-label"><User :size="15" /> Personal vs <Building2 :size="15" /> Empresa</span>
          <strong class="ent-kpi-value">{{ formatMoney(totals.personal.net) }} · {{ formatMoney(totals.business.net) }}</strong>
          <small>Patrimonio neto por naturaleza</small>
        </div>
      </div>

      <!-- Análisis inteligente -->
      <PanelCard v-if="topEntity || hasUnassigned" title="Análisis">
        <ul class="ent-insights">
          <li v-if="topEntity">
            <strong>{{ topEntity.name }}</strong> concentra el mayor patrimonio neto
            (<strong :class="topEntity.net >= 0 ? 'pos' : 'neg'">{{ formatMoney(topEntity.net) }}</strong>, ~{{ sharePct(topEntity) }}% del total).
          </li>
          <li v-if="totals.all.cardDebt > 0">
            La deuda de tarjetas representa
            <strong class="neg">{{ Math.round((totals.all.cardDebt / (totals.all.liquid || 1)) * 100) }}%</strong>
            de tu liquidez disponible.
          </li>
          <li v-if="businessGroups.length && personalGroups.length">
            Tienes <strong>{{ personalGroups.length }}</strong> entidad(es) personal(es) y
            <strong>{{ businessGroups.length }}</strong> empresarial(es).
          </li>
          <li v-if="hasUnassigned" class="warn">
            Hay cuentas/tarjetas <strong>sin razón social asignada</strong>. Edítalas en Cuentas o Tarjetas para incluirlas en el análisis por entidad.
          </li>
        </ul>
      </PanelCard>

      <!-- Grupos por naturaleza -->
      <template v-for="(section, idx) in [{ title: 'Personal', icon: User, items: personalGroups }, { title: 'Empresarial', icon: Building2, items: businessGroups }]" :key="idx">
        <div v-if="section.items.length" class="ent-section">
          <h2 class="ent-section-title"><component :is="section.icon" :size="18" /> {{ section.title }}</h2>
          <div class="ent-grid">
            <div v-for="g in section.items" :key="g.name" class="ent-card">
              <div class="ent-card-head">
                <span class="ent-card-name">{{ g.name }}</span>
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
                <p v-if="!g.accounts.length && !g.cards.length" class="hint">Sin cuentas ni tarjetas.</p>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div v-if="!groups.length" class="empty-state">
        <div class="empty-state-illustration"><Scale :size="36" /></div>
        <strong>Aún no hay cuentas ni tarjetas</strong>
        <p>Crea cuentas y tarjetas, y asígnales una razón social para verlas consolidadas aquí.</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ent-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 16px; }
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
