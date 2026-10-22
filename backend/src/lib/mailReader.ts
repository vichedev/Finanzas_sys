// =====================================================
// Lector de correo por IMAP (imapflow). Se conecta a un buzón dedicado (ej. un
// Gmail al que reenvías tus facturas) para ingerir comprobantes.
// imapflow es ESM; el backend compila a CommonJS → import() dinámico real.
// =====================================================
import { logger } from './logger';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export interface ImapCreds { host: string; port: number; email: string; password: string; folder: string; }

async function makeClient(creds: ImapCreds): Promise<any> {
  const { ImapFlow } = await esmImport('imapflow');
  return new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.port === 993,
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
    const lock = await client.getMailboxLock(creds.folder || 'INBOX');
    try {
      const status = await client.status(creds.folder || 'INBOX', { messages: true });
      const total: number = status.messages || 0;
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
    logger.warn({ e: e?.message }, 'mail: fallo de conexión IMAP');
    const m = String(e?.message || e);
    // Mensajes amables para los errores típicos de Gmail.
    if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(m)) {
      return { ok: false, error: 'Usuario o contraseña incorrectos. En Gmail usa una CONTRASEÑA DE APLICACIÓN (no la normal) y activa IMAP.' };
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(m)) {
      return { ok: false, error: 'No se pudo conectar al servidor IMAP. Revisa el host y el puerto.' };
    }
    return { ok: false, error: m.slice(0, 200) };
  } finally {
    try { if (client) await client.logout(); } catch { /* ignore */ }
  }
}
