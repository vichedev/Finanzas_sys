<script setup lang="ts">
// Visor de comprobantes en modal: muestra imágenes y PDF dentro del sistema,
// con opciones de abrir en pestaña nueva y descargar. Descarga el archivo con
// autenticación (axios) y lo expone como blob URL (se libera al cerrar).
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { ExternalLink, Download } from 'lucide-vue-next';
import AppModal from './AppModal.vue';
import { http } from '../api/http';
import { downloadAsFile, previewMime } from '../api/attachments';

const props = defineProps<{ open: boolean; attachment: { id: number; filename: string; mimeType: string } | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const url = ref<string | null>(null);
const loading = ref(false);
const error = ref('');

const downloading = ref(false);

// Solo imagen ráster y PDF se abren en el navegador; lo demás únicamente se descarga.
const mime = computed(() => previewMime(props.attachment?.mimeType));
const isPdf = computed(() => mime.value === 'application/pdf');

const fetchFile = async (id: number) =>
  (await http.get(`/attachments/${id}/file`, { responseType: 'blob' })).data as Blob;

function cleanup() {
  if (url.value) { URL.revokeObjectURL(url.value); url.value = null; }
}

async function loadFile() {
  cleanup();
  error.value = '';
  if (!props.open || !props.attachment || !mime.value) return;
  const type = mime.value;
  loading.value = true;
  try {
    // El tipo sale de la lista, no de la respuesta: el blob nunca se interpreta como otra cosa.
    url.value = URL.createObjectURL(new Blob([await fetchFile(props.attachment.id)], { type }));
  } catch {
    error.value = 'No se pudo cargar el archivo.';
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.attachment?.id], loadFile, { immediate: true });
onBeforeUnmount(cleanup);

function openTab() { if (url.value) window.open(url.value, '_blank'); }
async function download() {
  if (!props.attachment || downloading.value) return;
  downloading.value = true;
  error.value = '';
  try {
    downloadAsFile(await fetchFile(props.attachment.id), props.attachment.filename);
  } catch {
    error.value = 'No se pudo descargar el archivo.';
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <AppModal :open="open" :title="attachment?.filename || 'Documento'" max-width="900px" @close="emit('close')">
    <div class="viewer">
      <p v-if="loading" class="viewer-msg">Cargando…</p>
      <p v-else-if="error" class="viewer-msg viewer-err">{{ error }}</p>
      <p v-else-if="!mime" class="viewer-msg">Vista previa no disponible para este tipo. Usa “Descargar”.</p>
      <template v-else-if="url">
        <iframe v-if="isPdf" :src="url" class="viewer-pdf" title="Comprobante"></iframe>
        <img v-else :src="url" :alt="attachment?.filename" class="viewer-img" />
      </template>
    </div>
    <template #footer>
      <button type="button" class="ghost" :disabled="downloading" @click="download"><Download :size="15" /> Descargar</button>
      <button v-if="mime" type="button" class="ghost" @click="openTab" :disabled="!url"><ExternalLink :size="15" /> Abrir en pestaña</button>
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
