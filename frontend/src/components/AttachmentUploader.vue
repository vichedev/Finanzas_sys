<script setup lang="ts">
// Adjuntar comprobantes (imagen/PDF) a una entidad. Si entityId existe, sube
// al instante; si es null (registro nuevo), guarda los archivos en memoria y el
// padre llama a flush(nuevoId) tras crear el registro.
import { onMounted, ref, watch } from 'vue';
import { Paperclip, Eye, Trash2, FileText, Image as ImageIcon } from 'lucide-vue-next';
import { attachmentsApi, type AttachmentMeta, type EntityType } from '../api/attachments';
import AttachmentViewer from './AttachmentViewer.vue';
import { useToast } from '../composables/useToast';

const props = defineProps<{ entityType: EntityType; entityId: number | null }>();
const toast = useToast();

const ALLOWED = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'application/pdf'];
const MAX = 8 * 1024 * 1024;

const list = ref<AttachmentMeta[]>([]);
const pending = ref<{ filename: string; mimeType: string; dataBase64: string; size: number }[]>([]);
const busy = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const isImg = (m: string) => m.startsWith('image/');
const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

async function loadList() {
  if (props.entityId == null) { list.value = []; return; }
  try { list.value = await attachmentsApi.list(props.entityType, props.entityId); } catch { /* */ }
}
onMounted(loadList);
watch(() => props.entityId, loadList);

function pick() { fileInput.value?.click(); }

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  for (const f of files) {
    if (!ALLOWED.includes(f.type)) { toast.error(`"${f.name}": solo imágenes o PDF.`); continue; }
    if (f.size > MAX) { toast.error(`"${f.name}": máximo 8 MB.`); continue; }
    const dataBase64 = await readAsBase64(f);
    if (props.entityId != null) {
      busy.value = true;
      try {
        const meta = await attachmentsApi.upload({ entityType: props.entityType, entityId: props.entityId, filename: f.name, mimeType: f.type, dataBase64 });
        list.value.push(meta);
        toast.success('Comprobante adjuntado.');
      } catch { toast.error(`No se pudo subir "${f.name}".`); }
      finally { busy.value = false; }
    } else {
      pending.value.push({ filename: f.name, mimeType: f.type, dataBase64, size: f.size });
    }
  }
  input.value = '';
}

const viewing = ref<AttachmentMeta | null>(null);
const viewerOpen = ref(false);
function view(a: AttachmentMeta) { viewing.value = a; viewerOpen.value = true; }
async function removeServer(a: AttachmentMeta) {
  if (!confirm(`Eliminar "${a.filename}"?`)) return;
  try { await attachmentsApi.remove(a.id); list.value = list.value.filter((x) => x.id !== a.id); }
  catch { toast.error('No se pudo eliminar el comprobante.'); }
}
function removePending(i: number) { pending.value.splice(i, 1); }

/** Sube los pendientes tras crear el registro (lo llama el padre con el nuevo id). */
async function flush(newId: number) {
  for (const p of pending.value) {
    try { await attachmentsApi.upload({ entityType: props.entityType, entityId: newId, filename: p.filename, mimeType: p.mimeType, dataBase64: p.dataBase64 }); }
    catch { /* silencioso */ }
  }
  pending.value = [];
}
function reset() { pending.value = []; list.value = []; }
defineExpose({ flush, reset, hasPending: () => pending.value.length > 0 });
</script>

<template>
  <div class="att">
    <input ref="fileInput" type="file" accept="image/*,application/pdf" multiple class="att-input" @change="onFiles" />
    <button type="button" class="att-add" :disabled="busy" @click="pick">
      <Paperclip :size="15" /> {{ busy ? 'Subiendo…' : 'Adjuntar comprobante' }}
    </button>
    <small class="hint att-hint">Imagen o PDF, hasta 8 MB.</small>

    <ul v-if="list.length || pending.length" class="att-list">
      <li v-for="a in list" :key="'s' + a.id" class="att-item">
        <span class="att-ic"><component :is="isImg(a.mimeType) ? ImageIcon : FileText" :size="16" /></span>
        <span class="att-name" :title="a.filename">{{ a.filename }}</span>
        <span class="att-size">{{ fmtSize(a.size) }}</span>
        <button type="button" class="att-act" title="Ver" @click="view(a)"><Eye :size="15" /></button>
        <button type="button" class="att-act danger" title="Eliminar" @click="removeServer(a)"><Trash2 :size="15" /></button>
      </li>
      <li v-for="(p, i) in pending" :key="'p' + i" class="att-item pending">
        <span class="att-ic"><component :is="isImg(p.mimeType) ? ImageIcon : FileText" :size="16" /></span>
        <span class="att-name" :title="p.filename">{{ p.filename }}</span>
        <span class="att-size">{{ fmtSize(p.size) }} · se subirá al guardar</span>
        <button type="button" class="att-act danger" title="Quitar" @click="removePending(i)"><Trash2 :size="15" /></button>
      </li>
    </ul>

    <AttachmentViewer :open="viewerOpen" :attachment="viewing" @close="viewerOpen = false" />
  </div>
</template>

<style scoped>
.att { display: flex; flex-direction: column; gap: 6px; }
.att-input { display: none; }
.att-add {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 14px;
  border: 1.5px dashed var(--color-border-strong, #cbd5e1);
  background: var(--color-surface, #fff);
  color: var(--color-text-soft, #475569);
  border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 13.5px;
  transition: all .15s ease;
}
.att-add:hover:not(:disabled) { border-color: #6366f1; color: #4338ca; background: #eef2ff; }
.att-add:disabled { opacity: .6; cursor: progress; }
.att-hint { color: var(--color-text-muted, #94a3b8); }
.att-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.att-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 9px; background: var(--color-surface, #fff); }
.att-item.pending { border-style: dashed; background: #fafafa; }
.att-ic { color: #64748b; flex-shrink: 0; display: inline-flex; }
.att-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-size { font-size: 11px; color: #94a3b8; white-space: nowrap; }
.att-act { background: transparent; border: none; color: #64748b; cursor: pointer; padding: 4px; border-radius: 6px; display: inline-flex; }
.att-act:hover { background: #f1f5f9; color: #0f172a; }
.att-act.danger:hover { background: #fef2f2; color: #dc2626; }
</style>
