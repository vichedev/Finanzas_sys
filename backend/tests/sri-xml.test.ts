// Pruebas de comportamiento del lector de XML del SRI. Todos los datos son inventados.
// Uso (desde backend): npx tsx --test tests/sri-xml.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_XML_BYTES,
  parseSriXml,
  type ParsedSriInvoice,
  type SriErrorCode,
} from '../src/lib/sriXml';

interface Tax {
  codigo: string;
  codigoPorcentaje: string;
  base: string;
  valor: string;
  tarifa?: string;
}

interface InvoiceOptions {
  root: string;
  ambiente: string;
  razonSocial: string;
  ruc: string;
  codDoc: string;
  estab: string;
  ptoEmi: string;
  secuencial: string;
  fecha: string;
  comprador: string;
  identificacion: string;
  totalSinImpuestos: string;
  totalDescuento: string;
  propina: string;
  importeTotal: string;
  moneda: string;
  impuestos: Tax[];
  /** Si es undefined se genera una clave correcta; null omite la etiqueta. */
  clave: string | null | undefined;
}

const IVA_15: Tax = { codigo: '2', codigoPorcentaje: '4', base: '100.00', valor: '15.00', tarifa: '15' };

const DEFAULTS: InvoiceOptions = {
  root: 'factura',
  ambiente: '2',
  razonSocial: 'EMPRESA EJEMPLO S.A.',
  ruc: '1790000000001',
  codDoc: '01',
  estab: '001',
  ptoEmi: '002',
  secuencial: '000001234',
  fecha: '15/03/2026',
  comprador: 'CLIENTE EJEMPLO',
  identificacion: '0990000000001',
  totalSinImpuestos: '100.00',
  totalDescuento: '0.00',
  propina: '0.00',
  importeTotal: '115.00',
  moneda: 'DOLAR',
  impuestos: [IVA_15],
  clave: undefined,
};

function checkDigit(first48: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = 47; i >= 0; i -= 1) {
    sum += Number(first48[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const r = 11 - (sum % 11);
  if (r === 11) return 0;
  return r === 10 ? 1 : r;
}

/** Clave de 49 dígitos con verificador correcto para los datos dados. */
function buildKey(parts: Partial<InvoiceOptions> = {}): string {
  const o = { ...DEFAULTS, ...parts };
  const first48 =
    o.fecha.replaceAll('/', '') + o.codDoc + o.ruc + o.ambiente + o.estab + o.ptoEmi + o.secuencial + '12345678' + '1';
  return first48 + String(checkDigit(first48));
}

const tag = (name: string, value: string) => (value === '' ? '' : `<${name}>${value}</${name}>`);

function buildInvoice(overrides: Partial<InvoiceOptions> = {}): string {
  const o = { ...DEFAULTS, ...overrides };
  const key = o.clave === undefined ? buildKey(o) : o.clave;
  const taxes = o.impuestos
    .map(
      (t) =>
        `<totalImpuesto>${tag('codigo', t.codigo)}${tag('codigoPorcentaje', t.codigoPorcentaje)}` +
        `${tag('baseImponible', t.base)}${t.tarifa === undefined ? '' : tag('tarifa', t.tarifa)}${tag('valor', t.valor)}</totalImpuesto>`,
    )
    .join('');
  return (
    `<${o.root} id="comprobante" version="1.1.0"><infoTributaria>${tag('ambiente', o.ambiente)}` +
    `${tag('razonSocial', o.razonSocial)}${tag('ruc', o.ruc)}${key === null ? '' : tag('claveAcceso', key)}` +
    `${tag('codDoc', o.codDoc)}${tag('estab', o.estab)}${tag('ptoEmi', o.ptoEmi)}${tag('secuencial', o.secuencial)}` +
    `</infoTributaria><infoFactura>${tag('fechaEmision', o.fecha)}${tag('razonSocialComprador', o.comprador)}` +
    `${tag('identificacionComprador', o.identificacion)}${tag('totalSinImpuestos', o.totalSinImpuestos)}` +
    `${tag('totalDescuento', o.totalDescuento)}<totalConImpuestos>${taxes}</totalConImpuestos>` +
    `${tag('propina', o.propina)}${tag('importeTotal', o.importeTotal)}${tag('moneda', o.moneda)}</infoFactura></${o.root}>`
  );
}

const escapeXml = (xml: string) =>
  xml.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function buildAuthorization(comprobante: string, extra: { estado?: string; numero?: string; fecha?: string } = {}) {
  return (
    `<autorizacion><estado>${extra.estado ?? 'AUTORIZADO'}</estado>` +
    `<numeroAutorizacion>${extra.numero ?? buildKey()}</numeroAutorizacion>` +
    `<fechaAutorizacion>${extra.fecha ?? '2026-03-15T10:20:30-05:00'}</fechaAutorizacion>` +
    `<ambiente>PRODUCCION</ambiente><comprobante>${comprobante}</comprobante></autorizacion>`
  );
}

const cdata = (xml: string) => `<![CDATA[<?xml version="1.0" encoding="UTF-8"?>\n${xml}]]>`;

function parseOk(xml: string): ParsedSriInvoice {
  const result = parseSriXml(xml);
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error('inalcanzable');
  return result.invoice;
}

function assertError(xml: string, code: SriErrorCode, messagePattern?: RegExp) {
  const result = parseSriXml(xml);
  assert.equal(result.ok, false, 'se esperaba un error');
  if (result.ok) return undefined;
  assert.equal(result.code, code, result.message);
  assert.ok(result.message.length > 0);
  if (messagePattern) assert.match(result.message, messagePattern);
  return result;
}

const hasWarning = (invoice: ParsedSriInvoice, pattern: RegExp) =>
  invoice.warnings.some((warning) => pattern.test(warning));

// ---------- Formatos de entrada ----------

test('factura directa: lee los datos principales', () => {
  const invoice = parseOk(buildInvoice());
  assert.equal(invoice.issuerTaxId, '1790000000001');
  assert.equal(invoice.issuerName, 'EMPRESA EJEMPLO S.A.');
  assert.equal(invoice.buyerTaxId, '0990000000001');
  assert.equal(invoice.buyerName, 'CLIENTE EJEMPLO');
  assert.equal(invoice.number, '001-002-000001234');
  assert.equal(invoice.issueDate, '2026-03-15');
  assert.equal(invoice.netAmount, 100);
  assert.equal(invoice.vatAmount, 15);
  assert.equal(invoice.vatRate, 15);
  assert.equal(invoice.total, 115);
  assert.equal(invoice.otherCharges, 0);
  assert.equal(invoice.accessKey, buildKey());
  assert.equal(invoice.authorizedAt, null);
});

test('factura directa: avisa que no trae constancia de autorización', () => {
  assert.ok(hasWarning(parseOk(buildInvoice()), /no trae constancia de autorización/));
});

test('factura con estructura completa (detalles, firma, namespaces) se lee completa', () => {
  const template = readFileSync(join(__dirname, 'fixtures', 'sri', 'factura-completa.xml'), 'utf8');
  const key = buildKey({ ptoEmi: '002', secuencial: '000001234', fecha: '15/03/2026' });
  const invoice = parseOk(template.replace('{{CLAVE}}', key));
  assert.equal(invoice.accessKey, key);
  assert.equal(invoice.netAmount, 150);
  assert.equal(invoice.vatAmount, 15);
  assert.equal(invoice.total, 165);
  assert.equal(invoice.discount, 5);
  assert.equal(invoice.vatLines.length, 2);
  assert.deepEqual(invoice.warnings, ['El archivo no trae constancia de autorización del SRI.']);
});

test('quita el BOM inicial', () => {
  assert.equal(parseOk(`﻿${buildInvoice()}`).number, '001-002-000001234');
});

test('constancia con CDATA: lee la factura interior y la fecha de autorización', () => {
  const invoice = parseOk(buildAuthorization(cdata(buildInvoice())));
  assert.equal(invoice.number, '001-002-000001234');
  assert.equal(invoice.authorizedAt, '2026-03-15T15:20:30.000Z');
  assert.equal(hasWarning(invoice, /constancia/), false);
});

test('constancia con el XML interior como texto escapado', () => {
  const invoice = parseOk(buildAuthorization(escapeXml(buildInvoice({ razonSocial: 'A &amp; B' }))));
  assert.equal(invoice.total, 115);
  assert.equal(invoice.issuerName, 'A & B');
});

test('el CDATA es literal: una entidad dentro del CDATA de un campo no se decodifica', () => {
  const invoice = parseOk(buildInvoice({ razonSocial: '<![CDATA[A &amp; B & C]]>' }));
  assert.equal(invoice.issuerName, 'A &amp; B & C');
});

test('constancia dentro de RespuestaAutorizacionComprobante/autorizaciones', () => {
  const xml =
    `<RespuestaAutorizacionComprobante><claveAccesoConsultada>${buildKey()}</claveAccesoConsultada>` +
    `<numeroComprobantes>1</numeroComprobantes><autorizaciones>${buildAuthorization(cdata(buildInvoice()))}` +
    '</autorizaciones></RespuestaAutorizacionComprobante>';
  assert.equal(parseOk(xml).number, '001-002-000001234');
});

test('constancia con prefijos de namespace', () => {
  const xml =
    `<ns2:autorizacion xmlns:ns2="http://ejemplo.invalid/sri"><ns2:estado>AUTORIZADO</ns2:estado>` +
    `<ns2:numeroAutorizacion>${buildKey()}</ns2:numeroAutorizacion>` +
    `<ns2:fechaAutorizacion>2026-03-15T10:20:30-05:00</ns2:fechaAutorizacion>` +
    `<ns2:comprobante>${cdata(buildInvoice())}</ns2:comprobante></ns2:autorizacion>`;
  const invoice = parseOk(xml);
  assert.equal(invoice.total, 115);
  assert.equal(invoice.authorizedAt, '2026-03-15T15:20:30.000Z');
});

test('constancia dentro de un sobre SOAP con namespaces', () => {
  const xml =
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
    '<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ejemplo.invalid/sri">' +
    `<RespuestaAutorizacionComprobante><autorizaciones>${buildAuthorization(cdata(buildInvoice()))}` +
    '</autorizaciones></RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>' +
    '</soap:Body></soap:Envelope>';
  assert.equal(parseOk(xml).total, 115);
});

test('con varias autorizaciones, usa la que está AUTORIZADO', () => {
  const rejected = buildAuthorization('', { estado: 'NO AUTORIZADO' });
  const xml = `<autorizaciones>${rejected}${buildAuthorization(cdata(buildInvoice()))}</autorizaciones>`;
  assert.equal(parseOk(xml).total, 115);
});

test('fechaAutorizacion con atributo se lee igual', () => {
  const xml = buildAuthorization(cdata(buildInvoice())).replace('<fechaAutorizacion>', '<fechaAutorizacion class="fechaAutorizacion">');
  assert.equal(parseOk(xml).authorizedAt, '2026-03-15T15:20:30.000Z');
});

test('fechaAutorizacion sin zona se toma como hora de Ecuador', () => {
  const invoice = parseOk(buildAuthorization(cdata(buildInvoice()), { fecha: '15/03/2026 10:20:30' }));
  assert.equal(invoice.authorizedAt, '2026-03-15T15:20:30.000Z');
});

test('fechaAutorizacion no válida o inexistente queda en null, sin error', () => {
  assert.equal(parseOk(buildAuthorization(cdata(buildInvoice()), { fecha: 'ayer' })).authorizedAt, null);
  assert.equal(parseOk(buildAuthorization(cdata(buildInvoice()), { fecha: '2026-02-31T10:00:00-05:00' })).authorizedAt, null);
});

test('avisa si el número de autorización de 49 dígitos difiere de la clave', () => {
  const otherNumber = buildKey({ secuencial: '000009999' });
  const invoice = parseOk(buildAuthorization(cdata(buildInvoice()), { numero: otherNumber }));
  assert.ok(hasWarning(invoice, /número de autorización .* no coincide/));
});

// ---------- IVA y dinero ----------

test('dos tarifas (0 % + 15 %): IVA exacto, tarifa mayor y una línea por tarifa', () => {
  const invoice = parseOk(
    buildInvoice({
      totalSinImpuestos: '150.00',
      importeTotal: '165.00',
      impuestos: [{ codigo: '2', codigoPorcentaje: '0', base: '50.00', valor: '0.00' }, IVA_15],
    }),
  );
  assert.equal(invoice.vatAmount, 15);
  assert.equal(invoice.vatRate, 15);
  assert.deepEqual(invoice.vatLines, [
    { rate: 0, rateCode: '0', base: 50, vat: 0 },
    { rate: 15, rateCode: '4', base: 100, vat: 15 },
  ]);
  assert.equal(invoice.otherCharges, 0);
});

test('un solo totalImpuesto (objeto, no arreglo) produce una línea', () => {
  const invoice = parseOk(buildInvoice());
  assert.deepEqual(invoice.vatLines, [{ rate: 15, rateCode: '4', base: 100, vat: 15 }]);
});

test('solo tarifa 0 %: vatRate 0', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '100.00',
      impuestos: [{ codigo: '2', codigoPorcentaje: '0', base: '100.00', valor: '0.00' }],
    }),
  );
  assert.equal(invoice.vatRate, 0);
  assert.equal(invoice.vatAmount, 0);
});

test('la tarifa mayor ignora líneas con base 0', () => {
  const invoice = parseOk(
    buildInvoice({
      impuestos: [IVA_15, { codigo: '2', codigoPorcentaje: '99', tarifa: '20', base: '0.00', valor: '0.00' }],
    }),
  );
  assert.equal(invoice.vatRate, 15);
});

test('sin tarifa explícita, la deriva del código', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '105.00',
      impuestos: [{ codigo: '2', codigoPorcentaje: '5', base: '100.00', valor: '5.00' }],
    }),
  );
  assert.equal(invoice.vatLines[0].rate, 5);
  assert.equal(hasWarning(invoice, /IVA con código/), false);
});

test('propina: no suma a IVA, sí a otherCharges, y el aviso la nombra', () => {
  const invoice = parseOk(buildInvoice({ propina: '10.00', importeTotal: '125.00' }));
  assert.equal(invoice.vatAmount, 15);
  assert.equal(invoice.otherCharges, 10);
  assert.ok(hasWarning(invoice, /propina 10\.00/));
});

test('ICE: no va a vatLines ni a vatAmount, sí a otherCharges, y el aviso lo nombra', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '135.00',
      impuestos: [IVA_15, { codigo: '3', codigoPorcentaje: '3051', base: '100.00', valor: '20.00' }],
    }),
  );
  assert.equal(invoice.vatAmount, 15);
  assert.equal(invoice.vatLines.length, 1);
  assert.equal(invoice.otherCharges, 20);
  assert.ok(hasWarning(invoice, /ICE 20\.00/));
});

test('IRBPNR no cuenta como IVA y el aviso lo nombra', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '115.02',
      impuestos: [IVA_15, { codigo: '5', codigoPorcentaje: '5001', base: '2.00', valor: '0.02' }],
    }),
  );
  assert.equal(invoice.vatAmount, 15);
  assert.equal(invoice.otherCharges, 0.02);
  assert.ok(hasWarning(invoice, /IRBPNR 0\.02/));
});

test('otherCharges negativo también avisa', () => {
  const invoice = parseOk(buildInvoice({ importeTotal: '110.00' }));
  assert.equal(invoice.otherCharges, -5);
  assert.ok(hasWarning(invoice, /5\.00 menor/));
});

test('descuento: se informa y no altera el cálculo de otherCharges', () => {
  const invoice = parseOk(buildInvoice({ totalDescuento: '12.34' }));
  assert.equal(invoice.discount, 12.34);
  assert.equal(invoice.otherCharges, 0);
});

test('sin totalDescuento ni propina valen 0', () => {
  const invoice = parseOk(buildInvoice({ totalDescuento: '', propina: '' }));
  assert.equal(invoice.discount, 0);
  assert.equal(invoice.otherCharges, 0);
});

test('sumas tipo 0.1 + 0.2 no arrastran error de flotante', () => {
  const invoice = parseOk(
    buildInvoice({
      totalSinImpuestos: '0.30',
      importeTotal: '0.60',
      impuestos: [
        { codigo: '2', codigoPorcentaje: '99', tarifa: '100', base: '0.10', valor: '0.10' },
        { codigo: '2', codigoPorcentaje: '98', tarifa: '100', base: '0.20', valor: '0.20' },
      ],
    }),
  );
  assert.equal(invoice.vatAmount, 0.3);
  assert.equal(invoice.otherCharges, 0);
  assert.equal(hasWarning(invoice, /bases/), false);
});

test('valores con más de 2 decimales se redondean a centavos', () => {
  const invoice = parseOk(
    buildInvoice({
      totalSinImpuestos: '100.005',
      importeTotal: '115.014',
      impuestos: [{ codigo: '2', codigoPorcentaje: '4', base: '100.005', valor: '15.0049', tarifa: '15' }],
    }),
  );
  assert.equal(invoice.netAmount, 100.01);
  assert.equal(invoice.vatAmount, 15);
  assert.equal(invoice.total, 115.01);
  assert.equal(invoice.otherCharges, 0);
});

test('código de tarifa desconocido: deriva de valor/base, avisa y conserva el valor', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '118.00',
      impuestos: [{ codigo: '2', codigoPorcentaje: '77', base: '100.00', valor: '18.00' }],
    }),
  );
  assert.deepEqual(invoice.vatLines, [{ rate: 18, rateCode: '77', base: 100, vat: 18 }]);
  assert.ok(hasWarning(invoice, /«77» desconocido/));
});

test('código 8: deriva de valor/base y el aviso dice IVA diferenciado, no desconocido', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '108.00',
      impuestos: [{ codigo: '2', codigoPorcentaje: '8', base: '100.00', valor: '8.00' }],
    }),
  );
  assert.equal(invoice.vatLines[0].rate, 8);
  assert.ok(hasWarning(invoice, /IVA diferenciado/));
  assert.equal(hasWarning(invoice, /desconocido/), false);
});

test('base × tarifa difiere más de 0,02 del valor: deriva, avisa y el valor no cambia', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '112.00',
      impuestos: [{ codigo: '2', codigoPorcentaje: '4', base: '100.00', valor: '12.00' }],
    }),
  );
  assert.equal(invoice.vatLines[0].rate, 12);
  assert.equal(invoice.vatLines[0].vat, 12);
  assert.equal(invoice.vatAmount, 12);
  assert.ok(hasWarning(invoice, /no da el valor 12\.00/));
});

test('una diferencia de hasta 0,02 entre base × tarifa y valor se tolera sin aviso', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '115.02',
      impuestos: [{ codigo: '2', codigoPorcentaje: '4', base: '100.00', valor: '15.02' }],
    }),
  );
  assert.equal(invoice.vatLines[0].rate, 15);
  assert.equal(invoice.vatLines[0].vat, 15.02);
  assert.equal(hasWarning(invoice, /IVA con código/), false);
});

test('bases que no cuadran con totalSinImpuestos: aviso, no error', () => {
  const invoice = parseOk(buildInvoice({ totalSinImpuestos: '90.00', importeTotal: '105.00' }));
  assert.equal(invoice.netAmount, 90);
  assert.ok(hasWarning(invoice, /bases .* no cuadra/));
});

test('moneda distinta de DOLAR: aviso', () => {
  assert.ok(hasWarning(parseOk(buildInvoice({ moneda: 'EURO' })), /moneda .*EURO/));
});

test('una factura normal con DOLAR no genera aviso de moneda', () => {
  assert.equal(hasWarning(parseOk(buildInvoice()), /moneda/), false);
});

// ---------- Textos e identificaciones ----------

test('conserva ceros a la izquierda en RUC, comprador y secuencial', () => {
  const invoice = parseOk(
    buildInvoice({ ruc: '0190000000001', identificacion: '0102030405', estab: '001', ptoEmi: '001', secuencial: '000000007' }),
  );
  assert.equal(invoice.issuerTaxId, '0190000000001');
  assert.equal(invoice.buyerTaxId, '0102030405');
  assert.equal(invoice.number, '001-001-000000007');
});

test('decodifica &amp; en la razón social', () => {
  assert.equal(parseOk(buildInvoice({ razonSocial: 'FERRETERIA &amp; CIA' })).issuerName, 'FERRETERIA & CIA');
});

test('decodifica las cinco entidades y las numéricas, en una sola pasada', () => {
  const invoice = parseOk(
    buildInvoice({ comprador: '&lt;A&gt; &quot;B&quot; &apos;C&apos; &#209;&#xD1; &amp;lt; &nope;' }),
  );
  assert.equal(invoice.buyerName, `<A> "B" 'C' ÑÑ &lt; &nope;`);
});

test('una entidad numérica fuera de rango se deja como está y no lanza', () => {
  assert.equal(parseOk(buildInvoice({ comprador: 'A&#9999999;' })).buyerName, 'A&#9999999;');
});

test('recorta espacios en nombres e identificaciones', () => {
  const invoice = parseOk(buildInvoice({ comprador: '  CLIENTE EJEMPLO  ', identificacion: ' 0990000000001 ' }));
  assert.equal(invoice.buyerName, 'CLIENTE EJEMPLO');
  assert.equal(invoice.buyerTaxId, '0990000000001');
});

test('consumidor final 9999999999999 es válido', () => {
  const invoice = parseOk(buildInvoice({ comprador: 'CONSUMIDOR FINAL', identificacion: '9999999999999' }));
  assert.equal(invoice.buyerTaxId, '9999999999999');
  assert.equal(invoice.buyerName, 'CONSUMIDOR FINAL');
});

// ---------- Errores: documentos no admitidos ----------

const UNSUPPORTED_CASES: Array<[string, string, string]> = [
  ['04', 'notaCredito', 'nota de crédito'],
  ['05', 'notaDebito', 'nota de débito'],
  ['06', 'guiaRemision', 'guía de remisión'],
  ['07', 'comprobanteRetencion', 'comprobante de retención'],
  ['03', 'liquidacionCompra', 'liquidación de compra'],
];

for (const [codDoc, root, name] of UNSUPPORTED_CASES) {
  test(`${name}: UNSUPPORTED_DOC por raíz, con docType y mensaje claro`, () => {
    const result = assertError(buildInvoice({ root, codDoc }), 'UNSUPPORTED_DOC', new RegExp(`${name}.*aún no se importa`));
    assert.equal(result?.docType, name);
  });

  test(`${name}: UNSUPPORTED_DOC por codDoc ${codDoc} aunque la raíz sea factura`, () => {
    const result = assertError(buildInvoice({ codDoc }), 'UNSUPPORTED_DOC');
    assert.equal(result?.docType, name);
  });
}

test('nota de crédito sin infoTributaria también se reconoce por la raíz', () => {
  const result = assertError('<notaCredito></notaCredito>', 'UNSUPPORTED_DOC');
  assert.equal(result?.docType, 'nota de crédito');
});

test('nota de crédito dentro de una constancia autorizada: UNSUPPORTED_DOC', () => {
  const xml = buildAuthorization(cdata(buildInvoice({ root: 'notaCredito', codDoc: '04' })));
  assert.equal(assertError(xml, 'UNSUPPORTED_DOC')?.docType, 'nota de crédito');
});

test('código de documento desconocido: UNSUPPORTED_DOC', () => {
  assertError(buildInvoice({ codDoc: '99' }), 'UNSUPPORTED_DOC', /99/);
});

// ---------- Errores: NOT_SRI e INVALID_XML ----------

test('raíz desconocida: NOT_SRI', () => {
  assertError('<pedido><total>1</total></pedido>', 'NOT_SRI');
});

test('factura envuelta en una raíz desconocida: NOT_SRI', () => {
  assertError(`<lote>${buildInvoice()}</lote>`, 'NOT_SRI');
});

test('factura sin infoTributaria: NOT_SRI', () => {
  assertError('<factura><infoFactura></infoFactura></factura>', 'NOT_SRI');
});

test('un sobre SOAP sin constancia: NOT_SRI', () => {
  assertError('<soap:Envelope xmlns:soap="http://x.invalid"><soap:Body><otra/></soap:Body></soap:Envelope>', 'NOT_SRI');
});

test('constancia autorizada sin comprobante: NOT_SRI', () => {
  assertError('<autorizacion><estado>AUTORIZADO</estado></autorizacion>', 'NOT_SRI');
});

test('constancia cuyo interior es otra constancia: no se recursa, NOT_SRI', () => {
  const nested = buildAuthorization(cdata(buildInvoice()));
  assertError(buildAuthorization(escapeXml(nested)), 'NOT_SRI');
});

for (const [name, input] of [
  ['entrada vacía', ''],
  ['solo espacios', '   \n '],
  ['solo BOM', '﻿'],
  ['texto plano', 'esto no es xml'],
  ['XML truncado', buildInvoice().slice(0, 120)],
  ['etiquetas mal cerradas', '<factura><a></b></factura>'],
  ['texto después de la raíz', `${buildInvoice()} basura`],
  ['dos raíces', '<factura></factura><factura></factura>'],
  ['solo la declaración', '<?xml version="1.0"?>'],
] as const) {
  test(`${name}: INVALID_XML sin lanzar`, () => {
    assert.doesNotThrow(() => parseSriXml(input));
    assertError(input, 'INVALID_XML');
  });
}

test('comprobante interior ilegible: INVALID_XML', () => {
  assertError(buildAuthorization('<![CDATA[<factura><infoTributaria>]]>'), 'INVALID_XML');
});

test('una entrada que no es texto no lanza: INVALID_XML', () => {
  for (const input of [null, undefined, 42, {}]) {
    assertError(input as unknown as string, 'INVALID_XML');
  }
});

test('etiquetas hostiles (__proto__, constructor) no contaminan ni lanzan', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const result = parseSriXml(`<${name}><infoTributaria>x</infoTributaria></${name}>`);
    assert.equal(result.ok, false);
  }
  const inside = parseSriXml(`<factura><__proto__><polluted>1</polluted></__proto__></factura>`);
  assert.equal(inside.ok, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('anidamiento muy profundo no lanza', () => {
  const depth = 20000;
  const xml = `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;
  assert.doesNotThrow(() => parseSriXml(xml));
  assert.equal(parseSriXml(xml).ok, false);
});

// ---------- Seguridad: tamaño y DOCTYPE ----------

test('XML enorme: TOO_LARGE', () => {
  const huge = `<factura>${'x'.repeat(MAX_XML_BYTES)}</factura>`;
  assertError(huge, 'TOO_LARGE');
});

test('el límite se mide en bytes, no en caracteres', () => {
  const content = 'ñ'.repeat(Math.floor(MAX_XML_BYTES / 2) + 1);
  assert.ok(content.length < MAX_XML_BYTES);
  assertError(content, 'TOO_LARGE');
});

test('DOCTYPE con entidad: rechazado sin expandir', () => {
  const xml =
    '<?xml version="1.0"?><!DOCTYPE factura [<!ENTITY a "EXPANDIDA">]>' +
    buildInvoice({ razonSocial: '&a;' });
  const result = assertError(xml, 'INVALID_XML', /DOCTYPE/);
  assert.equal(JSON.stringify(result).includes('EXPANDIDA'), false);
});

test('bomba de entidades con DOCTYPE: rechazada', () => {
  const xml =
    '<!DOCTYPE b [<!ENTITY a "aaaaaaaaaa"><!ENTITY c "&a;&a;&a;&a;&a;&a;&a;&a;">]><factura>&c;</factura>';
  assertError(xml, 'INVALID_XML');
});

test('DOCTYPE oculto en el comprobante interior escapado: rechazado', () => {
  const inner = `<!DOCTYPE factura [<!ENTITY a "x">]>${buildInvoice()}`;
  assertError(buildAuthorization(escapeXml(inner)), 'INVALID_XML', /DOCTYPE/);
});

test('entidad sin declarar en un campo no se expande ni rompe el documento', () => {
  assert.equal(parseOk(buildInvoice({ comprador: 'A&nbsp;B' })).buyerName, 'A&nbsp;B');
});

// ---------- Errores: autorización y ambiente ----------

test('estado NO AUTORIZADO: NOT_AUTHORIZED, nombra el estado', () => {
  assertError(buildAuthorization(cdata(buildInvoice()), { estado: 'NO AUTORIZADO' }), 'NOT_AUTHORIZED', /NO AUTORIZADO/);
});

test('estado EN PROCESO: NOT_AUTHORIZED', () => {
  assertError(buildAuthorization(cdata(buildInvoice()), { estado: 'EN PROCESO' }), 'NOT_AUTHORIZED');
});

test('constancia sin estado: NOT_AUTHORIZED', () => {
  assertError(`<autorizacion><comprobante>${cdata(buildInvoice())}</comprobante></autorizacion>`, 'NOT_AUTHORIZED');
});

test('respuesta del SRI sin ninguna autorización: NOT_AUTHORIZED', () => {
  assertError(
    '<RespuestaAutorizacionComprobante><numeroComprobantes>0</numeroComprobantes><autorizaciones/></RespuestaAutorizacionComprobante>',
    'NOT_AUTHORIZED',
  );
});

test('ambiente 1: TEST_ENVIRONMENT', () => {
  assertError(buildInvoice({ ambiente: '1' }), 'TEST_ENVIRONMENT');
});

test('ambiente 1 dentro de constancia autorizada: TEST_ENVIRONMENT', () => {
  assertError(buildAuthorization(cdata(buildInvoice({ ambiente: '1' }))), 'TEST_ENVIRONMENT');
});

test('sin etiqueta ambiente, se toma de la clave: si es 1, TEST_ENVIRONMENT', () => {
  const key = buildKey({ ambiente: '1' });
  assertError(buildInvoice({ ambiente: '', clave: key }), 'TEST_ENVIRONMENT');
});

// ---------- Errores: clave de acceso ----------

function withWrongCheckDigit(key: string): string {
  return key.slice(0, 48) + String((Number(key[48]) + 1) % 10);
}

test('dígito verificador incorrecto: BAD_ACCESS_KEY', () => {
  assertError(buildInvoice({ clave: withWrongCheckDigit(buildKey()) }), 'BAD_ACCESS_KEY');
});

test('clave sin 49 dígitos: BAD_ACCESS_KEY', () => {
  assertError(buildInvoice({ clave: buildKey().slice(0, 48) }), 'BAD_ACCESS_KEY');
});

test('clave con letras: BAD_ACCESS_KEY', () => {
  assertError(buildInvoice({ clave: `A${buildKey().slice(1)}` }), 'BAD_ACCESS_KEY');
});

test('sin claveAcceso ni constancia: BAD_ACCESS_KEY', () => {
  assertError(buildInvoice({ clave: null }), 'BAD_ACCESS_KEY');
});

test('sin claveAcceso, usa numeroAutorizacion si tiene 49 dígitos', () => {
  const invoice = parseOk(buildAuthorization(cdata(buildInvoice({ clave: null }))));
  assert.equal(invoice.accessKey, buildKey());
});

test('sin claveAcceso y numeroAutorizacion corto: BAD_ACCESS_KEY', () => {
  assertError(buildAuthorization(cdata(buildInvoice({ clave: null })), { numero: '1234567890' }), 'BAD_ACCESS_KEY');
});

test('verificador: r = 11 se vuelve 0 y r = 10 se vuelve 1', () => {
  const seen = new Set<number>();
  for (let i = 1; i <= 2000 && seen.size < 11; i += 1) {
    const secuencial = String(i).padStart(9, '0');
    const key = buildKey({ secuencial });
    const first48 = key.slice(0, 48);
    let sum = 0;
    let weight = 2;
    for (let p = 47; p >= 0; p -= 1) {
      sum += Number(first48[p]) * weight;
      weight = weight === 7 ? 2 : weight + 1;
    }
    const raw = 11 - (sum % 11);
    seen.add(raw);
    if (raw === 10 || raw === 11) {
      assert.equal(key[48], raw === 11 ? '0' : '1');
      assert.equal(parseOk(buildInvoice({ secuencial })).accessKey, key);
    }
  }
  assert.ok(seen.has(10) && seen.has(11), 'la muestra debe cubrir ambos casos');
});

const MISMATCH_CASES: Array<[string, Partial<InvoiceOptions>, RegExp]> = [
  ['RUC', { ruc: '1790000000002' }, /RUC/],
  ['fecha', { fecha: '16/03/2026' }, /fecha/],
  ['secuencial', { secuencial: '000000001' }, /secuencial/],
  ['establecimiento', { estab: '009' }, /establecimiento/],
  ['punto de emisión', { ptoEmi: '009' }, /punto de emisión/],
];

for (const [name, change, pattern] of MISMATCH_CASES) {
  test(`clave que no coincide en ${name}: KEY_MISMATCH`, () => {
    assertError(buildInvoice({ ...change, clave: buildKey() }), 'KEY_MISMATCH', pattern);
  });
}

test('clave generada con otro tipo de documento: KEY_MISMATCH', () => {
  assertError(buildInvoice({ clave: buildKey({ codDoc: '04' }) }), 'KEY_MISMATCH', /tipo de comprobante/);
});

test('clave generada con otro ambiente: KEY_MISMATCH', () => {
  assertError(buildInvoice({ clave: buildKey({ ambiente: '1' }) }), 'KEY_MISMATCH', /ambiente/);
});

// ---------- Errores: campos ----------

const MISSING_CASES: Array<[keyof InvoiceOptions, string]> = [
  ['ruc', 'ruc'],
  ['razonSocial', 'razonSocial'],
  ['comprador', 'razonSocialComprador'],
  ['identificacion', 'identificacionComprador'],
  ['fecha', 'fechaEmision'],
  ['totalSinImpuestos', 'totalSinImpuestos'],
  ['importeTotal', 'importeTotal'],
  ['secuencial', 'secuencial'],
];

for (const [option, field] of MISSING_CASES) {
  test(`falta ${field}: MISSING_FIELDS, indica cuál`, () => {
    assertError(buildInvoice({ [option]: '', clave: buildKey() }), 'MISSING_FIELDS', new RegExp(field));
  });
}

test('sin infoFactura: MISSING_FIELDS', () => {
  const xml = buildInvoice().replace(/<infoFactura>.*<\/infoFactura>/, '');
  assertError(xml, 'MISSING_FIELDS', /infoFactura/);
});

test('fecha inexistente (31/02): MISSING_FIELDS', () => {
  assertError(buildInvoice({ fecha: '31/02/2026', clave: buildKey() }), 'MISSING_FIELDS', /fechaEmision/);
});

test('fecha con otro formato: MISSING_FIELDS', () => {
  assertError(buildInvoice({ fecha: '2026-03-15', clave: buildKey() }), 'MISSING_FIELDS', /fechaEmision/);
});

test('29 de febrero en año bisiesto es válido', () => {
  assert.equal(parseOk(buildInvoice({ fecha: '29/02/2028' })).issueDate, '2028-02-29');
});

test('monto no numérico: MISSING_FIELDS', () => {
  assertError(buildInvoice({ importeTotal: 'abc' }), 'MISSING_FIELDS', /importeTotal/);
});

test('monto con coma decimal: MISSING_FIELDS', () => {
  assertError(buildInvoice({ totalSinImpuestos: '100,00' }), 'MISSING_FIELDS', /totalSinImpuestos/);
});

test('monto negativo: MISSING_FIELDS', () => {
  assertError(buildInvoice({ importeTotal: '-115.00' }), 'MISSING_FIELDS', /importeTotal/);
});

test('valor de IVA negativo: MISSING_FIELDS', () => {
  assertError(
    buildInvoice({ impuestos: [{ codigo: '2', codigoPorcentaje: '4', base: '100.00', valor: '-15.00' }] }),
    'MISSING_FIELDS',
    /valor/,
  );
});

test('línea de IVA sin base: MISSING_FIELDS', () => {
  assertError(
    buildInvoice({ impuestos: [{ codigo: '2', codigoPorcentaje: '4', base: '', valor: '15.00' }] }),
    'MISSING_FIELDS',
    /baseImponible/,
  );
});

test('totalDescuento no numérico: MISSING_FIELDS', () => {
  assertError(buildInvoice({ totalDescuento: 'x' }), 'MISSING_FIELDS', /totalDescuento/);
});

test('un total repetido se trata como ausente, no se elige uno al azar', () => {
  const xml = buildInvoice().replace('<importeTotal>115.00</importeTotal>', '<importeTotal>115.00</importeTotal><importeTotal>1.00</importeTotal>');
  assertError(xml, 'MISSING_FIELDS', /importeTotal/);
});

// ---------- Línea de IVA no reconocida ----------

const LINEA_IVA = /ninguna línea de IVA/;

test('sin totalConImpuestos: MISSING_FIELDS, no pasa con IVA 0 y otros cargos', () => {
  const xml = buildInvoice().replace(/<totalConImpuestos>.*<\/totalConImpuestos>/, '');
  assertError(xml, 'MISSING_FIELDS', LINEA_IVA);
});

test('totalConImpuestos repetido: MISSING_FIELDS', () => {
  const xml = buildInvoice().replace(/(<totalConImpuestos>.*<\/totalConImpuestos>)/, '$1$1');
  assertError(xml, 'MISSING_FIELDS', LINEA_IVA);
});

test('totalImpuesto sin codigo: MISSING_FIELDS', () => {
  const xml = buildInvoice({ impuestos: [{ ...IVA_15, codigo: '' }] });
  assertError(xml, 'MISSING_FIELDS', LINEA_IVA);
});

test('solo una línea de ICE, sin IVA: MISSING_FIELDS', () => {
  const xml = buildInvoice({ impuestos: [{ codigo: '3', codigoPorcentaje: '3051', base: '100.00', valor: '15.00' }] });
  assertError(xml, 'MISSING_FIELDS', LINEA_IVA);
});

test('codigo 02 se normaliza a 2 y cuenta como IVA', () => {
  const invoice = parseOk(buildInvoice({ impuestos: [{ ...IVA_15, codigo: '02' }] }));
  assert.equal(invoice.vatAmount, 15);
  assert.equal(invoice.otherCharges, 0);
});

test('IVA 0 % explícito sí vale como línea de IVA', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '100.00',
      impuestos: [{ codigo: '2', codigoPorcentaje: '0', base: '100.00', valor: '0.00' }],
    }),
  );
  assert.equal(invoice.vatLines.length, 1);
  assert.equal(invoice.vatAmount, 0);
});

// ---------- Valores incoherentes ----------

test('valor de IVA mayor que la base: MISSING_FIELDS por valores incoherentes', () => {
  const xml = buildInvoice({
    importeTotal: '250.00',
    impuestos: [{ codigo: '2', codigoPorcentaje: '4', base: '100.00', valor: '150.00' }],
  });
  assertError(xml, 'MISSING_FIELDS', /valores incoherentes/);
});

test('valor de IVA con base 0: MISSING_FIELDS por valores incoherentes', () => {
  const xml = buildInvoice({ impuestos: [{ codigo: '2', codigoPorcentaje: '4', base: '0.00', valor: '15.00' }] });
  assertError(xml, 'MISSING_FIELDS', /valores incoherentes/);
});

test('un ICE mayor que su base no es incoherente', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '415.00',
      impuestos: [IVA_15, { codigo: '3', codigoPorcentaje: '3051', base: '100.00', valor: '300.00' }],
    }),
  );
  assert.equal(invoice.otherCharges, 300);
});

// ---------- Cuadre de bases con ICE ----------

test('neto 100, ICE base 100 valor 15, IVA base 115: sin aviso de bases', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '132.25',
      impuestos: [
        { codigo: '3', codigoPorcentaje: '3051', base: '100.00', valor: '15.00' },
        { codigo: '2', codigoPorcentaje: '4', base: '115.00', valor: '17.25', tarifa: '15' },
      ],
    }),
  );
  assert.equal(invoice.vatAmount, 17.25);
  assert.equal(invoice.otherCharges, 15);
  assert.equal(hasWarning(invoice, /bases/), false);
});

test('con ICE, una base de IVA que no cuadra con ninguno de los dos totales sí avisa', () => {
  const invoice = parseOk(
    buildInvoice({
      importeTotal: '135.00',
      impuestos: [
        { codigo: '3', codigoPorcentaje: '3051', base: '100.00', valor: '15.00' },
        { codigo: '2', codigoPorcentaje: '0', base: '120.00', valor: '0.00' },
      ],
    }),
  );
  assert.ok(hasWarning(invoice, /bases de IVA .* no cuadra/));
});

// ---------- Topes de campos ----------

const TOPE_CASES: Array<[string, Partial<InvoiceOptions>, RegExp]> = [
  ['identificacionComprador de 21 caracteres', { identificacion: '1'.repeat(21) }, /identificacionComprador/],
  ['ruc de 21 caracteres', { ruc: '1'.repeat(21) }, /ruc/],
  ['razonSocial de 161 caracteres', { razonSocial: 'A'.repeat(161) }, /razonSocial/],
  ['razonSocialComprador de 161 caracteres', { comprador: 'A'.repeat(161) }, /razonSocialComprador/],
  ['estab de 4 dígitos', { estab: '0001' }, /estab/],
  ['ptoEmi con letras', { ptoEmi: 'ABC' }, /ptoEmi/],
  ['secuencial sin rellenar', { secuencial: '1234' }, /secuencial/],
  ['secuencial de 10 dígitos', { secuencial: '0000001234' }, /secuencial/],
];

for (const [name, change, pattern] of TOPE_CASES) {
  test(`${name}: MISSING_FIELDS, nombra el campo`, () => {
    assertError(buildInvoice({ ...change, clave: buildKey() }), 'MISSING_FIELDS', pattern);
  });
}

test('nombres de 160 caracteres e identificación de 20 pasan', () => {
  const invoice = parseOk(buildInvoice({ razonSocial: 'A'.repeat(160), comprador: 'B'.repeat(160), identificacion: '1'.repeat(20) }));
  assert.equal(invoice.issuerName.length, 160);
  assert.equal(invoice.buyerTaxId.length, 20);
});

test('codigoPorcentaje de 5 caracteres: MISSING_FIELDS', () => {
  const xml = buildInvoice({ impuestos: [{ ...IVA_15, codigoPorcentaje: '12345' }] });
  assertError(xml, 'MISSING_FIELDS', /codigoPorcentaje/);
});

const ivaLines = (count: number): Tax[] =>
  Array.from({ length: count }, () => ({ codigo: '2', codigoPorcentaje: '0', base: '0.00', valor: '0.00' }));

test('más de 20 líneas de IVA: MISSING_FIELDS', () => {
  assertError(buildInvoice({ impuestos: [IVA_15, ...ivaLines(20)] }), 'MISSING_FIELDS', /más de 20 líneas de IVA/);
});

test('20 líneas de IVA pasan', () => {
  assert.equal(parseOk(buildInvoice({ impuestos: [IVA_15, ...ivaLines(19)] })).vatLines.length, 20);
});

test('un valor largo no se repite entero en mensajes ni avisos', () => {
  const invoice = parseOk(buildInvoice({ moneda: 'X'.repeat(1000) }));
  assert.ok(invoice.warnings.every((warning) => warning.length < 200));
  const result = assertError(buildInvoice({ codDoc: '9'.repeat(1000), clave: buildKey() }), 'UNSUPPORTED_DOC');
  assert.ok((result?.message.length ?? 0) < 300);
  assert.ok((result?.docType?.length ?? 0) < 60);
});

// ---------- Nombres de propiedades de Object como valores ----------

for (const value of ['constructor', '__proto__', 'toString']) {
  test(`codDoc = ${value}: UNSUPPORTED_DOC con mensaje limpio`, () => {
    const result = assertError(buildInvoice({ codDoc: value, clave: buildKey() }), 'UNSUPPORTED_DOC');
    assert.equal(result?.docType, `código ${value}`);
    assert.doesNotMatch(result?.message ?? '', /undefined|Object|function/);
  });

  test(`codigo de impuesto = ${value}: el aviso no muestra undefined ni Object`, () => {
    const invoice = parseOk(
      buildInvoice({
        importeTotal: '120.00',
        impuestos: [IVA_15, { codigo: value, codigoPorcentaje: '1', base: '100.00', valor: '5.00' }],
      }),
    );
    assert.equal(invoice.otherCharges, 5);
    assert.ok(hasWarning(invoice, /impuesto no identificado 5\.00/));
    assert.equal(hasWarning(invoice, /undefined|Object|function/), false);
  });
}

test('informa todos los campos que faltan a la vez', () => {
  const result = parseSriXml(buildInvoice({ ruc: '', importeTotal: '', clave: buildKey() }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /ruc/);
    assert.match(result.message, /importeTotal/);
  }
});
