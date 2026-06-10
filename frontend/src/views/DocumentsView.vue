<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { FileText, Image as ImageIcon, Eye, ExternalLink, Search, FolderOpen, X } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import { attachmentsApi, type DocAttachment } from '../api/attachments';
import { useToast } from '../composables/useToast';

const router = useRouter();
const toast = useToast();
const docs = ref<DocAttachment[]>([]);
const loading = ref(true);

const search = ref('');
const fileType = ref<'all' | 'image' | 'pdf'>('all');
const origin = ref<'all' | 'MOVEMENT' | 'INVOICE' | 'DEBT'>('all');
const from = ref('');
const to = ref('');
const sortDir = ref<'desc' | 'asc'>('desc');

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const ORIGIN_TABS: { value: typeof origin.value; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'MOVEMENT', label: 'Movimientos' },
  { value: 'INVOICE', label: 'Facturas' },
  { value: 'DEBT', label: 'Deudas' }
];

const isImage = (m: string) => m.startsWith('image/');
const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fmtDate = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const ym = (v: string) => String(v).slice(0, 10);

const hasFilters = computed(() =>
  !!search.value || fileType.value !== 'all' || origin.value !== 'all' || !!from.value || !!to.value
);

function clearFilters() {
  search.value = ''; fileType.value = 'all'; origin.value = 'all'; from.value = ''; to.value = '';
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = docs.value.filter((d) => {
    if (origin.value !== 'all' && d.entityType !== origin.value) return false;
    if (fileType.value === 'image' && !isImage(d.mimeType)) return false;
    if (fileType.value === 'pdf' && d.mimeType !== 'application/pdf') return false;
    const date = ym(d.contextDate);
    if (from.value && date < from.value) return false;
    if (to.value && date > to.value) return false;
    if (q && !(`${d.filename} ${d.contextLabel} ${d.entityLabel}`.toLowerCase().includes(q))) return false;
    return true;
  });
  list.sort((a, b) => {
    const da = new Date(a.contextDate).getTime();
    const db = new Date(b.contextDate).getTime();
    return sortDir.value === 'desc' ? db - da : da - db;
  });
  return list;
});

const totalSize = computed(() => filtered.value.reduce((s, d) => s + d.size, 0));

// Agrupado por "Mes Año" para orden cronológico claro
const groups = computed(() => {
  const map = new Map<string, DocAttachment[]>();
  for (const d of filtered.value) {
    const dt = new Date(d.contextDate);
    const key = Number.isNaN(dt.getTime()) ? 'Sin fecha' : `${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(d);
  }
  return Array.from(map, ([label, items]) => ({ label, items }));
});

async function view(d: DocAttachment) {
  try { await attachmentsApi.openFile(d.id); } catch { toast.error('No se pudo abrir el archivo.'); }
}
function goTo(d: DocAttachment) { if (d.link) router.push(d.link); }

async function load() {
  loading.value = true;
  try { docs.value = await attachmentsApi.listAll(); }
  catch { toast.error('No se pudieron cargar los documentos.'); }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Documentos" subtitle="Busca y consulta todos tus comprobantes adjuntos." />

    <PanelCard>
      <div class="doc-filters">
        <div class="doc-search">
          <Search :size="16" class="doc-search-ic" />
          <input v-model="search" type="search" placeholder="Buscar por nombre o concepto…" />
        </div>
        <select v-model="fileType" aria-label="Tipo de archivo">
          <option value="all">Todo tipo</option>
          <option value="image">Imágenes</option>
          <option value="pdf">PDF</option>
        </select>
        <input v-model="from" type="date" aria-label="Desde" title="Desde" />
        <input v-model="to" type="date" aria-label="Hasta" title="Hasta" />
        <select v-model="sortDir" aria-label="Orden">
          <option value="desc">Más recientes primero</option>
          <option value="asc">Más antiguos primero</option>
        </select>
        <button v-if="hasFilters" type="button" class="doc-clear" @click="clearFilters"><X :size="14" /> Limpiar</button>
      </div>

      <div class="doc-tabs">
        <button
          v-for="t in ORIGIN_TABS"
          :key="t.value"
          type="button"
          class="doc-tab"
          :class="{ active: origin === t.value }"
          @click="origin = t.value"
        >{{ t.label }}</button>
        <span class="doc-count">{{ filtered.length }} documento{{ filtered.length === 1 ? '' : 's' }} · {{ fmtSize(totalSize) }}</span>
      </div>
    </PanelCard>

    <p v-if="loading" class="dash-loading">Cargando documentos…</p>

    <PanelCard v-else-if="!filtered.length">
      <div class="empty-state">
        <div class="empty-state-illustration"><FolderOpen :size="36" /></div>
        <strong>{{ docs.length ? 'Sin resultados' : 'Aún no hay comprobantes' }}</strong>
        <p>{{ docs.length ? 'Ajusta la búsqueda o los filtros.' : 'Adjunta comprobantes en Movimientos o Facturas para verlos aquí.' }}</p>
      </div>
    </PanelCard>

    <template v-else>
      <div v-for="g in groups" :key="g.label" class="doc-group">
        <h3 class="doc-group-title">{{ g.label }} <span>{{ g.items.length }}</span></h3>
        <div class="doc-grid">
          <article v-for="d in g.items" :key="d.id" class="doc-card">
            <div class="doc-card-ic" :class="isImage(d.mimeType) ? 'img' : 'pdf'">
              <component :is="isImage(d.mimeType) ? ImageIcon : FileText" :size="22" />
            </div>
            <div class="doc-card-body">
              <strong class="doc-card-name" :title="d.filename">{{ d.filename }}</strong>
              <span class="doc-card-ctx">
                <span class="doc-badge" :class="'b-' + d.entityType.toLowerCase()">{{ d.entityLabel }}</span>
                {{ d.contextLabel }}
              </span>
              <span class="doc-card-meta">{{ fmtDate(d.contextDate) }} · {{ fmtSize(d.size) }}</span>
            </div>
            <div class="doc-card-acts">
              <button type="button" class="doc-act" title="Ver" @click="view(d)"><Eye :size="16" /></button>
              <button v-if="d.link" type="button" class="doc-act" title="Ir al registro" @click="goTo(d)"><ExternalLink :size="16" /></button>
            </div>
          </article>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.doc-filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.doc-search { position: relative; flex: 1; min-width: 200px; }
.doc-search-ic { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #94a3b8; }
.doc-search input { width: 100%; padding-left: 36px; }
.doc-filters select, .doc-filters input[type="date"] { padding: 9px 12px; border: 1px solid #e2e8f0; border-radius: 9px; background: #fff; font-size: 13.5px; }
.doc-clear { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 1px solid #e2e8f0; color: #64748b; border-radius: 9px; padding: 8px 12px; font-size: 13px; font-weight: 600; cursor: pointer; }
.doc-clear:hover { background: #f8fafc; color: #0f172a; }

.doc-tabs { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.doc-tab { background: transparent; border: 1px solid #e2e8f0; border-radius: 999px; padding: 5px 14px; font-size: 13px; font-weight: 600; color: #475569; cursor: pointer; transition: all .15s ease; }
.doc-tab:hover { background: #f1f5f9; }
.doc-tab.active { background: #0f172a; color: #fff; border-color: #0f172a; }
.doc-count { margin-left: auto; font-size: 12.5px; color: #94a3b8; }

.doc-group { margin-top: 22px; }
.doc-group-title { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
.doc-group-title span { background: #f1f5f9; color: #475569; border-radius: 999px; padding: 1px 8px; font-size: 11px; }
.doc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.doc-card { display: flex; align-items: center; gap: 12px; background: var(--color-surface, #fff); border: 1px solid var(--color-border, #e2e8f0); border-radius: 12px; padding: 12px 14px; }
.doc-card-ic { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; border-radius: 10px; }
.doc-card-ic.img { background: #eff6ff; color: #2563eb; }
.doc-card-ic.pdf { background: #fef2f2; color: #dc2626; }
.doc-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.doc-card-name { font-size: 13.5px; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-card-ctx { font-size: 12px; color: #475569; display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-card-meta { font-size: 11px; color: #94a3b8; }
.doc-badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 1px 6px; border-radius: 999px; flex-shrink: 0; }
.b-movement { background: #eef2ff; color: #4338ca; }
.b-invoice { background: #ecfdf5; color: #047857; }
.b-debt { background: #fff7ed; color: #c2410c; }
.doc-card-acts { display: flex; gap: 4px; flex-shrink: 0; }
.doc-act { background: transparent; border: 1px solid #e2e8f0; color: #64748b; border-radius: 8px; padding: 6px; cursor: pointer; display: inline-flex; }
.doc-act:hover { background: #f8fafc; color: #0f172a; border-color: #cbd5e1; }
</style>
