<script setup lang="ts">
// Importación de facturas desde XML autorizados del SRI: selección de archivos,
// revisión de lo que entendió el servidor y confirmación. Las cifras son de solo
// lectura: salen del comprobante y aquí no se editan.
import { computed, ref, watch } from 'vue';
import { FileText, Upload, X } from 'lucide-vue-next';
import AppButton from './AppButton.vue';
import AppModal from './AppModal.vue';
import { invoiceImportApi, type ImportConfirmItem, type ImportConfirmResult, type ImportDraft, type ImportFile, type ImportItemStatus, type ImportPreviewItem } from '../api/invoiceImport';
import { confirmState, useConfirm, type ConfirmOptions } from '../composables/useConfirm';
import { useFormat } from '../composables/useFormat';

const props = defineProps<{
  open: boolean;
  entities: { id: number; name: string }[];
  accounts: { id: number; label: string }[];
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'imported'): void }>();

const { confirm } = useConfirm();
const { formatMoney } = useFormat();

const MAX_FILES = 50;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILENAME_LENGTH = 200; // Límite del backend: más largo, devuelve el nombre recortado.
// Tamaño del cuerpo JSON de la petición, no de los archivos: el base64 ocupa un tercio más.
const MAX_REQUEST_BYTES = 12_000_000;
const ITEM_OVERHEAD_BYTES = 200;
const CONSUMER_FINAL_TAX_ID = '9999999999999';

type Stage = 'select' | 'review' | 'result';
type InvoiceKindChoice = 'SALE' | 'PURCHASE';

interface PickedFile extends ImportFile { size: number }

interface ReviewLine {
  key: number;
  filename: string;
  contentBase64: string;
  status: ImportItemStatus;
  errorMessage: string;
  draft: ImportDraft | null;
  duplicateOf: ImportPreviewItem['duplicateOf'] | null;
  selected: boolean;
  kind: InvoiceKindChoice | null;
  entityId: number | null;
  accountId: number | null;
  paid: boolean;
  allowDuplicate: boolean;
}

const stage = ref<Stage>('select');
const picked = ref<PickedFile[]>([]);
const rejected = ref<{ filename: string; message: string }[]>([]);
const lines = ref<ReviewLine[]>([]);
const result = ref<ImportConfirmResult | null>(null);
const dropActive = ref(false);
const reading = ref(false);
const previewing = ref(false);
const sending = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

// Una confirmación intentada pudo crear facturas aunque la respuesta no llegara.
let needsRefresh = false;
// Cada apertura o cierre invalida lo que aún esté en curso de la sesión anterior.
let session = 0;
// AppModal y ConfirmHost escuchan ESC a la vez: el ESC que cierra un aviso no debe cerrar también este modal.
let dialogOpen = false;

function reset() {
  session++;
  stage.value = 'select';
  picked.value = [];
  rejected.value = [];
  lines.value = [];
  result.value = null;
  dropActive.value = false;
  reading.value = false;
  previewing.value = false;
  needsRefresh = false;
}
watch(() => props.open, reset);

// ConfirmHost libera el scroll del fondo al cerrarse, aunque este modal siga abierto.
watch(() => confirmState.open, (isOpen) => {
  if (!isOpen && props.open) document.body.style.overflow = 'hidden';
}, { flush: 'post' });

async function dialog(options: ConfirmOptions): Promise<boolean> {
  dialogOpen = true;
  try {
    return await confirm(options);
  } finally {
    setTimeout(() => { dialogOpen = false; });
  }
}
const notify = (message: string, title = 'Aviso') => dialog({ message, title, alert: true });

const errorText = (err: unknown, fallback: string): string => {
  const response = (err as { response?: { status?: number; data?: { message?: unknown } } }).response;
  const message = response?.data?.message;
  if (typeof message === 'string' && message) return message;
  if (response?.status === 429) return 'Demasiadas solicitudes seguidas. Espera un momento y vuelve a intentarlo.';
  if (response?.status === 413) return 'El envío supera el tamaño que acepta el servidor. Prueba con menos archivos a la vez.';
  return fallback;
};

// ---- Selección ----
function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // Por encima de unos 100 000 argumentos, fromCharCode desborda la pila.
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const looksLikeXml = (file: File) =>
  file.name.toLowerCase().endsWith('.xml') || file.type === 'text/xml' || file.type === 'application/xml';

async function addFiles(files: File[]) {
  if (reading.value || !files.length) return;
  const run = session;
  reading.value = true;
  rejected.value = [];
  for (const file of files) {
    const refuse = (message: string) => rejected.value.push({ filename: file.name, message });
    if (!looksLikeXml(file)) { refuse('No es un archivo XML.'); continue; }
    if (file.name.length > MAX_FILENAME_LENGTH) { refuse(`El nombre supera los ${MAX_FILENAME_LENGTH} caracteres.`); continue; }
    if (file.size === 0) { refuse('El archivo está vacío.'); continue; }
    if (file.size > MAX_FILE_BYTES) { refuse('Supera el máximo de 512 KB por archivo.'); continue; }
    if (picked.value.length >= MAX_FILES) { refuse(`Se superó el máximo de ${MAX_FILES} archivos.`); continue; }
    try {
      const contentBase64 = bytesToBase64(await file.arrayBuffer());
      if (run !== session) return;
      if (picked.value.some((p) => p.contentBase64 === contentBase64)) { refuse('Este archivo ya está en la selección.'); continue; }
      picked.value.push({ filename: file.name, contentBase64, size: file.size });
    } catch {
      if (run !== session) return;
      refuse('No se pudo leer el archivo.');
    }
  }
  reading.value = false;
}

function onInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = input.files ? Array.from(input.files) : [];
  input.value = ''; // Permite volver a elegir el mismo archivo.
  void addFiles(files);
}

function onDrop(event: DragEvent) {
  dropActive.value = false;
  void addFiles(event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : []);
}

function requestBytes(files: ImportFile[]): number {
  return files.reduce((sum, f) => sum + f.contentBase64.length + f.filename.length + ITEM_OVERHEAD_BYTES, 0);
}

const fmtSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

const pickedRequestBytes = computed(() => requestBytes(picked.value));
const TOO_BIG_MESSAGE = 'Los archivos superan los 12 MB que se pueden enviar de una vez. Quita algunos e impórtalos en otra tanda.';

// ---- Revisión ----
function toLine(item: ImportPreviewItem, file: ImportFile, key: number): ReviewLine {
  const draft = item.draft ?? null;
  return {
    key,
    filename: item.filename,
    contentBase64: file.contentBase64,
    status: item.status,
    errorMessage: item.error?.message ?? '',
    draft,
    duplicateOf: item.duplicateOf ?? null,
    selected: !!draft && (item.status === 'READY' || item.status === 'NEEDS_KIND'),
    kind: draft?.kind ?? null,
    entityId: draft?.entityId ?? null,
    accountId: null,
    paid: false,
    allowDuplicate: false
  };
}

async function runPreview() {
  if (previewing.value || reading.value || !picked.value.length) return;
  if (pickedRequestBytes.value >= MAX_REQUEST_BYTES) { await notify(TOO_BIG_MESSAGE); return; }
  const run = session;
  const sent: ImportFile[] = picked.value.map((f) => ({ filename: f.filename, contentBase64: f.contentBase64 }));
  previewing.value = true;
  try {
    const items = await invoiceImportApi.preview(sent);
    if (run !== session) return;
    // Cada línea reenvía sus propios bytes: si el orden no coincide, se podría importar el archivo equivocado.
    if (items.length !== sent.length || items.some((item, i) => item.filename !== sent[i].filename)) {
      await notify('La respuesta del servidor no coincide con los archivos enviados. No se importó nada.');
      return;
    }
    lines.value = items.map((item, i) => toLine(item, sent[i], i));
    stage.value = 'review';
  } catch (err) {
    if (run !== session) return;
    await notify(errorText(err, 'No se pudieron revisar los archivos.'));
  } finally {
    if (run === session) previewing.value = false;
  }
}

const isPossibleDuplicate = (line: ReviewLine) =>
  !!line.draft && line.status === 'DUPLICATE' && line.duplicateOf?.source === 'NUMBER_AND_TAX_ID';

// Los duplicados por clave de acceso y los errores no se pueden seleccionar nunca.
function isSelectable(line: ReviewLine): boolean {
  if (!line.draft || line.status === 'ERROR') return false;
  if (line.status === 'DUPLICATE') return isPossibleDuplicate(line) && line.allowDuplicate;
  return true;
}

const canChooseKind = (line: ReviewLine) => !!line.draft && (line.status === 'NEEDS_KIND' || isPossibleDuplicate(line) && !line.draft.kind);
const hasOptions = (line: ReviewLine) => !!line.draft && line.status !== 'ERROR' && (line.status !== 'DUPLICATE' || isPossibleDuplicate(line));

function onAllowDuplicate(line: ReviewLine) {
  line.selected = line.allowDuplicate;
}

function counterpartyOf(line: ReviewLine): { name: string; taxId: string } {
  const draft = line.draft;
  if (!draft) return { name: '', taxId: '' };
  if (line.status === 'NEEDS_KIND' || !draft.kind) {
    if (line.kind === 'SALE') return { name: draft.buyerName, taxId: draft.buyerTaxId };
    if (line.kind === 'PURCHASE') return { name: draft.issuerName, taxId: draft.issuerTaxId };
    return { name: '', taxId: '' };
  }
  return { name: draft.counterparty, taxId: draft.counterpartyTaxId };
}

// Una compra a nombre de consumidor final no sustenta crédito tributario: el servidor la omite.
const isConsumerFinalPurchase = (line: ReviewLine) =>
  line.kind === 'PURCHASE' && line.draft?.buyerTaxId.trim() === CONSUMER_FINAL_TAX_ID;

const ownTaxId = (line: ReviewLine) => (line.kind === 'SALE' ? line.draft?.issuerTaxId : line.draft?.buyerTaxId) ?? '';

function statusOf(line: ReviewLine): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (line.status === 'ERROR' || !line.draft) return { label: 'Error', tone: 'bad' };
  if (line.status === 'DUPLICATE') return { label: 'Duplicada', tone: 'warn' };
  if (line.status === 'NEEDS_KIND' && !line.kind) return { label: 'Falta tipo', tone: 'warn' };
  return { label: 'Listo', tone: 'ok' };
}

function duplicateText(line: ReviewLine): string {
  const dup = line.duplicateOf;
  if (!dup) return 'Esta factura ya está registrada.';
  if (dup.source === 'ACCESS_KEY' && dup.id === 0) return 'Repetida en esta selección: tiene la misma clave de acceso que otro archivo.';
  const number = dup.number ? ` (${dup.number})` : '';
  return dup.source === 'ACCESS_KEY'
    ? `Ya importada${number}: tiene la misma clave de acceso, no se puede volver a importar.`
    : `Posible duplicada${number}: ya hay una factura con el mismo número y RUC.`;
}

// Las fechas del comprobante son texto YYYY-MM-DD: new Date() las correría un día en Ecuador.
function fmtDate(value: string): string {
  const parts = value.slice(0, 10).split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : '—';
}

const selectedLines = computed(() => lines.value.filter((line) => line.selected && isSelectable(line)));
const selectedWithoutKind = computed(() => selectedLines.value.filter((line) => !line.kind).length);
const canImport = computed(() => selectedLines.value.length > 0 && selectedWithoutKind.value === 0 && !sending.value);
const importLabel = computed(() => {
  const count = selectedLines.value.length;
  return `Importar ${count} factura${count === 1 ? '' : 's'}`;
});

function backToSelection() {
  lines.value = [];
  stage.value = 'select';
}

async function runConfirm() {
  if (!canImport.value) return;
  sending.value = true;
  const items: ImportConfirmItem[] = selectedLines.value.map((line) => ({
    filename: line.filename,
    contentBase64: line.contentBase64,
    kind: line.kind as InvoiceKindChoice,
    entityId: line.entityId,
    accountId: line.accountId,
    status: line.paid ? 'PAID' : 'ISSUED',
    ...(isPossibleDuplicate(line) ? { allowPossibleDuplicate: true } : {})
  }));
  needsRefresh = true;
  try {
    result.value = await invoiceImportApi.confirm(items);
    stage.value = 'result';
  } catch (err) {
    const answered = !!(err as { response?: unknown }).response;
    await notify(answered
      ? errorText(err, 'No se pudieron importar las facturas.')
      : 'No llegó la respuesta del servidor. Algunas facturas pudieron crearse: cierra y revisa el listado antes de volver a intentarlo.');
  } finally {
    sending.value = false;
  }
}

async function requestClose() {
  if (sending.value || dialogOpen) return;
  if (stage.value === 'review' && selectedLines.value.length) {
    const accepted = await dialog({
      title: 'Cerrar sin importar',
      message: 'Las facturas revisadas todavía no se han importado. ¿Cerrar de todas formas?',
      confirmText: 'Cerrar',
      cancelText: 'Seguir revisando'
    });
    if (!accepted) return;
  }
  if (needsRefresh) emit('imported');
  emit('close');
}
</script>

<template>
  <AppModal
    :open="open"
    title="Importar facturas desde XML"
    :max-width="stage === 'review' ? '1280px' : '680px'"
    @close="requestClose"
  >
    <div class="invoice-import" @dragover.prevent @drop.prevent>
      <!-- Selección -->
      <template v-if="stage === 'select'">
        <input ref="fileInput" type="file" class="file-input" multiple accept=".xml,text/xml,application/xml" @change="onInputChange" />
        <div
          class="drop-zone"
          :class="{ over: dropActive }"
          @dragover.prevent="dropActive = true"
          @dragenter.prevent="dropActive = true"
          @dragleave.prevent="dropActive = false"
          @drop.prevent="onDrop"
        >
          <Upload :size="22" />
          <p>{{ reading ? 'Leyendo archivos…' : dropActive ? 'Suelta los archivos aquí' : 'Arrastra aquí los XML autorizados del SRI' }}</p>
          <AppButton variant="ghost" :disabled="reading" @click="fileInput?.click()">Elegir archivos</AppButton>
          <small>Hasta {{ MAX_FILES }} archivos, 512 KB por archivo y 12 MB en total.</small>
        </div>

        <ul v-if="picked.length" class="file-list">
          <li v-for="(file, i) in picked" :key="i">
            <FileText :size="15" />
            <span class="file-name" :title="file.filename">{{ file.filename }}</span>
            <small>{{ fmtSize(file.size) }}</small>
            <button type="button" class="icon-btn" :aria-label="`Quitar ${file.filename}`" @click="picked.splice(i, 1)"><X :size="15" /></button>
          </li>
        </ul>
        <p v-if="picked.length" class="muted" :class="{ 'over-limit': pickedRequestBytes >= MAX_REQUEST_BYTES }">
          {{ picked.length }} archivo{{ picked.length === 1 ? '' : 's' }} · envío de {{ fmtSize(pickedRequestBytes) }}
          <template v-if="pickedRequestBytes >= MAX_REQUEST_BYTES"> · supera los 12 MB, quita algunos</template>
        </p>
      </template>

      <!-- Archivos descartados antes de enviar -->
      <ul v-if="rejected.length && stage !== 'result'" class="rejected-list">
        <li v-for="(file, i) in rejected" :key="i">
          <span class="badge bad">Error</span>
          <strong>{{ file.filename }}</strong> <span>{{ file.message }}</span> <small>No se envió.</small>
        </li>
      </ul>

      <!-- Revisión -->
      <template v-if="stage === 'review'">
        <p class="muted">Los datos salen del comprobante y no se editan. Puedes elegir razón social y cuenta, marcarla como pagada o desmarcar la línea.</p>
        <div class="review-scroll">
          <table class="review-table">
            <thead>
              <tr>
                <th><span class="sr-only">Importar</span></th>
                <th>Archivo</th>
                <th>Tipo</th>
                <th>Número</th>
                <th>Contraparte</th>
                <th>RUC</th>
                <th>Fecha</th>
                <th class="right">Subtotal</th>
                <th class="right">IVA</th>
                <th class="right">Total</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody v-for="line in lines" :key="line.key" :class="{ dimmed: !line.selected }">
              <tr class="line-main">
                <td>
                  <input
                    v-model="line.selected"
                    type="checkbox"
                    :disabled="!isSelectable(line)"
                    :aria-label="`Importar ${line.filename}`"
                  />
                </td>
                <td class="file-cell" :title="line.filename">{{ line.filename }}</td>
                <template v-if="line.draft">
                  <td>
                    <select v-if="canChooseKind(line)" v-model="line.kind" class="compact" aria-label="Tipo de factura">
                      <option :value="null">Elegir…</option>
                      <option value="SALE">Venta</option>
                      <option value="PURCHASE">Compra</option>
                    </select>
                    <span v-else-if="line.kind" class="badge" :class="line.kind === 'SALE' ? 'ok' : 'orange'">{{ line.kind === 'SALE' ? 'Venta' : 'Compra' }}</span>
                  </td>
                  <td class="nowrap" :title="`Clave de acceso: ${line.draft.accessKey}`">{{ line.draft.number }}</td>
                  <td class="party-cell">
                    <template v-if="counterpartyOf(line).name">{{ counterpartyOf(line).name }}</template>
                    <template v-else>
                      <small>Emisor: {{ line.draft.issuerName }}</small><br />
                      <small>Comprador: {{ line.draft.buyerName }}</small>
                    </template>
                  </td>
                  <td class="nowrap">{{ counterpartyOf(line).taxId || '—' }}</td>
                  <td class="nowrap">{{ fmtDate(line.draft.issueDate) }}</td>
                  <td class="right nowrap">{{ formatMoney(line.draft.netAmount) }}</td>
                  <td class="right nowrap">{{ formatMoney(line.draft.vatAmount) }}</td>
                  <td class="right nowrap"><strong>{{ formatMoney(line.draft.total) }}</strong></td>
                </template>
                <td v-else colspan="8" class="muted-cell">—</td>
                <td><span class="badge" :class="statusOf(line).tone">{{ statusOf(line).label }}</span></td>
              </tr>
              <tr class="line-detail">
                <td></td>
                <td colspan="10">
                  <p v-if="line.errorMessage" class="note bad">{{ line.errorMessage }}</p>
                  <p v-if="line.status === 'DUPLICATE'" class="note warn">{{ duplicateText(line) }}</p>
                  <template v-if="line.draft">
                    <p v-if="line.status === 'NEEDS_KIND' && !line.kind" class="note warn">No se pudo determinar si es venta o compra: elige el tipo. Si este documento ya está importado, se omitirá y verás el motivo al terminar.</p>
                    <p v-if="isConsumerFinalPurchase(line)" class="note warn">Emitida a consumidor final: como compra no sustenta crédito tributario y se omitirá al importar.</p>
                    <p v-else-if="line.status === 'NEEDS_KIND' && line.kind && ownTaxId(line)" class="note warn">Si el RUC {{ ownTaxId(line) }} es tuyo y aún no está en tu razón social, regístralo para que el tipo se detecte solo.</p>
                    <p v-for="(warning, i) in line.draft.warnings" :key="i" class="note warn">{{ warning }}</p>
                    <p v-if="Number(line.draft.otherCharges) !== 0" class="note warn">Otros cargos: {{ formatMoney(line.draft.otherCharges) }} (incluidos en el total)</p>
                    <p v-if="Number(line.draft.discount) !== 0" class="note">Descuento: {{ formatMoney(line.draft.discount) }}</p>
                    <p v-if="line.draft.vatLines.length > 1" class="note">
                      Desglose:
                      <span v-for="(vatLine, i) in line.draft.vatLines" :key="i" class="vat-line">
                        {{ Number(vatLine.rate) }}%: base {{ formatMoney(vatLine.base) }}, IVA {{ formatMoney(vatLine.vat) }}
                      </span>
                    </p>
                  </template>
                  <div v-if="hasOptions(line)" class="line-options">
                    <label v-if="isPossibleDuplicate(line)" class="check">
                      <input v-model="line.allowDuplicate" type="checkbox" @change="onAllowDuplicate(line)" />
                      Importar de todas formas
                    </label>
                    <label>
                      Razón social
                      <select v-model="line.entityId" class="compact">
                        <option :value="null">Sin razón social</option>
                        <option v-for="entity in entities" :key="entity.id" :value="entity.id">{{ entity.name }}</option>
                      </select>
                    </label>
                    <label>
                      Cuenta
                      <select v-model="line.accountId" class="compact">
                        <option :value="null">Sin cuenta vinculada</option>
                        <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.label }}</option>
                      </select>
                    </label>
                    <label class="check">
                      <input v-model="line.paid" type="checkbox" />
                      Pagada
                    </label>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <!-- Resultado -->
      <template v-if="stage === 'result' && result">
        <h4 class="result-title">Creadas ({{ result.created.length }})</h4>
        <p v-if="!result.created.length" class="muted">No se creó ninguna factura.</p>
        <ul v-else class="result-list">
          <li v-for="(item, i) in result.created" :key="i">
            <span class="badge ok">Creada</span>
            <strong>{{ item.number || 'Sin número' }}</strong> <small>{{ item.filename }}</small>
          </li>
        </ul>
        <template v-if="result.skipped.length">
          <h4 class="result-title">Omitidas ({{ result.skipped.length }})</h4>
          <ul class="result-list">
            <li v-for="(item, i) in result.skipped" :key="i">
              <span class="badge warn">Omitida</span>
              <strong>{{ item.filename }}</strong> <span>{{ item.reason }}</span>
            </li>
          </ul>
        </template>
      </template>
    </div>

    <template #footer>
      <template v-if="stage === 'select'">
        <AppButton variant="ghost" @click="requestClose">Cancelar</AppButton>
        <AppButton :disabled="!picked.length || reading" :loading="previewing" @click="runPreview">
          {{ previewing ? 'Revisando…' : 'Revisar facturas' }}
        </AppButton>
      </template>
      <template v-else-if="stage === 'review'">
        <span v-if="selectedWithoutKind" class="foot-hint">Falta elegir el tipo en {{ selectedWithoutKind }} línea{{ selectedWithoutKind === 1 ? '' : 's' }}.</span>
        <AppButton variant="ghost" :disabled="sending" @click="backToSelection">Cambiar archivos</AppButton>
        <AppButton :disabled="!canImport" :loading="sending" @click="runConfirm">
          {{ sending ? 'Importando…' : importLabel }}
        </AppButton>
      </template>
      <AppButton v-else @click="requestClose">Cerrar</AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.invoice-import { display: flex; flex-direction: column; gap: 12px; }
.file-input { display: none; }
.muted { margin: 0; font-size: 13px; color: var(--color-text-muted, #64748b); }
.over-limit { color: #b91c1c; font-weight: 600; }

.drop-zone {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 24px 16px; text-align: center;
  border: 1.5px dashed var(--color-border-strong, #cbd5e1); border-radius: 12px;
  color: var(--color-text-soft, #475569);
  transition: all .15s ease;
}
.drop-zone.over { border-color: #4338ca; border-style: solid; color: #4338ca; background: #e0e7ff; }
.drop-zone p { margin: 0; font-weight: 600; font-size: 14px; }
.drop-zone small { color: var(--color-text-muted, #94a3b8); }

.file-list, .rejected-list, .result-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.file-list { max-height: 240px; overflow-y: auto; }
.file-list li { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; color: var(--color-text-soft, #475569); }
.file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text, #0f172a); font-weight: 600; }
.file-list small { white-space: nowrap; }
.rejected-list li, .result-list li { overflow-wrap: anywhere; }
.rejected-list small, .result-list small { color: var(--color-text-muted, #64748b); }

.review-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.review-table { width: 100%; min-width: 1120px; border-collapse: collapse; font-size: 13px; }
.review-table th, .review-table td { padding: 8px; text-align: left; vertical-align: top; }
.review-table th { font-weight: 500; color: var(--color-text-muted, #64748b); border-bottom: 1px solid var(--color-border, #e2e8f0); white-space: nowrap; }
.review-table .right { text-align: right; }
.review-table .line-main td { padding-bottom: 4px; }
.review-table .line-detail td { padding-top: 0; border-bottom: 1px solid var(--color-border, #e2e8f0); }
.dimmed .line-main td { color: var(--color-text-muted, #94a3b8); }
.nowrap { white-space: nowrap; }
.file-cell { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.party-cell { min-width: 180px; overflow-wrap: anywhere; }
.muted-cell { color: var(--color-text-muted, #94a3b8); }

.note { margin: 0 0 4px; font-size: 12px; color: var(--color-text-soft, #475569); }
.note.warn { color: #b45309; }
.note.bad { color: #b91c1c; }
.vat-line { margin-left: 8px; white-space: nowrap; }

.line-options { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin-top: 2px; font-size: 12px; color: var(--color-text-soft, #475569); }
.line-options label { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
select.compact { width: auto; max-width: 240px; height: 30px; padding: 0 24px 0 8px; font-size: 12px; }
input[type='checkbox'] { width: 16px; height: 16px; padding: 0; flex: none; cursor: pointer; }
input[type='checkbox']:disabled { cursor: not-allowed; }

.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.badge.ok { background: #ecfdf5; color: #047857; }
.badge.warn { background: #fffbeb; color: #b45309; }
.badge.bad { background: #fef2f2; color: #b91c1c; }
.badge.orange { background: #fff7ed; color: #c2410c; }

.result-title { margin: 4px 0 0; font-size: 14px; color: var(--color-text, #334155); }
.foot-hint { margin-right: auto; align-self: center; font-size: 12px; color: #b45309; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

<style>
/* ConfirmHost y este modal comparten z-index y este se monta después: sin esto,
   los avisos de useConfirm quedarían debajo. AppModal no permite pasarle una clase. */
.modal-overlay:has(.invoice-import) { z-index: 1400; }
</style>
