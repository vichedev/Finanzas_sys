// =====================================================
// Ingesta inteligente de comprobantes por correo.
// Lee los correos nuevos del buzón dedicado, interpreta cada uno (factura SRI en
// XML de forma exacta, o notificación/recibo en texto con IA), y —si identifica
// el movimiento— lo registra automáticamente. Deja SIEMPRE un rastro en
// MailReceipt (historial) con el estado: APPROVED (agregado), PENDING (requiere
// revisión), DISCARDED (no es comprobante) o FAILED (error).
// =====================================================
import { logger } from './logger';
import { globalPrisma } from './globalPrisma';
import { getTenantPrisma } from './tenantPrisma';
import { decryptString } from './tenantCrypto';
import { fetchNewMessages, type FetchedMail, type ImapCreds } from './mailReader';
import { getBrainCreds, chatComplete } from '../whatsapp/llm';
import { createMovement } from '../routes/tenant/movements.routes';

const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export interface IngestSummary { checked: number; added: number; pending: number; discarded: number; failed: number; error?: string; }

interface Extracted {
  esComprobante: boolean;
  tipo: 'EXPENSE' | 'INCOME';
  monto: number | null;
  fecha: string | null;      // YYYY-MM-DD
  comercio: string | null;
  ultimos4: string | null;
  medio: 'CREDIT_CARD' | 'DEBIT_CARD' | 'ACCOUNT' | 'UNKNOWN';
  ruc: string | null;
  categoria: string | null;
}

const last4 = (s: unknown) => { const d = String(s ?? '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : null; };
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

// ---- Factura electrónica SRI (XML) → datos exactos ----
function parseSriXml(xml: string): Partial<Extracted> | null {
  try {
    const { XMLParser } = require('fast-xml-parser');
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });
    let doc = parser.parse(xml);
    // El SRI envuelve la factura dentro de <autorizacion><comprobante> (CDATA).
    const inner = doc?.autorizacion?.comprobante || doc?.AutorizacionComprobante?.comprobante;
    if (typeof inner === 'string' && inner.includes('<')) doc = parser.parse(inner);
    const f = doc?.factura;
    if (!f) return null;
    const info = f.infoFactura || {};
    const trib = f.infoTributaria || {};
    const total = num(info.importeTotal);
    if (!total) return null;
    const fecha = (() => {
      const d = String(info.fechaEmision || '').trim(); // dd/mm/yyyy
      const m = d.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    })();
    return {
      esComprobante: true, tipo: 'EXPENSE', monto: total, fecha,
      comercio: String(trib.razonSocial || info.razonSocialComprador || 'Proveedor').slice(0, 120),
      ruc: trib.ruc ? String(trib.ruc) : null, medio: 'UNKNOWN', ultimos4: null, categoria: null
    };
  } catch { return null; }
}

// ---- Interpretación por IA (notificaciones de consumo, recibos en texto) ----
async function extractWithAI(prisma: any, userId: number, categories: string[], mail: FetchedMail): Promise<Extracted | null> {
  const creds = await getBrainCreds(prisma);
  if (!creds) return null;
  const system = [
    'Eres un extractor de comprobantes financieros a partir de correos (notificaciones de consumo de tarjetas, recibos, facturas).',
    'Devuelve SOLO un JSON con este formato exacto:',
    '{"esComprobante":bool,"tipo":"EXPENSE"|"INCOME","monto":number|null,"fecha":"YYYY-MM-DD"|null,"comercio":string|null,"ultimos4":string|null,"medio":"CREDIT_CARD"|"DEBIT_CARD"|"ACCOUNT"|"UNKNOWN","ruc":string|null,"categoria":string|null}',
    'Reglas:',
    '- esComprobante=true SOLO si el correo informa de una compra/consumo/pago/factura con un MONTO concreto. Boletines, promociones, códigos de verificación, avisos de seguridad => esComprobante=false.',
    '- tipo: EXPENSE para consumos/compras/pagos; INCOME solo si es un abono/depósito RECIBIDO.',
    '- monto: el valor total (número, punto decimal). fecha: la del consumo (YYYY-MM-DD).',
    '- ultimos4: los últimos 4 dígitos de la tarjeta/cuenta si aparecen (ej. "TARJETA TERMINADA EN 478" => "478").',
    '- medio: CREDIT_CARD si es tarjeta de crédito, DEBIT_CARD si débito, ACCOUNT si cuenta/transferencia, UNKNOWN si no se sabe.',
    '- comercio: el establecimiento/proveedor.',
    `- categoria: elige UNA de esta lista del usuario si alguna encaja, o null: ${categories.join(', ') || '(sin categorías)'}.`,
    'No inventes datos. Si falta, usa null.'
  ].join('\n');
  const user = `ASUNTO: ${mail.subject || ''}\nDE: ${mail.from || ''}\n\n${mail.text}`.slice(0, 9000);
  let raw = '';
  try { raw = await chatComplete(creds, { system, user, jsonMode: true, maxTokens: 700 }); }
  catch (e: any) { logger.warn({ e: e?.message }, 'mail: IA falló al extraer comprobante'); return null; }
  try {
    const j = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return {
      esComprobante: !!j.esComprobante,
      tipo: j.tipo === 'INCOME' ? 'INCOME' : 'EXPENSE',
      monto: num(j.monto),
      fecha: typeof j.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.fecha) ? j.fecha : null,
      comercio: j.comercio ? String(j.comercio).slice(0, 120) : null,
      ultimos4: last4(j.ultimos4),
      medio: ['CREDIT_CARD', 'DEBIT_CARD', 'ACCOUNT'].includes(j.medio) ? j.medio : 'UNKNOWN',
      ruc: j.ruc ? String(j.ruc).replace(/\D/g, '').slice(0, 13) : null,
      categoria: j.categoria ? String(j.categoria) : null
    };
  } catch { return null; }
}

// ---- Resolución de instrumento (tarjeta/cuenta) por últimos 4 y medio ----
function resolveInstrument(ex: Extracted, accounts: any[], cards: any[]): { paymentMethod: string; accountId: number | null; cardId: number | null; resolved: boolean } {
  const l4 = ex.ultimos4;
  const credit = cards.filter((c) => c.type === 'CREDIT');
  const debit = cards.filter((c) => c.type === 'DEBIT');
  // 1) por últimos 4
  if (l4) {
    const cc = credit.find((c) => last4(c.last4) === l4);
    if (cc) return { paymentMethod: 'CREDIT_CARD', accountId: null, cardId: cc.id, resolved: true };
    const acc = accounts.find((a) => last4(a.accountNumber) === l4);
    if (acc) return { paymentMethod: 'DEBIT_CARD', accountId: acc.id, cardId: null, resolved: true };
    const dc = debit.find((c) => last4(c.last4) === l4);
    if (dc) { // tarjeta de débito: usa una cuenta del mismo banco/titular
      const a2 = accounts.find((a) => a.bankId && a.bankId === dc.bankId) || accounts.find((a) => (a.bankName || '') === (dc.bankName || ''));
      if (a2) return { paymentMethod: 'DEBIT_CARD', accountId: a2.id, cardId: null, resolved: true };
    }
  }
  // 2) por medio, si hay uno solo evidente
  if (ex.medio === 'CREDIT_CARD' && credit.length === 1) return { paymentMethod: 'CREDIT_CARD', accountId: null, cardId: credit[0].id, resolved: true };
  if (ex.medio === 'ACCOUNT' && accounts.length === 1) return { paymentMethod: 'BANK_TRANSFER', accountId: accounts[0].id, cardId: null, resolved: true };
  return { paymentMethod: 'CASH', accountId: null, cardId: null, resolved: false };
}

function matchCategory(name: string | null, categories: any[]): number | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const exact = categories.find((c) => c.name.toLowerCase() === n);
  if (exact) return exact.id;
  const partial = categories.find((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()));
  return partial ? partial.id : null;
}

/** Procesa un correo ya extraído: decide estado y crea el movimiento si procede. */
async function ingestOne(prisma: any, userId: number, autoCreate: boolean, ex: Extracted | null, mail: FetchedMail, accounts: any[], cards: any[], categories: any[], kind: string): Promise<'added' | 'pending' | 'discarded' | 'failed'> {
  const base = {
    userId, messageId: mail.messageId, fromAddr: mail.from, subject: mail.subject,
    receivedAt: mail.date || new Date(), kind
  };
  if (!ex || !ex.esComprobante) {
    await prisma.mailReceipt.create({ data: { ...base, status: 'DISCARDED', raw: { reason: 'No es un comprobante de consumo', ex } } });
    return 'discarded';
  }
  if (!ex.monto) {
    await prisma.mailReceipt.create({ data: { ...base, vendor: ex.comercio, status: 'FAILED', raw: { reason: 'No se encontró el monto', ex } } });
    return 'failed';
  }
  const inst = resolveInstrument(ex, accounts, cards);
  const categoryId = matchCategory(ex.categoria, categories);
  const docDate = ex.fecha ? new Date(`${ex.fecha}T12:00:00`) : (mail.date || new Date());
  const draft = {
    type: ex.tipo, amount: ex.monto, movementDate: docDate,
    description: (ex.comercio || mail.subject || 'Comprobante').slice(0, 200),
    paymentMethod: inst.paymentMethod, accountId: inst.accountId, cardId: inst.cardId,
    categoryId, vendor: ex.comercio, notes: 'Registrado desde el correo'
  };
  const rawData = { ex, draft, resolved: inst.resolved, categoryId };

  // Auto-registra solo si identificamos el instrumento (tarjeta/cuenta). Si no,
  // lo dejamos PENDIENTE en la bandeja para que el usuario lo apruebe.
  if (autoCreate && inst.resolved) {
    try {
      const mv = await createMovement(prisma, userId, draft);
      await prisma.mailReceipt.create({ data: { ...base, vendor: ex.comercio, taxId: ex.ruc, amount: ex.monto, docDate, status: 'APPROVED', movementId: mv.id, raw: rawData } });
      return 'added';
    } catch (e: any) {
      await prisma.mailReceipt.create({ data: { ...base, vendor: ex.comercio, taxId: ex.ruc, amount: ex.monto, docDate, status: 'FAILED', raw: { ...rawData, reason: e?.message || 'No se pudo registrar' } } });
      return 'failed';
    }
  }
  await prisma.mailReceipt.create({ data: { ...base, vendor: ex.comercio, taxId: ex.ruc, amount: ex.monto, docDate, status: 'PENDING', raw: { ...rawData, reason: inst.resolved ? 'Revisión manual' : 'No identifiqué la tarjeta/cuenta' } } });
  return 'pending';
}

/** Ingesta para un tenant concreto. Devuelve un resumen. */
export async function ingestTenantMail(prisma: any): Promise<IngestSummary> {
  const zero: IngestSummary = { checked: 0, added: 0, pending: 0, discarded: 0, failed: 0 };
  const cfg = await prisma.mailConfig.findUnique({ where: { id: 1 } });
  if (!cfg || !cfg.enabled || !cfg.email || !cfg.passwordEnc) return zero;
  const userId = cfg.userId || (await prisma.user.findFirst({ select: { id: true } }))?.id;
  if (!userId) return { ...zero, error: 'Sin usuario para imputar' };

  let password: string;
  try { password = decryptString(cfg.passwordEnc); } catch { return { ...zero, error: 'No se pudo leer la contraseña' }; }
  const creds: ImapCreds = { host: cfg.host, port: cfg.port, email: cfg.email, password, folder: cfg.folder };

  // Primera vez: fija el punto de partida sin procesar el histórico.
  if (cfg.lastSeenUid == null) {
    const base = await fetchNewMessages(creds, 0, { baselineOnly: true });
    if (!base.ok) return { ...zero, error: base.error };
    await prisma.mailConfig.update({ where: { id: 1 }, data: { lastSeenUid: base.maxUid, lastCheckAt: new Date() } });
    return zero;
  }

  const res = await fetchNewMessages(creds, cfg.lastSeenUid, { limit: 30 });
  if (!res.ok) { await prisma.mailConfig.update({ where: { id: 1 }, data: { lastCheckAt: new Date() } }).catch(() => {}); return { ...zero, error: res.error }; }

  const [accounts, cards, categories] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, bankId: true, accountKind: true, accountNumber: true } }),
    prisma.card.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, bankId: true, last4: true, type: true } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true } })
  ]);
  const catNames = categories.map((c: any) => c.name);

  const out = { ...zero };
  for (const mail of res.messages) {
    out.checked++;
    try {
      const existing = await prisma.mailReceipt.findUnique({ where: { userId_messageId: { userId, messageId: mail.messageId } } });
      if (existing) continue;

      // 1) ¿Factura SRI adjunta en XML? → datos exactos.
      let ex: Extracted | null = null;
      let kind = 'TEXT';
      const xmlAtt = mail.attachments.find((a) => /xml/i.test(a.mime || '') || /\.xml$/i.test(a.filename || ''));
      if (xmlAtt) {
        const sri = parseSriXml(xmlAtt.content.toString('utf8'));
        if (sri) { ex = sri as Extracted; kind = 'XML'; }
      }
      // 2) Si no, interpretación por IA del texto.
      if (!ex) ex = await extractWithAI(prisma, userId, catNames, mail);

      const r = await ingestOne(prisma, userId, cfg.autoCreate || cfg.enabled, ex, mail, accounts, cards, categories, kind);
      out[r]++;
    } catch (e: any) {
      logger.warn({ e: e?.message, uid: mail.uid }, 'mail: fallo procesando un correo');
      out.failed++;
    }
  }
  await prisma.mailConfig.update({ where: { id: 1 }, data: { lastSeenUid: res.maxUid, lastCheckAt: new Date() } });
  return out;
}

/** Recorre todos los tenants activos con lector de correo habilitado. */
export async function runMailScan(): Promise<void> {
  try {
    const conns = await globalPrisma.tenantConnection.findMany({ include: { tenant: { select: { status: true, slug: true } } } });
    for (const conn of conns) {
      if (conn.tenant.status !== 'ACTIVE') continue;
      try {
        const prisma = await getTenantPrisma(conn.tenantId);
        const r = await ingestTenantMail(prisma);
        if (r.checked || r.error) logger.info({ tenant: conn.tenant.slug, ...r }, 'mail: ingesta de tenant');
      } catch (err) {
        logger.error({ err, tenant: conn.tenant.slug }, 'mail: ingesta falló para tenant');
      }
    }
  } catch (err) {
    logger.error({ err }, 'mail: barrido de ingesta falló');
  }
}
