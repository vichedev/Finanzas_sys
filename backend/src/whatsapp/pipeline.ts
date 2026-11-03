// =====================================================
// Pipeline del bot de WhatsApp — registro INTERACTIVO tipo formulario.
//
// La IA extrae del audio/texto lo que puede (tipo, monto, detalle, fecha,
// categoría, quién paga, método). Luego el bot PIDE lo que falte, uno por uno,
// como el formulario web: monto → detalle → método de pago → cuenta/tarjeta/
// billetera (según el método, filtrando por banco si lo mencionas) → categoría.
// Cuando todo está resuelto, muestra el resumen y pide confirmación (SÍ/NO).
// También adjunta comprobantes y responde consultas.
// =====================================================
import { logger } from '../lib/logger';
import { getTenantPrisma } from '../lib/tenantPrisma';
import { getTranscribeCreds } from './llm';
import { transcribeAudio } from './transcribe';
import { parseMovement, type ParsedMovement, type MovType } from './parser';
import { normalizeMemoryKey, recordCategoryCorrection } from './aiMemory';
import { BARE_NO, CANCEL_REQUEST, STRICT_NO, STRICT_YES, isValidCategoryName, mentionsDate, parseAmountReply, parseDateReply, parseOptionIndex, readNumber } from './replies';
import type { ReviewIssue } from './reviewParsed';
import { todayEcuador } from '../lib/ecuadorDate';
import { answerQuestion } from './assistant';
import { classifyTarget, startEntity, continueEntity, clearEntityDraft, hasEntityDraft } from './entities';
import { createMovement, MOVE_LABEL } from '../routes/tenant/movements.routes';
import { createNotification } from '../lib/notifications';
import { optimizeImage } from '../lib/imageOptimize';
import type { IncomingMessage } from './gateway';

const fmt = (v: unknown) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

type Img = { buffer: Buffer; mimetype: string };
type Patch = Record<string, unknown>;
interface Option { label: string; patch: Patch; action?: 'showAllCats' | 'transferToPerson' | 'newCategory' }
interface Question { key: string; text: string; options?: Option[]; free?: 'amount' | 'description' | 'date'; resolveKey?: string }
interface Ctx { accounts: any[]; creditCards: any[]; wallets: any[]; categories: any[] }
interface Draft {
  payload: Record<string, unknown>;
  resolved: Set<string>;           // slots con valor "nulo válido" ya resueltos (method, category)
  bankHint: string;
  ctx: Ctx;
  categoryCandidates: number[];    // categorías probables (para no listar todas)
  showAllCats: boolean;            // el usuario pidió "ver todas" las categorías
  awaitingNewCategory: boolean;    // esperando el nombre de una categoría nueva a crear
  current: Question | null;
  awaiting: 'question' | 'confirm';
  userId: number;
  at: number;
  pendingImages: Img[];
  pendingChecks: ReviewIssue[];    // dudas de la revisión: se preguntan antes que nada
  proposedCategoryId: number | null; // la que propuso la IA o la memoria
  categoryChosenByUser: boolean;   // el usuario la eligió en este borrador (para aprender)
  vendor: string | null;           // comercio entendido, aunque el tipo no lo guarde
  originalText: string;            // lo que escribió o dijo el usuario
  memoryCategoryId: number | null; // la categoría que salió de un recuerdo
}

const drafts = new Map<string, Draft>();
const lastMovement = new Map<string, { id: number; label: string; at: number }>();
const DRAFT_TTL = 10 * 60 * 1000;
const LAST_TTL = 15 * 60 * 1000;

function getDraft(chatId: string): Draft | null {
  const d = drafts.get(chatId);
  if (!d) return null;
  if (Date.now() - d.at > DRAFT_TTL) { drafts.delete(chatId); return null; }
  return d;
}
function getLast(chatId: string) {
  const l = lastMovement.get(chatId);
  if (!l) return null;
  if (Date.now() - l.at > LAST_TTL) { lastMovement.delete(chatId); return null; }
  return l;
}

// En preguntas corrientes basta con que empiece así; en la confirmación se usa STRICT_NO.
const NEGATE = /^\s*(no|nel|nop|cancela(r)?|olv[ií]dalo|❌)(?![\p{L}\p{N}_])/iu;
const YES_PREFIX = /^\s*(s[ií]|ok(ay)?|dale)[\s,]/iu;
const BARE_NUMBER = /(?:^|\s)\d+(?:[.,]\d+)*(?:\s|$)/;
const MAX_TEXT = 2000;
const HELPREQ = /^\s*(ayuda|help|men[uú]|c[oó]mo funciona|hola|buenas|\?)\s*$/i;
const CHANGE_CATEGORY = /^\s*(cambiar?\s+(la\s+)?)?categor[ií]a\s*[.!]?\s*$/i;
const CHECK_KEY = 'check:';

const HELP = `👋 *Asistente de finanzas* — responde con el *número* de lo que quieres hacer (o descríbelo por audio/texto):

*1️⃣ Registrar movimiento* 💸
   _gasto, ingreso, compra, transferencia o retiro_
*2️⃣ Deuda o cobro* 🤝
   _me deben / yo debo / cobrar a alguien_
*3️⃣ Pago o cobro recurrente* 🔁
   _algo que se repite cada mes/semana_
*4️⃣ Presupuesto* 📊
   _límite de gasto por categoría_
*5️⃣ Crear cuenta* 🏦
   _efectivo, banco o billetera_
*6️⃣ Consultar / consejos* 🧠
   _¿en qué gasto más?, ¿cómo voy?_

Escribe el *número* (ej: *2*) y te voy pidiendo cada dato, uno por uno. 📎 En movimientos puedes enviar la *foto del comprobante*.`;

// Texto de arranque de cada opción del menú: le dice al usuario qué escribir/decir.
const MENU_PROMPT: Record<string, string> = {
  '1': '💸 *Registrar movimiento*\nEscribe o di qué pasó, con el *monto*. Ejemplos:\n• _gasté 20 en el súper con Pichincha_\n• _ingreso de 800 de sueldo_\n• _transferí 50 de Pichincha a Guayaquil_\nLo que falte te lo pregunto.',
  '6': '🧠 *Consulta*\nEscribe o di tu pregunta. Ejemplos:\n• _¿en qué gasto más este mes?_\n• _¿cómo voy con mis gastos?_\n• _dame consejos para ahorrar_'
};

const METHOD_LABEL: Record<string, string> = { CASH: 'Efectivo', BANK_TRANSFER: 'Transferencia', DEPOSIT: 'Depósito', DEBIT_CARD: 'Tarjeta de débito', CREDIT_CARD: 'Tarjeta de crédito', WALLET: 'Billetera', OTHER: 'Otro' };

function fmtDate(ymd: string): string { const [y, m, d] = ymd.split('-'); return d && m && y ? `${d}/${m}/${y}` : ymd; }
function accLabel(a: any): string {
  const parts: string[] = [a.name];
  if (a.accountKind) parts.push(a.accountKind === 'SAVINGS' ? 'Ahorros' : 'Corriente');
  if (a.accountNumber) parts.push('****' + String(a.accountNumber).slice(-4));
  else if (a.bankName) parts.push(a.bankName);
  return parts.join(' · ');
}
function cardLabel(c: any): string {
  const parts: string[] = [c.name];
  if (c.bankName) parts.push(c.bankName);
  if (c.last4) parts.push('****' + c.last4);
  return parts.join(' · ');
}
/**
 * Interpreta un monto tolerando separadores de miles y decimales en formato
 * latino o anglosajón: "3098"/"3.098"/"3,098" = 3098; "3,98"/"3.98" = 3.98;
 * "3.098,50"/"3,098.50" = 3098.50. Un separador con 3 dígitos detrás = miles.
 */
function parseAmount(text: string): number {
  const m = String(text).match(/-?\d[\d.,]*/);
  return m ? readNumber(m[0]) : NaN;
}

// ---- Comprobantes (imagen) ----
const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_ATT = 8 * 1024 * 1024;
function extOf(mime: string): string {
  if (mime.includes('png')) return 'png'; if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif'; if (mime.includes('pdf')) return 'pdf'; return 'jpg';
}
async function attachToMovement(prisma: any, userId: number, movementId: number, img: Img): Promise<'ok' | 'toobig' | 'badtype' | 'err'> {
  const mime = (img.mimetype || 'image/jpeg').split(';')[0].trim();
  if (!ALLOWED_MIME.includes(mime)) return 'badtype';
  if (!img.buffer?.length) return 'err';
  if (img.buffer.length > MAX_ATT) return 'toobig';
  try {
    const opt = await optimizeImage(img.buffer, mime);
    await prisma.attachment.create({ data: {
      userId, entityType: 'MOVEMENT', entityId: movementId,
      filename: `comprobante-wa-${Date.now()}.${extOf(opt.mimeType)}`,
      mimeType: opt.mimeType, size: opt.buffer.length, data: new Uint8Array(opt.buffer)
    } });
    return 'ok';
  } catch (e: any) { logger.error({ e: e?.message }, 'wa: fallo adjuntando comprobante'); return 'err'; }
}

// ---- Preguntas (slots) ----
/** Filtra una lista (cuentas/tarjetas) por el banco mencionado; si no calza ninguna, no filtra. */
function filterByBank<T extends { bankName?: string | null; name?: string | null }>(list: T[], bankHint: string): T[] {
  const hint = norm(bankHint);
  if (!hint) return list;
  const byBank = list.filter((x) => norm(x.bankName).includes(hint) || norm(x.name).includes(hint) || hint.includes(norm(x.bankName)));
  return byBank.length ? byBank : list;
}
function accountQ(key: string, text: string, accounts: any[], bankHint: string, field: 'accountId' | 'toAccountId'): Question {
  const list = filterByBank(accounts, bankHint);
  return { key, text, options: list.map((a: any) => ({ label: `🏦 ${accLabel(a)}`, patch: { [field]: a.id } })) };
}
function methodQ(ctx: Ctx): Question {
  const opts: Option[] = [{ label: '💵 Efectivo', patch: { paymentMethod: 'CASH', accountId: null, cardId: null, walletId: null } }];
  if (ctx.accounts.length) {
    opts.push({ label: '🏦 Transferencia', patch: { paymentMethod: 'BANK_TRANSFER' } });
    opts.push({ label: '🧾 Depósito', patch: { paymentMethod: 'DEPOSIT' } });
    opts.push({ label: '💳 Tarjeta de débito', patch: { paymentMethod: 'DEBIT_CARD' } });
  }
  if (ctx.creditCards.length) opts.push({ label: '💳 Tarjeta de crédito', patch: { paymentMethod: 'CREDIT_CARD' } });
  if (ctx.wallets.length) opts.push({ label: '👛 Billetera', patch: { paymentMethod: 'WALLET' } });
  opts.push({ label: '• Otro', patch: { paymentMethod: 'OTHER', accountId: null, cardId: null, walletId: null } });
  return { key: 'method', text: '💳 ¿Cuál es el *método de pago*?', options: opts, resolveKey: 'method' };
}
function cardQ(cards: any[], bankHint: string): Question {
  const list = filterByBank(cards, bankHint);
  return { key: 'card', text: '💳 ¿Cuál *tarjeta de crédito*?', options: list.map((c: any) => ({ label: `💳 ${cardLabel(c)}`, patch: { cardId: c.id } })) };
}
function walletQ(wallets: any[]): Question { return { key: 'wallet', text: '👛 ¿Cuál *billetera*?', options: wallets.map((w: any) => ({ label: `👛 ${w.name}`, patch: { walletId: w.id } })) }; }
/** Busca una categoría por nombre (sin distinguir mayúsculas) o la crea. */
async function findOrCreateCategory(prisma: any, userId: number, name: string): Promise<{ id: number; name: string }> {
  const clean = name.trim().slice(0, 60);
  const existing = await prisma.category.findFirst({ where: { userId, name: { equals: clean, mode: 'insensitive' } }, select: { id: true, name: true } });
  if (existing) return existing;
  return prisma.category.create({ data: { userId, name: clean }, select: { id: true, name: true } });
}

/** Categorías: muestra solo las candidatas (relacionadas al detalle) + "crear" + "ver todas". */
function categoryQ(d: Draft): Question {
  const cats = d.ctx.categories;
  const cands = d.showAllCats ? [] : cats.filter((c: any) => d.categoryCandidates.includes(c.id));
  const list = cands.length ? cands : cats;
  const options: Option[] = list.map((c: any) => ({ label: c.name, patch: { categoryId: c.id } }));
  options.push({ label: '➕ Crear nueva categoría', patch: {}, action: 'newCategory' });
  options.push({ label: 'Sin categoría', patch: { categoryId: null } });
  // Si mostramos solo las probables, deja una salida para ver el resto.
  if (cands.length && cands.length < cats.length) options.push({ label: '📋 Ver todas las categorías', patch: {}, action: 'showAllCats' });
  const hint = cands.length ? ' _(las más probables, o escribe el nombre de una)_' : '';
  return { key: 'category', text: `🏷️ ¿Qué *categoría*?${hint}`, options, resolveKey: 'category' };
}

/** Traduce el cambio de una duda de revisión a los campos del movimiento. */
function checkPatch(patch: ReviewIssue['options'][number]['patch']): Patch {
  const out: Patch = {};
  if (patch.amount !== undefined) out.amount = Number(patch.amount) > 0 ? Number(patch.amount) : null;
  if (patch.date !== undefined) out.movementDate = patch.date && /^\d{4}-\d{2}-\d{2}$/.test(patch.date) ? patch.date : todayEcuador();
  return out;
}
function checkQ(issue: ReviewIssue): Question {
  // En una duda de monto o de fecha se puede escribir el dato, aunque no sea una de las opciones.
  const free = issue.free ?? (issue.code.startsWith('AMOUNT_') ? 'amount' : issue.code.startsWith('DATE_') ? 'date' : undefined);
  return { key: CHECK_KEY + issue.code, text: issue.question, free, options: issue.options.map((o) => ({ label: o.label, patch: checkPatch(o.patch) })) };
}

function dateMissingIssue(today: string): ReviewIssue {
  const yesterday = parseDateReply('ayer', today);
  const options: ReviewIssue['options'] = [{ label: `Hoy (${fmtDate(today)})`, patch: { date: today } }];
  if (yesterday && 'date' in yesterday) options.push({ label: `Ayer (${fmtDate(yesterday.date)})`, patch: { date: yesterday.date } });
  return { code: 'DATE_MISSING', question: '📅 ¿Qué *fecha* tiene este movimiento?', options, free: 'date' };
}

type CheckAnswer = { patch: Patch } | { cancel: true } | { badDate: true } | null;

/**
 * Respuesta a una duda de revisión. Solo vale un mensaje que sea entero una opción, un dato o
 * una salida: "pagué 15 de taxi" o "sí, pero son 30" devuelven null y se vuelve a preguntar.
 */
function resolveCheckAnswer(q: Question, text: string): CheckAnswer {
  const options = q.options || [];
  const index = parseOptionIndex(text);
  if (index !== null && index >= 1 && index <= options.length) return { patch: options[index - 1].patch };
  if (CANCEL_REQUEST.test(text)) return { cancel: true };
  if (q.free === 'amount') {
    const amount = parseAmountReply(text);
    if (amount !== null) return { patch: { amount } };
  }
  if (q.free === 'date') {
    const date = parseDateReply(text, todayEcuador());
    if (date) return 'date' in date ? { patch: { movementDate: date.date } } : { badDate: true };
  }
  // "no, usar hoy" se compara como "usar hoy".
  const t = norm(text).replace(/^(no|nel|nop)\b[\s,.:-]*/, '');
  if (t.length >= 3) { const hits = options.filter((o) => norm(o.label).includes(t) || t.includes(norm(o.label))); if (hits.length === 1) return { patch: hits[0].patch }; }
  // Un "no" suelto elige la única opción que empieza por "No".
  if (BARE_NO.test(text)) { const noes = options.filter((o) => /^no\b/i.test(o.label)); if (noes.length === 1) return { patch: noes[0].patch }; }
  // La primera opción conserva lo entendido: "sí" significa dejarlo como está.
  if (options.length && STRICT_YES.test(text)) return { patch: options[0].patch };
  return null;
}

/** Ajusta campos derivados al elegir el tipo de movimiento (cuando se pregunta el tipo). */
function applyTypeDefaults(d: Draft): void {
  const t = d.payload.type as MovType;
  d.payload.expenseKind = t === 'EXPENSE' ? 'VARIABLE' : null;
  d.payload.isCredit = false;
  if (t === 'TRANSFER' || t === 'WITHDRAWAL') { d.payload.paymentMethod = 'BANK_TRANSFER'; d.resolved.add('method'); }
}

/** Devuelve la siguiente pregunta pendiente, auto-resolviendo las que tienen una sola opción. */
function computeNext(d: Draft): Question | null {
  for (let i = 0; i < 25; i++) {
    const q = rawNext(d);
    if (!q) return null;
    if (q.key.startsWith(CHECK_KEY)) return q; // las dudas siempre las responde el usuario
    if (q.options && q.options.length === 0) { if (q.resolveKey) d.resolved.add(q.resolveKey); else break; continue; }
    if (q.options && q.options.length === 1 && q.key !== 'method') {
      Object.assign(d.payload, q.options[0].patch);
      if (q.resolveKey) d.resolved.add(q.resolveKey);
      continue;
    }
    return q;
  }
  return null;
}
function rawNext(d: Draft): Question | null {
  // La fecha se pregunta después del monto y el detalle; las demás dudas, antes que nada.
  const nextCheck = d.pendingChecks[0];
  if (nextCheck && nextCheck.code !== 'DATE_MISSING') return checkQ(nextCheck);
  const p = d.payload;
  const type = p.type as MovType;
  if (!type) return { key: 'movtype', text: '¿Qué *tipo de movimiento* quieres registrar?', options: [
    { label: '💸 Gasto', patch: { type: 'EXPENSE' } },
    { label: '💰 Ingreso', patch: { type: 'INCOME' } },
    { label: '🛍️ Compra', patch: { type: 'PURCHASE' } },
    { label: '🔁 Transferencia', patch: { type: 'TRANSFER' } },
    { label: '🏧 Retiro', patch: { type: 'WITHDRAWAL' } }
  ] };
  if (!(Number(p.amount) > 0)) return { key: 'amount', text: '💵 Escribe el *monto* (solo números, ej: *20* o *24.50*)', free: 'amount' };
  if (!p.description || String(p.description).trim().length < 2) return { key: 'description', text: '📝 Escribe el *detalle* (ej: *Supermercado*, *Gasolina*, *Sueldo*)', free: 'description' };
  if (nextCheck) return checkQ(nextCheck);

  if (type === 'TRANSFER') {
    // Primero: ¿es entre cuentas propias o a otra persona? (cambia cómo se registra)
    if (!d.resolved.has('transferScope')) return { key: 'transferScope', text: '🔁 Esta transferencia es…', resolveKey: 'transferScope', options: [
      { label: '🔄 Entre MIS cuentas', patch: {} },
      { label: '👤 A otra persona (sale dinero)', patch: {}, action: 'transferToPerson' }
    ] };
    if (!p.accountId) return accountQ('fromAccount', '🔁 ¿De qué cuenta *sale* el dinero?', d.ctx.accounts, d.bankHint, 'accountId');
    if (!p.toAccountId) return accountQ('toAccount', '🔁 ¿A qué cuenta *entra*?', d.ctx.accounts.filter((a: any) => a.id !== p.accountId), '', 'toAccountId');
    return null;
  }
  if (type === 'WITHDRAWAL') {
    if (!p.accountId) return accountQ('account', '🏧 ¿De qué cuenta retiras el efectivo?', d.ctx.accounts, d.bankHint, 'accountId');
    return null;
  }
  // INCOME / EXPENSE / PURCHASE
  if (!d.resolved.has('method')) return methodQ(d.ctx);
  const m = String(p.paymentMethod || '');
  if ((m === 'BANK_TRANSFER' || m === 'DEPOSIT' || m === 'DEBIT_CARD') && !p.accountId) return accountQ('account', '🏦 ¿De qué *cuenta*?', d.ctx.accounts, d.bankHint, 'accountId');
  if (m === 'CREDIT_CARD' && !p.cardId) return cardQ(d.ctx.creditCards, d.bankHint);
  if (m === 'WALLET' && !p.walletId) return walletQ(d.ctx.wallets);
  if (!d.resolved.has('category') && hasCategory(type)) return categoryQ(d);
  return null;
}

function hasCategory(type: unknown): boolean { return type === 'EXPENSE' || type === 'INCOME' || type === 'PURCHASE'; }

function renderQuestion(q: Question): string {
  if (q.free && !q.options?.length) return q.text;
  const lines = (q.options || []).map((o, i) => `${i + 1}. ${o.label}`);
  const how = q.free === 'amount' ? 'Responde con el número de la opción o escribe el monto correcto.'
    : q.free === 'date' ? 'Responde con el número de la opción o escribe la fecha (ej: *ayer* o *15/03*).'
    : 'Responde con el número.';
  return `${q.text}\n${lines.join('\n')}\n\n_${how}_`;
}
function resolveChoice(q: Question, text: string): Option | null {
  const n = parseOptionIndex(text);
  if (n !== null && q.options && n >= 1 && n <= q.options.length) return q.options[n - 1];
  const t = norm(text);
  if (t.length >= 3 && q.options) { const hits = q.options.filter((o) => norm(o.label).includes(t) || t.includes(norm(o.label))); if (hits.length === 1) return hits[0]; }
  return null;
}

/** Texto limpio de un campo de la IA, que puede venir vacío o no ser texto. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

/** Arma el payload inicial + contexto desde lo que la IA entendió. */
async function buildRegister(prisma: any, userId: number, p: ParsedMovement, originalText: string): Promise<Draft | { ask: string }> {
  const type = p.type as MovType;
  const [accounts, creditCards, wallets, categories] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, accountKind: true, accountNumber: true }, orderBy: { name: 'asc' } }),
    prisma.card.findMany({ where: { userId, isActive: true, type: 'CREDIT' }, select: { id: true, name: true, bankName: true, last4: true }, orderBy: { name: 'asc' } }),
    prisma.wallet.findMany({ where: { userId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  ]);
  if (!accounts.length && (type === 'TRANSFER' || type === 'WITHDRAWAL')) {
    return { ask: 'No tienes cuentas registradas. Créalas en la sección *Cuentas* y vuelve a intentar.' };
  }

  // Sin fecha en el mensaje se pregunta: la que ponga la IA sería una suposición.
  const today = todayEcuador();
  const validDate = !!p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date);
  const saidToday = /(?<![\p{L}\p{N}])hoy(?![\p{L}\p{N}])/iu.test(originalText);
  const dated = saidToday || (mentionsDate(originalText) && validDate);
  const date = dated && validDate ? (p.date as string) : today;
  const payload: Record<string, unknown> = {
    type, amount: Number(p.amount) > 0 ? Number(p.amount) : null,
    movementDate: date, description: textOf(p.description),
    paymentMethod: null, accountId: null, toAccountId: null, cardId: null, walletId: null, categoryId: null,
    expenseKind: type === 'EXPENSE' ? 'VARIABLE' : null,
    isCredit: type === 'PURCHASE' ? !!p.isCredit : false,
    vendor: type === 'PURCHASE' ? textOf(p.vendor) : null,
    familyMember: textOf(p.familyMember),
    notes: textOf(p.notes)
  };
  const resolved = new Set<string>();

  // Precarga lo que la IA resolvió con seguridad.
  const acc = accounts.find((a: any) => a.id === p.accountId);
  const credit = creditCards.find((c: any) => c.id === p.cardId);
  const cat = categories.find((c: any) => c.id === p.categoryId);
  if (type === 'TRANSFER') {
    payload.paymentMethod = 'BANK_TRANSFER'; resolved.add('method');
    if (acc) payload.accountId = acc.id;
    if (accounts.find((a: any) => a.id === p.toAccountId)) payload.toAccountId = p.toAccountId;
  } else if (type === 'WITHDRAWAL') {
    payload.paymentMethod = 'BANK_TRANSFER'; resolved.add('method');
    if (acc) payload.accountId = acc.id;
  } else {
    // El MÉTODO manda y el instrumento es coherente con él:
    //  - crédito -> SOLO tarjeta de crédito (nunca cuenta).
    //  - transferencia/depósito/débito -> SOLO cuenta (nunca tarjeta).
    // Si pide crédito pero no hay tarjetas de crédito, no lo forzamos: se re-pregunta el método.
    let method = p.paymentMethod || null;
    if (method === 'CREDIT_CARD' && !creditCards.length) method = null;
    const wantsCredit = (method === 'CREDIT_CARD' || !!credit) && creditCards.length > 0;

    if (wantsCredit) {
      payload.paymentMethod = 'CREDIT_CARD'; resolved.add('method');
      payload.accountId = null;                 // crédito NO usa cuenta
      if (credit) payload.cardId = credit.id;   // si la IA acertó la tarjeta exacta
    } else if (method === 'CASH') {
      payload.paymentMethod = 'CASH'; resolved.add('method');
    } else if (acc) {
      payload.accountId = acc.id; payload.cardId = null;
      payload.paymentMethod = (method === 'DEBIT_CARD' || method === 'DEPOSIT') ? method : 'BANK_TRANSFER';
      resolved.add('method');
    } else if (method) {
      payload.paymentMethod = method; resolved.add('method');
    }
    if (cat) { payload.categoryId = cat.id; resolved.add('category'); }
  }

  // Si no dijo la fecha, las dudas sobre la que puso la IA no aplican: se le pregunta y ya.
  const reviewed: ReviewIssue[] = [...(p.reviewIssues || [])];
  const checks = dated ? reviewed : [...reviewed.filter((c) => !c.code.startsWith('DATE_')), dateMissingIssue(today)];

  return { payload, resolved, bankHint: p.bankHint || '', ctx: { accounts, creditCards, wallets, categories }, categoryCandidates: p.categoryCandidates || [], showAllCats: false, awaitingNewCategory: false, current: null, awaiting: 'question', userId, at: Date.now(), pendingImages: [], pendingChecks: checks, proposedCategoryId: cat?.id ?? null, categoryChosenByUser: false, vendor: textOf(p.vendor), originalText, memoryCategoryId: p.categoryFromMemory ? p.categoryId : null };
}

async function balanceReadback(prisma: any, userId: number, payload: Record<string, unknown>): Promise<string> {
  try {
    if (payload.accountId) { const a = await prisma.account.findFirst({ where: { id: payload.accountId, userId }, select: { name: true, currentBalance: true } }); if (a) return `\n💰 Saldo de ${a.name}: ${fmt(a.currentBalance)}`; }
    if (payload.cardId && payload.type !== 'TRANSFER') { const c = await prisma.card.findFirst({ where: { id: payload.cardId, userId }, select: { name: true, currentBalance: true } }); if (c) return `\n💳 Usado en ${c.name}: ${fmt(c.currentBalance)}`; }
  } catch { /* opcional */ }
  return '';
}

async function finalize(prisma: any, msg: IncomingMessage, d: Draft): Promise<void> {
  const p = d.payload;
  const [acc, toAcc, card, wallet, cat] = await Promise.all([
    p.accountId ? prisma.account.findFirst({ where: { id: p.accountId }, select: { name: true, accountKind: true, accountNumber: true, bankName: true } }) : null,
    p.toAccountId ? prisma.account.findFirst({ where: { id: p.toAccountId }, select: { name: true, accountKind: true, accountNumber: true, bankName: true } }) : null,
    p.cardId ? prisma.card.findFirst({ where: { id: p.cardId }, select: { name: true } }) : null,
    p.walletId ? prisma.wallet.findFirst({ where: { id: p.walletId }, select: { name: true } }) : null,
    p.categoryId ? prisma.category.findFirst({ where: { id: p.categoryId }, select: { name: true } }) : null
  ]);
  const type = p.type as MovType;
  const lines: string[] = [`📋 *${MOVE_LABEL[type]}* — ${fmt(p.amount)}`, `📝 ${p.description}`];
  if (type === 'TRANSFER') lines.push(`🔁 De *${acc ? accLabel(acc) : '?'}* a *${toAcc ? accLabel(toAcc) : '?'}*`);
  else {
    const via = card ? `💳 ${card.name}` : wallet ? `👛 ${wallet.name}` : acc ? `🏦 ${accLabel(acc)}` : '💵 Efectivo';
    lines.push(`${METHOD_LABEL[String(p.paymentMethod)] || p.paymentMethod} · ${via}`);
  }
  if (hasCategory(type)) lines.push(`🏷️ ${cat ? cat.name : 'Sin categoría'}${cat && p.categoryId === d.memoryCategoryId ? ' (recordada)' : ''}`);
  if (p.familyMember) lines.push(`👤 ${p.familyMember}`);
  if (type === 'PURCHASE' && p.isCredit) lines.push('🕒 Compra fiada (se paga después)');
  lines.push(`📅 ${fmtDate(String(p.movementDate))}`);

  d.awaiting = 'confirm'; d.current = null; d.at = Date.now();
  const extra = d.pendingImages.length ? '\n📎 Adjuntaré la foto del comprobante al confirmar.' : '';
  await msg.reply(`${lines.join('\n')}${extra}\n\n¿Lo registro? Responde *SÍ* o *NO*${hasCategory(type) ? ', o *CATEGORÍA* para cambiarla' : ''}.`);
}

/** Lo que el borrador está esperando, para repetirlo. */
function pendingPrompt(d: Draft): string {
  if (d.awaitingNewCategory) return '➕ Escribe el *nombre* de la nueva categoría (ej: *Mascotas*, *Educación*).';
  if (d.awaiting === 'question' && d.current) return renderQuestion(d.current);
  return hasCategory(d.payload.type) ? 'Responde *SÍ*, *NO* o *CATEGORÍA*.' : 'Responde *SÍ* o *NO*.';
}

async function advance(prisma: any, msg: IncomingMessage, d: Draft): Promise<void> {
  const q = computeNext(d);
  if (q) { d.current = q; d.awaiting = 'question'; d.at = Date.now(); await msg.reply(renderQuestion(q)); }
  else await finalize(prisma, msg, d);
}

export async function handleIncoming(msg: IncomingMessage): Promise<void> {
  if (msg.userId == null) { await msg.reply('⚠️ La vinculación quedó incompleta. Entra a *Ajustes → Asistente WhatsApp* y vuelve a vincular.'); return; }
  const prisma = await getTenantPrisma(msg.tenantId);
  const userId = msg.userId;
  const image = msg.image;

  let text = (msg.text || '').trim();
  const fromAudio = !!msg.audio;
  if (fromAudio) {
    const creds = await getTranscribeCreds(prisma);
    if (!creds) { await msg.reply('⚠️ Falta la clave de Groq para transcribir audio. Ve a *Ajustes → FinancIA* y guárdala.'); return; }
    await msg.reply('🎧 Escuchando tu audio…');
    try { text = (await transcribeAudio(creds.apiKey, msg.audio!.buffer, msg.audio!.mimetype)).trim(); }
    catch (e: any) { await msg.reply(`❌ ${e?.message || 'No se pudo transcribir el audio.'}`); return; }
    if (!text) { await msg.reply('No entendí el audio 😕. Intenta de nuevo, más claro.\n\n' + HELP); return; }
  }

  text = text.slice(0, MAX_TEXT);

  const draft = getDraft(msg.chatId);

  // Un pie de foto nunca es una respuesta a lo que esté pendiente.
  if (image && text && !fromAudio && hasEntityDraft(msg.chatId)) { await msg.reply('📎 No puedo guardar la foto en este registro. Responde sin foto a lo que te pregunté, o escribe *no* para salir.'); return; }

  // Si hay un flujo de ENTIDAD en curso (deuda/recurrente/presupuesto/cuenta),
  // la respuesta de texto va ahí (devuelve false si no hay borrador de entidad).
  if (!fromAudio && text && await continueEntity(prisma, msg, text)) return;

  if (image && !text && !fromAudio) { await handleVoucher(prisma, msg, image, draft); return; }
  if (text && HELPREQ.test(text) && !draft) { await msg.reply(HELP); return; }

  // Borrador en curso + respuesta de texto. Por audio solo se responde a la confirmación y a
  // las dudas: en esos puntos un audio tampoco debe reemplazar el borrador sin decir nada.
  const checking = !!draft && draft.awaiting === 'question' && !!draft.current?.key.startsWith(CHECK_KEY);
  if (draft && (!fromAudio || draft.awaiting === 'confirm' || checking)) {
    if (fromAudio) await msg.reply(`📝 Entendí: "${text}"`);
    if (image) {
      draft.pendingImages.push(image); draft.at = Date.now();
      await msg.reply(`📎 Foto guardada; la adjuntaré al confirmar. El texto de la foto no cuenta como respuesta.\n${pendingPrompt(draft)}`);
      return;
    }

    // Duda de la revisión: nada fuera de una respuesta completa toca el borrador.
    if (checking) {
      const question = draft.current!;
      const answer = resolveCheckAnswer(question, text);
      if (answer && 'cancel' in answer) { drafts.delete(msg.chatId); await msg.reply('❌ Cancelado. No registré nada.'); return; }
      if (answer && 'badDate' in answer) { await msg.reply('🤔 Esa fecha es futura o tiene más de un año.\n' + renderQuestion(question)); return; }
      if (!answer) { await msg.reply('🤔 No te entendí. Para anular el movimiento escribe *cancelar*.\n' + renderQuestion(question)); return; }
      Object.assign(draft.payload, answer.patch);
      const issue = draft.pendingChecks.shift();
      // Una vez aclarado el monto, no se vuelve a preguntar por el mismo monto.
      if (issue?.code.startsWith('AMOUNT_')) draft.pendingChecks = draft.pendingChecks.filter((c) => !c.code.startsWith('AMOUNT_'));
      draft.at = Date.now();
      await advance(prisma, msg, draft);
      return;
    }

    // En la pregunta de categoría, un "no" suelto no anula: se repregunta.
    const inCategory = draft.awaiting === 'question' && draft.current?.key === 'category';
    if (draft.awaiting === 'question' && NEGATE.test(text) && !(inCategory && BARE_NO.test(text))) { drafts.delete(msg.chatId); await msg.reply('❌ Cancelado. No registré nada.'); return; }

    // Esperando el nombre de una categoría nueva a crear.
    if (draft.awaitingNewCategory) {
      const name = text.trim();
      if (!isValidCategoryName(name)) { await msg.reply('🤔 Ese nombre no me sirve: usa hasta 4 palabras y 40 caracteres, sin signos. Escribe el *nombre* de la categoría.'); return; }
      draft.awaitingNewCategory = false;
      try {
        const cat = await findOrCreateCategory(prisma, userId, name);
        draft.ctx.categories.push(cat);
        draft.payload.categoryId = cat.id; draft.resolved.add('category'); draft.categoryChosenByUser = true;
        await msg.reply(`🏷️ Categoría *${cat.name}* lista.`);
        draft.at = Date.now(); await advance(prisma, msg, draft);
      } catch (e: any) {
        logger.error({ e: e?.message }, 'wa: fallo creando categoría');
        const q = categoryQ(draft); draft.current = q; await msg.reply('❌ No pude crear la categoría.\n' + renderQuestion(q));
      }
      return;
    }

    if (draft.awaiting === 'question' && draft.current) {
      const q = draft.current;
      if (q.free === 'amount') {
        const n = parseAmount(text);
        if (!(n > 0)) { await msg.reply('🤔 Dime solo el número, ej. *20*.'); return; }
        draft.payload.amount = n;
      } else if (q.free === 'description') {
        const desc = text.trim().slice(0, 200);
        if (desc.length < 2) { await msg.reply('🤔 El detalle es muy corto, dime algo más.'); return; }
        draft.payload.description = desc;
      } else {
        let createdByText = false;
        // Al reabrir la categoría, un "sí" exacto deja la que estaba.
        if (q.key === 'category' && draft.payload.categoryId && STRICT_YES.test(text)) {
          draft.resolved.add('category'); draft.at = Date.now();
          await advance(prisma, msg, draft);
          return;
        }
        // Una frase con cifras en la pregunta de categoría no es una respuesta ("gasté 15 en salud").
        const isPhrase = q.key === 'category' && parseOptionIndex(text) === null && BARE_NUMBER.test(text);
        let opt = isPhrase ? null : resolveChoice(q, text);
        // En categorías, permite escribir el NOMBRE: si existe la usa; si es un nombre válido, la CREA al vuelo.
        if (!opt && !isPhrase && q.key === 'category' && !BARE_NO.test(text)) {
          const t = norm(text);
          const hit = t.length >= 3 ? draft.ctx.categories.find((c: any) => norm(c.name).includes(t) || t.includes(norm(c.name))) : null;
          if (hit) opt = { label: hit.name, patch: { categoryId: hit.id } };
          else if (!YES_PREFIX.test(text) && text.trim().length >= 3 && isValidCategoryName(text)) {
            try {
              const cat = await findOrCreateCategory(prisma, userId, text.trim());
              draft.ctx.categories.push(cat);
              await msg.reply(`🏷️ Categoría *${cat.name}* creada.`);
              opt = { label: cat.name, patch: { categoryId: cat.id } };
              createdByText = true;
            } catch (e: any) { logger.error({ e: e?.message }, 'wa: fallo creando categoría'); }
          }
        }
        if (!opt) { await msg.reply('🤔 No te entendí.\n' + renderQuestion(q)); return; }
        // "Crear nueva categoría": pide el nombre.
        if (opt.action === 'newCategory') { draft.awaitingNewCategory = true; draft.at = Date.now(); await msg.reply('➕ Escribe el *nombre* de la nueva categoría (ej: *Mascotas*, *Educación*).'); return; }
        // "Ver todas las categorías": no es una opción real, re-pregunta con la lista completa.
        if (opt.action === 'showAllCats') { draft.showAllCats = true; draft.at = Date.now(); const full = categoryQ(draft); draft.current = full; await msg.reply(renderQuestion(full)); return; }
        // Transferencia a otra persona = sale dinero → se registra como GASTO (no como transferencia interna).
        if (opt.action === 'transferToPerson') {
          draft.payload.type = 'EXPENSE';
          draft.payload.toAccountId = null;
          draft.payload.paymentMethod = 'BANK_TRANSFER';
          draft.payload.expenseKind = 'VARIABLE';
          draft.resolved.add('method');
          draft.at = Date.now();
          await msg.reply('👤 Entendido, es un *gasto por transferencia* a otra persona. Sigo con los datos…');
          await advance(prisma, msg, draft);
          return;
        }
        Object.assign(draft.payload, opt.patch);
        if (q.resolveKey) draft.resolved.add(q.resolveKey);
        // Lo escrito a mano puede ser una errata: no se aprende de una categoría creada así.
        if (q.key === 'category') draft.categoryChosenByUser = opt.patch.categoryId != null && !createdByText;
        if (q.key === 'movtype') applyTypeDefaults(draft);
      }
      draft.at = Date.now();
      await advance(prisma, msg, draft);
      return;
    }
    if (draft.awaiting === 'confirm') {
      if (STRICT_YES.test(text)) { await confirmAndCreate(prisma, msg, draft); return; }
      if (STRICT_NO.test(text)) { drafts.delete(msg.chatId); await msg.reply('❌ Cancelado. No registré nada.'); return; }
      if (CHANGE_CATEGORY.test(text) && hasCategory(draft.payload.type)) {
        draft.resolved.delete('category'); draft.showAllCats = false; draft.at = Date.now();
        await advance(prisma, msg, draft);
        return;
      }
      // Cualquier otra cosa no registra ni reemplaza el borrador, ni siquiera una instrucción nueva.
      draft.at = Date.now();
      await msg.reply(`⚠️ Aún no registré nada. ${pendingPrompt(draft)}`);
      return;
    }
  }

  // Instrucción nueva.
  if (fromAudio) await msg.reply(`📝 Entendí: "${text}"`);
  if (!text) { await msg.reply('📎 Recibí la foto, pero cuéntame primero el movimiento (audio o texto).\n\n' + HELP); return; }

  // Instrucción nueva: descarta cualquier borrador de entidad colgado.
  clearEntityDraft(msg.chatId);

  // Selección del MENÚ: un número suelto 1-6 (sin borrador activo) abre esa opción.
  const pick = text.trim().match(/^([1-6])$/);
  if (pick) {
    const n = pick[1];
    if (n === '1' || n === '6') { await msg.reply(MENU_PROMPT[n]); return; }
    const kind = { '2': 'debt', '3': 'recurring', '4': 'budget', '5': 'account' }[n] as 'debt' | 'recurring' | 'budget' | 'account';
    drafts.delete(msg.chatId);
    await startEntity(prisma, msg, kind, '');
    return;
  }

  // Enrutador por intención: decide QUÉ quiere el usuario y a qué sección va.
  const target = await classifyTarget(prisma, userId, text);

  if (target === 'query') { await msg.reply('🧠 Analizando tus finanzas…'); await msg.reply(await answerQuestion(prisma, userId, text)); return; }
  if (target === 'card') { await msg.reply('💳 Para crear una *tarjeta* entra a *Tarjetas* en la app: necesita banco, cupo y fechas de corte/pago. Ahí queda perfecta.'); return; }
  if (target === 'debt' || target === 'recurring' || target === 'budget' || target === 'account') {
    drafts.delete(msg.chatId);            // no mezclar con un borrador de movimiento
    await startEntity(prisma, msg, target, text);
    return;
  }

  // target === 'movement' (por defecto): movimiento o consulta (lo decide el parser).
  const parsed = await parseMovement(prisma, userId, text);
  if ('error' in parsed) { await msg.reply(`❌ ${parsed.error}`); return; }
  if (parsed.intent === 'query') { await msg.reply('🧠 Analizando tus finanzas…'); await msg.reply(await answerQuestion(prisma, userId, text)); return; }

  // Aunque falte el tipo o el monto, ARRANCAMOS el flujo: el bot pide lo que falte
  // (tipo → monto → detalle → método → cuenta/tarjeta → categoría) paso a paso.
  const built = await buildRegister(prisma, userId, parsed, text);
  if ('ask' in built) { await msg.reply(built.ask); return; }
  built.pendingImages = image ? [image] : [];
  clearEntityDraft(msg.chatId);           // por si quedó uno de entidad abandonado
  drafts.set(msg.chatId, built);
  await advance(prisma, msg, built);
}

async function handleVoucher(prisma: any, msg: IncomingMessage, image: Img, draft: Draft | null): Promise<void> {
  if (draft) { draft.pendingImages.push(image); await msg.reply('📎 Foto recibida. La adjuntaré al confirmar el movimiento.'); return; }
  const last = getLast(msg.chatId);
  if (last) {
    const r = await attachToMovement(prisma, msg.userId!, last.id, image);
    await msg.reply(r === 'ok' ? `📎 Comprobante adjuntado a *${last.label}*.` : r === 'toobig' ? '❌ La imagen supera los 8 MB.' : r === 'badtype' ? '❌ Formato no admitido. Envía una foto (JPG/PNG) o PDF.' : '❌ No pude adjuntar la imagen.');
    return;
  }
  await msg.reply('📎 Recibí una foto, pero no hay un movimiento reciente al cual adjuntarla.\nDime primero el movimiento (audio o texto) y luego envíame el comprobante.');
}

/** Recuerda la categoría que el usuario eligió y la IA no propuso. No se espera ni puede fallar. */
function learnCategory(prisma: any, draft: Draft): void {
  const categoryId = draft.payload.categoryId as number | null;
  if (!draft.categoryChosenByUser || !categoryId || categoryId === draft.proposedCategoryId) return;
  // El comercio solo se aprende si el usuario lo dijo: la IA podría haberlo supuesto.
  const textKey = normalizeMemoryKey(draft.originalText);
  const vendorKey = normalizeMemoryKey(draft.vendor);
  const vendor = textKey && vendorKey && ` ${textKey} `.includes(` ${vendorKey} `) ? draft.vendor : null;
  const input = { description: textOf(draft.payload.description), vendor, categoryId, type: draft.payload.type as string };
  void Promise.resolve()
    .then(() => recordCategoryCorrection(prisma, draft.userId, input))
    .catch((e: any) => logger.warn({ e: e?.message }, 'wa: no se pudo recordar la categoría'));
}

async function confirmAndCreate(prisma: any, msg: IncomingMessage, draft: Draft): Promise<void> {
  drafts.delete(msg.chatId);
  try {
    const row = await createMovement(prisma, draft.userId, draft.payload);
    learnCategory(prisma, draft);
    const label = MOVE_LABEL[String(draft.payload.type)] || 'Movimiento';
    let attached = 0;
    for (const img of draft.pendingImages) if ((await attachToMovement(prisma, draft.userId, row.id, img)) === 'ok') attached++;
    lastMovement.set(msg.chatId, { id: row.id, label, at: Date.now() });
    const bal = await balanceReadback(prisma, draft.userId, draft.payload);
    await msg.reply(`✅ Registrado: *${label}* ${fmt(row.amount)}.${bal}`);
    if (attached > 0) await msg.reply(`📎 ${attached} comprobante${attached === 1 ? '' : 's'} adjuntado${attached === 1 ? '' : 's'}.`);
    else await msg.reply('📎 ¿Tienes el comprobante? Envíame la *foto* y lo adjunto.');
    void createNotification(prisma, { userId: draft.userId, type: 'MOVEMENT_CREATED', title: 'Movimiento por WhatsApp', body: `${label}: "${row.description}" · ${fmt(row.amount)}`, link: '/movements' }).catch(() => {});
  } catch (e: any) {
    logger.error({ e: e?.message, name: e?.name }, 'wa: fallo creando movimiento');
    const friendly = (e?.status && e?.message) ? e.message : e?.name === 'ZodError' ? 'No pude validar los datos (revisa el monto y la cuenta/tarjeta).' : 'No se pudo registrar el movimiento.';
    await msg.reply(`❌ ${friendly}\nPuedes intentarlo de nuevo con otro mensaje.`);
  }
}
