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
import { buildReceiptImage } from './mailReceiptImage';
import { parseSriXml } from './sriXml';

function decodeXml(bytes: Buffer): string {
  const head = bytes.subarray(0, 200).toString('latin1');
  const enc = /encoding=["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (enc && /8859|latin|1252/i.test(enc)) return bytes.toString('latin1');
  return bytes.toString('utf8');
}
const taxKey = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/**
 * Factura electrónica SRI (XML adjunto) → crea la Factura en la zona Facturas e
 * IVA (con IVA desglosado) y adjunta el XML y el PDF. Devuelve el resultado, o
 * null si el XML no es una factura válida (para caer a la interpretación por IA).
 */
async function ingestInvoiceFromXml(prisma: any, userId: number, mail: FetchedMail, xmlAtt: any, allAtts: any[], entities: any[]): Promise<'added' | 'failed' | 'discarded' | null> {
  const base = { userId, messageId: mail.messageId, fromAddr: mail.from, subject: mail.subject, receivedAt: mail.date || new Date(), kind: 'XML' };
  const result = parseSriXml(decodeXml(xmlAtt.content));
  if (!result.ok) {
    // XML que no es un comprobante del SRI o es ilegible → que lo intente la IA por texto.
    if (result.code === 'NOT_SRI' || result.code === 'INVALID_XML') return null;
    // Es un comprobante del SRI pero no se puede registrar (no autorizado, nota de crédito,
    // ambiente de pruebas, faltan datos…): deja constancia con el motivo real.
    await prisma.mailReceipt.create({ data: { ...base, status: 'FAILED', raw: { reason: `Factura no registrada: ${result.message}` } } });
    return 'failed';
  }
  const inv = result.invoice;
  const issueDate = new Date(`${inv.issueDate}T12:00:00.000Z`);

  const dup = await prisma.invoice.findFirst({ where: { userId, accessKey: inv.accessKey }, select: { id: true } });
  if (dup) {
    await prisma.mailReceipt.create({ data: { ...base, vendor: inv.issuerName, taxId: inv.issuerTaxId, amount: inv.total, docDate: issueDate, status: 'DISCARDED', invoiceId: dup.id, raw: { reason: 'Esta factura ya estaba registrada', invoice: { number: inv.number } } } });
    return 'discarded';
  }

  // Compra (recibida) o venta (emitida), según a quién pertenece el RUC.
  const issuerMine = entities.filter((e) => taxKey(e.taxId) && taxKey(e.taxId) === taxKey(inv.issuerTaxId));
  const buyerMine = entities.filter((e) => taxKey(e.taxId) && taxKey(e.taxId) === taxKey(inv.buyerTaxId));
  const kind = (issuerMine.length && !buyerMine.length) ? 'SALE' : 'PURCHASE';
  const entityId = (kind === 'SALE' ? issuerMine : buyerMine)[0]?.id ?? null;
  const counterparty = kind === 'PURCHASE' ? inv.issuerName : inv.buyerName;
  const counterpartyTaxId = kind === 'PURCHASE' ? inv.issuerTaxId : inv.buyerTaxId;
  const pdfAtt = allAtts.find((a) => /pdf/i.test(a.mime || '') || /\.pdf$/i.test(a.filename || ''));

  try {
    const invoiceId = await prisma.$transaction(async (tx: any) => {
      const row = await tx.invoice.create({
        data: {
          userId, kind, status: 'ISSUED', number: inv.number,
          counterparty: (counterparty || counterpartyTaxId).slice(0, 160), counterpartyTaxId,
          issueDate, netAmount: inv.netAmount, vatRate: inv.vatRate, vatAmount: inv.vatAmount, total: inv.total,
          source: 'SRI_XML', accessKey: inv.accessKey, discount: inv.discount, otherCharges: inv.otherCharges,
          vatLines: inv.vatLines.map((l: any) => ({ rate: l.rate, rateCode: l.rateCode, base: l.base, vat: l.vat })),
          issuerTaxId: inv.issuerTaxId, buyerTaxId: inv.buyerTaxId, entityId
        },
        select: { id: true }
      });
      await tx.attachment.create({ data: { userId, entityType: 'INVOICE', entityId: row.id, filename: (xmlAtt.filename || `factura-${inv.number}.xml`).slice(0, 200), mimeType: 'application/xml', size: xmlAtt.content.length, data: new Uint8Array(xmlAtt.content) } });
      if (pdfAtt) await tx.attachment.create({ data: { userId, entityType: 'INVOICE', entityId: row.id, filename: (pdfAtt.filename || `factura-${inv.number}.pdf`).slice(0, 200), mimeType: 'application/pdf', size: pdfAtt.content.length, data: new Uint8Array(pdfAtt.content) } });
      return row.id;
    }, { maxWait: 10000, timeout: 20000 });
    await prisma.mailReceipt.create({ data: { ...base, vendor: counterparty, taxId: counterpartyTaxId, amount: inv.total, docDate: issueDate, status: 'APPROVED', invoiceId, raw: { invoice: { number: inv.number, kind } } } });
    return 'added';
  } catch (e: any) {
    if (e?.code === 'P2002') {
      await prisma.mailReceipt.create({ data: { ...base, vendor: inv.issuerName, amount: inv.total, status: 'DISCARDED', raw: { reason: 'Esta factura ya estaba registrada' } } });
      return 'discarded';
    }
    logger.warn({ e: e?.message }, 'mail: fallo creando factura desde XML');
    await prisma.mailReceipt.create({ data: { ...base, vendor: inv.issuerName, amount: inv.total, status: 'FAILED', raw: { reason: e?.message || 'No se pudo registrar la factura' } } });
    return 'failed';
  }
}

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Efectivo', BANK_TRANSFER: 'Transferencia', DEPOSIT: 'Depósito',
  DEBIT_CARD: 'Tarjeta de débito', CREDIT_CARD: 'Tarjeta de crédito', WALLET: 'Billetera', OTHER: 'Otro'
};

/**
 * Genera una IMAGEN de comprobante con los datos y la adjunta al movimiento.
 * Defensivo: si algo falla, el movimiento ya quedó creado (no se revierte).
 */
export async function attachComprobanteImage(prisma: any, userId: number, movementId: number, ex: any, draft: any): Promise<void> {
  if (!ex || typeof ex.monto !== 'number') return;
  try {
    let bankName: string | null = ex.banco || null;
    const instRows: { label: string; value: string }[] = [];
    if (draft?.cardId) {
      const c = await prisma.card.findUnique({ where: { id: draft.cardId }, select: { name: true, bankName: true, last4: true } });
      if (c) { bankName = bankName || c.bankName; instRows.push({ label: 'Tarjeta', value: `${c.name}${c.last4 ? ' ···' + c.last4 : ''}` }); }
    } else if (draft?.accountId) {
      const a = await prisma.account.findUnique({ where: { id: draft.accountId }, select: { name: true, bankName: true } });
      if (a) { bankName = bankName || a.bankName; instRows.push({ label: 'Cuenta', value: a.name }); }
    }
    const rows: { label: string; value: string }[] = [
      { label: 'Concepto', value: ex.concepto || ex.comercio || '' },
      ...instRows,
      { label: 'Cuenta origen', value: ex.ultimos4 ? '···' + ex.ultimos4 : '' },
      { label: 'Destino', value: ex.destino || '' },
      { label: 'Método', value: METHOD_LABEL[draft?.paymentMethod] || '' },
      { label: 'Fecha', value: ex.fecha || '' },
      { label: 'Documento', value: ex.documento || '' },
      { label: 'RUC', value: ex.ruc || '' }
    ];
    const img = await buildReceiptImage({
      bank: bankName, title: ex.titulo,
      typeLabel: ex.esTransferencia ? 'Transferencia' : (ex.tipo === 'INCOME' ? 'Ingreso' : 'Gasto'),
      amount: ex.monto, rows
    });
    if (!img) return;
    await prisma.attachment.create({ data: {
      userId, entityType: 'MOVEMENT', entityId: movementId,
      filename: `comprobante-correo-${Date.now()}.png`, mimeType: 'image/png',
      size: img.length, data: new Uint8Array(img)
    } });
  } catch (e: any) { logger.warn({ e: e?.message }, 'mail: no se pudo adjuntar el comprobante'); }
}

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
  banco: string | null;        // banco/cooperativa mencionado (ej. "JEP", "Pichincha")
  cuentaId: number | null;     // id de cuenta que la IA identificó del catálogo
  tarjetaId: number | null;    // id de tarjeta de crédito que la IA identificó
  esTransferencia: boolean;    // ¿es una transferencia enviada?
  concepto: string | null;     // motivo/concepto de la transacción
  destino: string | null;      // nombre o cuenta destino (en transferencias)
  documento: string | null;    // número de documento/comprobante
  titulo: string | null;       // título del correo (ej. "Transferencia exitosa")
  ruc: string | null;
  categoria: string | null;
}

interface Catalog { accounts: any[]; cards: any[]; categories: any[] }

const last4 = (s: unknown) => { const d = String(s ?? '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : null; };
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

// ---- Interpretación por IA (notificaciones de consumo, recibos en texto) ----
async function extractWithAI(prisma: any, userId: number, cat: Catalog, mail: FetchedMail): Promise<Extracted | null> {
  const creds = await getBrainCreds(prisma);
  if (!creds) return null;
  const kind = (a: any) => a.accountKind === 'SAVINGS' ? 'ahorros' : a.accountKind === 'CHECKING' ? 'corriente' : '';
  const cuentasTxt = cat.accounts.map((a) => `#${a.id} "${a.name}" (${a.bankName || 's/banco'}${kind(a) ? ', ' + kind(a) : ''}${last4(a.accountNumber) ? ', term ' + last4(a.accountNumber) : ''})`).join('; ') || '(ninguna)';
  const creditos = cat.cards.filter((c) => c.type === 'CREDIT');
  const tarjetasTxt = creditos.map((c) => `#${c.id} "${c.name}" (${c.bankName || 's/banco'}${last4(c.last4) ? ', term ' + last4(c.last4) : ''})`).join('; ') || '(ninguna)';
  const debitosTxt = cat.cards.filter((c) => c.type === 'DEBIT').map((c) => `${c.bankName || c.name}${last4(c.last4) ? ' term ' + last4(c.last4) : ''}`).join('; ') || '(ninguna)';

  const system = [
    'Eres un extractor de comprobantes financieros desde correos (notificaciones de consumo de tarjetas, recibos, facturas del SRI).',
    'Devuelve SOLO un JSON EXACTO: {"esComprobante":bool,"tipo":"EXPENSE"|"INCOME","monto":number|null,"fecha":"YYYY-MM-DD"|null,"comercio":string|null,"ultimos4":string|null,"medio":"CREDIT_CARD"|"DEBIT_CARD"|"ACCOUNT"|"UNKNOWN","banco":string|null,"cuentaId":number|null,"tarjetaId":number|null,"esTransferencia":bool,"concepto":string|null,"destino":string|null,"documento":string|null,"titulo":string|null,"ruc":string|null,"categoria":string|null}',
    '',
    'CATÁLOGO DEL USUARIO (usa estos ids reales):',
    `- CUENTAS (para débito/transferencia): ${cuentasTxt}`,
    `- TARJETAS DE CRÉDITO: ${tarjetasTxt}`,
    `- Tarjetas de débito registradas: ${debitosTxt}`,
    '',
    'Reglas:',
    '- esComprobante=true SOLO si informa de una compra/consumo/pago/factura con MONTO concreto. Boletines, promos, códigos de verificación o avisos de seguridad => false.',
    '- tipo: EXPENSE para consumos/compras/pagos; INCOME solo si es un abono/depósito RECIBIDO.',
    '- monto: valor total (número, punto decimal). fecha del consumo (YYYY-MM-DD). comercio: el establecimiento.',
    '- ultimos4: los 4 últimos dígitos de la tarjeta/cuenta si aparecen (ej. "TARJETA TERMINADA EN 478" => "478").',
    '- banco: el banco o cooperativa mencionado (ej. "Cooperativa JEP" => "JEP"; "Diners" => "Diners"; "Pichincha").',
    '- medio: CREDIT_CARD si fue tarjeta de crédito; DEBIT_CARD si "tarjeta de débito"; ACCOUNT si cuenta/transferencia; UNKNOWN si no se sabe.',
    '- IDENTIFICA EL INSTRUMENTO con el catálogo: si es CRÉDITO, pon tarjetaId con el id que calce por últimos 4 o por banco/nombre. Si es DÉBITO o cuenta, pon cuentaId con el id de la CUENTA que calce por banco (ej. "Tarjeta de Débito JEP" => la cuenta cuyo banco es la Cooperativa JEP; "cuenta de origen ****4464" del Banco Pichincha => la cuenta Pichincha) o por últimos 4. Si ninguno calza con seguridad, deja cuentaId y tarjetaId en null.',
    '- esTransferencia=true si el correo dice que se realizó/envió una TRANSFERENCIA. En ese caso ultimos4 = los últimos 4 de la CUENTA DE ORIGEN, destino = el nombre o número de la cuenta DESTINO, y medio="ACCOUNT".',
    '- concepto: el motivo/concepto de la transacción si aparece (ej. "Devolución de préstamo"). documento: el número de documento/comprobante si aparece. titulo: el encabezado del correo (ej. "Transferencia exitosa", "Notificación de Consumos").',
    `- categoria: elige UNA de esta lista si encaja con el comercio/concepto, o null: ${cat.categories.map((c) => c.name).join(', ') || '(sin categorías)'}.`,
    'No inventes ids que no estén en el catálogo. Si dudas, deja null.'
  ].join('\n');
  const user = `ASUNTO: ${mail.subject || ''}\nDE: ${mail.from || ''}\n\n${mail.text}`.slice(0, 9000);
  let raw = '';
  try { raw = await chatComplete(creds, { system, user, jsonMode: true, maxTokens: 800 }); }
  catch (e: any) { logger.warn({ e: e?.message }, 'mail: IA falló al extraer comprobante'); return null; }
  try {
    const j = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const toId = (v: any) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
    return {
      esComprobante: !!j.esComprobante,
      tipo: j.tipo === 'INCOME' ? 'INCOME' : 'EXPENSE',
      monto: num(j.monto),
      fecha: typeof j.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.fecha) ? j.fecha : null,
      comercio: j.comercio ? String(j.comercio).slice(0, 120) : null,
      ultimos4: last4(j.ultimos4),
      medio: ['CREDIT_CARD', 'DEBIT_CARD', 'ACCOUNT'].includes(j.medio) ? j.medio : 'UNKNOWN',
      banco: j.banco ? String(j.banco).slice(0, 60) : null,
      cuentaId: toId(j.cuentaId),
      tarjetaId: toId(j.tarjetaId),
      esTransferencia: !!j.esTransferencia,
      concepto: j.concepto ? String(j.concepto).slice(0, 160) : null,
      destino: j.destino ? String(j.destino).slice(0, 120) : null,
      documento: j.documento ? String(j.documento).slice(0, 60) : null,
      titulo: j.titulo ? String(j.titulo).slice(0, 80) : null,
      ruc: j.ruc ? String(j.ruc).replace(/\D/g, '').slice(0, 13) : null,
      categoria: j.categoria ? String(j.categoria) : null
    };
  } catch { return null; }
}

// ---- Resolución de instrumento (tarjeta/cuenta) ----
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function bankMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}
function acctMethod(medio: Extracted['medio']): string { return medio === 'ACCOUNT' ? 'BANK_TRANSFER' : 'DEBIT_CARD'; }

interface Instrument { paymentMethod: string; accountId: number | null; cardId: number | null; bankId: number | null; resolved: boolean }
function viaCard(c: any): Instrument { return { paymentMethod: 'CREDIT_CARD', accountId: null, cardId: c.id, bankId: c.bankId ?? null, resolved: true }; }
function viaAcc(a: any, medio: Extracted['medio']): Instrument { return { paymentMethod: acctMethod(medio), accountId: a.id, cardId: null, bankId: a.bankId ?? null, resolved: true }; }

function resolveInstrument(ex: Extracted, accounts: any[], cards: any[]): Instrument {
  const l4 = ex.ultimos4;
  const credit = cards.filter((c) => c.type === 'CREDIT');
  const debit = cards.filter((c) => c.type === 'DEBIT');

  // 1) ids que identificó la IA desde el catálogo (lo más fiable)
  if (ex.tarjetaId) { const cc = credit.find((c) => c.id === ex.tarjetaId); if (cc) return viaCard(cc); }
  if (ex.cuentaId) { const acc = accounts.find((a) => a.id === ex.cuentaId); if (acc) return viaAcc(acc, ex.medio); }

  // 2) por últimos 4
  if (l4) {
    const cc = credit.find((c) => last4(c.last4) === l4);
    if (cc) return viaCard(cc);
    const acc = accounts.find((a) => last4(a.accountNumber) === l4);
    if (acc) return viaAcc(acc, ex.medio);
    const dc = debit.find((c) => last4(c.last4) === l4);
    if (dc) {
      const a2 = accounts.find((a) => a.bankId && a.bankId === dc.bankId) || accounts.find((a) => bankMatch(a.bankName, dc.bankName));
      if (a2) return { paymentMethod: 'DEBIT_CARD', accountId: a2.id, cardId: null, bankId: a2.bankId ?? dc.bankId ?? null, resolved: true };
    }
  }

  // 3) por banco/cooperativa mencionado
  if (ex.banco) {
    if (ex.medio === 'CREDIT_CARD') {
      const cc = credit.find((c) => bankMatch(c.bankName, ex.banco) || bankMatch(c.name, ex.banco));
      if (cc) return viaCard(cc);
    } else {
      const acc = accounts.find((a) => bankMatch(a.bankName, ex.banco) || bankMatch(a.name, ex.banco));
      if (acc) return viaAcc(acc, ex.medio);
    }
  }

  // 4) un solo candidato evidente por medio
  if (ex.medio === 'CREDIT_CARD' && credit.length === 1) return viaCard(credit[0]);
  if ((ex.medio === 'ACCOUNT' || ex.medio === 'DEBIT_CARD') && accounts.length === 1) return viaAcc(accounts[0], ex.medio);

  return { paymentMethod: 'CASH', accountId: null, cardId: null, bankId: null, resolved: false };
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
  const description = (ex.concepto || ex.comercio || ex.destino || ex.titulo || mail.subject || 'Comprobante').slice(0, 200);
  const notesParts = [ex.titulo, ex.destino ? `Destino: ${ex.destino}` : '', ex.documento ? `Doc: ${ex.documento}` : '', 'Registrado desde el correo'].filter(Boolean);
  const draft: any = {
    type: ex.tipo, amount: ex.monto, movementDate: docDate, description,
    paymentMethod: inst.paymentMethod, accountId: inst.accountId, cardId: inst.cardId,
    categoryId, vendor: ex.comercio, notes: notesParts.join(' · ').slice(0, 1000)
  };
  // Banco en el movimiento (columna "Bancos"): según el instrumento resuelto.
  if (inst.bankId) { if (ex.tipo === 'INCOME') draft.toBankId = inst.bankId; else draft.fromBankId = inst.bankId; }
  const rawData = { ex, draft, resolved: inst.resolved, categoryId };

  // Auto-registra solo si identificamos el instrumento (tarjeta/cuenta). Si no,
  // lo dejamos PENDIENTE en la bandeja para que el usuario lo apruebe.
  if (autoCreate && inst.resolved) {
    try {
      const mv = await createMovement(prisma, userId, draft);
      await attachComprobanteImage(prisma, userId, mv.id, ex, draft);
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

  const [accounts, cards, categories, entities] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, bankId: true, accountKind: true, accountNumber: true } }),
    prisma.card.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, bankId: true, last4: true, type: true } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true } }),
    prisma.entity.findMany({ where: { userId }, select: { id: true, taxId: true } })
  ]);

  const out = { ...zero };
  for (const mail of res.messages) {
    out.checked++;
    try {
      const existing = await prisma.mailReceipt.findUnique({ where: { userId_messageId: { userId, messageId: mail.messageId } } });
      if (existing) continue;

      // 1) ¿Factura SRI adjunta en XML? → va a la zona Facturas e IVA.
      const xmlAtt = mail.attachments.find((a) => /xml/i.test(a.mime || '') || /\.xml$/i.test(a.filename || ''));
      if (xmlAtt) {
        const r = await ingestInvoiceFromXml(prisma, userId, mail, xmlAtt, mail.attachments, entities);
        if (r) { out[r]++; continue; }  // factura manejada (o duplicada/fallida)
      }

      // 2) Si no, interpretación por IA del texto (con el catálogo del usuario) → movimiento.
      const ex = await extractWithAI(prisma, userId, { accounts, cards, categories }, mail);
      const r = await ingestOne(prisma, userId, cfg.autoCreate || cfg.enabled, ex, mail, accounts, cards, categories, 'TEXT');
      out[r]++;
    } catch (e: any) {
      logger.warn({ e: e?.message, uid: mail.uid }, 'mail: fallo procesando un correo');
      out.failed++;
    }
  }
  await prisma.mailConfig.update({ where: { id: 1 }, data: { lastSeenUid: res.maxUid, lastCheckAt: new Date() } });
  return out;
}

// Evita que dos barridos se solapen: si el anterior aún corre (IMAP lento, muchos
// correos), el siguiente tick se salta. Así no se acumulan conexiones ni carga.
let mailScanRunning = false;

/** Recorre todos los tenants activos con lector de correo habilitado. */
export async function runMailScan(): Promise<void> {
  if (mailScanRunning) { logger.info('mail: barrido anterior aún en curso, se omite este tick'); return; }
  mailScanRunning = true;
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
  } finally {
    mailScanRunning = false;
  }
}
