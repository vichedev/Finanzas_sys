// =====================================================
// Lector de comprobantes electrónicos del SRI (Ecuador) en XML.
// Contrato común de la importación de facturas; los valores monetarios salen
// siempre del documento y se devuelven como número con 2 decimales.
// =====================================================
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type SriErrorCode =
  | 'INVALID_XML'        // no es XML legible
  | 'NOT_SRI'            // XML válido, pero no es un comprobante del SRI
  | 'UNSUPPORTED_DOC'    // nota de crédito, retención, etc.: aún no se importan
  | 'NOT_AUTHORIZED'     // trae constancia de autorización con estado distinto de AUTORIZADO
  | 'TEST_ENVIRONMENT'   // emitido en ambiente de pruebas: sin validez tributaria
  | 'BAD_ACCESS_KEY'     // clave ausente, sin 49 dígitos o con dígito verificador incorrecto
  | 'KEY_MISMATCH'       // la clave no coincide con el RUC, tipo, fecha o secuencial del documento
  | 'MISSING_FIELDS'     // faltan datos indispensables
  | 'TOO_LARGE';         // supera MAX_XML_BYTES

export interface SriVatLine {
  rate: number;          // tarifa en % (0, 5, 15...)
  rateCode: string;      // codigoPorcentaje tal como viene
  base: number;          // baseImponible
  vat: number;           // valor
}

export interface ParsedSriInvoice {
  accessKey: string;     // 49 dígitos
  issuerTaxId: string;   // RUC del emisor, con sus ceros
  issuerName: string;
  buyerTaxId: string;    // identificacionComprador, con sus ceros
  buyerName: string;
  number: string;        // estab-ptoEmi-secuencial, ej. 001-001-000001234
  issueDate: string;     // YYYY-MM-DD
  netAmount: number;     // totalSinImpuestos
  discount: number;      // totalDescuento
  vatAmount: number;     // suma de los impuestos con codigo 2 (IVA)
  vatRate: number;       // tarifa mayor con base > 0; 0 si no hay
  vatLines: SriVatLine[];
  otherCharges: number;  // importeTotal - netAmount - vatAmount (ICE, propina...)
  total: number;         // importeTotal
  authorizedAt: string | null; // fecha de autorización ISO, si viene la constancia
  warnings: string[];    // avisos en español para mostrar en la revisión
}

export type SriParseResult =
  | { ok: true; invoice: ParsedSriInvoice }
  | { ok: false; code: SriErrorCode; message: string; docType?: string };

export const MAX_XML_BYTES = 512 * 1024;

type SriFailure = Extract<SriParseResult, { ok: false }>;
type XmlNode = Record<string, unknown>;

const TEXT_KEY = '#text';
const CDATA_KEY = '#cdata';

const INVOICE_DOC_CODE = '01';

// Tipos de comprobante que el SRI define y que todavía no se importan.
const UNSUPPORTED_DOCS = new Map<string, { name: string; article: string }>([
  ['03', { name: 'liquidación de compra', article: 'una' }],
  ['04', { name: 'nota de crédito', article: 'una' }],
  ['05', { name: 'nota de débito', article: 'una' }],
  ['06', { name: 'guía de remisión', article: 'una' }],
  ['07', { name: 'comprobante de retención', article: 'un' }],
]);

const UNSUPPORTED_ROOTS = new Map<string, string>([
  ['liquidacionCompra', '03'],
  ['notaCredito', '04'],
  ['notaDebito', '05'],
  ['guiaRemision', '06'],
  ['comprobanteRetencion', '07'],
]);

// Envolturas por las que llega la constancia en la respuesta del servicio web del SRI.
const TRANSPORT_WRAPPERS = new Set(['Envelope', 'Body', 'autorizacionComprobanteResponse']);
const AUTHORIZATION_WRAPPERS = new Set(['RespuestaAutorizacionComprobante', 'autorizaciones']);

const VAT_TAX_CODE = '2';

// Tarifa por codigoPorcentaje. NO está confirmada contra la ficha técnica vigente del SRI:
// por eso siempre se contrasta con base y valor (ver resolveVatRate).
const VAT_RATE_BY_CODE = new Map<string, number | null>([
  ['0', 0],
  ['2', 12],
  ['3', 14],
  ['4', 15],
  ['5', 5],
  ['6', 0],
  ['7', 0],
  ['8', null],
  ['10', 13],
]);

const ICE_TAX_CODE = '3';
const OTHER_TAX_NAMES = new Map<string, string>([
  [ICE_TAX_CODE, 'ICE'],
  ['5', 'IRBPNR'],
]);

// Topes de los campos que se guardan o se muestran.
const MAX_TAX_ID_LENGTH = 20;
const MAX_NAME_LENGTH = 160;
const MAX_RATE_CODE_LENGTH = 4;
const MAX_VAT_LINES = 20;
const MAX_ECHOED_LENGTH = 40;

// Diferencia máxima, en centavos, entre base × tarifa y el valor del documento.
const VAT_TOLERANCE_CENTS = 2;
// Ecuador continental no tiene horario de verano; se usa si la fecha no trae zona.
const ECUADOR_OFFSET = '-05:00';
const MAX_INTEGER_DIGITS = 13;

const fail = (code: SriErrorCode, message: string, docType?: string): SriFailure =>
  docType === undefined ? { ok: false, code, message } : { ok: false, code, message, docType };

/** Acorta un valor del documento antes de repetirlo en un mensaje. */
const clip = (value: string): string =>
  value.length > MAX_ECHOED_LENGTH ? `${value.slice(0, MAX_ECHOED_LENGTH)}…` : value;

/** El SRI usa el código 2 para el IVA; se admite también escrito como 02. */
const normalizeTaxCode = (code: string): string => code.replace(/^0+(?=\d)/, '');

const isNode = (value: unknown): value is XmlNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const getChild = (node: unknown, key: string): unknown =>
  isNode(node) && Object.prototype.hasOwnProperty.call(node, key) ? node[key] : undefined;

/** Decodifica en una sola pasada las cinco entidades predefinidas y las numéricas. */
function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(
    /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g,
    (match, decimal?: string, hex?: string, name?: string) => {
      if (name) return named[name];
      const codePoint = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex as string, 16);
      const valid =
        codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
      return valid ? String.fromCodePoint(codePoint) : match;
    },
  );
}

/**
 * Texto de un nodo. El contenido normal se decodifica; el CDATA es literal y no se toca.
 * Un campo repetido se trata como ausente: no hay forma de saber cuál de los dos vale.
 */
function nodeText(node: unknown): string {
  if (typeof node === 'string') return decodeEntities(node);
  if (!isNode(node)) return '';
  const plain = getChild(node, TEXT_KEY);
  const cdata = asArray(getChild(node, CDATA_KEY)).filter((part) => typeof part === 'string');
  return (typeof plain === 'string' ? decodeEntities(plain) : '') + cdata.join('');
}

const fieldText = (node: unknown, key: string): string => nodeText(getChild(node, key)).trim();

type ReadDocument = { ok: true; rootName: string; root: unknown } | SriFailure;

/** Valida y parsea un documento XML sin expandir entidades. */
function readDocument(xml: string): ReadDocument {
  const clean = xml.replace(/^﻿+/, '').trim();
  if (!clean) return fail('INVALID_XML', 'El archivo está vacío.');
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(clean)) {
    return fail('INVALID_XML', 'El XML declara DOCTYPE o entidades; los comprobantes del SRI no los usan.');
  }
  if (XMLValidator.validate(clean) !== true) {
    return fail('INVALID_XML', 'El archivo no es un XML legible o está incompleto.');
  }
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    htmlEntities: false,
    removeNSPrefix: true,
    cdataPropName: CDATA_KEY,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  const parsed: unknown = parser.parse(clean);
  const rootNames = isNode(parsed) ? Object.keys(parsed) : [];
  if (rootNames.length !== 1) {
    return fail('INVALID_XML', 'El archivo no es un XML legible o está incompleto.');
  }
  return { ok: true, rootName: rootNames[0], root: (parsed as XmlNode)[rootNames[0]] };
}

/**
 * Busca las autorizaciones de una constancia, solo por las envolturas conocidas.
 * Devuelve null si el documento no es una constancia.
 */
function findAuthorizations(name: string, node: unknown): unknown[] | null {
  if (name === 'autorizacion') return asArray(node);
  const isAuthorizationWrapper = AUTHORIZATION_WRAPPERS.has(name);
  if (!isAuthorizationWrapper && !TRANSPORT_WRAPPERS.has(name)) return null;
  if (isNode(node)) {
    for (const key of Object.keys(node)) {
      const found = findAuthorizations(key, node[key]);
      if (found) return found;
    }
  }
  return isAuthorizationWrapper ? [] : null;
}

/** Pasa un monto decimal a centavos sin usar flotantes; redondea a la mitad hacia arriba. */
function toCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const integerPart = match[1].replace(/^0+(?=\d)/, '');
  if (integerPart.length > MAX_INTEGER_DIGITS) return null;
  const decimals = match[2] ?? '';
  const cents = Number(integerPart) * 100 + Number(decimals.slice(0, 2).padEnd(2, '0'));
  return decimals.length > 2 && decimals[2] >= '5' ? cents + 1 : cents;
}

const fromCents = (cents: number): number => cents / 100;
const money = (cents: number): string => (cents / 100).toFixed(2);

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Convierte dd/mm/aaaa a YYYY-MM-DD; null si el formato no cuadra o la fecha no existe. */
function toIsoDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const [, day, month, year] = match;
  if (!isRealDate(Number(year), Number(month), Number(day))) return null;
  return `${year}-${month}-${day}`;
}

/** Fecha de autorización a instante ISO (UTC). Sin zona declarada, se asume hora de Ecuador. */
function toIsoInstant(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  const local = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  let parts: { year: string; month: string; day: string; time: string[]; frac: string; zone: string };
  if (iso) {
    const zone = iso[8] ?? ECUADOR_OFFSET;
    parts = {
      year: iso[1],
      month: iso[2],
      day: iso[3],
      time: [iso[4], iso[5], iso[6]],
      frac: iso[7] ?? '',
      zone: zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone,
    };
  } else if (local) {
    parts = {
      year: local[3],
      month: local[2],
      day: local[1],
      time: [local[4], local[5], local[6]],
      frac: '',
      zone: ECUADOR_OFFSET,
    };
  } else {
    return null;
  }
  if (!isRealDate(Number(parts.year), Number(parts.month), Number(parts.day))) return null;
  if (Number(parts.time[0]) > 23 || Number(parts.time[1]) > 59 || Number(parts.time[2]) > 59) return null;
  const date = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.time.join(':')}${parts.frac}${parts.zone}`,
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Dígito verificador módulo 11 sobre los 48 primeros dígitos, con pesos 2..7 desde la derecha. */
function accessKeyCheckDigit(first48: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = first48.length - 1; i >= 0; i -= 1) {
    sum += Number(first48[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const result = 11 - (sum % 11);
  if (result === 11) return 0;
  return result === 10 ? 1 : result;
}

const isValidAccessKey = (key: string): boolean =>
  /^\d{49}$/.test(key) && accessKeyCheckDigit(key.slice(0, 48)) === Number(key[48]);

/**
 * Tarifa de una línea de IVA, en centésimas de punto porcentual (15 % = 1500).
 * Nunca altera el valor del documento: si la tarifa no cuadra, se deriva de valor/base.
 */
function resolveVatRate(
  rateCode: string,
  declaredRate: string,
  baseCents: number,
  vatCents: number,
  warnings: string[],
): number {
  const declared = toCents(declaredRate);
  const fromTable = VAT_RATE_BY_CODE.get(rateCode);
  const expected = declared ?? (typeof fromTable === 'number' ? fromTable * 100 : null);
  const derived = baseCents > 0 ? Math.round((vatCents * 10000) / baseCents) : 0;
  const percent = (hundredths: number) => `${hundredths / 100} %`;

  if (expected === null && fromTable === null) {
    warnings.push(
      `IVA diferenciado (código ${rateCode}): se dedujo ${percent(derived)} a partir de valor/base.`,
    );
    return derived;
  }
  if (expected === null) {
    warnings.push(
      `IVA con código de tarifa «${rateCode || 'sin código'}» desconocido: se dedujo ${percent(derived)} a partir de valor/base.`,
    );
    return derived;
  }
  const difference = Math.abs(baseCents * expected - vatCents * 10000);
  if (difference > VAT_TOLERANCE_CENTS * 10000) {
    warnings.push(
      `IVA con código «${rateCode}»: la base ${money(baseCents)} a ${percent(expected)} no da el valor ${money(vatCents)}; se dedujo ${percent(derived)} a partir de valor/base. Se respeta el valor del documento.`,
    );
    return derived;
  }
  return expected;
}

/** Monto opcional: ausente vale 0; presente pero inválido se anota como problema. */
function optionalAmount(node: unknown, key: string, label: string, problems: string[]): number {
  const raw = fieldText(node, key);
  if (!raw) return 0;
  const cents = toCents(raw);
  if (cents === null) {
    problems.push(`${label} (monto no válido)`);
    return 0;
  }
  return cents;
}

/** Monto obligatorio: ausente o inválido se anota como problema. */
function requiredAmount(node: unknown, key: string, label: string, problems: string[]): number {
  const raw = fieldText(node, key);
  if (!raw) {
    problems.push(label);
    return 0;
  }
  return optionalAmount(node, key, label, problems);
}

function describeUnsupported(docCode: string): SriFailure {
  const doc = UNSUPPORTED_DOCS.get(docCode);
  if (doc) {
    return fail(
      'UNSUPPORTED_DOC',
      `Este archivo es ${doc.article} ${doc.name} (código ${docCode}). Por ahora solo se importan facturas: este tipo de comprobante aún no se importa.`,
      doc.name,
    );
  }
  return fail(
    'UNSUPPORTED_DOC',
    `Este comprobante tiene el código de documento ${clip(docCode)}. Por ahora solo se importan facturas: este tipo de comprobante aún no se importa.`,
    `código ${clip(docCode)}`,
  );
}

interface Authorization {
  number: string;
  authorizedAt: string | null;
}

function buildInvoice(
  rootName: string,
  root: unknown,
  authorization: Authorization | null,
): SriParseResult {
  const rootDocCode = UNSUPPORTED_ROOTS.get(rootName);
  if (rootDocCode) return describeUnsupported(rootDocCode);
  if (rootName !== 'factura') {
    return fail('NOT_SRI', `El XML no es un comprobante del SRI (elemento raíz «${clip(rootName)}»).`);
  }

  const taxInfo = getChild(root, 'infoTributaria');
  if (!isNode(taxInfo)) {
    return fail('NOT_SRI', 'El XML no es un comprobante del SRI: no trae infoTributaria.');
  }

  const docCode = fieldText(taxInfo, 'codDoc') || INVOICE_DOC_CODE;
  if (docCode !== INVOICE_DOC_CODE) return describeUnsupported(docCode);

  const environment = fieldText(taxInfo, 'ambiente');
  const testEnvironmentFailure = () =>
    fail('TEST_ENVIRONMENT', 'Esta factura se emitió en ambiente de pruebas: no tiene validez tributaria.');
  if (environment === '1') return testEnvironmentFailure();

  const invoiceInfo = getChild(root, 'infoFactura');
  const problems: string[] = [];
  const requiredText = (node: unknown, key: string, maxLength?: number): string => {
    const value = fieldText(node, key);
    if (!value) problems.push(key);
    else if (maxLength !== undefined && value.length > maxLength) {
      problems.push(`${key} (máximo ${maxLength} caracteres)`);
    }
    return value;
  };
  const requiredDigits = (node: unknown, key: string, digits: number): string => {
    const value = requiredText(node, key);
    if (value && !new RegExp(`^\\d{${digits}}$`).test(value)) {
      problems.push(`${key} (debe tener ${digits} dígitos)`);
    }
    return value;
  };

  if (!isNode(invoiceInfo)) problems.push('infoFactura');
  const issuerTaxId = requiredText(taxInfo, 'ruc', MAX_TAX_ID_LENGTH);
  const issuerName = requiredText(taxInfo, 'razonSocial', MAX_NAME_LENGTH);
  const establishment = requiredDigits(taxInfo, 'estab', 3);
  const emissionPoint = requiredDigits(taxInfo, 'ptoEmi', 3);
  const sequential = requiredDigits(taxInfo, 'secuencial', 9);
  const buyerName = isNode(invoiceInfo) ? requiredText(invoiceInfo, 'razonSocialComprador', MAX_NAME_LENGTH) : '';
  const buyerTaxId = isNode(invoiceInfo) ? requiredText(invoiceInfo, 'identificacionComprador', MAX_TAX_ID_LENGTH) : '';

  let issueDate: string | null = null;
  let netCents = 0;
  let totalCents = 0;
  let discountCents = 0;
  let tipCents = 0;
  const warnings: string[] = [];
  const vatLines: SriVatLine[] = [];
  let vatCents = 0;
  let vatBasesCents = 0;
  let iceCents = 0;
  const otherTaxes = new Map<string, number>();

  if (isNode(invoiceInfo)) {
    const rawDate = requiredText(invoiceInfo, 'fechaEmision');
    issueDate = toIsoDate(rawDate);
    if (rawDate && !issueDate) problems.push('fechaEmision (fecha inexistente o mal escrita)');

    netCents = requiredAmount(invoiceInfo, 'totalSinImpuestos', 'totalSinImpuestos', problems);
    totalCents = requiredAmount(invoiceInfo, 'importeTotal', 'importeTotal', problems);
    discountCents = optionalAmount(invoiceInfo, 'totalDescuento', 'totalDescuento', problems);
    tipCents = optionalAmount(invoiceInfo, 'propina', 'propina', problems);

    const taxes = asArray(getChild(getChild(invoiceInfo, 'totalConImpuestos'), 'totalImpuesto'))
      .filter(isNode)
      .map((tax) => ({ tax, taxCode: normalizeTaxCode(fieldText(tax, 'codigo')) }));
    const vatLineCount = taxes.filter(({ taxCode }) => taxCode === VAT_TAX_CODE).length;
    if (vatLineCount === 0) {
      // Sin línea de IVA legible no se sabe el IVA: el total no puede pasar como "otros cargos".
      problems.push('totalConImpuestos (ninguna línea de IVA legible con código 2)');
    } else if (vatLineCount > MAX_VAT_LINES) {
      problems.push(`totalConImpuestos (más de ${MAX_VAT_LINES} líneas de IVA)`);
    }
    for (const { tax, taxCode } of vatLineCount > MAX_VAT_LINES ? [] : taxes) {
      const label = `totalImpuesto código ${clip(taxCode) || '?'}`;
      if (taxCode === VAT_TAX_CODE) {
        const problemsBefore = problems.length;
        const base = requiredAmount(tax, 'baseImponible', `${label}: baseImponible`, problems);
        const vat = requiredAmount(tax, 'valor', `${label}: valor`, problems);
        if (problems.length === problemsBefore && vat > base) {
          problems.push(
            `${label}: valores incoherentes (valor ${money(vat)} mayor que baseImponible ${money(base)})`,
          );
        }
        const rateCode = fieldText(tax, 'codigoPorcentaje');
        if (rateCode.length > MAX_RATE_CODE_LENGTH) {
          problems.push(`${label}: codigoPorcentaje (máximo ${MAX_RATE_CODE_LENGTH} caracteres)`);
        }
        const hundredths = resolveVatRate(rateCode, fieldText(tax, 'tarifa'), base, vat, warnings);
        vatLines.push({ rate: hundredths / 100, rateCode, base: fromCents(base), vat: fromCents(vat) });
        vatCents += vat;
        vatBasesCents += base;
      } else {
        optionalAmount(tax, 'baseImponible', `${label}: baseImponible`, problems);
        const value = optionalAmount(tax, 'valor', `${label}: valor`, problems);
        if (taxCode === ICE_TAX_CODE) iceCents += value;
        const name = OTHER_TAX_NAMES.get(taxCode) ?? (/^\d{1,4}$/.test(taxCode) ? `impuesto código ${taxCode}` : 'impuesto no identificado');
        otherTaxes.set(name, (otherTaxes.get(name) ?? 0) + value);
      }
    }
  }

  if (problems.length > 0) {
    return fail('MISSING_FIELDS', `Faltan datos o no son válidos: ${problems.join(', ')}.`);
  }

  const documentKey = fieldText(taxInfo, 'claveAcceso');
  const accessKey = documentKey || (/^\d{49}$/.test(authorization?.number ?? '') ? authorization!.number : '');
  if (!accessKey) {
    return fail('BAD_ACCESS_KEY', 'La factura no trae una clave de acceso de 49 dígitos.');
  }
  if (!isValidAccessKey(accessKey)) {
    return fail('BAD_ACCESS_KEY', 'La clave de acceso no tiene 49 dígitos o su dígito verificador es incorrecto.');
  }

  const [year, month, day] = (issueDate as string).split('-');
  const mismatches: string[] = [];
  if (accessKey.slice(0, 8) !== `${day}${month}${year}`) mismatches.push('fecha de emisión');
  if (accessKey.slice(8, 10) !== docCode) mismatches.push('tipo de comprobante');
  if (accessKey.slice(10, 23) !== issuerTaxId) mismatches.push('RUC del emisor');
  if (environment && accessKey[23] !== environment) mismatches.push('ambiente');
  if (accessKey.slice(24, 30) !== `${establishment}${emissionPoint}`) mismatches.push('establecimiento y punto de emisión');
  if (accessKey.slice(30, 39) !== sequential) mismatches.push('secuencial');
  if (mismatches.length > 0) {
    return fail('KEY_MISMATCH', `La clave de acceso no coincide con el documento en: ${mismatches.join(', ')}.`);
  }

  const effectiveEnvironment = environment || accessKey[23];
  if (effectiveEnvironment === '1') return testEnvironmentFailure();
  if (effectiveEnvironment !== '2') {
    warnings.push(`El ambiente «${clip(effectiveEnvironment)}» no es el de producción (2).`);
  }

  if (!authorization) {
    warnings.push('El archivo no trae constancia de autorización del SRI.');
  } else if (/^\d{49}$/.test(authorization.number) && authorization.number !== accessKey) {
    warnings.push('El número de autorización de la constancia no coincide con la clave de acceso de la factura.');
  }

  const currency = fieldText(invoiceInfo, 'moneda');
  if (currency && currency.toUpperCase() !== 'DOLAR') {
    warnings.push(`La moneda de la factura es «${clip(currency)}», no DOLAR.`);
  }

  // Con ICE, la base del IVA puede incluir el valor del ICE.
  if (vatBasesCents !== netCents && vatBasesCents !== netCents + iceCents) {
    warnings.push(
      `La suma de las bases de IVA (${money(vatBasesCents)}) no cuadra con el total sin impuestos (${money(netCents)}).`,
    );
  }

  const otherCents = totalCents - netCents - vatCents;
  if (otherCents !== 0) {
    const detected: string[] = [];
    if (tipCents > 0) detected.push(`propina ${money(tipCents)}`);
    for (const [name, value] of otherTaxes) {
      if (value > 0) detected.push(`${name} ${money(value)}`);
    }
    const detail = detected.length > 0 ? `Detectado: ${detected.join(', ')}.` : 'No se identificó el concepto.';
    warnings.push(
      otherCents > 0
        ? `El total incluye ${money(otherCents)} además del neto y el IVA. ${detail}`
        : `El total es ${money(-otherCents)} menor que el neto más el IVA. ${detail}`,
    );
  }

  const taxedRates = vatLines.filter((line) => line.base > 0).map((line) => line.rate);

  return {
    ok: true,
    invoice: {
      accessKey,
      issuerTaxId,
      issuerName,
      buyerTaxId,
      buyerName,
      number: `${establishment}-${emissionPoint}-${sequential}`,
      issueDate: issueDate as string,
      netAmount: fromCents(netCents),
      discount: fromCents(discountCents),
      vatAmount: fromCents(vatCents),
      vatRate: taxedRates.length > 0 ? Math.max(...taxedRates) : 0,
      vatLines,
      otherCharges: fromCents(otherCents),
      total: fromCents(totalCents),
      authorizedAt: authorization?.authorizedAt ?? null,
      warnings,
    },
  };
}

function parseDocument(content: string): SriParseResult {
  if (typeof content !== 'string') return fail('INVALID_XML', 'El archivo está vacío.');
  if (Buffer.byteLength(content, 'utf8') > MAX_XML_BYTES) {
    return fail('TOO_LARGE', `El archivo supera el máximo de ${MAX_XML_BYTES / 1024} KB.`);
  }

  const outer = readDocument(content);
  if (!outer.ok) return outer;

  const authorizations = findAuthorizations(outer.rootName, outer.root);
  if (!authorizations) return buildInvoice(outer.rootName, outer.root, null);

  const stateOf = (item: unknown) => fieldText(item, 'estado').toUpperCase();
  const authorized = authorizations.find((item) => stateOf(item) === 'AUTORIZADO');
  if (!authorized) {
    const state = authorizations.length > 0 ? fieldText(authorizations[0], 'estado') : '';
    return fail(
      'NOT_AUTHORIZED',
      state
        ? `El SRI no autorizó este comprobante: su estado es «${clip(state)}».`
        : 'La constancia no indica que el SRI haya autorizado este comprobante.',
    );
  }

  const voucher = fieldText(authorized, 'comprobante');
  if (!voucher) return fail('NOT_SRI', 'La constancia de autorización no trae el comprobante.');

  const inner = readDocument(voucher);
  if (!inner.ok) return inner;

  return buildInvoice(inner.rootName, inner.root, {
    number: fieldText(authorized, 'numeroAutorizacion'),
    authorizedAt: toIsoInstant(fieldText(authorized, 'fechaAutorizacion')),
  });
}

/** Lee un XML de factura del SRI. Nunca lanza excepción: devuelve el error tipado. */
export function parseSriXml(content: string): SriParseResult {
  try {
    return parseDocument(content);
  } catch {
    return fail('INVALID_XML', 'El archivo no es un XML legible o está incompleto.');
  }
}
