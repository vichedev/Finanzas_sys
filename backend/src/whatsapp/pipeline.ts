// =====================================================
// Pipeline del bot de WhatsApp (Fase 2 + comprobantes).
//
// Audio/texto -> transcribe -> interpreta con IA -> resumen + confirmación SÍ/NO
// -> crea el movimiento (createMovement). Además admite adjuntar la FOTO del
// comprobante: junto con el audio/nota (se adjunta al confirmar) o después de
// registrar (se adjunta al último movimiento). Si no entiende, guía al usuario.
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

type Img = { buffer: Buffer; mimetype: string };
interface Draft { payload: Record<string, unknown>; summary: string; userId: number; at: number; pendingImages: Img[] }

// Borradores pendientes de confirmación y último movimiento creado, por chat.
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
const NEGATE = /^\s*(no|nel|nop|cancela(r)?|para|espera|olv[ií]dalo|❌)\b/i;
const HELPREQ = /^\s*(ayuda|help|men[uú]|c[oó]mo|como funciona|hola|buenas|\?)\s*$/i;

const HELP = `👋 Soy tu asistente de finanzas. Mándame un *audio* o *texto* diciendo qué registrar:

• 💸 *Gasto*: "gasté 20 en el súper con la cuenta de Pichincha"
• 💰 *Ingreso*: "ingreso de 800 de sueldo"
• 🛍️ *Compra*: "compré una laptop de 900 con la tarjeta de crédito"
• 🔁 *Transferencia*: "transferí 50 de Pichincha a Guayaquil"
• 🏧 *Retiro*: "retiré 100 en efectivo de Guayaquil"

Te muestro un resumen y me confirmas con *SÍ*.
📎 También puedes enviarme la *foto del comprobante* (con una nota o después de registrar) y la adjunto al movimiento.`;

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return d && m && y ? `${d}/${m}/${y}` : ymd;
}

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Efectivo', BANK_TRANSFER: 'Transferencia', DEPOSIT: 'Depósito',
  DEBIT_CARD: 'Tarjeta de débito', CREDIT_CARD: 'Tarjeta de crédito', WALLET: 'Billetera', OTHER: 'Otro'
};

// ---- Adjuntar comprobante (imagen) a un movimiento ----
const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_ATT = 8 * 1024 * 1024;
function extOf(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('pdf')) return 'pdf';
  return 'jpg';
}
async function attachToMovement(prisma: any, userId: number, movementId: number, img: Img): Promise<'ok' | 'toobig' | 'badtype' | 'err'> {
  const mime = (img.mimetype || 'image/jpeg').split(';')[0].trim();
  if (!ALLOWED_MIME.includes(mime)) return 'badtype';
  if (!img.buffer?.length) return 'err';
  if (img.buffer.length > MAX_ATT) return 'toobig';
  try {
    const opt = await optimizeImage(img.buffer, mime); // achica la foto antes de guardarla
    await prisma.attachment.create({
      data: {
        userId, entityType: 'MOVEMENT', entityId: movementId,
        filename: `comprobante-wa-${Date.now()}.${extOf(opt.mimeType)}`,
        mimeType: opt.mimeType, size: opt.buffer.length, data: opt.buffer
      }
    });
    return 'ok';
  } catch (e: any) { logger.error({ e: e?.message }, 'wa: fallo adjuntando comprobante'); return 'err'; }
}

/** Construye el payload de createMovement + resumen legible, o una aclaración. */
function buildDraft(p: ParsedMovement): { payload: Record<string, unknown>; summary: string } | { ask: string } {
  const type = p.type as MovType;
  const amount = Number(p.amount);
  if (!type || !(amount > 0)) return { ask: '🤔 Dime al menos el tipo y el monto.\n\n' + HELP };

  const date = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : todayYmd();
  const paymentMethod = p.paymentMethod || (p.cardId ? 'CREDIT_CARD' : p.accountId ? 'BANK_TRANSFER' : 'CASH');

  if (type === 'TRANSFER') {
    if (!p.accountId || !p.toAccountId) return { ask: '🤔 Para una transferencia dime la cuenta de *origen* y la de *destino*.' };
    if (p.accountId === p.toAccountId) return { ask: '🤔 El origen y el destino deben ser cuentas distintas.' };
  }
  if (type === 'WITHDRAWAL' && !p.accountId) return { ask: '🤔 ¿De qué *cuenta* retiras el efectivo?' };

  const description = (p.description || MOVE_LABEL[type] || 'Movimiento').slice(0, 200);
  const payload: Record<string, unknown> = {
    type, amount, movementDate: date, description, paymentMethod,
    accountId: p.accountId ?? null,
    toAccountId: type === 'TRANSFER' ? (p.toAccountId ?? null) : null,
    cardId: p.cardId ?? null,
    categoryId: (type === 'WITHDRAWAL' || type === 'TRANSFER') ? null : (p.categoryId ?? null),
    expenseKind: type === 'EXPENSE' ? 'VARIABLE' : null,
    isCredit: type === 'PURCHASE' ? !!p.isCredit : false,
    vendor: type === 'PURCHASE' ? (p.vendor || null) : null
  };

  const lines: string[] = [`📋 *${MOVE_LABEL[type]}* — ${fmt(amount)}`, `📝 ${description}`];
  if (type === 'TRANSFER') lines.push(`🔁 De *${p.accountName}* a *${p.toAccountName}*`);
  else {
    const via = p.cardId ? `💳 ${p.cardName}` : p.accountId ? `🏦 ${p.accountName}` : '💵 Efectivo';
    lines.push(`${METHOD_LABEL[paymentMethod] || paymentMethod} · ${via}`);
  }
  if (p.categoryName && type !== 'TRANSFER' && type !== 'WITHDRAWAL') lines.push(`🏷️ ${p.categoryName}`);
  if (type === 'PURCHASE' && p.isCredit) lines.push('🕒 Compra fiada (se paga después)');
  lines.push(`📅 ${fmtDate(date)}`);

  return { payload, summary: lines.join('\n') };
}

async function balanceReadback(prisma: any, userId: number, payload: Record<string, unknown>): Promise<string> {
  try {
    if (payload.accountId) {
      const a = await prisma.account.findFirst({ where: { id: payload.accountId, userId }, select: { name: true, currentBalance: true } });
      if (a) return `\n💰 Saldo de ${a.name}: ${fmt(a.currentBalance)}`;
    }
    if (payload.cardId && payload.type !== 'TRANSFER') {
      const c = await prisma.card.findFirst({ where: { id: payload.cardId, userId }, select: { name: true, currentBalance: true } });
      if (c) return `\n💳 Usado en ${c.name}: ${fmt(c.currentBalance)}`;
    }
  } catch { /* opcional */ }
  return '';
}

export async function handleIncoming(msg: IncomingMessage): Promise<void> {
  if (msg.userId == null) {
    await msg.reply('⚠️ La vinculación quedó incompleta. Entra a *Ajustes → Asistente WhatsApp* y vuelve a vincular.');
    return;
  }
  const prisma = await getTenantPrisma(msg.tenantId);
  const userId = msg.userId;
  const image = msg.image;

  // 1) Texto (transcribir si es audio).
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

  // 2) Foto sola (sin texto ni audio) → comprobante.
  if (image && !text && !fromAudio) { await handleVoucher(prisma, msg, image); return; }

  // 3) Petición de ayuda.
  if (text && HELPREQ.test(text) && !getDraft(msg.chatId)) { await msg.reply(HELP); return; }

  // 4) Borrador pendiente + respuesta de texto → SÍ/NO.
  const pending = getDraft(msg.chatId);
  if (pending && !fromAudio && !image) {
    if (AFFIRM.test(text)) { await confirmAndCreate(prisma, msg, pending); return; }
    if (NEGATE.test(text)) { drafts.delete(msg.chatId); await msg.reply('❌ Cancelado. No registré nada.'); return; }
    // Si no es sí/no, se interpreta como instrucción nueva (reemplaza el borrador).
  }

  // 5) Interpretar como instrucción nueva.
  if (fromAudio) await msg.reply(`📝 Entendí: "${text}"`);
  if (!text) { await msg.reply('📎 Recibí la foto, pero cuéntame primero el movimiento (audio o texto).\n\n' + HELP); return; }

  const parsed = await parseMovement(prisma, userId, text);
  if ('error' in parsed) { await msg.reply(`❌ ${parsed.error}`); return; }

  // Consulta/pregunta → responde con contexto financiero y una lista de acciones.
  if (parsed.intent === 'query') {
    await msg.reply('🧠 Analizando tus finanzas…');
    await msg.reply(await answerQuestion(prisma, userId, text));
    return;
  }

  if (!parsed.understood) {
    await msg.reply(`🤔 ${parsed.clarification || 'No entendí bien lo que quieres registrar.'}\n\n${HELP}`);
    return;
  }

  const built = buildDraft(parsed);
  if ('ask' in built) { await msg.reply(built.ask); return; }

  drafts.set(msg.chatId, { ...built, userId, at: Date.now(), pendingImages: image ? [image] : [] });
  const extra = image ? '\n📎 Adjuntaré la foto del comprobante al confirmar.' : '';
  await msg.reply(`${built.summary}${extra}\n\n¿Lo registro? Responde *SÍ* o *NO*.`);
}

/** Foto de comprobante sin comando: al borrador pendiente o al último movimiento. */
async function handleVoucher(prisma: any, msg: IncomingMessage, image: Img): Promise<void> {
  const pending = getDraft(msg.chatId);
  if (pending) {
    pending.pendingImages.push(image);
    await msg.reply('📎 Foto recibida. La adjuntaré al confirmar. Responde *SÍ* para registrar.');
    return;
  }
  const last = getLast(msg.chatId);
  if (last) {
    const r = await attachToMovement(prisma, msg.userId!, last.id, image);
    await msg.reply(
      r === 'ok' ? `📎 Comprobante adjuntado a *${last.label}*.`
        : r === 'toobig' ? '❌ La imagen supera los 8 MB.'
        : r === 'badtype' ? '❌ Formato no admitido. Envía una foto (JPG/PNG) o PDF.'
        : '❌ No pude adjuntar la imagen.'
    );
    return;
  }
  await msg.reply('📎 Recibí una foto, pero no hay un movimiento reciente al cual adjuntarla.\nDime primero el movimiento (audio o texto) y luego envíame el comprobante — o mándalos juntos: la foto con una nota describiendo el gasto.');
}

async function confirmAndCreate(prisma: any, msg: IncomingMessage, draft: Draft): Promise<void> {
  drafts.delete(msg.chatId);
  try {
    const row = await createMovement(prisma, draft.userId, draft.payload);
    const label = MOVE_LABEL[String(draft.payload.type)] || 'Movimiento';

    let attached = 0;
    for (const img of draft.pendingImages) {
      if ((await attachToMovement(prisma, draft.userId, row.id, img)) === 'ok') attached++;
    }
    lastMovement.set(msg.chatId, { id: row.id, label, at: Date.now() });

    const bal = await balanceReadback(prisma, draft.userId, draft.payload);
    await msg.reply(`✅ Registrado: *${label}* ${fmt(row.amount)}.${bal}`);
    if (attached > 0) await msg.reply(`📎 ${attached} comprobante${attached === 1 ? '' : 's'} adjuntado${attached === 1 ? '' : 's'}.`);
    else await msg.reply('📎 ¿Tienes el comprobante? Envíame la *foto* y lo adjunto a este movimiento.');

    void createNotification(prisma, {
      userId: draft.userId, type: 'MOVEMENT_CREATED',
      title: 'Movimiento por WhatsApp',
      body: `${label}: "${row.description}" · ${fmt(row.amount)}`,
      link: '/movements'
    }).catch(() => {});
  } catch (e: any) {
    logger.error({ e: e?.message, name: e?.name }, 'wa: fallo creando movimiento');
    const friendly = (e?.status && e?.message) ? e.message
      : e?.name === 'ZodError' ? 'No pude validar los datos (revisa el monto y la cuenta/tarjeta).'
      : 'No se pudo registrar el movimiento.';
    await msg.reply(`❌ ${friendly}\nPuedes intentarlo de nuevo con otro mensaje.`);
  }
}
