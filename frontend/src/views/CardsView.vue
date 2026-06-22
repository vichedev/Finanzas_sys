<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CreditCard, Pencil, Trash2, Plus, X, Wallet, Power } from 'lucide-vue-next';
import { http } from '../api/http';
import { useEntitiesStore } from '../stores/entities';
import { useFormat } from '../composables/useFormat';
import { useToast } from '../composables/useToast';
import { useConfirm } from '../composables/useConfirm';
import PageHeader from '../components/PageHeader.vue';
import AppModal from '../components/AppModal.vue';

const { formatMoney } = useFormat();
const toast = useToast();
const { confirm } = useConfirm();
const entities = useEntitiesStore();
const activeBanks = computed(() => entities.activeBanks);
const activeAccounts = computed(() => entities.accounts.filter((a) => a.isActive !== false));

interface Card {
  id: number | string;
  name: string;
  type: 'CREDIT' | 'DEBIT';
  entityId?: number | null;
  entity?: { id: number; name: string; kind: 'PERSONAL' | 'BUSINESS' } | null;
  bankId?: number | null;
  bankName?: string | null;
  last4?: string | null;
  creditLimit?: number | string | null;
  cutoffDay?: number | null;
  paymentDueDay?: number | null;
  currentBalance?: number | string | null;
  color?: string | null;
  logo?: string | null;
  isActive?: boolean;
}

interface CardForm {
  name: string;
  type: 'CREDIT' | 'DEBIT';
  entityId: number | null;
  bankId: number | null;
  last4: string;
  creditLimit: number | null;
  cutoffDay: number | null;
  paymentDueDay: number | null;
  currentBalance: number;
  color: string;
  logo: string | null;       // data URL del logo (preview)
}

const emptyForm = (): CardForm => ({
  name: '', type: 'CREDIT', entityId: null, bankId: null, last4: '',
  creditLimit: null, cutoffDay: null, paymentDueDay: null, currentBalance: 0,
  color: '#4338ca', logo: null
});
// Marca si el logo cambió en esta edición (para enviarlo solo cuando hace falta).
const logoTouched = ref(false);
const entityList = ref<{ id: number; name: string; kind: 'PERSONAL' | 'BUSINESS' }[]>([]);
async function loadEntities() { entityList.value = (await http.get<typeof entityList.value>('/entities')).data; }

const rows = ref<Card[]>([]);
const form = ref<CardForm>(emptyForm());
const saving = ref(false);
const editingId = ref<number | null>(null);

const isCredit = computed(() => form.value.type === 'CREDIT');
const balanceHint = computed(() => isCredit.value
  ? 'Lo ya consumido hoy.'
  : 'Saldo disponible en la cuenta.');

function toNumber(v: number | string | null | undefined) { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }
function availableCredit(item: Card) { return Math.max(0, toNumber(item.creditLimit) - toNumber(item.currentBalance)); }
function usedPct(item: Card) { const limit = toNumber(item.creditLimit); if (limit <= 0) return 0; return Math.min(100, Math.max(0, Math.round((toNumber(item.currentBalance) / limit) * 100))); }
function pctSeverity(pct: number) { if (pct >= 80) return 'high'; if (pct >= 50) return 'mid'; return 'low'; }
function sanitizeLast4() { form.value.last4 = form.value.last4.replace(/\D+/g, '').slice(0, 4); }

// Colores sugeridos + subida de logo
const PRESET_COLORS = ['#4338ca', '#6d28d9', '#9333ea', '#0f766e', '#0891b2', '#1e3a8a', '#b91c1c', '#b45309', '#0f172a', '#be185d'];
const MAX_LOGO = 1.5 * 1024 * 1024;
async function onLogoFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0]; input.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) { toast.error('El logo debe ser una imagen.'); return; }
  if (f.size > MAX_LOGO) { toast.error('El logo es muy grande (máx 1.5 MB).'); return; }
  const dataUrl = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
  form.value.logo = dataUrl; logoTouched.value = true;
}
function clearLogo() { form.value.logo = null; logoTouched.value = true; }

// Estilo del fondo de una tarjeta (color personalizado o gradiente por tipo).
function cardStyle(c: Card) {
  if (c.color) return { background: `linear-gradient(135deg, ${c.color} 0%, ${shade(c.color, -0.28)} 100%)` };
  return {};
}
function shade(hex: string, amt: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
  const n = parseInt(m[1], 16);
  const adj = (v: number) => Math.max(0, Math.min(255, Math.round(v + 255 * amt)));
  const r = adj((n >> 16) & 255), g = adj((n >> 8) & 255), b = adj(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

async function toggleActive(item: Card) {
  try {
    await http.put(`/cards/${item.id}`, { isActive: !(item.isActive ?? true) });
    toast.success((item.isActive ?? true) ? 'Tarjeta desactivada.' : 'Tarjeta activada.');
    await load();
  } catch { toast.error('No se pudo cambiar el estado.'); }
}

async function load() {
  // ?all=1: incluye inactivas para poder reactivarlas o eliminarlas.
  try { const r = await http.get<Card[]>('/cards', { params: { all: 1 } }); rows.value = Array.isArray(r.data) ? r.data : []; }
  catch { toast.error('No se pudieron cargar las tarjetas.'); }
}

async function save() {
  if (!form.value.name.trim()) { toast.error('El nombre de la tarjeta es obligatorio.'); return; }
  if (form.value.last4 && !/^\d{1,4}$/.test(form.value.last4)) { toast.error('Los últimos 4 dígitos deben ser numéricos.'); return; }
  const payload: Record<string, unknown> = {
    name: form.value.name.trim(), type: form.value.type,
    entityId: form.value.entityId || null,
    bankId: form.value.bankId ?? null,
    last4: form.value.last4 || null,
    color: form.value.color || null,
    currentBalance: toNumber(form.value.currentBalance)
  };
  // El logo solo se envía al crear o si cambió (evita re-subir la imagen en cada guardado).
  if (editingId.value === null || logoTouched.value) payload.logoDataUrl = form.value.logo;
  if (form.value.type === 'CREDIT') {
    payload.creditLimit = form.value.creditLimit !== null ? toNumber(form.value.creditLimit) : null;
    payload.cutoffDay = form.value.cutoffDay ?? null;
    payload.paymentDueDay = form.value.paymentDueDay ?? null;
  } else {
    payload.creditLimit = null; payload.cutoffDay = null; payload.paymentDueDay = null;
  }
  saving.value = true;
  try {
    if (editingId.value !== null) {
      await http.put(`/cards/${editingId.value}`, payload);
      toast.success('Tarjeta actualizada.');
    } else {
      await http.post('/cards', payload);
      toast.success('Tarjeta guardada correctamente.');
    }
    form.value = emptyForm();
    editingId.value = null;
    logoTouched.value = false;
    await load();
  }
  catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } };
    toast.error(e?.response?.data?.message ?? 'No se pudo guardar la tarjeta.');
  } finally { saving.value = false; }
}

function startEdit(item: Card) {
  editingId.value = Number(item.id);
  logoTouched.value = false;
  form.value = {
    name: item.name,
    type: item.type,
    entityId: item.entityId ?? null,
    bankId: item.bankId ?? null,
    last4: item.last4 || '',
    creditLimit: item.creditLimit !== null && item.creditLimit !== undefined ? toNumber(item.creditLimit) : null,
    cutoffDay: item.cutoffDay ?? null,
    paymentDueDay: item.paymentDueDay ?? null,
    currentBalance: toNumber(item.currentBalance),
    color: item.color || '#4338ca',
    logo: item.logo ?? null
  };
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  editingId.value = null;
  form.value = emptyForm();
}

async function removeRow(item: Card, force = false) {
  if (!force && !(await confirm({ message: `¿Eliminar definitivamente la tarjeta "${item.name}"? Sus movimientos se conservan pero quedan sin tarjeta asociada. Si solo quieres ocultarla, usa "Desactivar".`, danger: true, confirmText: 'Eliminar' }))) return;
  try {
    await http.delete(`/cards/${item.id}`, { params: force ? { force: 1 } : undefined });
    toast.success('Tarjeta eliminada.');
    if (editingId.value === Number(item.id)) cancelEdit();
    await load();
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { message?: string; code?: string } } };
    if (e?.response?.status === 409 && e.response.data?.code === 'NONZERO_BALANCE') {
      if (await confirm({ message: e.response.data.message || 'La tarjeta tiene saldo usado. ¿Eliminar de todos modos?', danger: true, confirmText: 'Eliminar' })) await removeRow(item, true);
      return;
    }
    toast.error('No se pudo eliminar la tarjeta.');
  }
}

// ---- Pago de tarjeta de crédito ----
const payOpen = ref(false);
const payCardRef = ref<Card | null>(null);
const payForm = ref<{ accountId: number | null; amount: number | null; payDate: string; notes: string }>({ accountId: null, amount: null, payDate: '', notes: '' });
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const payErr = ref('');
const paying = ref(false);

// Saldo adeudado de la tarjeta (nunca negativo).
const payOwed = computed(() => Math.max(0, toNumber(payCardRef.value?.currentBalance)));
function openPay(card: Card) {
  payCardRef.value = card;
  const owed = Math.max(0, toNumber(card.currentBalance));
  payForm.value = { accountId: activeAccounts.value[0]?.id ?? null, amount: owed || null, payDate: todayYmd(), notes: '' };
  payErr.value = '';
  payOpen.value = true;
}

async function submitPay() {
  payErr.value = '';
  if (!payCardRef.value) return;
  if (!payForm.value.accountId) { payErr.value = 'Selecciona la cuenta de origen.'; return; }
  if (!payForm.value.amount || payForm.value.amount <= 0) { payErr.value = 'Ingresa un monto válido.'; return; }
  if (payOwed.value <= 0) { payErr.value = 'Esta tarjeta no tiene saldo por pagar.'; return; }
  if (payForm.value.amount > payOwed.value) { payErr.value = `No puedes pagar más de lo adeudado (${formatMoney(payOwed.value)}).`; return; }
  if (!payForm.value.payDate) { payErr.value = 'Selecciona la fecha del pago.'; return; }
  paying.value = true;
  try {
    await http.post(`/cards/${payCardRef.value.id}/pay`, {
      accountId: payForm.value.accountId,
      amount: payForm.value.amount,
      movementDate: payForm.value.payDate,
      notes: payForm.value.notes.trim() || null
    });
    payOpen.value = false;
    toast.success('Pago registrado. Saldos de tarjeta y cuenta actualizados.');
    await Promise.all([load(), entities.ensureAccounts(true)]);
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } };
    payErr.value = e?.response?.data?.message ?? 'No se pudo registrar el pago.';
  } finally { paying.value = false; }
}

// Fuerza catálogos frescos al entrar (sin recargar la página).
onMounted(() => Promise.all([load(), loadEntities(), entities.ensureBanks(true), entities.ensureAccounts(true)]));
</script>

<template>
  <section class="dashboard">
    <PageHeader title="Tarjetas" subtitle="Tarjetas de crédito y débito." />

    <div class="stack">
      <div class="panel">
        <div class="panel-header"><h2>{{ editingId !== null ? 'Editar tarjeta' : 'Nueva tarjeta' }}</h2></div>

        <form class="form" @submit.prevent="save">
          <div class="form-grid">
            <div class="field">
              <label for="card-name">Nombre de la tarjeta <span class="required-mark">*</span></label>
              <input id="card-name" v-model="form.name" type="text" placeholder="ej. Visa Personal Pichincha" autocomplete="off" required />
              <small class="hint">Un alias fácil de reconocer.</small>
            </div>

            <div class="field">
              <label for="card-type">Tipo <span class="required-mark">*</span></label>
              <select id="card-type" v-model="form.type">
                <option value="CREDIT">Crédito</option>
                <option value="DEBIT">Débito</option>
              </select>
              <small class="hint">Crédito habilita cupo y fechas.</small>
            </div>

            <div class="field">
              <label for="card-bank">Banco emisor</label>
              <select id="card-bank" v-model.number="form.bankId">
                <option :value="null">— Sin banco —</option>
                <option v-for="b in activeBanks" :key="b.id" :value="b.id">{{ b.name }}</option>
              </select>
              <small v-if="activeBanks.length" class="hint">Tomado de Configuración → Bancos.</small>
              <small v-else class="hint warn-hint">Sin bancos. Agrégalos en <strong>Configuración → Bancos</strong>.</small>
            </div>

            <div class="field">
              <label for="card-entity">Razón social / Entidad</label>
              <select id="card-entity" v-model.number="form.entityId">
                <option :value="null">— Sin asignar —</option>
                <option v-for="e in entityList" :key="e.id" :value="e.id">{{ e.name }} ({{ e.kind === 'BUSINESS' ? 'Empresa' : 'Personal' }})</option>
              </select>
              <small v-if="!entityList.length" class="hint warn-hint">No hay razones sociales. Créalas en <strong>Razones sociales</strong>.</small>
            </div>

            <div class="field">
              <label for="card-last4">Últimos 4 dígitos</label>
              <input id="card-last4" v-model="form.last4" type="text" inputmode="numeric" pattern="\d{0,4}" maxlength="4" placeholder="1234" autocomplete="off" @input="sanitizeLast4" />
              <small class="hint">Para identificarla a simple vista.</small>
            </div>

            <div class="field">
              <label>Color de la tarjeta</label>
              <div class="color-row">
                <input type="color" v-model="form.color" class="color-input" aria-label="Color personalizado" />
                <button v-for="c in PRESET_COLORS" :key="c" type="button" class="color-dot" :class="{ on: form.color.toLowerCase() === c }" :style="{ background: c }" :title="c" @click="form.color = c"></button>
              </div>
              <small class="hint">Elige un color o uno de los sugeridos.</small>
            </div>

            <div class="field">
              <label>Logo de la tarjeta</label>
              <div class="logo-row">
                <span class="logo-prev" :class="{ empty: !form.logo }">
                  <img v-if="form.logo" :src="form.logo" alt="logo" />
                  <span v-else>Sin logo</span>
                </span>
                <label class="logo-btn">Subir imagen<input type="file" accept="image/*" hidden @change="onLogoFile" /></label>
                <button v-if="form.logo" type="button" class="ghost mini danger" @click="clearLogo"><X :size="14" /> Quitar</button>
              </div>
              <small class="hint">PNG/JPG, máx 1.5 MB.</small>
            </div>

            <template v-if="isCredit">
              <div class="field">
                <label for="card-cutoff">Día de corte (1-31)</label>
                <input id="card-cutoff" v-model.number="form.cutoffDay" type="number" min="1" max="31" placeholder="10" />
                <small class="hint">Día del mes del corte.</small>
              </div>

              <div class="field">
                <label for="card-due">Día de pago (1-31)</label>
                <input id="card-due" v-model.number="form.paymentDueDay" type="number" min="1" max="31" placeholder="25" />
                <small class="hint">Día límite sin mora.</small>
              </div>
            </template>
          </div>

          <div class="form-footer">
            <div class="field field-narrow">
              <template v-if="isCredit">
                <label for="card-limit">Cupo / Límite de crédito (USD)</label>
                <input id="card-limit" v-model.number="form.creditLimit" type="number" step="0.01" min="0" placeholder="1500.00" />
                <small class="hint">Cupo asignado por el banco.</small>
              </template>
              <template v-else>
                <label for="card-balance">Saldo actual (USD)</label>
                <input id="card-balance" v-model.number="form.currentBalance" type="number" step="0.01" placeholder="0.00" />
                <small class="hint">{{ balanceHint }}</small>
              </template>
            </div>
            <div v-if="isCredit && editingId !== null" class="field field-narrow">
              <label for="card-used">Saldo usado actual (USD)</label>
              <input id="card-used" v-model.number="form.currentBalance" type="number" step="0.01" placeholder="0.00" />
              <small class="hint">Lo consumido hoy. Ajústalo si difiere del estado de cuenta (puede ser negativo si pagaste de más).</small>
            </div>
            <div class="form-actions">
              <button v-if="editingId !== null" type="button" class="ghost" @click="cancelEdit"><X :size="16" /> Cancelar</button>
              <button type="submit" :disabled="saving"><component :is="editingId !== null ? Pencil : Plus" :size="16" /> {{ saving ? 'Guardando…' : (editingId !== null ? 'Guardar cambios' : 'Crear tarjeta') }}</button>
            </div>
          </div>

        </form>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Mis tarjetas</h2>
          <span class="panel-hint">{{ rows.length }} tarjeta{{ rows.length === 1 ? '' : 's' }}</span>
        </div>

        <div v-if="rows.length === 0" class="empty-state">
          <div class="empty-state-illustration"><CreditCard :size="36" /></div>
          <strong>Sin tarjetas registradas</strong>
          <p>Agrega tus tarjetas de crédito o débito para verlas aquí.</p>
        </div>

        <div v-else class="real-cards">
          <div v-for="item in rows" :key="item.id" class="rcard" :class="[item.color ? '' : (item.type === 'CREDIT' ? 'rcard-credit' : 'rcard-debit'), { 'rcard-off': item.isActive === false }]" :style="cardStyle(item)">
            <span v-if="item.isActive === false" class="rcard-badge">Inactiva</span>
            <div class="rcard-row1">
              <span class="rcard-kind">{{ item.type === 'CREDIT' ? 'CRÉDITO' : 'DÉBITO' }}</span>
              <img v-if="item.logo" :src="item.logo" alt="logo" class="rcard-logo" />
              <span v-else class="rcard-bank">{{ item.bankName || 'Sin banco' }}</span>
            </div>
            <div class="rcard-chip"></div>
            <div class="rcard-number">**** **** **** {{ item.last4 || '••••' }}</div>
            <div class="rcard-row2">
              <div class="rcard-holder">
                <small>Titular / Razón social</small>
                <strong>{{ item.entity?.name || item.name }}</strong>
              </div>
              <span v-if="item.entity" class="rcard-tag">{{ item.entity.kind === 'BUSINESS' ? 'Empresarial' : 'Personal' }}</span>
            </div>

            <div class="rcard-foot">
              <template v-if="item.type === 'CREDIT'">
                <div class="rcard-stat"><small>Disponible</small><strong>{{ formatMoney(availableCredit(item)) }}</strong></div>
                <div class="rcard-stat"><small>Usado</small><strong>{{ formatMoney(item.currentBalance) }}</strong></div>
                <div class="rcard-stat"><small>Corte / Pago</small><strong>{{ item.cutoffDay ?? '—' }} / {{ item.paymentDueDay ?? '—' }}</strong></div>
              </template>
              <template v-else>
                <div class="rcard-stat"><small>Saldo</small><strong>{{ formatMoney(item.currentBalance) }}</strong></div>
              </template>
            </div>
            <div v-if="item.type === 'CREDIT' && toNumber(item.creditLimit) > 0" class="rcard-progress">
              <div class="rcard-progress-fill" :style="{ width: usedPct(item) + '%' }"></div>
            </div>

            <div class="rcard-actions">
              <button v-if="item.type === 'CREDIT' && item.isActive !== false" type="button" class="icon-btn rcard-act" title="Pagar tarjeta" @click="openPay(item)"><Wallet :size="16" /></button>
              <button type="button" class="icon-btn rcard-act" title="Editar" :disabled="editingId === Number(item.id)" @click="startEdit(item)"><Pencil :size="16" /></button>
              <button type="button" class="icon-btn rcard-act" :title="item.isActive === false ? 'Activar' : 'Desactivar'" @click="toggleActive(item)"><Power :size="16" /></button>
              <button type="button" class="icon-btn rcard-act danger" title="Eliminar" @click="removeRow(item)"><Trash2 :size="16" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <AppModal :open="payOpen" :title="`Pagar tarjeta${payCardRef ? ' · ' + payCardRef.name : ''}`" @close="payOpen = false">
      <div class="pay-body">
        <p class="pay-hint">
          El pago sale de la cuenta seleccionada y reduce el saldo usado de la tarjeta.
          <template v-if="payCardRef"><br />Saldo por pagar: <strong>{{ formatMoney(payOwed) }}</strong>.</template>
        </p>
        <p v-if="payOwed <= 0" class="hint warn-hint" style="margin-top:0">Esta tarjeta no tiene saldo por pagar.</p>
        <div class="field">
          <label for="pay-acc">Cuenta de origen <span class="required-mark">*</span></label>
          <select id="pay-acc" v-model.number="payForm.accountId">
            <option :value="null">— Selecciona —</option>
            <option v-for="a in activeAccounts" :key="a.id" :value="a.id">{{ [a.name, a.bankName, a.accountNumber ? '****' + a.accountNumber.slice(-4) : ''].filter(Boolean).join(' · ') }} ({{ formatMoney(a.currentBalance) }})</option>
          </select>
          <small v-if="!activeAccounts.length" class="hint warn-hint">Sin cuentas. Crea una en <strong>Cuentas</strong>.</small>
        </div>
        <div class="field">
          <label for="pay-amt">Monto a pagar (USD) <span class="required-mark">*</span></label>
          <input id="pay-amt" v-model.number="payForm.amount" type="number" step="0.01" min="0" :max="payOwed" placeholder="0.00" />
          <small class="hint">Máximo {{ formatMoney(payOwed) }} (lo adeudado).</small>
        </div>
        <div class="field">
          <label for="pay-date">Fecha del pago <span class="required-mark">*</span></label>
          <input id="pay-date" v-model="payForm.payDate" type="date" min="2026-05-01" :max="todayYmd()" />
          <small class="hint">Con esta fecha aparecerá el pago en Movimientos.</small>
        </div>
        <div class="field">
          <label for="pay-notes">Notas</label>
          <input id="pay-notes" v-model="payForm.notes" type="text" maxlength="500" placeholder="Opcional" />
        </div>
        <p class="hint" style="margin:0">¿Te equivocaste? Puedes eliminar este pago luego en <strong>Movimientos</strong> y el saldo se revertirá automáticamente.</p>
        <p v-if="payErr" class="error">{{ payErr }}</p>
      </div>
      <template #footer>
        <button type="button" class="ghost" @click="payOpen = false"><X :size="16" /> Cancelar</button>
        <button type="button" @click="submitPay" :disabled="paying || payOwed <= 0"><Wallet :size="16" /> {{ paying ? 'Procesando…' : 'Registrar pago' }}</button>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.required-mark { color: #ef4444; font-weight: 700; }
.warn-hint { color: var(--color-warning-text, #b45309); }
.row-actions button.mini.pay { color: #047857; border-color: #a7f3d0; }
.row-actions button.mini.pay:hover { background: #ecfdf5; }
.pay-body { display: flex; flex-direction: column; gap: 12px; }
.pay-body .field { display: flex; flex-direction: column; gap: 4px; }
.pay-hint { font-size: 13px; color: #6b7280; margin: 0; }
.card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.card-last4 { font-family: ui-monospace, monospace; font-size: 12px; color: #6b7280; letter-spacing: 0.05em; margin-top: 2px; }
.pill-credit { background: #ecfdf5; color: #047857; }
.pill-debit { background: #eff6ff; color: #1d4ed8; }
.pill-active { background: #ecfdf5; color: #047857; }
.progress-bar { width: 100%; height: 6px; background: #e5e7eb; border-radius: 999px; overflow: hidden; margin: 4px 0 2px; }
.progress-fill { height: 100%; border-radius: 999px; transition: width 0.25s ease; }
.progress-fill.sev-low { background: #10b981; }
.progress-fill.sev-mid { background: #f59e0b; }
.progress-fill.sev-high { background: #ef4444; }
.table-scroll { overflow-x: auto; }

/* Anchos de columna en tabla de Tarjetas */
.cards-table { table-layout: fixed; }
.cards-table .col-name   { width: 22%; }
.cards-table .col-money  { width: 13%; }
.cards-table .col-dates  { width: 12%; }
.cards-table .col-status { width: 9%; }
.cards-table .col-acts   { width: 18%; }
@media (max-width: 1000px) {
  .cards-table { table-layout: auto; }
  .cards-table .col-name, .cards-table .col-money, .cards-table .col-dates, .cards-table .col-status, .cards-table .col-acts { width: auto; }
}
button[disabled] { opacity: 0.6; cursor: not-allowed; }
.actions-row { display: flex; gap: 8px; }
.actions-row .ghost { background: white; border: 1px solid #e2e8f0; color: #475569; }
.row-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.row-actions button.mini { background: white; border: 1px solid #e2e8f0; color: #475569; cursor: pointer; font-weight: 600; }
.row-actions button.mini:hover:not(:disabled) { background: #f8fafc; }
.row-actions button.mini:disabled { opacity: 0.4; cursor: not-allowed; }
.row-actions button.mini.danger { color: #dc2626; border-color: #fecaca; }
.row-actions button.mini.danger:hover { background: #fef2f2; }

/* Tarjetas realistas */
.real-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.rcard {
  position: relative; border-radius: 16px; padding: 18px; color: #fff; min-height: 200px;
  display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(15, 23, 42, .18);
  background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 60%, #3b82f6 100%);
  overflow: hidden;
}
.rcard-credit { background: linear-gradient(135deg, #4338ca 0%, #6d28d9 55%, #9333ea 100%); }
.rcard-debit { background: linear-gradient(135deg, #0f766e 0%, #0891b2 55%, #0ea5e9 100%); }
.rcard::after { content: ''; position: absolute; right: -40px; top: -40px; width: 160px; height: 160px; background: rgba(255,255,255,.08); border-radius: 50%; pointer-events: none; }
.rcard-row1 { display: flex; justify-content: space-between; align-items: center; font-size: 11px; letter-spacing: .08em; font-weight: 700; opacity: .92; }
.rcard-bank { opacity: .85; font-weight: 600; }
.rcard-chip { width: 38px; height: 28px; border-radius: 6px; margin: 14px 0 10px; background: linear-gradient(135deg, #fde68a, #d4af37); box-shadow: inset 0 0 0 1px rgba(0,0,0,.1); }
.rcard-number { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 18px; letter-spacing: 2px; font-weight: 600; }
.rcard-row2 { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 10px; gap: 8px; }
.rcard-holder small { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .08em; opacity: .7; }
.rcard-holder strong { font-size: 13px; font-weight: 700; }
.rcard-tag { font-size: 10px; font-weight: 700; background: rgba(255,255,255,.2); padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
.rcard-foot { display: flex; gap: 14px; margin-top: auto; padding-top: 14px; flex-wrap: wrap; }
.rcard-stat small { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
.rcard-stat strong { font-size: 14px; font-weight: 700; }
.rcard-progress { height: 5px; border-radius: 999px; background: rgba(255,255,255,.25); margin-top: 10px; overflow: hidden; }
.rcard-progress-fill { height: 100%; background: #fff; border-radius: 999px; }
.rcard-actions { position: absolute; top: 12px; right: 12px; z-index: 3; display: flex; gap: 6px; opacity: 0; transform: translateY(-4px); transition: opacity .15s ease, transform .15s ease; }
.rcard:hover .rcard-actions { opacity: 1; transform: none; }
/* Botones de acción: círculo claro con icono oscuro (alto contraste sobre la tarjeta) */
.rcard-actions .rcard-act { width: 34px; height: 34px; border-radius: 50%; border: none; background: rgba(255,255,255,.92); color: #1e293b; cursor: pointer; display: inline-grid; place-items: center; box-shadow: 0 2px 6px rgba(0,0,0,.2); transition: background .12s ease, color .12s ease, transform .1s ease; }
.rcard-actions .rcard-act:hover:not(:disabled) { background: #fff; transform: translateY(-1px); }
.rcard-actions .rcard-act.danger { color: #dc2626; }
.rcard-actions .rcard-act.danger:hover:not(:disabled) { background: #fee2e2; }
.rcard-actions .rcard-act:disabled { opacity: .5; cursor: not-allowed; }
@media (hover: none) { .rcard-actions { opacity: 1; transform: none; } }
.rcard-logo { max-height: 26px; max-width: 90px; object-fit: contain; }
.rcard-off { filter: grayscale(.7); opacity: .6; }
.rcard-badge { position: absolute; top: 12px; left: 14px; font-size: 10px; font-weight: 800; background: rgba(0,0,0,.35); padding: 3px 8px; border-radius: 999px; letter-spacing: .04em; }

/* Personalización en el formulario */
.color-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.color-input { width: 42px; height: 32px; padding: 0; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; background: none; cursor: pointer; }
.color-dot { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #e2e8f0; cursor: pointer; }
.color-dot.on { box-shadow: 0 0 0 2px var(--color-primary, #2563eb); }
.logo-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.logo-prev { width: 56px; height: 40px; border-radius: 8px; border: 1px dashed #cbd5e1; display: inline-grid; place-items: center; overflow: hidden; background: #f8fafc; }
.logo-prev img { max-width: 100%; max-height: 100%; object-fit: contain; }
.logo-prev.empty span { font-size: 10px; color: #94a3b8; }
.logo-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border: 1px solid var(--color-border, #e2e8f0); border-radius: 8px; background: #fff; color: #475569; font-weight: 600; font-size: 13px; cursor: pointer; }
.logo-btn:hover { background: #f1f5f9; }
</style>
