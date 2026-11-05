// =====================================================
// Lector de correo por IMAP (imapflow). Se conecta a un buzón dedicado (ej. un
// Gmail al que reenvías tus facturas) para ingerir comprobantes.
// imapflow es ESM; el backend compila a CommonJS → import() dinámico real.
// =====================================================
import { logger } from './logger';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export interface ImapCreds { host: string; port: number; email: string; password: string; folder: string; }

/**
 * Normaliza host/puerto IMAP para evitar el error más común: poner el servidor
 * de ENVÍO (smtp.gmail.com / pop.gmail.com, puerto 587/465) cuando lo que se
 * necesita es el de LECTURA (imap.gmail.com, puerto 993 con SSL).
 */
export function normalizeImap(host?: string | null, port?: number | null, email?: string | null): { host: string; port: number } {
  let h = String(host || '').trim().toLowerCase();
  const mail = String(email || '').trim().toLowerCase();
  // smtp.* / pop.* → imap.*  (p. ej. smtp.gmail.com → imap.gmail.com)
  if (h === 'smtp.gmail.com' || h === 'pop.gmail.com') h = 'imap.gmail.com';
  else if (h.startsWith('smtp.')) h = 'imap.' + h.slice(5);
  else if (h.startsWith('pop.')) h = 'imap.' + h.slice(4);
  else if (h.startsWith('pop3.')) h = 'imap.' + h.slice(5);
  // Host en blanco pero el correo es Gmail → asumimos el IMAP de Gmail.
  if (!h && /@gmail\.com$/.test(mail)) h = 'imap.gmail.com';
  if (!h) h = 'imap.gmail.com';
  let p = Number(port) || 0;
  if (h === 'imap.gmail.com') p = 993;                 // Gmail: siempre 993 (SSL)
  else if (p === 587 || p === 465 || p === 25 || !p) p = 993; // puertos de SMTP → IMAP SSL
  return { host: h, port: p };
}

async function makeClient(creds: ImapCreds): Promise<any> {
  const { ImapFlow } = await esmImport('imapflow');
  const { host, port } = normalizeImap(creds.host, creds.port, creds.email);
  return new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user: creds.email, pass: creds.password },
    logger: false,
    emitLogs: false
  });
}

/** Prueba la conexión: devuelve el total de correos y los asuntos recientes. */
export async function testConnection(creds: ImapCreds): Promise<{ ok: true; total: number; recent: string[] } | { ok: false; error: string }> {
  let client: any = null;
  try {
    client = await makeClient(creds);
    await client.connect();
    // getMailboxLock SELECCIONA la carpeta; NO usar STATUS sobre la carpeta ya
    // seleccionada (Gmail lo rechaza con "Command failed"). El total viene del
    // propio buzón seleccionado (client.mailbox.exists).
    const lock = await client.getMailboxLock(creds.folder || 'INBOX');
    try {
      const total: number = client.mailbox?.exists || 0;
      const recent: string[] = [];
      if (total > 0) {
        const from = Math.max(1, total - 4);
        for await (const msg of client.fetch(`${from}:*`, { envelope: true })) {
          recent.unshift(msg.envelope?.subject || '(sin asunto)');
        }
      }
      return { ok: true, total, recent };
    } finally {
      lock.release();
    }
  } catch (e: any) {
    // imapflow esconde el detalle real en responseText/response: lo recuperamos.
    const detail = [e?.responseText, e?.response, e?.message].filter(Boolean).join(' | ');
    logger.warn({ detail, authFailed: e?.authenticationFailed, code: e?.serverResponseCode }, 'mail: fallo de conexión IMAP');
    const m = String(detail || e);
    if (e?.authenticationFailed || /\[AUTHENTICATIONFAILED\]|AUTHENTICATE|LOGIN/i.test(m)) {
      return { ok: false, error: 'Usuario o contraseña incorrectos. En Gmail usa una CONTRASEÑA DE APLICACIÓN (no la normal), con verificación en 2 pasos activa e IMAP habilitado.' };
    }
    if (/Invalid credentials/i.test(m)) {
      return { ok: false, error: 'Usuario o contraseña incorrectos. En Gmail usa una CONTRASEÑA DE APLICACIÓN (no la normal) y activa IMAP.' };
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EPROTO|wrong version number|Timeout|closed unexpectedly|ECONNRESET|socket/i.test(m)) {
      return { ok: false, error: 'No se pudo conectar al servidor IMAP. Para Gmail usa host imap.gmail.com y puerto 993 (no el SMTP/587).' };
    }
    return { ok: false, error: m.slice(0, 200) || 'No se pudo conectar.' };
  } finally {
    try { if (client) await client.logout(); } catch { /* ignore */ }
  }
}

export interface FetchedMail {
  uid: number;
  messageId: string;
  from: string | null;
  subject: string | null;
  date: Date | null;
  text: string;
  attachments: { filename: string | null; mime: string | null; content: Buffer }[];
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Lee los correos NUEVOS (uid > sinceUid). Con baselineOnly solo devuelve el uid
 * máximo actual (para fijar un punto de partida sin procesar el histórico).
 */
export async function fetchNewMessages(
  creds: ImapCreds,
  sinceUid: number,
  opts: { limit?: number; baselineOnly?: boolean } = {}
): Promise<{ ok: true; messages: FetchedMail[]; maxUid: number } | { ok: false; error: string }> {
  const limit = opts.limit ?? 30;
  let client: any = null;
  try {
    client = await makeClient(creds);
    await client.connect();
    const lock = await client.getMailboxLock(creds.folder || 'INBOX');
    try {
      const uidNext: number = client.mailbox?.uidNext || 1;
      if (opts.baselineOnly) return { ok: true, messages: [], maxUid: Math.max(0, uidNext - 1) };

      const { simpleParser } = await esmImport('mailparser');
      const messages: FetchedMail[] = [];
      let maxUid = sinceUid;
      const start = sinceUid > 0 ? sinceUid + 1 : 1;
      for await (const msg of client.fetch(`${start}:*`, { uid: true, envelope: true, source: true }, { uid: true })) {
        const uid: number = msg.uid;
        if (uid <= sinceUid) continue;
        if (uid > maxUid) maxUid = uid;
        let parsed: any = {};
        try { parsed = await simpleParser(msg.source); } catch { /* correo ilegible */ }
        const text = (parsed.text && parsed.text.trim()) || stripHtml(parsed.html || parsed.textAsHtml || '');
        const attachments = (parsed.attachments || [])
          .filter((a: any) => a?.content)
          .map((a: any) => ({ filename: a.filename || null, mime: a.contentType || null, content: a.content as Buffer }));
        messages.push({
          uid,
          messageId: parsed.messageId || `uid-${uid}`,
          from: parsed.from?.text || null,
          subject: parsed.subject || null,
          date: parsed.date || msg.envelope?.date || null,
          text: String(text || '').slice(0, 9000),
          attachments
        });
      }
      messages.sort((a, b) => a.uid - b.uid);
      return { ok: true, messages: messages.slice(0, limit), maxUid };
    } finally {
      lock.release();
    }
  } catch (e: any) {
    const detail = [e?.responseText, e?.response, e?.message].filter(Boolean).join(' | ');
    logger.warn({ detail }, 'mail: fallo al leer correos nuevos');
    return { ok: false, error: String(detail || e).slice(0, 200) };
  } finally {
    try { if (client) await client.logout(); } catch { /* ignore */ }
  }
}
