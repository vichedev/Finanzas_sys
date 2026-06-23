<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { http } from '../api/http';
import { FileText, Image as ImageIcon, Trash2, Eye, Upload, Landmark, Calendar } from 'lucide-vue-next';
import PageHeader from '../components/PageHeader.vue';
import PanelCard from '../components/PanelCard.vue';
import { useFormat } from '../composables/useFormat';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';

const { formatDate } = useFormat();
const toast = useToast();
const { confirm } = useConfirm();

interface Account { id: number; name: string; bankName?: string | null }
interface Statement {
  id: number; accountId: number | null; periodDate: string; title: string;
  filename: string; mimeType: string; size: number; notes?: string | null; createdAt: string;
  account?: { id: number; name: string; bankName?: string | null } | null;
}

const rows = ref<Statement[]>([]);
const accounts = ref<Account[]>([]);
const loading = ref(true);
const uploading = ref(false);

const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const form = ref<{ title: string; periodDate: string; accountId: number | null; notes: string; file: File | null }>({
  title: '', periodDate: todayYmd(), accountId: null, notes: '', file: null
});
const fileInput = ref<HTMLInputElement | null>(null);

async function load() {
  loading.value = true;
  try {
    const [s, a] = await Promise.all([http.get<Statement[]>('/statements'), http.get<Account[]>('/accounts')]);
    rows.value = s.data; accounts.value = a.data;
  } finally { loading.value = false; }
}
onMounted(load);

// Asigna el archivo (de input, pegado o arrastrado) y prefija el título si está vacío.
let pasteCount = 0;
function setFile(f: File | null) {
  if (f && !ALLOWED.includes(f.type)) { toast.error('Solo PDF o imágenes.'); return; }
  form.value.file = f;
  if (f && !form.value.title.trim()) form.value.title = f.name.replace(/\.[^.]+$/, '');
}
function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  setFile(input.files?.[0] || null);
}
function pick() { fileInput.value?.click(); }

// Pegar imagen (Ctrl+V) desde el portapapeles, o arrastrarla a la zona.
const dropActive = ref(false);
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of Array.from(items)) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (!f) continue;
      e.preventDefault();
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const named = f.name && f.name !== 'image.png' ? f : new File([f], `estado-pegado-${++pasteCount}.${ext}`, { type: f.type });
      setFile(named);
      toast.success('Imagen pegada. Ponle un título y súbela.');
      return;
    }
  }
}
function onDrop(e: DragEvent) {
  dropActive.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) setFile(f);
}
onMounted(() => window.addEventListener('paste', onPaste));
onBeforeUnmount(() => window.removeEventListener('paste', onPaste));

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function submit() {
  if (!form.value.file) { toast.error('Selecciona el archivo del estado de cuenta.'); return; }
  if (!form.value.title.trim()) { toast.error('Ponle un título.'); return; }
  if (!form.value.periodDate) { toast.error('Indica la fecha/período.'); return; }
  uploading.value = true;
  try {
    const dataBase64 = await readBase64(form.value.file);
    // El nombre del archivo guardado = el Título (saneado) + la extensión original.
    const origName = form.value.file.name || 'archivo';
    const ext = origName.includes('.') ? origName.slice(origName.lastIndexOf('.')) : '';
    const base = form.value.title.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 100) || 'estado';
    await http.post('/statements', {
      title: form.value.title.trim(),
      periodDate: form.value.periodDate,
      accountId: form.value.accountId || null,
      notes: form.value.notes.trim() || null,
      filename: base + ext,
      mimeType: form.value.file.type,
      dataBase64
    });
    toast.success('Estado de cuenta subido.');
    form.value = { title: '', periodDate: todayYmd(), accountId: null, notes: '', file: null };
    if (fileInput.value) fileInput.value.value = '';
    await load();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    toast.error(err?.response?.data?.message ?? 'No se pudo subir.');
  } finally { uploading.value = false; }
}

function fileUrl(s: Statement) { return `/api/statements/${s.id}/file`; }
const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const isImg = (m: string) => m.startsWith('image/');

async function remove(s: Statement) {
  if (!(await confirm({ message: `¿Eliminar el estado de cuenta "${s.title}"?`, danger: true, confirmText: 'Eliminar' }))) return;
  try { await http.delete(`/statements/${s.id}`); toast.success('Eliminado.'); await load(); }
  catch { toast.error('No se pudo eliminar.'); }
}

// Agrupa por año-mes para el listado cronológico.
const grouped = computed(() => {
  const map = new Map<string, Statement[]>();
  for (const s of rows.value) {
    const key = String(s.periodDate).slice(0, 7);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
});
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const groupLabel = (key: string) => { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Estados de cuenta" subtitle="Sube y consulta tus estados de cuenta bancarios ordenados por fecha." />

    <div class="stack">
      <PanelCard title="Subir estado de cuenta">
        <div class="st-form">
          <div class="field">
            <label for="st-title">Título <span class="required-mark">*</span></label>
            <input id="st-title" v-model="form.title" maxlength="160" placeholder="ej. Estado Banco Pichincha — mayo" />
          </div>
          <div class="field">
            <label for="st-date">Fecha / período <span class="required-mark">*</span></label>
            <input id="st-date" v-model="form.periodDate" type="date" :max="todayYmd()" />
          </div>
          <div class="field">
            <label for="st-acc">Cuenta</label>
            <select id="st-acc" v-model.number="form.accountId">
              <option :value="null">Sin cuenta específica</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ [a.name, a.bankName].filter(Boolean).join(' · ') }}</option>
            </select>
          </div>
          <div class="field">
            <label for="st-notes">Notas</label>
            <input id="st-notes" v-model="form.notes" maxlength="500" placeholder="Opcional" />
          </div>
          <div class="field st-file-field">
            <label>Archivo (PDF o imagen) <span class="required-mark">*</span></label>
            <input ref="fileInput" type="file" accept="application/pdf,image/*" class="st-file-input" @change="onFile" />
            <div
              class="st-drop"
              :class="{ over: dropActive, has: !!form.file }"
              @click="pick"
              @dragover.prevent="dropActive = true"
              @dragenter.prevent="dropActive = true"
              @dragleave.prevent="dropActive = false"
              @drop.prevent="onDrop"
            >
              <Upload :size="16" />
              <span v-if="form.file">{{ form.file.name }} — listo para subir</span>
              <span v-else-if="dropActive">Suelta el archivo aquí</span>
              <span v-else>Haz clic para elegir, arrastra, o pega una imagen (Ctrl+V)</span>
            </div>
            <small class="hint">El archivo se guardará con el <strong>Título</strong> de arriba (edítalo para renombrarlo).</small>
          </div>
          <div class="st-actions">
            <button type="button" :disabled="uploading" @click="submit"><Upload :size="16" /> {{ uploading ? 'Subiendo…' : 'Subir' }}</button>
          </div>
        </div>
      </PanelCard>

      <PanelCard title="Historial" :hint="`${rows.length} documento${rows.length === 1 ? '' : 's'}`">
        <p v-if="loading" class="hint">Cargando…</p>
        <div v-else-if="!rows.length" class="empty-state">
          <div class="empty-state-illustration"><FileText :size="36" /></div>
          <strong>Aún no hay estados de cuenta</strong>
          <p>Sube el primero con el formulario de arriba.</p>
        </div>
        <div v-else class="st-timeline">
          <div v-for="[key, items] in grouped" :key="key" class="st-group">
            <div class="st-group-head"><Calendar :size="14" /> {{ groupLabel(key) }}</div>
            <div v-for="s in items" :key="s.id" class="st-item">
              <span class="st-ic"><component :is="isImg(s.mimeType) ? ImageIcon : FileText" :size="18" /></span>
              <div class="st-body">
                <strong>{{ s.title }}</strong>
                <small>
                  {{ formatDate(s.periodDate) }}
                  <template v-if="s.account"> · <Landmark :size="11" /> {{ s.account.name }}</template>
                  · {{ fmtSize(s.size) }}
                  <template v-if="s.notes"> · {{ s.notes }}</template>
                </small>
              </div>
              <a class="st-act" :href="fileUrl(s)" target="_blank" rel="noopener" title="Ver"><Eye :size="16" /></a>
              <button type="button" class="st-act danger" title="Eliminar" @click="remove(s)"><Trash2 :size="16" /></button>
            </div>
          </div>
        </div>
      </PanelCard>
    </div>
  </section>
</template>

<style scoped>
.st-form { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.st-form .field { display: flex; flex-direction: column; gap: 4px; }
.st-form label { font-size: 13px; font-weight: 600; color: #334155; }
.st-form input, .st-form select { padding: 8px 10px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; font: inherit; color: #334155; }
.st-file-field, .st-actions { grid-column: 1 / -1; }
.st-file-input { display: none; }
.st-drop {
  display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  border: 1.5px dashed var(--color-border-strong, #cbd5e1); border-radius: 10px;
  background: #fff; color: var(--color-text-soft, #475569); font-weight: 600; font-size: 13.5px; cursor: pointer;
  transition: all .15s ease;
}
.st-drop:hover { border-color: #6366f1; color: #4338ca; background: #eef2ff; }
.st-drop.over { border-color: #4338ca; color: #4338ca; background: #e0e7ff; border-style: solid; }
.st-drop.has { border-color: #10b981; color: #047857; background: #ecfdf5; border-style: solid; }
.st-actions button { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border: none; border-radius: 10px; background: var(--color-primary, #2563eb); color: #fff; font-weight: 600; cursor: pointer; }
.st-actions button:disabled { opacity: .6; cursor: progress; }
.st-timeline { display: flex; flex-direction: column; gap: 14px; }
.st-group-head { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #64748b; margin-bottom: 6px; }
.st-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 10px; background: #fff; margin-bottom: 6px; }
.st-ic { color: #64748b; flex: none; display: inline-flex; }
.st-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.st-body strong { font-size: 14px; color: #0f172a; }
.st-body small { font-size: 12px; color: #94a3b8; display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.st-act { display: inline-grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; background: #fff; color: #475569; cursor: pointer; text-decoration: none; }
.st-act:hover { background: #f1f5f9; color: #0f172a; }
.st-act.danger:hover { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
@media (max-width: 640px) { .st-form { grid-template-columns: 1fr; } }
</style>
