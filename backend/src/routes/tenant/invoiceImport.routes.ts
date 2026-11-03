import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requirePermission } from '../../middleware/permissions';
import { auditFromReq } from '../../lib/tenantAudit';
import { logger } from '../../lib/logger';
import { MAX_XML_BYTES, parseSriXml, type ParsedSriInvoice } from '../../lib/sriXml';

// Importación de facturas desde el XML del SRI. Los importes salen siempre del documento:
// /confirm vuelve a leer cada XML y del cliente solo toma lo que el documento no puede decir.
// Se monta detrás de requireAuth + tenantContext. El router trae sus propios permisos, límites y
// parser de cuerpo, en este orden: nada lee el cuerpo sin haber autenticado y autorizado.
export const invoiceImportRouter = Router();

const MAX_FILES = 50;
const MAX_REQUESTS_PER_MINUTE = 20;
const MAX_CONCURRENT_IMPORTS = 2;
const CONSUMER_FINAL_TAX_ID = '9999999999999';

/** Parser JSON para el resto de la API: la importación se salta el límite global y lee el suyo. */
export function jsonExceptInvoiceImport(limit: string): RequestHandler {
  const parser = express.json({ limit });
  return (req, res, next) => (/^\/api\/invoices\/import(\/|$)/i.test(req.path) ? next() : parser(req, res, next));
}

function requireTenantUser(req: Request, res: Response, next: NextFunction) {
  // Un superadmin que entra a una empresa no tiene usuario local: sin esto, un userId
  // indefinido haría que Prisma quitara el filtro y viera las facturas de todos.
  if (req.tenantUserId == null) return res.status(400).json({ message: 'La importación requiere un usuario de la empresa.' });
  return next();
}

// La clave es la cuenta y no el id local: el id local se repite entre empresas.
const perUserLimit = rateLimit({
  windowMs: 60_000,
  max: MAX_REQUESTS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.auth!.kind}:${(req.auth as { id: string }).id}`,
  message: { message: 'Demasiadas importaciones seguidas. Espera un minuto y vuelve a intentarlo.' }
});

let importsInFlight = 0;

function limitConcurrency(_req: Request, res: Response, next: NextFunction) {
  if (importsInFlight >= MAX_CONCURRENT_IMPORTS) {
    res.setHeader('Retry-After', '5');
    return res.status(429).json({ message: 'El servidor está procesando otras importaciones. Inténtalo de nuevo en unos segundos.' });
  }
  importsInFlight++;
  res.once('close', () => { importsInFlight--; });
  return next();
}

invoiceImportRouter.use(
  requirePermission('invoices', 'write'),
  requireTenantUser,
  perUserLimit,
  limitConcurrency,
  express.json({ limit: '12mb' })
);

// Lista sin validar elemento a elemento: un archivo malo da un error en su ítem, no un 400 del lote.
const previewSchema = z.object({ files: z.array(z.unknown()).min(1).max(MAX_FILES) });
const confirmSchema = z.object({ items: z.array(z.unknown()).min(1).max(MAX_FILES) });

const fileSchema = z.object({
  filename: z.string().min(1).max(200),
  contentBase64: z.string()
});

const confirmItemSchema = fileSchema.extend({
  kind: z.enum(['SALE', 'PURCHASE']),
  entityId: z.number().int().positive().nullish(),
  accountId: z.number().int().positive().nullish(),
  status: z.enum(['ISSUED', 'PAID']).optional(),
  description: z.string().max(200).nullish(),
  allowPossibleDuplicate: z.boolean().optional()
});

type InvoiceKind = 'SALE' | 'PURCHASE';
type EntityRow = { id: number; taxId: string | null };
type Parties = { issuer: EntityRow[]; buyer: EntityRow[] };
type ItemError = { code: string; message: string };
type ReadResult = { ok: true; bytes: Buffer; invoice: ParsedSriInvoice } | ({ ok: false } & ItemError);
type NumberedInvoice = { id: number; number: string | null; kind: InvoiceKind; counterpartyTaxId: string | null; accessKey: string | null };
type NumberIndex = Map<string, NumberedInvoice[]>;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Forma comparable de un RUC o cédula: solo dígitos, y la cédula como su RUC (cédula + 001). */
function taxIdKey(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length === 10 ? `${digits}001` : digits;
}

/** Razones sociales del usuario que coinciden con el emisor y con el comprador del documento. */
function matchParties(entities: EntityRow[], issuerTaxId: string, buyerTaxId: string): Parties {
  const find = (taxId: string) => {
    const key = taxIdKey(taxId);
    return key ? entities.filter((e) => taxIdKey(e.taxId) === key) : [];
  };
  return { issuer: find(issuerTaxId), buyer: find(buyerTaxId) };
}

/** Tipo que dicta el documento: solo si coincide un lado. Con ambos o ninguno, decide el usuario. */
function expectedKind(parties: Parties): InvoiceKind | null {
  if (parties.issuer.length > 0 && parties.buyer.length === 0) return 'SALE';
  if (parties.buyer.length > 0 && parties.issuer.length === 0) return 'PURCHASE';
  return null;
}

/**
 * Establecimiento, punto de emisión y secuencial como enteros. Acepta 001-001-000000777, 1-1-777,
 * 001001000000777 (15 dígitos) y una clave de acceso de 49 dígitos. Cualquier otra cosa da null.
 */
function invoiceNumberKey(value: string | null): string | null {
  const text = (value ?? '').trim();
  const parts =
    /^(\d{1,3})-(\d{1,3})-(\d{1,9})$/.exec(text) ??
    /^(\d{3})(\d{3})(\d{9})$/.exec(text) ??
    /^\d{24}(\d{3})(\d{3})(\d{9})\d{10}$/.exec(text);
  return parts ? `${Number(parts[1])}-${Number(parts[2])}-${Number(parts[3])}` : null;
}

/** Codificación con la que leer el archivo: la que declara el XML si es latina, si no UTF-8. */
function decodeXml(bytes: Buffer): string {
  const head = bytes.subarray(0, 200).toString('latin1');
  const encoding = /^(?:\xef\xbb\xbf)?\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1].toLowerCase();
  if (encoding === 'iso-8859-1' || encoding === 'windows-1252') return new TextDecoder(encoding).decode(bytes);
  return bytes.toString('utf8');
}

function readDocument(contentBase64: string): ReadResult {
  const validBase64 = contentBase64.length > 0 && contentBase64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64);
  if (!validBase64) return { ok: false, code: 'INVALID_BASE64', message: 'El archivo no se pudo leer: su contenido no es base64 válido.' };
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length > MAX_XML_BYTES) return { ok: false, code: 'TOO_LARGE', message: 'El archivo supera el tamaño máximo de un comprobante.' };
  const parsed = parseSriXml(decodeXml(bytes));
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
  return { ok: true, bytes, invoice: parsed.invoice };
}

/** Nombre visible del adjunto: sin ruta ni caracteres reservados, de control o bidi, y siempre .xml. */
function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩:*?"<>|]/g, '').trim().replace(/[. ]+$/, '');
  const stem = clean.replace(/\.xml$/i, '').slice(0, 196).trim();
  return `${stem || 'factura'}.xml`;
}

/** Nombre recibido de un elemento que no pasó la validación, solo para identificarlo en la respuesta. */
function rawFilename(raw: unknown): string {
  const name = (raw as { filename?: unknown } | null)?.filename;
  return typeof name === 'string' ? name.slice(0, 200) : '';
}

const loadEntities = (req: Request) => req.tenantPrisma!.entity.findMany({
  where: { userId: req.tenantUserId! },
  select: { id: true, taxId: true }
});

function addToIndex(index: NumberIndex, row: NumberedInvoice) {
  const number = invoiceNumberKey(row.number);
  if (!number) return;
  const key = `${row.kind}:${number}`;
  index.set(key, [...(index.get(key) ?? []), row]);
}

/** Facturas del usuario por tipo y número normalizado. El formato del número se resuelve en la aplicación. */
async function loadNumberIndex(req: Request): Promise<NumberIndex> {
  const rows = await req.tenantPrisma!.invoice.findMany({
    where: { userId: req.tenantUserId!, number: { not: null } },
    select: { id: true, number: true, kind: true, counterpartyTaxId: true, accessKey: true }
  });
  const index: NumberIndex = new Map();
  for (const row of rows) addToIndex(index, row);
  return index;
}

/** Otra factura del mismo tipo y número, con el mismo RUC o con RUC vacío en alguna de las dos. */
function findPossibleDuplicate(index: NumberIndex, kind: InvoiceKind, inv: ParsedSriInvoice): NumberedInvoice | null {
  const taxId = taxIdKey(kind === 'SALE' ? inv.buyerTaxId : inv.issuerTaxId);
  const candidates = index.get(`${kind}:${invoiceNumberKey(inv.number)}`) ?? [];
  return candidates.find((row) => {
    if (row.accessKey === inv.accessKey) return false; // el mismo documento se controla por clave
    const other = taxIdKey(row.counterpartyTaxId);
    return !other || !taxId || other === taxId;
  }) ?? null;
}

invoiceImportRouter.post('/preview', async (req: Request, res: Response) => {
  const { files } = previewSchema.parse(req.body);
  const entities = await loadEntities(req);
  const numbers = await loadNumberIndex(req);
  const seenKeys = new Set<string>();

  const items = [];
  for (const raw of files) {
    await yieldToEventLoop();
    const file = fileSchema.safeParse(raw);
    if (!file.success) {
      items.push({
        filename: rawFilename(raw),
        status: 'ERROR',
        error: { code: 'INVALID_FILE', message: 'El nombre o el contenido del archivo no son válidos.' }
      });
      continue;
    }
    const { filename, contentBase64 } = file.data;
    const doc = readDocument(contentBase64);
    if (!doc.ok) {
      items.push({ filename, status: 'ERROR', error: { code: doc.code, message: doc.message } });
      continue;
    }

    const inv = doc.invoice;
    const parties = matchParties(entities, inv.issuerTaxId, inv.buyerTaxId);
    const onlyIssuer = parties.issuer.length === 1 && parties.buyer.length === 0;
    const onlyBuyer = parties.buyer.length === 1 && parties.issuer.length === 0;
    const kind: InvoiceKind | null = onlyIssuer ? 'SALE' : onlyBuyer ? 'PURCHASE' : null;
    const foreignDocument = parties.issuer.length === 0 && parties.buyer.length === 0;

    const draft = {
      kind,
      entityId: onlyIssuer ? parties.issuer[0].id : onlyBuyer ? parties.buyer[0].id : null,
      accessKey: inv.accessKey,
      number: inv.number,
      counterparty: onlyIssuer ? inv.buyerName : onlyBuyer ? inv.issuerName : '',
      counterpartyTaxId: onlyIssuer ? inv.buyerTaxId : onlyBuyer ? inv.issuerTaxId : '',
      issuerTaxId: inv.issuerTaxId,
      issuerName: inv.issuerName,
      buyerTaxId: inv.buyerTaxId,
      buyerName: inv.buyerName,
      issueDate: inv.issueDate,
      netAmount: inv.netAmount,
      discount: inv.discount,
      vatRate: inv.vatRate,
      vatAmount: inv.vatAmount,
      vatLines: inv.vatLines,
      otherCharges: inv.otherCharges,
      total: inv.total,
      warnings: foreignDocument
        ? [...inv.warnings, 'Ninguna razón social coincide con este documento; revíselo antes de registrar.']
        : inv.warnings
    };

    // Con el tipo sin decidir solo es duplicado si ya está registrada en los dos lados.
    const possibleKinds: InvoiceKind[] = kind ? [kind] : ['SALE', 'PURCHASE'];
    const sameKey = await req.tenantPrisma!.invoice.findMany({
      where: { userId: req.tenantUserId!, accessKey: inv.accessKey, kind: { in: possibleKinds } },
      select: { id: true, number: true }
    });
    const repeatedInBatch = seenKeys.has(inv.accessKey);
    seenKeys.add(inv.accessKey);
    if (sameKey.length === possibleKinds.length) {
      items.push({ filename, status: 'DUPLICATE', draft, duplicateOf: { id: sameKey[0].id, number: sameKey[0].number, source: 'ACCESS_KEY' } });
      continue;
    }
    if (repeatedInBatch) {
      items.push({ filename, status: 'DUPLICATE', draft, duplicateOf: { id: 0, number: inv.number, source: 'ACCESS_KEY' } });
      continue;
    }

    const sameNumber = possibleKinds.map((k) => findPossibleDuplicate(numbers, k, inv)).find(Boolean);
    if (sameNumber) {
      items.push({ filename, status: 'DUPLICATE', draft, duplicateOf: { id: sameNumber.id, number: sameNumber.number, source: 'NUMBER_AND_TAX_ID' } });
      continue;
    }

    items.push({ filename, status: kind ? 'READY' : 'NEEDS_KIND', draft });
  }

  res.json({ items });
});

invoiceImportRouter.post('/confirm', async (req: Request, res: Response) => {
  const { items } = confirmSchema.parse(req.body);
  const p = req.tenantPrisma!;
  const userId = req.tenantUserId!;
  const entities = await loadEntities(req);
  const numbers = await loadNumberIndex(req);

  const created: { filename: string; id: number; number: string | null }[] = [];
  const skipped: { filename: string; reason: string; code: string }[] = [];

  for (const raw of items) {
    await yieldToEventLoop();
    const parsedItem = confirmItemSchema.safeParse(raw);
    if (!parsedItem.success) {
      skipped.push({ filename: rawFilename(raw), code: 'INVALID_ITEM', reason: 'Los datos de este archivo no son válidos.' });
      continue;
    }
    const item = parsedItem.data;
    const { filename } = item;
    const skip = (code: string, reason: string) => skipped.push({ filename, code, reason });

    const doc = readDocument(item.contentBase64);
    if (!doc.ok) {
      skip(doc.code, doc.message);
      continue;
    }
    const inv = doc.invoice;

    const parties = matchParties(entities, inv.issuerTaxId, inv.buyerTaxId);
    const expected = expectedKind(parties);
    if (expected && item.kind !== expected) {
      skip('KIND_MISMATCH', `El documento coincide con una razón social tuya y es una ${expected === 'SALE' ? 'venta' : 'compra'}.`);
      continue;
    }
    if (item.kind === 'PURCHASE' && taxIdKey(inv.buyerTaxId) === CONSUMER_FINAL_TAX_ID) {
      skip('CONSUMER_FINAL', 'Una compra a consumidor final no sustenta crédito tributario; regístrala a mano sin IVA si la necesitas.');
      continue;
    }

    const chosenEntity = item.entityId != null ? entities.find((e) => e.id === item.entityId) : null;
    if (item.entityId != null && !chosenEntity) {
      skip('INVALID_ENTITY', 'La razón social indicada no existe.');
      continue;
    }
    // Una venta es del emisor y una compra del comprador. Una razón sin RUC no se puede contrastar.
    const ownSideTaxId = item.kind === 'SALE' ? inv.issuerTaxId : inv.buyerTaxId;
    const chosenTaxId = taxIdKey(chosenEntity?.taxId);
    if (chosenTaxId && chosenTaxId !== taxIdKey(ownSideTaxId)) {
      skip('INVALID_ENTITY', `El RUC de la razón social elegida no es el del ${item.kind === 'SALE' ? 'emisor' : 'comprador'} del documento.`);
      continue;
    }

    if (item.accountId != null) {
      const account = await p.account.findFirst({ where: { id: item.accountId, userId }, select: { id: true } });
      if (!account) {
        skip('INVALID_ACCOUNT', 'La cuenta indicada no existe.');
        continue;
      }
    }

    const sameKey = await p.invoice.findFirst({
      where: { userId, accessKey: inv.accessKey, kind: item.kind },
      select: { number: true }
    });
    if (sameKey) {
      skip('DUPLICATE_ACCESS_KEY', `Esta factura ya está registrada${sameKey.number ? ` con el número ${sameKey.number}` : ''}.`);
      continue;
    }
    const sameNumber = findPossibleDuplicate(numbers, item.kind, inv);
    if (sameNumber && !item.allowPossibleDuplicate) {
      skip('POSSIBLE_DUPLICATE', `Ya existe una factura del mismo tipo con el número ${inv.number} y el mismo RUC o sin RUC.`);
      continue;
    }

    const counterpartyTaxId = item.kind === 'SALE' ? inv.buyerTaxId : inv.issuerTaxId;
    const counterpartyName = item.kind === 'SALE' ? inv.buyerName : inv.issuerName;

    // Sin razón social elegida se usa la del documento, si es una sola.
    const sameSide = item.kind === 'SALE' ? parties.issuer : parties.buyer;
    const entityId = item.entityId ?? (sameSide.length === 1 ? sameSide[0].id : null);

    try {
      // Factura y adjunto se crean juntos o ninguno. El adjunto no tiene clave foránea a la factura.
      const row = await p.$transaction(async (tx) => {
        const invoice = await tx.invoice.create({
          data: {
            userId,
            kind: item.kind,
            status: item.status ?? 'ISSUED',
            number: inv.number,
            // El formulario de edición admite hasta 160 caracteres; el SRI, más.
            counterparty: (counterpartyName || counterpartyTaxId).slice(0, 160),
            counterpartyTaxId,
            // Mediodía UTC: el período tributario se calcula en UTC y el día no cambia al mostrarlo en hora local.
            issueDate: new Date(`${inv.issueDate}T12:00:00.000Z`),
            netAmount: inv.netAmount,
            vatRate: inv.vatRate,
            vatAmount: inv.vatAmount,
            total: inv.total,
            description: item.description?.trim() || null,
            accountId: item.accountId ?? null,
            entityId,
            source: 'SRI_XML',
            accessKey: inv.accessKey,
            discount: inv.discount,
            otherCharges: inv.otherCharges,
            vatLines: inv.vatLines.map((l) => ({ rate: l.rate, rateCode: l.rateCode, base: l.base, vat: l.vat })),
            issuerTaxId: inv.issuerTaxId,
            buyerTaxId: inv.buyerTaxId
          },
          select: { id: true, number: true }
        });
        await tx.attachment.create({
          data: {
            userId,
            entityType: 'INVOICE',
            entityId: invoice.id,
            filename: safeFilename(filename),
            mimeType: 'application/xml',
            size: doc.bytes.length,
            data: new Uint8Array(doc.bytes)
          }
        });
        return invoice;
      }, { maxWait: 10_000, timeout: 20_000 }); // cada empresa tiene pocas conexiones: esperar turno no es un fallo
      created.push({ filename, id: row.id, number: row.number });
      addToIndex(numbers, { id: row.id, number: row.number, kind: item.kind, counterpartyTaxId, accessKey: inv.accessKey });
      const authorized = sameNumber ? ` (posible duplicado de la factura ${sameNumber.id}, autorizado por el usuario)` : '';
      await auditFromReq(req, 'CREATE', 'invoice', row.id, `Factura ${row.number} importada del SRI${authorized}`);
    } catch (err) {
      // P2002: otra petición guardó la misma clave entre la consulta y la creación.
      if ((err as { code?: string })?.code === 'P2002') {
        skip('DUPLICATE_ACCESS_KEY', 'Esta factura ya está registrada.');
      } else {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'invoice import item failed');
        skip('SAVE_FAILED', 'No se pudo guardar esta factura.');
      }
    }
  }

  res.json({ created, skipped });
});
