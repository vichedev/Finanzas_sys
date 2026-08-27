// =====================================================
// Enrutador inteligente + creación de ENTIDADES por WhatsApp (además de movimientos).
//
// El bot detecta qué quiere el usuario (deuda/cobro, recurrente, presupuesto,
// cuenta) y lo guarda en su sección, pidiendo por lista lo que falte — igual que
// el flujo de movimientos. Los movimientos y consultas los sigue manejando
// pipeline.ts; aquí van las demás entidades con un motor genérico de slots.
// =====================================================
import { logger } from '../lib/logger';
import { getBrainCreds, chatComplete } from './llm';
import { createNotification } from '../lib/notifications';
import type { IncomingMessage } from './gateway';

export type Target = 'movement' | 'debt' | 'recurring' | 'budget' | 'account' | 'card' | 'query';
type EntityKind = 'debt' | 'recurring' | 'budget' | 'account';

const fmt = (v: unknown) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(ymd: string): string { const [y, m, d] = ymd.split('-'); return d && m && y ? `${d}/${m}/${y}` : ymd; }
function parseAmount(text: string): number { const m = text.replace(/,/g, '.').match(/\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; }

/** Parsea una fecha libre: "5/9", "05/09/2026", "sin fecha"/"no" → null. undefined si no entiende. */
function parseDateLoose(text: string): string | null | undefined {
  const t = norm(text);
  if (/^(sin fecha|no|ninguna|nada|omitir|luego)$/.test(t)) return null;
  const m = t.match(/(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{2,4}))?/);
  if (m) {
    const d = Number(m[1]); const mo = Number(m[2]); let y = m[3] ? Number(m[3]) : new Date().getFullYear();
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  return undefined;
}

function extractJson(raw: string): any | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* intenta */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* nada */ } }
  return null;
}

// ---- Clasificador de intención ----
const CLASSIFY_SYSTEM = `Clasifica el mensaje del usuario (español, Ecuador) según lo que quiere hacer en su app de finanzas.
Responde SOLO un JSON: {"target":"..."}. Valores posibles de target:
- "movement": registrar algo que YA ocurrió: un gasto, ingreso, compra, transferencia entre cuentas, o retiro. Ej: "gasté 20 en el súper", "ingreso de 800", "compré una laptop", "transferí 50", "retiré 100".
- "debt": una DEUDA o COBRO puntual con una persona: me deben / debo / presté / me prestaron / "cobrar a X" / "pagarle a X" / recordatorio de cobro o pago. Ej: "recuérdame cobrar 500 a Juan el 5", "le debo 200 a Pedro".
- "recurring": un pago o cobro que se REPITE periódicamente. Ej: "todos los meses pago 300 de arriendo", "cada mes cobro 800 de sueldo", "suscripción de Netflix 15 mensual".
- "budget": un PRESUPUESTO o límite de gasto por categoría. Ej: "ponme un presupuesto de 400 en comida", "límite de 200 en transporte".
- "account": crear una CUENTA, billetera o efectivo nuevo. Ej: "crea una cuenta de ahorros en Pichincha", "agrega una billetera".
- "card": crear una TARJETA de crédito o débito. Ej: "agrega una tarjeta Visa".
- "query": una pregunta, consulta, análisis o consejo. Ej: "¿cuánto gasté?", "¿en qué gasto más?", "dame consejos".
Elige el MÁS probable. Si dudas entre movement y debt: si es una transacción ya hecha con dinero propio -> movement; si involucra deber/cobrar a una persona -> debt.`;

export async function classifyTarget(prisma: any, userId: number, text: string): Promise<Target> {
  try {
    const creds = await getBrainCreds(prisma);
    if (!creds) return 'movement';
    const raw = await chatComplete(creds, { system: CLASSIFY_SYSTEM, user: text, jsonMode: true, temperature: 0, maxTokens: 800 });
    const j = extractJson(raw);
    const t = String(j?.target || '').toLowerCase();
    if (['movement', 'debt', 'recurring', 'budget', 'account', 'card', 'query'].includes(t)) return t as Target;
  } catch (e: any) { logger.warn({ e: e?.message }, 'wa: clasificador falló, asumo movement'); }
  return 'movement';
}

// =====================================================
// Motor genérico de slots para entidades
// =====================================================
type SlotType = 'num' | 'text' | 'date' | 'choice';
interface Slot { key: string; ask: string; type: SlotType; options?: { label: string; value: any }[]; optional?: boolean }
interface EDraft { kind: EntityKind; data: Record<string, any>; current: Slot | null; awaiting: 'question' | 'confirm'; userId: number; at: number; ctx: any }

const eDrafts = new Map<string, EDraft>();
const E_TTL = 10 * 60 * 1000;
function getEDraft(chatId: string): EDraft | null {
  const d = eDrafts.get(chatId);
  if (!d) return null;
  if (Date.now() - d.at > E_TTL) { eDrafts.delete(chatId); return null; }
  return d;
}
/** ¿Hay un borrador de entidad activo para este chat? (para que pipeline ceda el control) */
export function hasEntityDraft(chatId: string): boolean { return !!getEDraft(chatId); }
export function clearEntityDraft(chatId: string): void { eDrafts.delete(chatId); }

const AFFIRM = /^\s*(s[ií]|si|dale|ok(ay)?|conf[ií]rmo|correcto|listo|va|h[aá]zlo|reg[ií]stralo?|de una|👍|✅)\b/i;
const NEGATE = /^\s*(no|nel|nop|cancela(r)?|olv[ií]dalo|❌)\b/i;

function renderSlot(s: Slot): string {
  if (s.type !== 'choice') return s.ask;
  const lines = (s.options || []).map((o, i) => `${i + 1}. ${o.label}`);
  return `${s.ask}\n${lines.join('\n')}\n\n_Responde con el número._`;
}
function resolveChoice(s: Slot, text: string): { value: any } | null {
  const num = text.match(/\d+/);
  if (num) { const n = parseInt(num[0], 10); if (s.options && n >= 1 && n <= s.options.length) return { value: s.options[n - 1].value }; }
  const t = norm(text);
  if (t.length >= 3 && s.options) { const hits = s.options.filter((o) => norm(o.label).includes(t) || t.includes(norm(o.label))); if (hits.length === 1) return { value: hits[0].value }; }
  return null;
}

// ---- Especificaciones por entidad ----
interface Spec {
  title: string;
  loadCtx: (prisma: any, userId: number) => Promise<any>;
  extractSystem: (ctx: any) => string;
  precarga: (data: Record<string, any>, parsed: any, ctx: any) => void;
  slots: (data: Record<string, any>, ctx: any) => Slot[];
  summary: (data: Record<string, any>, ctx: any) => string[];
  create: (prisma: any, userId: number, data: Record<string, any>) => Promise<{ text: string; link: string }>;
}

const catList = (cats: any[]) => cats.map((c: any) => ({ label: c.name, value: c.id }));

const SPECS: Record<EntityKind, Spec> = {
  // ---------------- DEUDA / COBRO ----------------
  debt: {
    title: 'Deuda/Cobro',
    loadCtx: async () => ({}),
    extractSystem: () => `Extrae los datos de una DEUDA o COBRO (Ecuador, USD). Hoy es ${todayYmd()}.
Devuelve SOLO JSON: {"kind":"RECEIVABLE|PAYABLE|LOAN|null","amount":number|null,"counterparty":string|null,"dueDate":"YYYY-MM-DD|null","description":string|null}
- kind: RECEIVABLE si a ti te deben o vas a COBRAR ("me debe", "cobrar a", "presté"); PAYABLE si TÚ debes o vas a pagar ("le debo", "tengo que pagar"); LOAN si es un préstamo formal con cuotas. Si no está claro, null.
- amount: número en USD. counterparty: nombre de la persona/institución. dueDate: fecha de cobro/pago si la dice (resuelve "el 5", "5 de septiembre"). description: concepto breve.`,
    precarga: (data, p) => {
      if (['RECEIVABLE', 'PAYABLE', 'LOAN'].includes(p.kind)) data.kind = p.kind;
      if (Number(p.amount) > 0) data.amount = Number(p.amount);
      if (p.counterparty) data.counterparty = String(p.counterparty).trim();
      if (p.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) { data.dueDate = p.dueDate; data._dueSet = true; }
      if (p.description) data.description = String(p.description).trim();
    },
    slots: (data) => {
      const s: Slot[] = [];
      if (!(Number(data.amount) > 0)) s.push({ key: 'amount', ask: '💵 ¿De cuánto es? (solo el número)', type: 'num' });
      if (!data.counterparty) s.push({ key: 'counterparty', ask: '👤 ¿Con quién? (nombre de la persona o institución)', type: 'text' });
      if (!data.kind) s.push({ key: 'kind', ask: '¿Es un cobro o un pago?', type: 'choice', options: [
        { label: '💰 Por cobrar (me deben)', value: 'RECEIVABLE' },
        { label: '💸 Por pagar (yo debo)', value: 'PAYABLE' },
        { label: '🏦 Préstamo', value: 'LOAN' }
      ] });
      if (!data._dueSet) s.push({ key: 'dueDate', ask: '📅 ¿Para qué fecha? (ej. 5/09/2026, o escribe *sin fecha*)', type: 'date', optional: true });
      return s;
    },
    summary: (data) => {
      const kindLabel = data.kind === 'PAYABLE' ? 'Por pagar' : data.kind === 'LOAN' ? 'Préstamo' : 'Por cobrar';
      const lines = [`📌 *${kindLabel}* — ${fmt(data.amount)}`, `👤 ${data.counterparty}`];
      if (data.description) lines.push(`📝 ${data.description}`);
      lines.push(`📅 ${data.dueDate ? fmtDate(data.dueDate) : 'Sin fecha'}`);
      return lines;
    },
    create: async (prisma, userId, data) => {
      const kindLabel = data.kind === 'PAYABLE' ? 'Pago a' : data.kind === 'LOAN' ? 'Préstamo con' : 'Cobro a';
      const name = data.description || `${kindLabel} ${data.counterparty}`;
      const row = await prisma.debt.create({ data: {
        userId, kind: data.kind, status: 'OPEN', name,
        counterparty: data.counterparty || null,
        principal: data.amount, balance: data.amount,
        dueDate: data.dueDate ? new Date(data.dueDate + 'T00:00:00Z') : null
      } });
      const kl = data.kind === 'PAYABLE' ? 'cuenta por pagar' : data.kind === 'LOAN' ? 'préstamo' : 'cuenta por cobrar';
      return { text: `✅ Registré en *Deudas y Cobros* una *${kl}*: ${data.counterparty} · ${fmt(data.amount)}${data.dueDate ? ` (vence ${fmtDate(data.dueDate)})` : ''}.`, link: '/debts' };
    }
  },

  // ---------------- RECURRENTE ----------------
  recurring: {
    title: 'Recurrente',
    loadCtx: async (prisma, userId) => ({
      categories: await prisma.category.findMany({ where: { userId }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    }),
    extractSystem: (ctx) => `Extrae los datos de un pago/cobro RECURRENTE (se repite) en Ecuador, USD. Hoy es ${todayYmd()}.
Devuelve SOLO JSON: {"type":"INCOME|EXPENSE|null","amount":number|null,"name":string|null,"frequency":"DAILY|WEEKLY|MONTHLY|YEARLY|null","paymentMethod":"CASH|BANK_TRANSFER|DEBIT_CARD|CREDIT_CARD|WALLET|OTHER|null","nextRunDate":"YYYY-MM-DD|null","categoryId":number|null}
- type: INCOME si es algo que COBRAS/recibes (sueldo, renta a favor); EXPENSE si PAGAS (arriendo, suscripción, servicios).
- frequency: "mensual/todos los meses"=MONTHLY, "semanal"=WEEKLY, "diario"=DAILY, "anual"=YEARLY.
- name: concepto (ej. "Arriendo", "Netflix", "Sueldo"). nextRunDate: próxima fecha de pago/cobro si la dice; si no, null.
- categoryId: elige de las categorías por id si aplica; si no, null.
Categorías: ${JSON.stringify(catList(ctx.categories))}`,
    precarga: (data, p, ctx) => {
      if (['INCOME', 'EXPENSE'].includes(p.type)) data.type = p.type;
      if (Number(p.amount) > 0) data.amount = Number(p.amount);
      if (p.name) data.name = String(p.name).trim();
      if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(p.frequency)) data.frequency = p.frequency;
      if (['CASH', 'BANK_TRANSFER', 'DEBIT_CARD', 'CREDIT_CARD', 'WALLET', 'OTHER'].includes(p.paymentMethod)) data.paymentMethod = p.paymentMethod;
      if (p.nextRunDate && /^\d{4}-\d{2}-\d{2}$/.test(p.nextRunDate)) { data.nextRunDate = p.nextRunDate; data._nextSet = true; }
      if (p.categoryId && ctx.categories.some((c: any) => c.id === p.categoryId)) data.categoryId = p.categoryId;
    },
    slots: (data) => {
      const s: Slot[] = [];
      if (!data.type) s.push({ key: 'type', ask: '¿Es un ingreso o un gasto recurrente?', type: 'choice', options: [
        { label: '💰 Ingreso (cobro)', value: 'INCOME' }, { label: '💸 Gasto (pago)', value: 'EXPENSE' }
      ] });
      if (!(Number(data.amount) > 0)) s.push({ key: 'amount', ask: '💵 ¿De cuánto? (solo el número)', type: 'num' });
      if (!data.name || String(data.name).length < 2) s.push({ key: 'name', ask: '📝 ¿Qué nombre/concepto? (ej. Arriendo, Netflix, Sueldo)', type: 'text' });
      if (!data.frequency) s.push({ key: 'frequency', ask: '🔁 ¿Cada cuánto se repite?', type: 'choice', options: [
        { label: 'Mensual', value: 'MONTHLY' }, { label: 'Semanal', value: 'WEEKLY' }, { label: 'Diario', value: 'DAILY' }, { label: 'Anual', value: 'YEARLY' }
      ] });
      if (!data.paymentMethod) s.push({ key: 'paymentMethod', ask: '💳 ¿Método de pago habitual?', type: 'choice', options: [
        { label: '💵 Efectivo', value: 'CASH' }, { label: '🏦 Transferencia', value: 'BANK_TRANSFER' }, { label: '💳 T. Débito', value: 'DEBIT_CARD' }, { label: '💳 T. Crédito', value: 'CREDIT_CARD' }, { label: '👛 Billetera', value: 'WALLET' }, { label: '• Otro', value: 'OTHER' }
      ] });
      if (!data._nextSet) s.push({ key: 'nextRunDate', ask: '📅 ¿Fecha máxima de pago/cobro? (ej. 5/09/2026)', type: 'date' });
      return s;
    },
    summary: (data, ctx) => {
      const freq: Record<string, string> = { MONTHLY: 'Mensual', WEEKLY: 'Semanal', DAILY: 'Diario', YEARLY: 'Anual' };
      const cat = ctx.categories.find((c: any) => c.id === data.categoryId);
      const lines = [`🔁 *Recurrente ${data.type === 'INCOME' ? 'ingreso' : 'gasto'}* — ${fmt(data.amount)}`, `📝 ${data.name}`, `⏱️ ${freq[data.frequency] || data.frequency}`];
      if (cat) lines.push(`🏷️ ${cat.name}`);
      lines.push(`📅 Próximo: ${data.nextRunDate ? fmtDate(data.nextRunDate) : '—'}`);
      return lines;
    },
    create: async (prisma, userId, data) => {
      const row = await prisma.recurringRule.create({ data: {
        userId, name: data.name, type: data.type, amount: data.amount,
        frequency: data.frequency, paymentMethod: data.paymentMethod,
        nextRunDate: new Date((data.nextRunDate || todayYmd()) + 'T00:00:00Z'),
        categoryId: data.categoryId || null
      } });
      return { text: `✅ Creé un *recurrente ${data.type === 'INCOME' ? 'de ingreso' : 'de gasto'}*: ${data.name} · ${fmt(data.amount)}.`, link: '/recurrings' };
    }
  },

  // ---------------- PRESUPUESTO ----------------
  budget: {
    title: 'Presupuesto',
    loadCtx: async (prisma, userId) => ({
      categories: await prisma.category.findMany({ where: { userId }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    }),
    extractSystem: (ctx) => `Extrae un PRESUPUESTO mensual (límite de gasto por categoría) en USD.
Devuelve SOLO JSON: {"categoryId":number|null,"amount":number|null}
- categoryId: elige de las categorías por id la que mejor calce; si no calza, null.
- amount: el límite mensual en número.
Categorías: ${JSON.stringify(catList(ctx.categories))}`,
    precarga: (data, p, ctx) => {
      if (p.categoryId && ctx.categories.some((c: any) => c.id === p.categoryId)) data.categoryId = p.categoryId;
      if (Number(p.amount) > 0) data.amount = Number(p.amount);
    },
    slots: (data, ctx) => {
      const s: Slot[] = [];
      if (!data.categoryId) s.push({ key: 'categoryId', ask: '🏷️ ¿Para qué *categoría* es el presupuesto?', type: 'choice', options: catList(ctx.categories) });
      if (!(Number(data.amount) > 0)) s.push({ key: 'amount', ask: '💵 ¿Cuál es el *límite mensual*? (solo el número)', type: 'num' });
      return s;
    },
    summary: (data, ctx) => {
      const cat = ctx.categories.find((c: any) => c.id === data.categoryId);
      return [`📊 *Presupuesto mensual*`, `🏷️ ${cat ? cat.name : '—'}`, `💵 Límite: ${fmt(data.amount)}`];
    },
    create: async (prisma, userId, data) => {
      // upsert por (userId, categoryId, period): re-crear actualiza el límite.
      const existing = await prisma.budget.findFirst({ where: { userId, categoryId: data.categoryId, period: 'MONTHLY' }, select: { id: true } });
      if (existing) await prisma.budget.update({ where: { id: existing.id }, data: { amount: data.amount } });
      else await prisma.budget.create({ data: { userId, categoryId: data.categoryId, amount: data.amount, period: 'MONTHLY' } });
      return { text: `✅ Presupuesto guardado: ${fmt(data.amount)} al mes.`, link: '/budgets' };
    }
  },

  // ---------------- CUENTA ----------------
  account: {
    title: 'Cuenta',
    loadCtx: async () => ({}),
    extractSystem: () => `Extrae los datos para crear una CUENTA nueva (efectivo, banco o billetera) en USD.
Devuelve SOLO JSON: {"name":string|null,"type":"CASH|BANK|WALLET|null","initialBalance":number|null,"holder":string|null}
- type: CASH=efectivo, BANK=cuenta bancaria, WALLET=billetera digital. name: nombre para identificarla (ej. "Cuenta Pichincha sueldo"). initialBalance: saldo inicial si lo dice (si no, 0). holder: titular si lo menciona.`,
    precarga: (data, p) => {
      if (p.name) data.name = String(p.name).trim();
      if (['CASH', 'BANK', 'WALLET'].includes(p.type)) data.type = p.type;
      if (p.initialBalance != null && !isNaN(Number(p.initialBalance))) { data.initialBalance = Number(p.initialBalance); data._balSet = true; }
      if (p.holder) data.holder = String(p.holder).trim();
    },
    slots: (data) => {
      const s: Slot[] = [];
      if (!data.name || String(data.name).length < 2) s.push({ key: 'name', ask: '🏷️ ¿Cómo se llama la cuenta? (ej. Cuenta Pichincha sueldo)', type: 'text' });
      if (!data.type) s.push({ key: 'type', ask: '¿Qué tipo de cuenta es?', type: 'choice', options: [
        { label: '🏦 Banco', value: 'BANK' }, { label: '💵 Efectivo', value: 'CASH' }, { label: '👛 Billetera', value: 'WALLET' }
      ] });
      if (!data._balSet) s.push({ key: 'initialBalance', ask: '💵 ¿Saldo inicial? (0 si empieza vacía)', type: 'num' });
      return s;
    },
    summary: (data) => {
      const t: Record<string, string> = { BANK: 'Banco', CASH: 'Efectivo', WALLET: 'Billetera' };
      const lines = [`🏦 *Nueva cuenta* — ${t[data.type] || data.type}`, `🏷️ ${data.name}`, `💵 Saldo inicial: ${fmt(data.initialBalance || 0)}`];
      if (data.holder) lines.push(`👤 ${data.holder}`);
      return lines;
    },
    create: async (prisma, userId, data) => {
      const bal = Number(data.initialBalance || 0);
      await prisma.account.create({ data: {
        userId, name: data.name, type: data.type, holder: data.holder || null,
        initialBalance: bal, currentBalance: bal, isActive: true
      } });
      return { text: `✅ Creé la cuenta *${data.name}* con saldo ${fmt(bal)}.`, link: '/accounts' };
    }
  }
};

// ---- Extracción por entidad ----
async function extractEntity(prisma: any, userId: number, kind: EntityKind, text: string, ctx: any): Promise<any> {
  const creds = await getBrainCreds(prisma);
  if (!creds) return {};
  try {
    const raw = await chatComplete(creds, { system: SPECS[kind].extractSystem(ctx), user: text, jsonMode: true, temperature: 0.1, maxTokens: 1500 });
    return extractJson(raw) || {};
  } catch (e: any) { logger.warn({ e: e?.message, kind }, 'wa: extracción de entidad falló'); return {}; }
}

// ---- Motor: siguiente slot, auto-resolviendo choices de 1 opción ----
function nextSlot(spec: Spec, d: EDraft): Slot | null {
  for (let i = 0; i < 20; i++) {
    const slots = spec.slots(d.data, d.ctx);
    if (!slots.length) return null;
    const s = slots[0];
    if (s.type === 'choice') {
      if (!s.options || s.options.length === 0) { d.data[s.key] = null; if (s.key === 'dueDate') d.data._dueSet = true; continue; }
      if (s.options.length === 1) { d.data[s.key] = s.options[0].value; continue; }
    }
    return s;
  }
  return null;
}

async function askOrFinalize(msg: IncomingMessage, spec: Spec, d: EDraft): Promise<void> {
  const s = nextSlot(spec, d);
  if (s) { d.current = s; d.awaiting = 'question'; d.at = Date.now(); await msg.reply(renderSlot(s)); return; }
  // Resumen + confirmación
  d.awaiting = 'confirm'; d.current = null; d.at = Date.now();
  await msg.reply(`${spec.summary(d.data, d.ctx).join('\n')}\n\n¿Lo registro? Responde *SÍ* o *NO*.`);
}

/**
 * Arranca el flujo de una entidad (deuda/recurrente/presupuesto/cuenta): extrae lo
 * que pueda del texto y pide lo que falte. Devuelve true si tomó el control.
 */
export async function startEntity(prisma: any, msg: IncomingMessage, kind: EntityKind, text: string): Promise<void> {
  const spec = SPECS[kind];
  const ctx = await spec.loadCtx(prisma, msg.userId!);
  const parsed = await extractEntity(prisma, msg.userId!, kind, text, ctx);
  const data: Record<string, any> = {};
  spec.precarga(data, parsed, ctx);
  const d: EDraft = { kind, data, current: null, awaiting: 'question', userId: msg.userId!, at: Date.now(), ctx };
  eDrafts.set(msg.chatId, d);
  await askOrFinalize(msg, spec, d);
}

/**
 * Continúa un flujo de entidad en curso con la respuesta del usuario.
 * Devuelve true si consumió el mensaje (había borrador y lo procesó).
 */
export async function continueEntity(prisma: any, msg: IncomingMessage, text: string): Promise<boolean> {
  const d = getEDraft(msg.chatId);
  if (!d) return false;
  const spec = SPECS[d.kind];

  if (NEGATE.test(text)) { eDrafts.delete(msg.chatId); await msg.reply('❌ Cancelado. No registré nada.'); return true; }

  if (d.awaiting === 'confirm') {
    if (AFFIRM.test(text)) {
      eDrafts.delete(msg.chatId);
      try {
        const r = await spec.create(prisma, d.userId, d.data);
        await msg.reply(r.text);
        void createNotification(prisma, { userId: d.userId, type: 'INFO', title: `${spec.title} por WhatsApp`, body: r.text.replace(/\*/g, ''), link: r.link }).catch(() => {});
      } catch (e: any) {
        logger.error({ e: e?.message, kind: d.kind }, 'wa: fallo creando entidad');
        await msg.reply(`❌ No pude guardar (${e?.message || 'error'}). Intenta de nuevo.`);
      }
      return true;
    }
    // No es sí/no en confirmación → lo tratamos como corrección re-preguntando.
    await msg.reply(`${spec.summary(d.data, d.ctx).join('\n')}\n\n¿Lo registro? Responde *SÍ* o *NO*.`);
    return true;
  }

  // Respondiendo a una pregunta (slot)
  const s = d.current;
  if (!s) { await askOrFinalize(msg, spec, d); return true; }
  if (s.type === 'num') {
    const n = parseAmount(text);
    if (!(n >= 0)) { await msg.reply('🤔 Dime solo el número, ej. *500*.'); return true; }
    d.data[s.key] = n; if (s.key === 'initialBalance') d.data._balSet = true;
  } else if (s.type === 'text') {
    const v = text.trim().slice(0, 120);
    if (v.length < 2) { await msg.reply('🤔 Muy corto, dime algo más.'); return true; }
    d.data[s.key] = v;
  } else if (s.type === 'date') {
    const parsed = parseDateLoose(text);
    if (parsed === undefined) { await msg.reply('🤔 No entendí la fecha. Escribe *5/09/2026*' + (s.optional ? ' o *sin fecha*.' : '.')); return true; }
    d.data[s.key] = parsed; if (s.key === 'dueDate') d.data._dueSet = true; if (s.key === 'nextRunDate') d.data._nextSet = true;
  } else { // choice
    const c = resolveChoice(s, text);
    if (!c) { await msg.reply('🤔 No te entendí.\n' + renderSlot(s)); return true; }
    d.data[s.key] = c.value;
  }
  d.at = Date.now();
  await askOrFinalize(msg, spec, d);
  return true;
}
