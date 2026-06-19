<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CreditCard, Pencil, Trash2, Plus, X, Wallet } from 'lucide-vue-next';
import { http } from '../api/http';
import { useEntitiesStore } from '../stores/entities';
import { useFormat } from '../composables/useFormat';
import { useToast } from '../composables/useToast';
import PageHeader from '../components/PageHeader.vue';
import AppModal from '../components/AppModal.vue';

const { formatMoney } = useFormat();
const toast = useToast();
const entities = useEntitiesStore();
const activeBanks = computed(() => entities.activeBanks);
const activeAccounts = computed(() => entities.accounts.filter((a) => a.isActive !== false));

interface Card {
  id: number | string;
  name: string;
  type: 'CREDIT' | 'DEBIT';
  entityName?: string | null;
  entityKind?: 'PERSONAL' | 'BUSINESS';
  bankId?: number | null;
  bankName?: string | null;
  last4?: string | null;
  creditLimit?: number | string | null;
  cutoffDay?: number | null;
  paymentDueDay?: number | null;
  currentBalance?: number | string | null;
}

interface CardForm {
  name: string;
  type: 'CREDIT' | 'DEBIT';
  entityName: string;
  entityKind: 'PERSONAL' | 'BUSINESS';
  bankId: number | null;
  last4: string;
  creditLimit: number | null;
  cutoffDay: number | null;
  paymentDueDay: number | null;
  currentBalance: number;
}

const emptyForm = (): CardForm => ({
  name: '', type: 'CREDIT', entityName: '', entityKind: 'PERSONAL', bankId: null, last4: '',
  creditLimit: null, cutoffDay: null, paymentDueDay: null, currentBalance: 0
});
const entityNameOptions = computed(() => [...new Set(rows.value.map((c) => c.entityName?.trim()).filter(Boolean) as string[])]);

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

async function load() {
  try { const r = await http.get<Card[]>('/cards'); rows.value = Array.isArray(r.data) ? r.data : []; }
  catch { toast.error('No se pudieron cargar las tarjetas.'); }
}

async function save() {
  if (!form.value.name.trim()) { toast.error('El nombre de la tarjeta es obligatorio.'); return; }
  if (form.value.last4 && !/^\d{1,4}$/.test(form.value.last4)) { toast.error('Los últimos 4 dígitos deben ser numéricos.'); return; }
  const payload: Record<string, unknown> = {
    name: form.value.name.trim(), type: form.value.type,
    entityName: form.value.entityName.trim() || null,
    entityKind: form.value.entityKind,
    bankId: form.value.bankId ?? null,
    last4: form.value.last4 || null,
    currentBalance: toNumber(form.value.currentBalance)
  };
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
    await load();
  }
  catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } } };
    toast.error(e?.response?.data?.message ?? 'No se pudo guardar la tarjeta.');
  } finally { saving.value = false; }
}

function startEdit(item: Card) {
  editingId.value = Number(item.id);
  form.value = {
    name: item.name,
    type: item.type,
    entityName: item.entityName ?? '',
    entityKind: item.entityKind ?? 'PERSONAL',
    bankId: item.bankId ?? null,
    last4: item.last4 || '',
    creditLimit: item.creditLimit !== null && item.creditLimit !== undefined ? toNumber(item.creditLimit) : null,
    cutoffDay: item.cutoffDay ?? null,
    paymentDueDay: item.paymentDueDay ?? null,
    currentBalance: toNumber(item.currentBalance)
  };
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  editingId.value = null;
  form.value = emptyForm();
}

async function removeRow(item: Card, force = false) {
  if (!force && !confirm(`Eliminar la tarjeta "${item.name}"? Se marcará inactiva. Sus movimientos NO se eliminan.`)) return;
  try {
    await http.delete(`/cards/${item.id}`, { params: force ? { force: 1 } : undefined });
    toast.success('Tarjeta eliminada.');
    if (editingId.value === Number(item.id)) cancelEdit();
    await load();
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: { message?: string; code?: string } } };
    if (e?.response?.status === 409 && e.response.data?.code === 'NONZERO_BALANCE') {
      if (confirm(e.response.data.message || 'La tarjeta tiene saldo. ¿Marcar inactiva igual?')) await removeRow(item, true);
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
onMounted(() => Promise.all([load(), entities.ensureBanks(true), entities.ensureAccounts(true)]));
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
              <input id="card-entity" v-model="form.entityName" maxlength="120" list="card-entity-names" placeholder="ej. Personal, GROUPMAAT S.A.S" />
              <datalist id="card-entity-names">
                <option v-for="n in entityNameOptions" :key="n" :value="n" />
              </datalist>
              <small class="hint">Para el consolidado en "Razones sociales".</small>
            </div>

            <div class="field">
              <label for="card-entkind">Naturaleza</label>
              <select id="card-entkind" v-model="form.entityKind">
                <option value="PERSONAL">Personal</option>
                <option value="BUSINESS">Empresarial</option>
              </select>
            </div>

            <div class="field">
              <label for="card-last4">Últimos 4 dígitos</label>
              <input id="card-last4" v-model="form.last4" type="text" inputmode="numeric" pattern="\d{0,4}" maxlength="4" placeholder="1234" autocomplete="off" @input="sanitizeLast4" />
              <small class="hint">Para identificarla a simple vista.</small>
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
                <input id="card-balance" v-model.number="form.currentBalance" type="number" step="0.01" min="0" placeholder="0.00" />
                <small class="hint">{{ balanceHint }}</small>
              </template>
            </div>
            <div v-if="isCredit && editingId !== null" class="field field-narrow">
              <label for="card-used">Saldo usado actual (USD)</label>
              <input id="card-used" v-model.number="form.currentBalance" type="number" step="0.01" min="0" placeholder="0.00" />
              <small class="hint">Lo consumido hoy. Ajústalo si difiere del estado de cuenta.</small>
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
          <div v-for="item in rows" :key="item.id" class="rcard" :class="item.type === 'CREDIT' ? 'rcard-credit' : 'rcard-debit'">
            <div class="rcard-row1">
              <span class="rcard-kind">{{ item.type === 'CREDIT' ? 'CRÉDITO' : 'DÉBITO' }}</span>
              <span class="rcard-bank">{{ item.bankName || 'Sin banco' }}</span>
            </div>
            <div class="rcard-chip"></div>
            <div class="rcard-number">**** **** **** {{ item.last4 || '••••' }}</div>
            <div class="rcard-row2">
              <div class="rcard-holder">
                <small>Titular / Razón social</small>
                <strong>{{ item.entityName || item.name }}</strong>
              </div>
              <span v-if="item.entityKind" class="rcard-tag">{{ item.entityKind === 'BUSINESS' ? 'Empresarial' : 'Personal' }}</span>
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
              <button v-if="item.type === 'CREDIT'" type="button" title="Pagar tarjeta" @click="openPay(item)"><Wallet :size="15" /></button>
              <button type="button" title="Editar" :disabled="editingId === Number(item.id)" @click="startEdit(item)"><Pencil :size="15" /></button>
              <button type="button" title="Eliminar" @click="removeRow(item)"><Trash2 :size="15" /></button>
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
.rcard::after { content: ''; position: absolute; right: -40px; top: -40px; width: 160px; height: 160px; background: rgba(255,255,255,.08); border-radius: 50%; }
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
.rcard-actions { position: absolute; top: 12px; right: 14px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s ease; }
.rcard:hover .rcard-actions { opacity: 1; }
.rcard-actions button { width: 30px; height: 30px; border: none; border-radius: 8px; background: rgba(255,255,255,.22); color: #fff; cursor: pointer; display: inline-grid; place-items: center; }
.rcard-actions button:hover:not(:disabled) { background: rgba(255,255,255,.4); }
.rcard-actions button:disabled { opacity: .4; cursor: not-allowed; }
@media (hover: none) { .rcard-actions { opacity: 1; } }
</style>
