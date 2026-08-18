// =====================================================
// Gateway de WhatsApp (Baileys) — socket ÚNICO en el proceso backend.
//
// - Baileys es ESM y el backend compila a CommonJS → se importa con un import()
//   dinámico "real" (envuelto en new Function para que tsc no lo baje a require).
// - Modo "nota para mí": el bot se vincula al PROPIO número; solo procesa mensajes
//   del chat consigo mismo (remoteJid === propio jid).
// - La sesión se persiste con useMultiFileAuthState en WA_SESSION_DIR (un volumen
//   en Docker); así el QR se escanea una sola vez.
// - Guard anti-loop: en el self-chat nuestras propias respuestas también llegan
//   como mensajes; se ignoran por id (sentIds).
// =====================================================
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import { logger } from '../lib/logger';
import { getTenantPrisma } from '../lib/tenantPrisma';

// import() nativo que sobrevive a la compilación a CommonJS (Baileys es ESM puro).
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export type WaState = 'idle' | 'connecting' | 'qr' | 'connected' | 'logged_out';

export interface IncomingMessage {
  tenantId: string;
  userId: number | null;
  chatId: string; // jid al que responder (self-chat)
  text: string | null;
  audio: { buffer: Buffer; mimetype: string } | null;
  image: { buffer: Buffer; mimetype: string } | null; // comprobante
  reply: (text: string) => Promise<void>;
}
export type IncomingHandler = (msg: IncomingMessage) => Promise<void>;

const SESSION_BASE = process.env.WA_SESSION_DIR || path.resolve(process.cwd(), '.wa-session');

// ---- Estado del singleton ----
let sock: any = null;
let state: WaState = 'idle';
let currentQr: string | null = null; // data URL PNG del QR vigente
let ownJid: string | null = null; // jid propio (número real, @s.whatsapp.net)
let ownLid: string | null = null; // jid propio en formato LID (@lid) — WhatsApp lo usa por privacidad
let linkedNumber: string | null = null;
let boundTenantId: string | null = null;
let boundUserId: number | null = null;
let startedAtSec = 0;
let reconnecting = false;
let manualClose = false;
let incomingHandler: IncomingHandler | null = null;
const sentIds = new Set<string>(); // ids de mensajes que enviamos nosotros (anti-loop)

// Números autorizados a escribir al bot (solo dígitos). El 1º es el "principal":
// recibe los avisos proactivos. Si la lista está vacía, solo se atiende el self-chat.
let allowedNumbers: string[] = [];
let allowSelfChat = true;

export function setIncomingHandler(h: IncomingHandler) { incomingHandler = h; }

/** Configura la lista blanca de números autorizados (en vivo, sin reconectar). */
export function setAllowedNumbers(nums: string[], allowSelf: boolean) {
  allowedNumbers = (nums || []).map(digits).filter((n) => n.length >= 8);
  allowSelfChat = allowSelf;
}

export function getStatus() {
  return { state, qr: currentQr, linkedNumber, tenantId: boundTenantId, userId: boundUserId, allowedNumbers, allowSelfChat };
}

/** Solo los dígitos de un string/número. */
function digits(s: unknown): string { return String(s ?? '').replace(/\D/g, ''); }
/** Compara dos números por sus últimos 9 dígitos (tolera +593 vs 0 en Ecuador). */
function sameNumber(a: string, b: string): boolean {
  const x = digits(a), y = digits(b);
  if (x.length < 8 || y.length < 8) return false;
  const n = Math.min(9, x.length, y.length);
  return x.slice(-n) === y.slice(-n);
}
/** jid de destino a partir de un número (dígitos con código de país). */
function numberToJid(num: string): string { return `${digits(num)}@s.whatsapp.net`; }

/** Quita el sufijo de dispositivo (":12") para comparar jids. */
function normJid(jid: string | null | undefined): string {
  return (jid || '').replace(/:\d+@/, '@');
}

function sessionDir(tenantId: string): string {
  return path.join(SESSION_BASE, tenantId.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

/** Vincula/reconecta el socket a un tenant + usuario. Reemplaza cualquier socket previo. */
export async function connect(tenantId: string, userId: number | null): Promise<void> {
  boundTenantId = tenantId;
  boundUserId = userId;
  manualClose = false;
  // Carga la lista blanca de números autorizados desde la config del tenant.
  try {
    const prisma = await getTenantPrisma(tenantId);
    const cfg = await prisma.whatsappConfig.findUnique({ where: { id: 1 } });
    setAllowedNumbers((cfg?.allowedNumbers || '').split(',').map((s: string) => s.trim()).filter(Boolean), cfg?.allowSelfChat ?? true);
  } catch { /* la fila puede no existir aún */ }
  await startSocket();
}

/** Cierra el socket. Con logout=true además borra la sesión (fuerza re-escaneo de QR). */
export async function disconnect(logout = false): Promise<void> {
  manualClose = true;
  const tid = boundTenantId;
  try {
    if (sock && logout) await sock.logout().catch(() => {});
    else if (sock) sock.end?.(undefined);
  } catch { /* ignore */ }
  sock = null;
  currentQr = null;
  ownJid = null;
  ownLid = null;
  state = logout ? 'logged_out' : 'idle';
  if (logout && tid) {
    try { fs.rmSync(sessionDir(tid), { recursive: true, force: true }); } catch { /* ignore */ }
    linkedNumber = null;
  }
}

/**
 * Envía un mensaje al "dueño": el primer número autorizado (a quien van los avisos
 * proactivos). Si no hay números configurados, cae al propio chat (nota para mí).
 */
export async function sendToOwner(text: string): Promise<boolean> {
  if (state !== 'connected') return false;
  const target = allowedNumbers.length ? numberToJid(allowedNumbers[0]) : ownJid;
  if (!target) return false;
  try { await sendText(target, text); return true; }
  catch { return false; }
}

/** Envía un texto y registra el id para no reprocesar nuestra propia respuesta. */
export async function sendText(jid: string, text: string): Promise<void> {
  if (!sock) return;
  const sent = await sock.sendMessage(jid, { text });
  const id = sent?.key?.id;
  if (id) {
    sentIds.add(id);
    if (sentIds.size > 200) { for (const k of sentIds) { sentIds.delete(k); if (sentIds.size <= 100) break; } }
  }
}

async function startSocket(): Promise<void> {
  if (!boundTenantId) return;
  const baileys = await esmImport('@whiskeysockets/baileys');
  const makeWASocket = baileys.makeWASocket ?? baileys.default;
  const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers, downloadMediaMessage } = baileys;

  const dir = sessionDir(boundTenantId);
  fs.mkdirSync(dir, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const waLogger = logger.child({ mod: 'whatsapp' }, { level: 'silent' });

  state = 'connecting';
  currentQr = null;
  startedAtSec = Math.floor(Date.now() / 1000);

  sock = makeWASocket({
    version,
    auth: authState,
    logger: waLogger,
    browser: Browsers.appropriate('MAAT Finanzas'),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u: any) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      try { currentQr = await QRCode.toDataURL(qr); state = 'qr'; }
      catch (e) { logger.error({ e }, 'wa: fallo generando QR'); }
    }
    if (connection === 'open') {
      state = 'connected';
      currentQr = null;
      ownJid = normJid(sock?.user?.id);
      ownLid = normJid(sock?.user?.lid) || null;
      linkedNumber = ownJid ? ownJid.split('@')[0] : null;
      logger.info({ tenant: boundTenantId, number: linkedNumber, ownJid, ownLid }, 'wa: conectado');
      // Persistir el número vinculado para mostrarlo aunque el proceso reinicie (best-effort).
      if (boundTenantId && linkedNumber) {
        getTenantPrisma(boundTenantId)
          .then((p) => p.whatsappConfig.update({ where: { id: 1 }, data: { linkedNumber } }))
          .catch(() => { /* la fila puede no existir todavía */ });
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason?.loggedOut;
      if (loggedOut) {
        logger.warn({ tenant: boundTenantId }, 'wa: sesión cerrada (loggedOut), se requiere re-vincular');
        state = 'logged_out';
        currentQr = null;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
        return;
      }
      if (manualClose) return;
      if (!reconnecting) {
        reconnecting = true;
        state = 'connecting';
        setTimeout(() => { reconnecting = false; startSocket().catch((e) => logger.error({ e }, 'wa: reconexión falló')); }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async (up: any) => {
    // Log de llegada (diagnóstico): confirma que CUALQUIER mensaje llega a Baileys,
    // con su remitente y tipo, antes de cualquier filtro de autorización.
    const jids = (up.messages || []).map((mm: any) => mm?.key?.remoteJid).filter(Boolean);
    logger.info({ type: up.type, count: (up.messages || []).length, jids }, 'wa: upsert recibido');
    // En "nota para mí" los mensajes propios pueden llegar como 'notify' o 'append';
    // no filtramos por tipo, nos apoyamos en el guard de antigüedad + sentIds.
    for (const m of up.messages || []) {
      try { await handleMessage(m, downloadMediaMessage, waLogger, up.type); }
      catch (e) { logger.error({ e }, 'wa: error procesando mensaje'); }
    }
  });
}

/** Desanida el contenido real de un mensaje (ephemeral / viewOnce / etc.). */
function unwrap(message: any): any {
  return message?.ephemeralMessage?.message
    ?? message?.viewOnceMessage?.message
    ?? message?.viewOnceMessageV2?.message
    ?? message?.documentWithCaptionMessage?.message
    ?? message;
}

/** Solo la parte numérica del jid (sin sufijo de dispositivo ni servidor). */
function jidNumber(jid: string | null | undefined): string {
  return (jid || '').split('@')[0].split(':')[0];
}

async function handleMessage(m: any, downloadMediaMessage: any, waLogger: any, upsertType?: string): Promise<void> {
  if (!m?.message || !m.key) return;
  const jid: string = m.key.remoteJid || '';
  const content = unwrap(m.message);
  const audioMsg = content?.audioMessage;
  const imageMsg = content?.imageMessage;
  // El texto puede venir suelto o como pie de foto (caption de una imagen).
  const text: string | null = content?.conversation || content?.extendedTextMessage?.text || content?.imageMessage?.caption || null;
  const ts = Number(m.messageTimestamp || 0);

  // No atendemos grupos ni canales (solo chats 1:1).
  if (jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;

  // Chat consigo mismo (nota para mí): coincide con el propio número real (PN)
  // o con el propio LID (@lid), que WhatsApp usa por privacidad.
  const chatNum = jidNumber(jid);
  const isSelfChat = (!!ownJid && chatNum === jidNumber(ownJid)) || (!!ownLid && chatNum === jidNumber(ownLid));

  // Autorizados: números en la lista blanca (comparados por sus últimos dígitos).
  // Se prueban varias formas del remitente por si WhatsApp usa @lid en vez del número.
  const rawCandidates: string[] = [jid, m.key.senderPn, m.key.participant, m.key.participantPn, m.key.remoteJidAlt, m.key.participantAlt, m.participant].filter(Boolean);
  // Si el chat viene como @lid, intenta mapearlo al número real (PN) vía Baileys.
  if (jid.endsWith('@lid')) {
    try {
      const pn = sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      const resolved = pn && typeof pn.then === 'function' ? await pn : pn;
      if (resolved) rawCandidates.push(resolved);
    } catch { /* mapping no disponible */ }
  }
  const senderCandidates = rawCandidates.map((c: string) => jidNumber(c));
  const isAllowed = allowedNumbers.some((n) => senderCandidates.some((c) => sameNumber(n, c)));

  const accepted = (allowSelfChat && isSelfChat) || isAllowed;
  if (!accepted) {
    // Info (no debug) para poder diagnosticar por qué no responde a un número externo.
    logger.info({ jid, fromMe: m.key.fromMe, senderCandidates, allowedNumbers }, 'wa: mensaje ignorado (remitente no autorizado)');
    return;
  }

  logger.info({
    type: upsertType, jid, fromMe: m.key.fromMe, isSelfChat, isAllowed,
    hasAudio: !!audioMsg, hasImage: !!imageMsg, hasText: !!text
  }, 'wa: mensaje recibido (autorizado)');
  // En un chat externo autorizado, fromMe=true significa que lo enviamos NOSOTROS
  // (una respuesta del bot): se ignora. En el self-chat, fromMe es normal.
  if (isAllowed && !isSelfChat && m.key.fromMe) return;
  if (m.key.id && sentIds.has(m.key.id)) return;           // no reprocesar nuestras respuestas
  if (ts && ts < startedAtSec - 5) { logger.info('wa: ignorado por antigüedad'); return; }
  if (!incomingHandler) { logger.warn('wa: sin handler registrado'); return; }
  if (!audioMsg && !imageMsg && !text) return;

  let audio: { buffer: Buffer; mimetype: string } | null = null;
  if (audioMsg) {
    const buffer: Buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: waLogger, reuploadRequest: sock.updateMediaMessage });
    audio = { buffer, mimetype: audioMsg.mimetype || 'audio/ogg' };
  }
  let image: { buffer: Buffer; mimetype: string } | null = null;
  if (imageMsg) {
    const buffer: Buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: waLogger, reuploadRequest: sock.updateMediaMessage });
    image = { buffer, mimetype: imageMsg.mimetype || 'image/jpeg' };
  }

  // Self-chat → respondemos por el número real propio; autorizado externo → a su chat.
  const replyTo = isSelfChat ? (ownJid || jid) : jid;
  await incomingHandler({
    tenantId: boundTenantId!,
    userId: boundUserId,
    chatId: replyTo,
    text,
    audio,
    image,
    reply: (t: string) => sendText(replyTo, t)
  });
}
