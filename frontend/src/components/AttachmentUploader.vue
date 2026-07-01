<script setup lang="ts">
// Adjuntar comprobantes (imagen/PDF) a una entidad. Si entityId existe, sube
// al instante; si es null (registro nuevo), guarda los archivos en memoria y el
// padre llama a flush(nuevoId) tras crear el registro.
import { onMounted, onBeforeUnmount, ref, computed, nextTick, watch } from 'vue';
import { Paperclip, Eye, Trash2, FileText, Image as ImageIcon, Pencil, Check, X } from 'lucide-vue-next';
import { attachmentsApi, type AttachmentMeta, type EntityType } from '../api/attachments';
import AttachmentViewer from './AttachmentViewer.vue';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';

const props = defineProps<{ entityType: EntityType; entityId: number | null }>();
const toast = useToast();
const { confirm } = useConfirm();

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

async function addFile(f: File) {
  if (!ALLOWED.includes(f.type)) { toast.error(`"${f.name}": solo imágenes o PDF.`); return; }
  if (f.size > MAX) { toast.error(`"${f.name}": máximo 8 MB.`); return; }
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

async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  for (const f of files) await addFile(f);
  input.value = '';
}

// Pegar imagen desde el portapapeles (ej. copiada de WhatsApp) o arrastrarla.
const dropActive = ref(false);
let pasteCount = 0;
async function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imgs: File[] = [];
  for (const it of Array.from(items)) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) imgs.push(f);
    }
  }
  if (!imgs.length) return; // pegar texto u otra cosa: no interferir
  e.preventDefault();
  for (const f of imgs) {
    // El portapapeles no trae nombre: generamos uno legible y único.
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const named = f.name && f.name !== 'image.png'
      ? f
      : new File([f], `comprobante-pegado-${++pasteCount}.${ext}`, { type: f.type });
    await addFile(named);
  }
  toast.success(imgs.length > 1 ? 'Imágenes pegadas.' : 'Imagen pegada.');
}
async function onDrop(e: DragEvent) {
  dropActive.value = false;
  const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
  if (!files.length) return;
  for (const f of files) await addFile(f);
}
onMounted(() => window.addEventListener('paste', onPaste));
onBeforeUnmount(() => window.removeEventListener('paste', onPaste));

const viewing = ref<AttachmentMeta | null>(null);
const viewerOpen = ref(false);
function view(a: AttachmentMeta) { viewing.value = a; viewerOpen.value = true; }
async function removeServer(a: AttachmentMeta) {
  if (!(await confirm({ message: `¿Eliminar "${a.filename}"?`, danger: true, confirmText: 'Eliminar' }))) return;
  try { await attachmentsApi.remove(a.id); list.value = list.value.filter((x) => x.id !== a.id); }
  catch { toast.error('No se pudo eliminar el comprobante.'); }
}
function removePending(i: number) {
  pending.value.splice(i, 1);
  if (editingIdx.value === i) cancelRename();
}

// ---- Renombrar un comprobante pendiente (antes de guardar) ----
const editingIdx = ref<number | null>(null);
const editValue = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
function bindRenameInput(el: unknown) { renameInput.value = (el as HTMLInputElement | null) ?? null; }
// Separa "factura.png" → { base: "factura", ext: ".png" } (sin extensión → ext "").
function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
}
const editingExt = computed(() => editingIdx.value != null ? splitName(pending.value[editingIdx.value].filename).ext : '');
async function startRename(i: number) {
  cancelRenameServer();
  editingIdx.value = i;
  editValue.value = splitName(pending.value[i].filename).base;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}
function commitRename() {
  if (editingIdx.value == null) return;
  const i = editingIdx.value;
  // Quita caracteres no válidos para nombre de archivo; conserva la extensión original.
  const base = editValue.value.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 100);
  if (base) pending.value[i].filename = base + splitName(pending.value[i].filename).ext;
  editingIdx.value = null;
}
function cancelRename() { editingIdx.value = null; }

// ---- Renombrar un comprobante YA subido (modo edición) ----
const editingServerId = ref<number | null>(null);
const editServerValue = ref('');
const savingName = ref(false);
const editingServerExt = computed(() => {
  if (editingServerId.value == null) return '';
  const a = list.value.find((x) => x.id === editingServerId.value);
  return a ? splitName(a.filename).ext : '';
});
async function startRenameServer(a: AttachmentMeta) {
  cancelRename();
  editingServerId.value = a.id;
  editServerValue.value = splitName(a.filename).base;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}
async function commitRenameServer() {
  if (editingServerId.value == null || savingName.value) return;
  const a = list.value.find((x) => x.id === editingServerId.value);
  if (!a) { editingServerId.value = null; return; }
  const base = editServerValue.value.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 100);
  const newName = base ? base + splitName(a.filename).ext : '';
  if (!newName || newName === a.filename) { editingServerId.value = null; return; }
  savingName.value = true;
  try {
    const updated = await attachmentsApi.rename(a.id, newName);
    const idx = list.value.findIndex((x) => x.id === a.id);
    if (idx !== -1) list.value[idx] = updated;
    toast.success('Nombre actualizado.');
  } catch { toast.error('No se pudo renombrar el comprobante.'); }
  finally { savingName.value = false; editingServerId.value = null; }
}
function cancelRenameServer() { editingServerId.value = null; }

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
    <div
      class="att-drop"
      :class="{ over: dropActive }"
      @click="pick"
      @dragover.prevent="dropActive = true"
      @dragenter.prevent="dropActive = true"
      @dragleave.prevent="dropActive = false"
      @drop.prevent="onDrop"
    >
      <Paperclip :size="15" />
      <span>{{ busy ? 'Subiendo…' : dropActive ? 'Suelta la imagen aquí' : 'Adjuntar comprobante' }}</span>
    </div>
    <small class="hint att-hint">Imagen o PDF, hasta 8 MB · arrastra o pega (Ctrl+V) una imagen copiada.</small>

    <ul v-if="list.length || pending.length" class="att-list">
      <li v-for="a in list" :key="'s' + a.id" class="att-item">
        <span class="att-ic"><component :is="isImg(a.mimeType) ? ImageIcon : FileText" :size="16" /></span>
        <template v-if="editingServerId === a.id">
          <span class="att-rename">
            <input
              :ref="bindRenameInput"
              v-model="editServerValue"
              class="att-rename-input"
              maxlength="100"
              placeholder="Nombre del comprobante"
              @keydown.enter.prevent="commitRenameServer"
              @keydown.esc.prevent="cancelRenameServer"
            />
            <span class="att-ext">{{ editingServerExt }}</span>
          </span>
          <button type="button" class="att-act ok" title="Guardar nombre" :disabled="savingName" @click="commitRenameServer"><Check :size="15" /></button>
          <button type="button" class="att-act" title="Cancelar" @click="cancelRenameServer"><X :size="15" /></button>
        </template>
        <template v-else>
          <span class="att-name" :title="a.filename">{{ a.filename }}</span>
          <span class="att-size">{{ fmtSize(a.size) }}</span>
          <button type="button" class="att-act" title="Renombrar" @click="startRenameServer(a)"><Pencil :size="15" /></button>
          <button type="button" class="att-act" title="Ver" @click="view(a)"><Eye :size="15" /></button>
          <button type="button" class="att-act danger" title="Eliminar" @click="removeServer(a)"><Trash2 :size="15" /></button>
        </template>
      </li>
      <li v-for="(p, i) in pending" :key="'p' + i" class="att-item pending">
        <span class="att-ic"><component :is="isImg(p.mimeType) ? ImageIcon : FileText" :size="16" /></span>
        <template v-if="editingIdx === i">
          <span class="att-rename">
            <input
              :ref="bindRenameInput"
              v-model="editValue"
              class="att-rename-input"
              maxlength="100"
              placeholder="Nombre del comprobante"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
            />
            <span class="att-ext">{{ editingExt }}</span>
          </span>
          <button type="button" class="att-act ok" title="Guardar nombre" @click="commitRename"><Check :size="15" /></button>
          <button type="button" class="att-act" title="Cancelar" @click="cancelRename"><X :size="15" /></button>
        </template>
        <template v-else>
          <span class="att-name" :title="p.filename">{{ p.filename }}</span>
          <span class="att-size">{{ fmtSize(p.size) }} · se subirá al guardar</span>
          <button type="button" class="att-act" title="Renombrar" @click="startRename(i)"><Pencil :size="15" /></button>
          <button type="button" class="att-act danger" title="Quitar" @click="removePending(i)"><Trash2 :size="15" /></button>
        </template>
      </li>
    </ul>

    <AttachmentViewer :open="viewerOpen" :attachment="viewing" @close="viewerOpen = false" />
  </div>
</template>

<style scoped>
.att { display: flex; flex-direction: column; gap: 6px; }
.att-input { display: none; }
.att-drop {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 14px;
  border: 1.5px dashed var(--color-border-strong, #cbd5e1);
  background: var(--color-surface, #fff);
  color: var(--color-text-soft, #475569);
  border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 13.5px;
  transition: all .15s ease;
}
.att-drop:hover { border-color: #6366f1; color: #4338ca; background: #eef2ff; }
.att-drop.over { border-color: #4338ca; color: #4338ca; background: #e0e7ff; border-style: solid; }
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
.att-act.ok { color: #059669; }
.att-act.ok:hover { background: #ecfdf5; color: #047857; }
.att-rename { flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 2px; }
.att-rename-input {
  flex: 1; min-width: 0; padding: 5px 8px; font-size: 13px; font-weight: 600; color: #0f172a;
  border: 1.5px solid var(--color-primary, #6366f1); border-radius: 7px; background: #fff; outline: none;
}
.att-ext { font-size: 12px; color: #94a3b8; font-weight: 600; flex-shrink: 0; }
</style>
