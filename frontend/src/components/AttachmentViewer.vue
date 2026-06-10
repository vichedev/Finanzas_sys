<script setup lang="ts">
// Visor de comprobantes en modal: muestra imágenes y PDF dentro del sistema,
// con opciones de abrir en pestaña nueva y descargar. Descarga el archivo con
// autenticación (axios) y lo expone como blob URL (se libera al cerrar).
import { ref, watch, onBeforeUnmount } from 'vue';
import { ExternalLink, Download } from 'lucide-vue-next';
import AppModal from './AppModal.vue';
import { http } from '../api/http';

const props = defineProps<{ open: boolean; attachment: { id: number; filename: string; mimeType: string } | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const url = ref<string | null>(null);
const loading = ref(false);
const error = ref('');

const isImage = (m?: string) => !!m && m.startsWith('image/');
const isPdf = (m?: string) => m === 'application/pdf';

function cleanup() {
  if (url.value) { URL.revokeObjectURL(url.value); url.value = null; }
}

async function loadFile() {
  cleanup();
  error.value = '';
  if (!props.open || !props.attachment) return;
  loading.value = true;
  try {
    const { data } = await http.get(`/attachments/${props.attachment.id}/file`, { responseType: 'blob' });
    url.value = URL.createObjectURL(data as Blob);
  } catch {
    error.value = 'No se pudo cargar el archivo.';
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.attachment?.id], loadFile, { immediate: true });
onBeforeUnmount(cleanup);

function openTab() { if (url.value) window.open(url.value, '_blank'); }
function download() {
  if (!url.value || !props.attachment) return;
  const a = document.createElement('a');
  a.href = url.value;
  a.download = props.attachment.filename;
  document.body.appendChild(a); a.click(); a.remove();
}
</script>

<template>
  <AppModal :open="open" :title="attachment?.filename || 'Documento'" max-width="900px" @close="emit('close')">
    <div class="viewer">
      <p v-if="loading" class="viewer-msg">Cargando…</p>
      <p v-else-if="error" class="viewer-msg viewer-err">{{ error }}</p>
      <template v-else-if="url">
        <img v-if="isImage(attachment?.mimeType)" :src="url" :alt="attachment?.filename" class="viewer-img" />
        <iframe v-else-if="isPdf(attachment?.mimeType)" :src="url" class="viewer-pdf" title="Comprobante"></iframe>
        <p v-else class="viewer-msg">Vista previa no disponible para este tipo. Usa “Descargar” o “Abrir en pestaña”.</p>
      </template>
    </div>
    <template #footer>
      <button type="button" class="ghost" @click="download"><Download :size="15" /> Descargar</button>
      <button type="button" class="ghost" @click="openTab" :disabled="!url"><ExternalLink :size="15" /> Abrir en pestaña</button>
    </template>
  </AppModal>
</template>

<style scoped>
.viewer { display: flex; align-items: center; justify-content: center; min-height: 200px; }
.viewer-msg { color: #64748b; font-size: 14px; padding: 30px; text-align: center; }
.viewer-err { color: #dc2626; }
.viewer-img { max-width: 100%; max-height: 70vh; border-radius: 8px; display: block; }
.viewer-pdf { width: 100%; height: 70vh; border: none; border-radius: 8px; }
</style>
