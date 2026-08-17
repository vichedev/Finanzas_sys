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
import { getGroqCreds } from './groq';
import { transcribeAudio } from './transcribe';
import { parseMovement, type ParsedMovement, type MovType } from './parser';
import { answerQuestion } from './assistant';
import { createMovement, MOVE_LABEL } from '../routes/tenant/movements.routes';
import { createNotification } from '../lib/notifications';
import { optimizeImage } from '../lib/imageOptimize';
import type { IncomingMessage } from './gateway';

const fmt = (v: unknown) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

type Img = { buffer: Buffer; mimetype: string };
type Patch = Record<string, unknown>;
interface Option { label: string; patch: Patch }
interface Question { key: string; text: string; options?: Option[]; free?: 'amount' | 'description'; resolveKey?: string }
interface Ctx { accounts: any[]; creditCards: any[]; wallets: any[]; categories: any[] }
interface Draft {
  payload: Record<string, unknown>;
  resolved: Set<string>;           // slots con valor "nulo válido" ya resueltos (method, category)
  bankHint: string;
  ctx: Ctx;
  current: Question | null;
  awaiting: 'question' | 'confirm';
  userId: number;
  at: number;
  pendingImages: Img[];
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

const AFFIRM = /^\s*(s[ií]|si|dale|ok(ay)?|conf[ií]rmo|correcto|listo|va|h[aá]zlo|reg[ií]stralo?|de una|👍|✅)\b/i;
const NEGATE = /^\s*(no|nel|nop|cancela(r)?|olv[ií]dalo|❌)\b/i;
const HELPREQ = /^\s*(ayuda|help|men[uú]|c[oó]mo funciona|hola|buenas|\?)\s*$/i;

const HELP = `👋 Soy tu asistente de finanzas. Mándame un *audio* o *texto* con lo que quieras registrar:

• 💸 *Gasto*: "gasté 20 en el súper"
• 💰 *Ingreso*: "ingreso de 800 de sueldo"
• 🛍️ *Compra*: "compré una laptop de 900"
• 🔁 *Transferencia*: "transferí 50 de Pichincha a Guayaquil"
• 🏧 *Retiro*: "retiré 100 en efectivo"

Voy tomando los datos que me des (monto, detalle, fecha, categoría, quién paga, método). *Lo que falte te lo pregunto con una lista* y eliges el número. Al final confirmas con *SÍ*.
📎 También puedes enviarme la *foto del comprobante*.`;

const METHOD_LABEL: Record<string, string> = { CASH: 'Efectivo', BANK_TRANSFER: 'Transferencia', DEPOSIT: 'Depósito', DEBIT_CARD: 'Tarjeta de débito', CREDIT_CARD: 'Tarjeta de crédito', WALLET: 'Billetera', OTHER: 'Otro' };

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
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
function parseAmount(text: string): number {
  const m = text.replace(/,/g, '.').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
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
function accountQ(key: string, text: string, accounts: any[], bankHint: string, field: 'accountId' | 'toAccountId'): Question {
  let list = accounts;
  const hint = norm(bankHint);
  if (hint) {
    const byBank = accounts.filter((a: any) => norm(a.bankName).includes(hint) || norm(a.name).includes(hint) || hint.includes(norm(a.bankName)));
    if (byBank.length) list = byBank;
  }
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
function cardQ(cards: any[]): Question { return { key: 'card', text: '💳 ¿Cuál *tarjeta de crédito*?', options: cards.map((c: any) => ({ label: `💳 ${cardLabel(c)}`, patch: { cardId: c.id } })) }; }
function walletQ(wallets: any[]): Question { return { key: 'wallet', text: '👛 ¿Cuál *billetera*?', options: wallets.map((w: any) => ({ label: `👛 ${w.name}`, patch: { walletId: w.id } })) }; }
function categoryQ(cats: any[]): Question { return { key: 'category', text: '🏷️ ¿Qué *categoría*?', options: [...cats.map((c: any) => ({ label: c.name, patch: { categoryId: c.id } })), { label: 'Sin categoría', patch: { categoryId: null } }], resolveKey: 'category' }; }

/** Devuelve la siguiente pregunta pendiente, auto-resolviendo las que tienen una sola opción. */
function computeNext(d: Draft): Question | null {
  for (let i = 0; i < 25; i++) {
    const q = rawNext(d);
    if (!q) return null;
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
  const p = d.payload;
  const type = p.type as MovType;
  if (!(Number(p.amount) > 0)) return { key: 'amount', text: '💵 ¿Cuál es el *monto*? (solo el número, ej. 20)', free: 'amount' };
  if (!p.description || String(p.description).trim().length < 2) return { key: 'description', text: '📝 ¿Qué *detalle* le pongo? (ej. Supermercado, Sueldo)', free: 'description' };

  if (type === 'TRANSFER') {
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
  if (m === 'CREDIT_CARD' && !p.cardId) return cardQ(d.ctx.creditCards);
  if (m === 'WALLET' && !p.walletId) return walletQ(d.ctx.wallets);
  if (!d.resolved.has('category') && (type === 'EXPENSE' || type === 'INCOME' || type === 'PURCHASE')) return categoryQ(d.ctx.categories);
  return null;
}

function renderQuestion(q: Question): string {
  if (q.free) return q.text;
  const lines = (q.options || []).map((o, i) => `${i + 1}. ${o.label}`);
  return `${q.text}\n${lines.join('\n')}\n\n_Responde con el número._`;
}
function resolveChoice(q: Question, text: string): Option | null {
  const numMatch = text.match(/\d+/);
  if (numMatch) { const n = parseInt(numMatch[0], 10); if (q.options && n >= 1 && n <= q.options.length) return q.options[n - 1]; }
  const t = norm(text);
  if (t.length >= 3 && q.options) { const hits = q.options.filter((o) => norm(o.label).includes(t) || t.includes(norm(o.label))); if (hits.length === 1) return hits[0]; }
  return null;
}

/** Arma el payload inicial + contexto desde lo que la IA entendió. */
async function buildRegister(prisma: any, userId: number, p: ParsedMovement): Promise<Draft | { ask: string }> {
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

  const date = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : todayYmd();
  const payload: Record<string, unknown> = {
    type, amount: Number(p.amount) > 0 ? Number(p.amount) : null,
    movementDate: date, description: (p.description || '').trim() || null,
    paymentMethod: null, accountId: null, toAccountId: null, cardId: null, walletId: null, categoryId: null,
    expenseKind: type === 'EXPENSE' ? 'VARIABLE' : null,
    isCredit: type === 'PURCHASE' ? !!p.isCredit : false,
    vendor: type === 'PURCHASE' ? (p.vendor || null) : null,
    familyMember: p.familyMember?.trim() || null,
    notes: p.notes?.trim() || null
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
    if (p.paymentMethod) { payload.paymentMethod = p.paymentMethod; resolved.add('method'); }
    if (credit) { payload.cardId = credit.id; payload.paymentMethod = 'CREDIT_CARD'; resolved.add('method'); }
    else if (acc) { payload.accountId = acc.id; if (!payload.paymentMethod) { payload.paymentMethod = 'BANK_TRANSFER'; resolved.add('method'); } }
    if (cat) { payload.categoryId = cat.id; resolved.add('category'); }
  }

  return { payload, resolved, bankHint: p.bankHint || '', ctx: { accounts, creditCards, wallets, categories }, current: null, awaiting: 'question', userId, at: Date.now(), pendingImages: [] };
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
  if (type === 'EXPENSE' || type === 'INCOME' || type === 'PURCHASE') lines.push(`🏷️ ${cat ? cat.name : 'Sin categoría'}`);
  if (p.familyMember) lines.push(`👤 ${p.familyMember}`);
  if (type === 'PURCHASE' && p.isCredit) lines.push('🕒 Compra fiada (se paga después)');
  lines.push(`📅 ${fmtDate(String(p.movementDate))}`);

  d.awaiting = 'confirm'; d.current = null; d.at = Date.now();
  const extra = d.pendingImages.length ? '\n📎 Adjuntaré la foto del comprobante al confirmar.' : '';
  await msg.reply(`${lines.join('\n')}${extra}\n\n¿Lo registro? Responde *SÍ* o *NO*.`);
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
    const creds = await getGroqCreds(prisma);
    if (!creds) { await msg.reply('⚠️ Falta la clave de IA. Ve a *Ajustes → FinancIA* y guárdala.'); return; }
    await msg.reply('🎧 Escuchando tu audio…');
    try { text = (await transcribeAudio(creds.apiKey, msg.audio!.buffer, msg.audio!.mimetype)).trim(); }
    catch (e: any) { await msg.reply(`❌ ${e?.message || 'No se pudo transcribir el audio.'}`); return; }
    if (!text) { await msg.reply('No entendí el audio 😕. Intenta de nuevo, más claro.\n\n' + HELP); return; }
  }

  const draft = getDraft(msg.chatId);

  if (image && !text && !fromAudio) { await handleVoucher(prisma, msg, image, draft); return; }
  if (text && HELPREQ.test(text) && !draft) { await msg.reply(HELP); return; }

  // Borrador en curso + respuesta de texto.
  if (draft && !fromAudio) {
    if (image) draft.pendingImages.push(image);
    if (NEGATE.test(text)) { drafts.delete(msg.chatId); await msg.reply('❌ Cancelado. No registré nada.'); return; }

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
        const opt = resolveChoice(q, text);
        if (!opt) { await msg.reply('🤔 No te entendí.\n' + renderQuestion(q)); return; }
        Object.assign(draft.payload, opt.patch);
        if (q.resolveKey) draft.resolved.add(q.resolveKey);
      }
      draft.at = Date.now();
      await advance(prisma, msg, draft);
      return;
    }
    if (draft.awaiting === 'confirm') {
      if (AFFIRM.test(text)) { await confirmAndCreate(prisma, msg, draft); return; }
      // No es sí/no → instrucción nueva (reemplaza el borrador).
    }
  }

  // Instrucción nueva.
  if (fromAudio) await msg.reply(`📝 Entendí: "${text}"`);
  if (!text) { await msg.reply('📎 Recibí la foto, pero cuéntame primero el movimiento (audio o texto).\n\n' + HELP); return; }

  const parsed = await parseMovement(prisma, userId, text);
  if ('error' in parsed) { await msg.reply(`❌ ${parsed.error}`); return; }
  if (parsed.intent === 'query') { await msg.reply('🧠 Analizando tus finanzas…'); await msg.reply(await answerQuestion(prisma, userId, text)); return; }
  if (!parsed.type) { await msg.reply(`🤔 ${parsed.clarification || 'No entendí qué quieres registrar.'}\n\n${HELP}`); return; }

  const built = await buildRegister(prisma, userId, parsed);
  if ('ask' in built) { await msg.reply(built.ask); return; }
  built.pendingImages = image ? [image] : [];
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

async function confirmAndCreate(prisma: any, msg: IncomingMessage, draft: Draft): Promise<void> {
  drafts.delete(msg.chatId);
  try {
    const row = await createMovement(prisma, draft.userId, draft.payload);
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
