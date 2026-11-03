// Pruebas de comportamiento de la importación de facturas del SRI, contra la API real y con
// el lector real. Crean una base global y dos de empresa propias, y las borran al terminar.
// Uso: npm run test:invoices
import 'express-async-errors';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import http, { type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { Client } from 'pg';

const SUFFIX = randomBytes(4).toString('hex');
const DB_GLOBAL = `finanzas_test_${SUFFIX}`;
const DB_A = `finanzas_test_${SUFFIX}_a`;
const DB_B = `finanzas_test_${SUFFIX}_b`;
const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT } = process.env;
const credentials = `${encodeURIComponent(POSTGRES_USER!)}:${encodeURIComponent(POSTGRES_PASSWORD!)}`;
const urlFor = (db: string) => `postgresql://${credentials}@${POSTGRES_HOST}:${POSTGRES_PORT}/${db}`;
process.env.GLOBAL_DATABASE_URL = `${urlFor(DB_GLOBAL)}?schema=public`;

type TenantClient = import('../src/lib/tenantPrisma').TenantPrisma;
type TestUser = { token: string; userId: number; tenant: TestTenant; membershipId: string };
type TestTenant = { id: string; prisma: TenantClient };

let server: Server;
let base: string;
let globalPrisma: typeof import('../src/lib/globalPrisma').globalPrisma;
let signToken: typeof import('../src/lib/jwt').signToken;
let disconnectAll: () => Promise<void>;
let tenantA: TestTenant;
let tenantB: TestTenant;
let counter = 0;

/** Reintenta hasta que la condición se cumpla; falla a los 10 s. */
async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, 'la condición no se cumplió a tiempo');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function sql(db: string, statement: string) {
  const client = new Client({ connectionString: urlFor(db) });
  await client.connect();
  try { await client.query(statement); } finally { await client.end(); }
}

async function createTenant(name: string, dbName: string): Promise<TestTenant> {
  const { encryptConnection } = await import('../src/lib/tenantCrypto');
  const { getTenantPrisma } = await import('../src/lib/tenantPrisma');
  execSync('npx prisma db push --schema=prisma/tenant/schema.prisma --skip-generate', {
    stdio: 'ignore',
    env: { ...process.env, TENANT_DATABASE_URL: `${urlFor(dbName)}?schema=public` }
  });
  const enc = encryptConnection({ user: POSTGRES_USER!, password: POSTGRES_PASSWORD! });
  const tenant = await globalPrisma.tenant.create({ data: { slug: `${name}-${SUFFIX}`, legalName: name, email: `${name}@prueba.example` } });
  await globalPrisma.tenantConnection.create({
    data: {
      tenantId: tenant.id, dbHost: POSTGRES_HOST!, dbPort: Number(POSTGRES_PORT), dbName,
      dbUserCipher: enc.userCipher, dbPasswordCipher: enc.passwordCipher
    }
  });
  return { id: tenant.id, prisma: await getTenantPrisma(tenant.id) };
}

before(async () => {
  await sql('postgres', `CREATE DATABASE "${DB_GLOBAL}"`);
  await sql('postgres', `CREATE DATABASE "${DB_A}"`);
  await sql('postgres', `CREATE DATABASE "${DB_B}"`);
  execSync('npx prisma db push --schema=prisma/global/schema.prisma --skip-generate', { stdio: 'ignore', env: process.env });

  ({ globalPrisma } = await import('../src/lib/globalPrisma'));
  ({ signToken } = await import('../src/lib/jwt'));
  disconnectAll = (await import('../src/lib/tenantPrisma')).disconnectAllTenantClients;
  tenantA = await createTenant('a', DB_A);
  tenantB = await createTenant('b', DB_B);

  const { requireAuth } = await import('../src/middleware/auth');
  const { tenantContext } = await import('../src/middleware/tenantContext');
  const { invoicesRouter } = await import('../src/routes/tenant/invoices.routes');
  const { invoiceImportRouter, jsonExceptInvoiceImport } = await import('../src/routes/tenant/invoiceImport.routes');
  const { attachmentsRouter } = await import('../src/routes/tenant/attachments.routes');
  const { backupRouter } = await import('../src/routes/tenant/backup.routes');

  // Mismo orden que index.ts: parsers grandes antes del global, importación antes de /api/invoices.
  const app = express();
  app.use('/api/attachments', express.json({ limit: '12mb' }));
  app.use('/api/backup/import', express.json({ limit: '256mb' }));
  app.use(jsonExceptInvoiceImport('256kb'));
  const tenantScope = [requireAuth, tenantContext];
  app.use('/api/invoices/import', tenantScope, invoiceImportRouter);
  app.use('/api/invoices', tenantScope, invoicesRouter);
  app.use('/api/attachments', tenantScope, attachmentsRouter);
  app.use('/api/backup', tenantScope, backupRouter);
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ message: 'Datos inválidos' });
    return next(err);
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await disconnectAll?.();
  await globalPrisma?.$disconnect();
  for (const db of [DB_GLOBAL, DB_A, DB_B]) await sql('postgres', `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
});

// ---------- Usuarios y datos ----------

async function newUser(tenant: TestTenant = tenantA, permissions?: Record<string, string>): Promise<TestUser> {
  const email = `u${++counter}-${SUFFIX}@prueba.example`;
  const role = permissions ? 'USUARIO_EMPRESA' : 'ADMIN_EMPRESA';
  const local = await tenant.prisma.user.create({ data: { email, name: 'Prueba', role } });
  const membership = await globalPrisma.tenantMembership.create({
    data: { email, passwordHash: 'sin-uso', name: 'Prueba', tenantId: tenant.id, role, permissions }
  });
  const token = signToken({ kind: 'tenant', id: membership.id, email, tenantId: tenant.id, role, tokenVersion: 0 });
  return { token, userId: local.id, tenant, membershipId: membership.id };
}

const addEntity = (user: TestUser, taxId: string | null) =>
  user.tenant.prisma.entity.create({ data: { userId: user.userId, name: `Razón ${++counter}`, taxId } });

const addAccount = (user: TestUser) =>
  user.tenant.prisma.account.create({ data: { userId: user.userId, name: `Cuenta ${++counter}`, type: 'BANK' } });

function call(method: string, path: string, user: TestUser | null, body?: unknown) {
  return fetch(`${base}/api${path}`, {
    method,
    headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const counts = async (user: TestUser) => ({
  invoices: await user.tenant.prisma.invoice.count({ where: { userId: user.userId } }),
  attachments: await user.tenant.prisma.attachment.count({ where: { userId: user.userId } })
});

// ---------- XML inventado, con clave de acceso válida ----------

function checkDigit(first48: string): string {
  let sum = 0;
  let weight = 2;
  for (let i = first48.length - 1; i >= 0; i--) {
    sum += Number(first48[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const r = 11 - (sum % 11);
  return String(r === 11 ? 0 : r === 10 ? 1 : r);
}

const ISSUER = '1790000001001';
const BUYER = '1712345678001';
const BUYER_CEDULA = '1712345678';

type VatLine = { code: string; base: string; vat: string };
type XmlOptions = {
  issuer?: string;
  buyer?: string;
  date?: string; // YYYY-MM-DD
  seq?: number;
  buyerName?: string;
  net?: string;
  discount?: string;
  total?: string;
  lines?: VatLine[];
};

function makeInvoice(o: XmlOptions = {}) {
  const issuer = o.issuer ?? ISSUER;
  const buyer = o.buyer ?? BUYER;
  const [y, m, d] = (o.date ?? '2026-01-15').split('-');
  const sequential = String(o.seq ?? ++counter).padStart(9, '0');
  const first48 = `${d}${m}${y}01${issuer}2001001${sequential}123456781`;
  const accessKey = first48 + checkDigit(first48);
  const lines = o.lines ?? [{ code: '4', base: '100.00', vat: '15.00' }];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="1.1.0">
  <infoTributaria>
    <ambiente>2</ambiente><tipoEmision>1</tipoEmision>
    <razonSocial>Emisor de Prueba S.A.</razonSocial>
    <ruc>${issuer}</ruc><claveAcceso>${accessKey}</claveAcceso><codDoc>01</codDoc>
    <estab>001</estab><ptoEmi>001</ptoEmi><secuencial>${sequential}</secuencial>
    <dirMatriz>Calle de Prueba 1</dirMatriz>
  </infoTributaria>
  <infoFactura>
    <fechaEmision>${d}/${m}/${y}</fechaEmision>
    <tipoIdentificacionComprador>04</tipoIdentificacionComprador>
    <razonSocialComprador>${o.buyerName ?? 'Comprador de Prueba'}</razonSocialComprador>
    <identificacionComprador>${buyer}</identificacionComprador>
    <totalSinImpuestos>${o.net ?? '100.00'}</totalSinImpuestos>
    <totalDescuento>${o.discount ?? '0.00'}</totalDescuento>
    <totalConImpuestos>${lines.map((l) => `
      <totalImpuesto><codigo>2</codigo><codigoPorcentaje>${l.code}</codigoPorcentaje><baseImponible>${l.base}</baseImponible><valor>${l.vat}</valor></totalImpuesto>`).join('')}
    </totalConImpuestos>
    <propina>0.00</propina>
    <importeTotal>${o.total ?? '115.00'}</importeTotal>
    <moneda>DOLAR</moneda>
  </infoFactura>
</factura>`;
  return {
    xml,
    accessKey,
    number: `001-001-${sequential}`,
    contentBase64: Buffer.from(xml, 'utf8').toString('base64'),
    filename: `factura-${sequential}.xml`
  };
}

const twoRates: XmlOptions = {
  net: '150.00',
  total: '167.50',
  lines: [{ code: '4', base: '100.00', vat: '15.00' }, { code: '5', base: '50.00', vat: '2.50' }]
};

async function preview(user: TestUser, ...files: { filename: string; contentBase64: string }[]) {
  const res = await call('POST', '/invoices/import/preview', user, {
    files: files.map(({ filename, contentBase64 }) => ({ filename, contentBase64 }))
  });
  assert.equal(res.status, 200);
  return (await res.json()).items as any[];
}

async function confirm(user: TestUser, ...items: Record<string, unknown>[]) {
  const res = await call('POST', '/invoices/import/confirm', user, { items });
  assert.equal(res.status, 200);
  return await res.json() as { created: { filename: string; id: number; number: string | null }[]; skipped: { filename: string; reason: string; code: string }[] };
}

const toConfirm = (doc: ReturnType<typeof makeInvoice>, extra: Record<string, unknown>) =>
  ({ filename: doc.filename, contentBase64: doc.contentBase64, ...extra });

async function importOne(user: TestUser, options: XmlOptions = {}, kind: 'SALE' | 'PURCHASE' = 'PURCHASE') {
  const doc = makeInvoice(options);
  const result = await confirm(user, toConfirm(doc, { kind }));
  assert.deepEqual(result.skipped, []);
  const row = await user.tenant.prisma.invoice.findFirstOrThrow({ where: { id: result.created[0].id, userId: user.userId } });
  return { doc, row };
}

/** Lo que reenvía el formulario de edición de facturas (InvoicesView.vue). */
function formPayload(row: any) {
  return {
    kind: row.kind,
    status: row.status,
    number: row.number,
    counterparty: row.counterparty,
    counterpartyTaxId: row.counterpartyTaxId,
    issueDate: new Date(row.issueDate).toISOString().slice(0, 10),
    netAmount: Number(row.netAmount),
    vatRate: Number(row.vatRate),
    description: row.description,
    accountId: row.accountId,
    entityId: row.entityId,
    notes: row.notes
  };
}

const vatSummary = async (user: TestUser, year: number, month: number) =>
  (await call('GET', `/invoices/vat-summary?year=${year}&month=${month}`, user)).json();

// ---------- Vista previa ----------

test('la vista previa no escribe nada', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const items = await preview(user, makeInvoice());
  assert.equal(items[0].status, 'READY');
  assert.deepEqual(await counts(user), { invoices: 0, attachments: 0 });
});

test('detecta la venta por el emisor: la contraparte es el comprador', async () => {
  const user = await newUser();
  const entity = await addEntity(user, ISSUER);
  const doc = makeInvoice();
  const [item] = await preview(user, doc);
  assert.equal(item.status, 'READY');
  assert.equal(item.draft.kind, 'SALE');
  assert.equal(item.draft.entityId, entity.id);
  assert.equal(item.draft.counterparty, 'Comprador de Prueba');
  assert.equal(item.draft.counterpartyTaxId, BUYER);
  assert.equal(item.draft.accessKey, doc.accessKey);
  assert.equal(item.draft.number, doc.number);
  assert.equal(item.draft.issueDate, '2026-01-15');
  assert.equal(item.draft.total, 115);
});

test('detecta la compra por el comprador: la contraparte es el emisor', async () => {
  const user = await newUser();
  const entity = await addEntity(user, BUYER);
  const [item] = await preview(user, makeInvoice());
  assert.equal(item.status, 'READY');
  assert.equal(item.draft.kind, 'PURCHASE');
  assert.equal(item.draft.entityId, entity.id);
  assert.equal(item.draft.counterparty, 'Emisor de Prueba S.A.');
  assert.equal(item.draft.counterpartyTaxId, ISSUER);
});

test('una cédula de 10 dígitos coincide con el RUC igual a esa cédula + 001, en ambos sentidos', async () => {
  const withCedula = await newUser();
  await addEntity(withCedula, BUYER_CEDULA);
  assert.equal((await preview(withCedula, makeInvoice({ buyer: BUYER })))[0].draft.kind, 'PURCHASE');

  const withRuc = await newUser();
  await addEntity(withRuc, BUYER);
  assert.equal((await preview(withRuc, makeInvoice({ buyer: BUYER_CEDULA })))[0].draft.kind, 'PURCHASE');

  const withFormat = await newUser();
  await addEntity(withFormat, '1712345678-001');
  assert.equal((await preview(withFormat, makeInvoice()))[0].draft.kind, 'PURCHASE');

  const otherEstablishment = await newUser();
  await addEntity(otherEstablishment, '17123456780');
  assert.equal((await preview(otherEstablishment, makeInvoice()))[0].status, 'NEEDS_KIND');
});

test('NEEDS_KIND si no coincide ninguno, si coinciden ambos o si dos razones comparten RUC', async () => {
  const expectNeedsKind = (item: any) => {
    assert.equal(item.status, 'NEEDS_KIND');
    assert.equal(item.draft.kind, null);
    assert.equal(item.draft.entityId, null);
    assert.equal(item.draft.counterparty, '');
    assert.equal(item.draft.counterpartyTaxId, '');
  };
  const none = await newUser();
  await addEntity(none, '0990000002001');
  await addEntity(none, null);
  expectNeedsKind((await preview(none, makeInvoice()))[0]);

  const both = await newUser();
  await addEntity(both, ISSUER);
  await addEntity(both, BUYER);
  expectNeedsKind((await preview(both, makeInvoice()))[0]);

  const twice = await newUser();
  await addEntity(twice, ISSUER);
  await addEntity(twice, ISSUER);
  expectNeedsKind((await preview(twice, makeInvoice()))[0]);
});

test('al confirmar un NEEDS_KIND, la contraparte se resuelve según el tipo elegido', async () => {
  const user = await newUser();
  const { row } = await importOne(user, {}, 'PURCHASE');
  assert.equal(row.counterparty, 'Emisor de Prueba S.A.');
  assert.equal(row.counterpartyTaxId, ISSUER);
  assert.equal(row.entityId, null);
  const { row: sale } = await importOne(user, {}, 'SALE');
  assert.equal(sale.counterparty, 'Comprador de Prueba');
  assert.equal(sale.counterpartyTaxId, BUYER);
});

test('un límite de 51 archivos o una lista vacía se rechazan; 50 pasan', async () => {
  const user = await newUser();
  const file = { filename: 'a.xml', contentBase64: 'AAAA' };
  assert.equal((await call('POST', '/invoices/import/preview', user, { files: Array(51).fill(file) })).status, 400);
  assert.equal((await call('POST', '/invoices/import/confirm', user, { items: Array(51).fill({ ...file, kind: 'SALE' }) })).status, 400);
  assert.equal((await call('POST', '/invoices/import/preview', user, { files: [] })).status, 400);
  assert.equal((await preview(user, ...Array(50).fill(file))).length, 50);
});

test('un archivo malo produce su error y no rompe el lote', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const good = makeInvoice();
  const tooLarge = Buffer.alloc(600 * 1024, 'a').toString('base64');
  const res = await call('POST', '/invoices/import/preview', user, {
    files: [
      { filename: 'mal-base64.xml', contentBase64: '%%% no es base64 %%%' },
      { filename: 'sin-relleno.xml', contentBase64: 'abc' },
      { filename: 'vacio.xml', contentBase64: '' },
      { filename: 'no-es-xml.xml', contentBase64: Buffer.from('hola').toString('base64') },
      { filename: 'x'.repeat(201), contentBase64: good.contentBase64 },
      { filename: 'grande.xml', contentBase64: tooLarge },
      'esto ni siquiera es un objeto',
      { filename: good.filename, contentBase64: good.contentBase64 }
    ]
  });
  assert.equal(res.status, 200);
  const { items } = await res.json();
  assert.deepEqual(items.map((i: any) => i.status), ['ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'READY']);
  assert.equal(items[0].error.code, 'INVALID_BASE64');
  assert.equal(items[1].error.code, 'INVALID_BASE64');
  assert.equal(items[3].error.code, 'INVALID_XML');
  assert.equal(items[4].error.code, 'INVALID_FILE');
  assert.equal(items[5].error.code, 'TOO_LARGE');
  assert.equal(typeof items[0].error.message, 'string');

  const result = await confirm(user,
    { filename: 'mal.xml', contentBase64: '%%%', kind: 'SALE' },
    { filename: 'sin-tipo.xml', contentBase64: good.contentBase64 },
    toConfirm(good, { kind: 'SALE' })
  );
  assert.deepEqual(result.skipped.map((s) => s.code), ['INVALID_BASE64', 'INVALID_ITEM']);
  assert.equal(result.created.length, 1);
});

test('un documento rechazado por el lector llega con el código del lector', async () => {
  const user = await newUser();
  const doc = makeInvoice();
  const tampered = doc.xml.replace(doc.accessKey, doc.accessKey.slice(0, 48) + ((Number(doc.accessKey[48]) + 1) % 10));
  const contentBase64 = Buffer.from(tampered).toString('base64');
  assert.equal((await preview(user, { filename: 'a.xml', contentBase64 }))[0].error.code, 'BAD_ACCESS_KEY');
  const result = await confirm(user, { filename: 'a.xml', contentBase64, kind: 'SALE' });
  assert.equal(result.skipped[0].code, 'BAD_ACCESS_KEY');
  assert.deepEqual(await counts(user), { invoices: 0, attachments: 0 });
});

// ---------- Confirmar: los importes son del documento ----------

test('confirmar ignora los montos y datos falsos que mande el cliente', async () => {
  const user = await newUser();
  const entity = await addEntity(user, ISSUER);
  const doc = makeInvoice({ date: '2026-03-10' });
  const result = await confirm(user, toConfirm(doc, {
    kind: 'SALE',
    entityId: entity.id,
    status: 'PAID',
    description: ' Servicios ',
    netAmount: 1, vatAmount: 1, total: 1, vatRate: 1, discount: 99, otherCharges: 99,
    number: 'FALSO', accessKey: '1'.repeat(49), issueDate: '2020-01-01',
    counterparty: 'Falso', counterpartyTaxId: '1', source: 'MANUAL', userId: 1
  }));
  assert.equal(result.created.length, 1);
  const row = await user.tenant.prisma.invoice.findFirstOrThrow({ where: { userId: user.userId } });
  assert.equal(Number(row.netAmount), 100);
  assert.equal(Number(row.vatAmount), 15);
  assert.equal(Number(row.total), 115);
  assert.equal(Number(row.vatRate), 15);
  assert.equal(Number(row.discount), 0);
  assert.equal(Number(row.otherCharges), 0);
  assert.equal(row.number, doc.number);
  assert.equal(row.accessKey, doc.accessKey);
  assert.equal(row.source, 'SRI_XML');
  assert.equal(row.issuerTaxId, ISSUER);
  assert.equal(row.buyerTaxId, BUYER);
  assert.equal(row.counterparty, 'Comprador de Prueba');
  assert.equal(row.counterpartyTaxId, BUYER);
  assert.equal(row.status, 'PAID');
  assert.equal(row.description, 'Servicios');
  assert.equal(row.entityId, entity.id);
  assert.equal(row.issueDate.toISOString().slice(0, 10), '2026-03-10');
});

test('con dos tarifas, IVA y total son exactos y la vat-summary los suma', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const { row } = await importOne(user, { ...twoRates, date: '2026-04-20' }, 'SALE');
  assert.equal(Number(row.netAmount), 150);
  assert.equal(Number(row.vatAmount), 17.5);
  assert.equal(Number(row.total), 167.5);
  assert.equal(Number(row.vatRate), 15);
  assert.deepEqual(row.vatLines, [
    { rate: 15, rateCode: '4', base: 100, vat: 15 },
    { rate: 5, rateCode: '5', base: 50, vat: 2.5 }
  ]);
  const summary = await vatSummary(user, 2026, 4);
  assert.equal(summary.sales.net, 150);
  assert.equal(summary.sales.vat, 17.5);
  assert.equal(summary.sales.total, 167.5);
  assert.equal(summary.sales.count, 1);
  assert.equal(summary.netVat, 17.5);
});

test('la factura del último día del mes cae en su período, y la del primero en el suyo', async () => {
  const user = await newUser();
  await addEntity(user, BUYER);
  await importOne(user, { date: '2026-01-31' });
  await importOne(user, { date: '2026-02-01', net: '200.00', total: '230.00', lines: [{ code: '4', base: '200.00', vat: '30.00' }] });
  const jan = await vatSummary(user, 2026, 1);
  const feb = await vatSummary(user, 2026, 2);
  assert.equal(jan.purchases.count, 1);
  assert.equal(jan.purchases.vat, 15);
  assert.equal(feb.purchases.count, 1);
  assert.equal(feb.purchases.vat, 30);
  const rows = await (await call('GET', '/invoices', user)).json();
  assert.deepEqual(rows.map((r: any) => String(r.issueDate).slice(0, 7)).sort(), ['2026-01', '2026-02']);
});

// ---------- Duplicados ----------

test('duplicado por clave: se avisa en la vista previa y nunca se crea, ni autorizándolo', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const doc = makeInvoice();
  const { created } = await confirm(user, toConfirm(doc, { kind: 'SALE' }));
  const [item] = await preview(user, doc);
  assert.equal(item.status, 'DUPLICATE');
  assert.deepEqual(item.duplicateOf, { id: created[0].id, number: doc.number, source: 'ACCESS_KEY' });
  assert.equal(item.draft.accessKey, doc.accessKey);

  const again = await confirm(user, toConfirm(doc, { kind: 'SALE', allowPossibleDuplicate: true }));
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped[0].code, 'DUPLICATE_ACCESS_KEY');
  assert.deepEqual(await counts(user), { invoices: 1, attachments: 1 });
});

test('la misma clave dos veces en un lote: el segundo archivo es duplicado', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const doc = makeInvoice();
  const items = await preview(user, doc, { ...doc, filename: 'copia.xml' });
  assert.equal(items[0].status, 'READY');
  assert.equal(items[1].status, 'DUPLICATE');
  assert.deepEqual(items[1].duplicateOf, { id: 0, number: doc.number, source: 'ACCESS_KEY' });

  const result = await confirm(user, toConfirm(doc, { kind: 'SALE' }), { ...toConfirm(doc, { kind: 'SALE' }), filename: 'copia.xml' });
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.skipped.map((s) => [s.filename, s.code]), [['copia.xml', 'DUPLICATE_ACCESS_KEY']]);
  assert.deepEqual(await counts(user), { invoices: 1, attachments: 1 });
});

test('en una carrera solo una petición crea la factura, la otra queda como duplicado', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const doc = makeInvoice();
  const results = await Promise.all(Array.from({ length: 2 }, () => confirm(user, toConfirm(doc, { kind: 'SALE' }))));
  assert.equal(results.flatMap((r) => r.created).length, 1);
  assert.deepEqual(results.flatMap((r) => r.skipped).map((s) => s.code), ['DUPLICATE_ACCESS_KEY']);
  assert.deepEqual(await counts(user), { invoices: 1, attachments: 1 });
});

test('si otra transacción guarda la misma clave a mitad de camino, el índice lo frena (P2002)', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const doc = makeInvoice();
  // Fila sin confirmar: la consulta previa no la ve y la creación se queda esperando el índice.
  const rival = new Client({ connectionString: urlFor(DB_A) });
  await rival.connect();
  try {
    await rival.query('BEGIN');
    await rival.query(
      `INSERT INTO "Invoice" ("userId", kind, counterparty, "issueDate", "netAmount", "vatAmount", total, "accessKey", "updatedAt")
       VALUES ($1, 'SALE', 'Rival', now(), 100, 15, 115, $2, now())`,
      [user.userId, doc.accessKey]
    );
    const pending = confirm(user, toConfirm(doc, { kind: 'SALE' }));
    await until(async () => {
      const { rows } = await rival.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [DB_A]);
      return rows[0].n > 0;
    });
    await rival.query('COMMIT');
    const result = await pending;
    assert.equal(result.created.length, 0);
    assert.deepEqual(result.skipped.map((s) => s.code), ['DUPLICATE_ACCESS_KEY']);
  } finally {
    await rival.end();
  }
  assert.deepEqual(await counts(user), { invoices: 1, attachments: 0 });
});

test('una factura entre dos razones propias se registra en los dos lados, una vez cada uno', async () => {
  const user = await newUser();
  const issuer = await addEntity(user, ISSUER);
  const buyer = await addEntity(user, BUYER);
  const doc = makeInvoice();
  assert.equal((await preview(user, doc))[0].status, 'NEEDS_KIND');

  const sale = await confirm(user, toConfirm(doc, { kind: 'SALE' }));
  assert.equal(sale.created.length, 1);
  assert.equal((await preview(user, doc))[0].status, 'NEEDS_KIND');
  assert.equal((await confirm(user, toConfirm(doc, { kind: 'SALE' }))).skipped[0].code, 'DUPLICATE_ACCESS_KEY');

  const purchase = await confirm(user, toConfirm(doc, { kind: 'PURCHASE' }));
  assert.equal(purchase.created.length, 1);
  assert.deepEqual(await counts(user), { invoices: 2, attachments: 2 });

  const [again] = await preview(user, doc);
  assert.equal(again.status, 'DUPLICATE');
  assert.equal(again.duplicateOf.source, 'ACCESS_KEY');
  assert.equal((await confirm(user, toConfirm(doc, { kind: 'PURCHASE' }))).skipped[0].code, 'DUPLICATE_ACCESS_KEY');

  const rows = await user.tenant.prisma.invoice.findMany({ where: { userId: user.userId }, orderBy: { id: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.kind, r.entityId]), [['SALE', issuer.id], ['PURCHASE', buyer.id]]);
});

test('con tipo detectado, la misma clave solo es duplicado si existe con ese tipo', async () => {
  const user = await newUser();
  const doc = makeInvoice();
  await confirm(user, toConfirm(doc, { kind: 'PURCHASE' }));
  await addEntity(user, ISSUER);
  assert.equal((await preview(user, doc))[0].status, 'READY');
  await confirm(user, toConfirm(doc, { kind: 'SALE' }));
  assert.equal((await preview(user, doc))[0].status, 'DUPLICATE');
});

test('duplicado por número y RUC: solo pasa si el usuario lo autoriza', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const doc = makeInvoice();
  // La factura manual tiene la cédula del comprador; el documento, su RUC.
  const manual = await (await call('POST', '/invoices', user, {
    kind: 'SALE', number: doc.number, counterparty: 'Cliente', counterpartyTaxId: BUYER_CEDULA,
    issueDate: '2026-01-15', netAmount: 100, vatRate: 15
  })).json();

  const [item] = await preview(user, doc);
  assert.equal(item.status, 'DUPLICATE');
  assert.deepEqual(item.duplicateOf, { id: manual.id, number: doc.number, source: 'NUMBER_AND_TAX_ID' });

  const refused = await confirm(user, toConfirm(doc, { kind: 'SALE' }));
  assert.equal(refused.created.length, 0);
  assert.equal(refused.skipped[0].code, 'POSSIBLE_DUPLICATE');

  const allowed = await confirm(user, toConfirm(doc, { kind: 'SALE', allowPossibleDuplicate: true }));
  assert.equal(allowed.created.length, 1);
  assert.equal((await counts(user)).invoices, 2);
});

const addManual = async (user: TestUser, number: string, counterpartyTaxId: string | null, kind = 'SALE') =>
  (await call('POST', '/invoices', user, {
    kind, number, counterparty: 'Manual', counterpartyTaxId, issueDate: '2026-01-15', netAmount: 100, vatRate: 15
  })).json();

test('el número se compara por establecimiento, punto y secuencial, en cualquier formato', async () => {
  const seq = ++counter;
  const padded = String(seq).padStart(9, '0');
  const key = makeInvoice({ seq }).accessKey;
  for (const number of [`001-001-${padded}`, `1-1-${seq}`, `001001${padded}`, key]) {
    const user = await newUser();
    await addEntity(user, ISSUER);
    const manual = await addManual(user, number, BUYER);
    const [item] = await preview(user, makeInvoice({ seq, date: '2026-01-15' }));
    assert.equal(item.status, 'DUPLICATE', number);
    assert.deepEqual(item.duplicateOf, { id: manual.id, number, source: 'NUMBER_AND_TAX_ID' });
  }
  for (const number of [`2-1-${seq}`, `1-2-${seq}`, `1-1-${seq + 1}`, String(seq), 'F-1']) {
    const user = await newUser();
    await addEntity(user, ISSUER);
    await addManual(user, number, BUYER);
    assert.equal((await preview(user, makeInvoice({ seq })))[0].status, 'READY', number);
  }
});

test('hay posible duplicado con RUC igual o vacío; no con otro RUC ni con otro tipo', async () => {
  const seq = ++counter;
  const number = `001-001-${String(seq).padStart(9, '0')}`;
  const status = async (taxId: string | null, kind = 'SALE') => {
    const user = await newUser();
    await addEntity(user, ISSUER);
    await addManual(user, number, taxId, kind);
    return (await preview(user, makeInvoice({ seq })))[0].status;
  };
  assert.equal(await status(BUYER), 'DUPLICATE');
  assert.equal(await status(BUYER_CEDULA), 'DUPLICATE');
  assert.equal(await status(null), 'DUPLICATE');
  assert.equal(await status('0990000002001'), 'READY');
  assert.equal(await status(BUYER, 'PURCHASE'), 'READY');
});

test('otra clave con el mismo número y RUC es posible duplicado también entre importadas, y en el lote', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const first = makeInvoice();
  const { created } = await confirm(user, toConfirm(first, { kind: 'SALE' }));

  // Otro código numérico: misma factura según número y RUC, con otra clave.
  const seq = Number(first.number.slice(-9));
  const otherKey = makeInvoice({ seq, date: '2026-01-16' });
  assert.notEqual(otherKey.accessKey, first.accessKey);
  const [item] = await preview(user, otherKey);
  assert.equal(item.status, 'DUPLICATE');
  assert.deepEqual(item.duplicateOf, { id: created[0].id, number: first.number, source: 'NUMBER_AND_TAX_ID' });
  assert.equal((await confirm(user, toConfirm(otherKey, { kind: 'SALE' }))).skipped[0].code, 'POSSIBLE_DUPLICATE');

  const authorized = await confirm(user, toConfirm(otherKey, { kind: 'SALE', allowPossibleDuplicate: true }));
  assert.equal(authorized.created.length, 1);
  const log = await user.tenant.prisma.auditLog.findFirstOrThrow({ where: { userId: user.userId, entityId: authorized.created[0].id } });
  assert.match(log.summary!, new RegExp(`posible duplicado de la factura ${created[0].id}`));
  const plain = await user.tenant.prisma.auditLog.findFirstOrThrow({ where: { userId: user.userId, entityId: created[0].id } });
  assert.doesNotMatch(plain.summary!, /duplicado/);

  // Dos claves distintas con el mismo número dentro de un lote.
  const other = await newUser();
  await addEntity(other, ISSUER);
  const batch = await confirm(other,
    toConfirm(first, { kind: 'SALE' }),
    { ...toConfirm(otherKey, { kind: 'SALE' }), filename: 'otra.xml' }
  );
  assert.equal(batch.created.length, 1);
  assert.deepEqual(batch.skipped.map((s) => s.code), ['POSSIBLE_DUPLICATE']);
});

test('sin coincidencia con ninguna razón social el borrador trae el aviso', async () => {
  const foreign = await newUser();
  const [item] = await preview(foreign, makeInvoice());
  assert.equal(item.status, 'NEEDS_KIND');
  assert.ok(item.draft.warnings.some((w: string) => /ninguna razón social coincide/i.test(w)));

  const own = await newUser();
  await addEntity(own, ISSUER);
  const [matched] = await preview(own, makeInvoice());
  assert.ok(!matched.draft.warnings.some((w: string) => /ninguna razón social coincide/i.test(w)));
});

test('la razón social elegida debe ser la del lado del documento según el tipo', async () => {
  const user = await newUser();
  const issuer = await addEntity(user, ISSUER);
  const buyerByCedula = await addEntity(user, BUYER_CEDULA);
  const noTaxId = await addEntity(user, null);
  const unrelated = await addEntity(user, '0990000002001');
  const code = async (kind: string, entityId: number) => {
    const result = await confirm(user, toConfirm(makeInvoice(), { kind, entityId }));
    return result.skipped[0]?.code ?? 'CREADA';
  };
  assert.equal(await code('SALE', buyerByCedula.id), 'INVALID_ENTITY');
  assert.equal(await code('PURCHASE', issuer.id), 'INVALID_ENTITY');
  assert.equal(await code('SALE', unrelated.id), 'INVALID_ENTITY');
  assert.equal(await code('SALE', issuer.id), 'CREADA');
  assert.equal(await code('PURCHASE', buyerByCedula.id), 'CREADA');
  assert.equal(await code('SALE', noTaxId.id), 'CREADA');
});

test('una compra a consumidor final no se importa; una venta a consumidor final sí', async () => {
  const user = await newUser();
  const doc = makeInvoice({ buyer: '9999999999999' });
  const result = await confirm(user, toConfirm(doc, { kind: 'PURCHASE' }));
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped[0].code, 'CONSUMER_FINAL');
  assert.match(result.skipped[0].reason, /no sustenta crédito tributario/);

  await addEntity(user, ISSUER);
  assert.equal((await confirm(user, toConfirm(doc, { kind: 'SALE' }))).created.length, 1);
});

test('NEEDS_KIND también detecta el posible duplicado, por cualquiera de los dos RUC', async () => {
  const user = await newUser();
  const doc = makeInvoice();
  await call('POST', '/invoices', user, {
    kind: 'PURCHASE', number: doc.number, counterparty: 'Proveedor', counterpartyTaxId: ISSUER,
    issueDate: '2026-01-15', netAmount: 100, vatRate: 15
  });
  const [item] = await preview(user, doc);
  assert.equal(item.status, 'DUPLICATE');
  assert.equal(item.duplicateOf.source, 'NUMBER_AND_TAX_ID');
});

// ---------- Tipo, pertenencia y aislamiento ----------

test('KIND_MISMATCH si el cliente contradice al documento', async () => {
  const seller = await newUser();
  await addEntity(seller, ISSUER);
  const doc = makeInvoice();
  const result = await confirm(seller, toConfirm(doc, { kind: 'PURCHASE' }));
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped[0].code, 'KIND_MISMATCH');

  const buyer = await newUser();
  await addEntity(buyer, BUYER);
  assert.equal((await confirm(buyer, toConfirm(doc, { kind: 'SALE' }))).skipped[0].code, 'KIND_MISMATCH');
  assert.deepEqual(await counts(seller), { invoices: 0, attachments: 0 });

  // Dos razones con el mismo RUC de emisor: no se sabe cuál, pero sí que es una venta.
  const twice = await newUser();
  await addEntity(twice, ISSUER);
  await addEntity(twice, ISSUER);
  assert.equal((await confirm(twice, toConfirm(doc, { kind: 'PURCHASE' }))).skipped[0].code, 'KIND_MISMATCH');
  const { created } = await confirm(twice, toConfirm(doc, { kind: 'SALE' }));
  assert.equal(created.length, 1);
  const row = await twice.tenant.prisma.invoice.findFirstOrThrow({ where: { userId: twice.userId } });
  assert.equal(row.entityId, null);
});

test('con ambos lados propios el cliente elige, y la razón social sale del lado elegido', async () => {
  const user = await newUser();
  const issuer = await addEntity(user, ISSUER);
  await addEntity(user, BUYER);
  const { row } = await importOne(user, {}, 'SALE');
  assert.equal(row.entityId, issuer.id);
});

test('se rechaza la razón social o la cuenta de otro usuario', async () => {
  const user = await newUser();
  const other = await newUser();
  const foreignEntity = await addEntity(other, ISSUER);
  const foreignAccount = await addAccount(other);
  const account = await addAccount(user);
  const doc = makeInvoice();

  const byEntity = await confirm(user, toConfirm(doc, { kind: 'SALE', entityId: foreignEntity.id }));
  assert.equal(byEntity.skipped[0].code, 'INVALID_ENTITY');
  const byAccount = await confirm(user, toConfirm(doc, { kind: 'SALE', accountId: foreignAccount.id }));
  assert.equal(byAccount.skipped[0].code, 'INVALID_ACCOUNT');
  assert.deepEqual(await counts(user), { invoices: 0, attachments: 0 });

  const ok = await confirm(user, toConfirm(doc, { kind: 'SALE', accountId: account.id }));
  assert.equal(ok.created.length, 1);
  const row = await user.tenant.prisma.invoice.findFirstOrThrow({ where: { userId: user.userId } });
  assert.equal(row.accountId, account.id);
});

test('otro usuario u otra empresa no ven ni duplican las facturas ajenas', async () => {
  const owner = await newUser();
  const sameCompany = await newUser();
  const otherCompany = await newUser(tenantB);
  const doc = makeInvoice();
  const { created } = await confirm(owner, toConfirm(doc, { kind: 'SALE' }));

  for (const other of [sameCompany, otherCompany]) {
    assert.equal((await preview(other, doc))[0].status, 'NEEDS_KIND');
    assert.deepEqual(await (await call('GET', '/invoices', other)).json(), []);
    const theirs = await confirm(other, toConfirm(doc, { kind: 'SALE' }));
    assert.equal(theirs.created.length, 1);
    assert.equal(((await (await call('GET', '/invoices', other)).json()) as any[]).length, 1);
    assert.equal(await other.tenant.prisma.attachment.count({ where: { userId: other.userId } }), 1);
  }
  assert.equal(((await (await call('GET', '/invoices', owner)).json()) as any[]).length, 1);

  const attachment = await owner.tenant.prisma.attachment.findFirstOrThrow({ where: { userId: owner.userId } });
  assert.equal(attachment.entityId, created[0].id);
  assert.equal((await call('GET', `/attachments/${attachment.id}/file`, sameCompany)).status, 404);
  assert.equal((await call('PUT', `/invoices/${created[0].id}`, sameCompany, { status: 'PAID' })).status, 404);
});

test('sin permiso de escritura en facturas: 403; sin sesión: 401', async () => {
  const viewer = await newUser(tenantA, { invoices: 'view' });
  const none = await newUser(tenantA, { invoices: 'none' });
  const doc = makeInvoice();
  const previewBody = { files: [{ filename: doc.filename, contentBase64: doc.contentBase64 }] };
  const confirmBody = { items: [toConfirm(doc, { kind: 'SALE' })] };
  for (const user of [viewer, none]) {
    assert.equal((await call('POST', '/invoices/import/preview', user, previewBody)).status, 403);
    assert.equal((await call('POST', '/invoices/import/confirm', user, confirmBody)).status, 403);
  }
  assert.equal((await call('GET', '/invoices', viewer)).status, 200);
  assert.equal((await call('POST', '/invoices/import/preview', null, previewBody)).status, 401);
  assert.equal((await call('POST', '/invoices/import/confirm', null, confirmBody)).status, 401);
  assert.deepEqual(await counts(viewer), { invoices: 0, attachments: 0 });
});

test('un superadmin dentro de una empresa no puede importar a un usuario indefinido', async () => {
  const admin = await globalPrisma.superAdmin.create({ data: { email: `s-${SUFFIX}@prueba.example`, passwordHash: 'sin-uso', name: 'Super' } });
  const token = signToken({ kind: 'super', id: admin.id, email: admin.email, role: 'SUPER_ADMIN', tokenVersion: 0 });
  const doc = makeInvoice();
  const res = await fetch(`${base}/api/invoices/import/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Impersonate-Tenant': tenantA.id, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ filename: doc.filename, contentBase64: doc.contentBase64 }] })
  });
  assert.equal(res.status, 400);
});

// ---------- Factura y adjunto, juntos o ninguno ----------

test('si el adjunto falla no queda la factura, y el resto del lote sigue', async (t) => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  // Fallo real en la base: el insert del adjunto con este nombre revienta dentro de la transacción.
  await sql(DB_A, `
    CREATE FUNCTION rechaza_adjunto_de_prueba() RETURNS trigger AS $$
    BEGIN
      IF NEW.filename = 'falla-adjunto.xml' THEN RAISE EXCEPTION 'adjunto rechazado por la prueba'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER rechaza_adjunto_de_prueba BEFORE INSERT ON "Attachment"
      FOR EACH ROW EXECUTE FUNCTION rechaza_adjunto_de_prueba();
  `);
  t.after(() => sql(DB_A, `
    DROP TRIGGER rechaza_adjunto_de_prueba ON "Attachment";
    DROP FUNCTION rechaza_adjunto_de_prueba();
  `));

  const bad = makeInvoice();
  const good = makeInvoice();
  const result = await confirm(user,
    { ...toConfirm(bad, { kind: 'SALE' }), filename: 'falla-adjunto.xml' },
    toConfirm(good, { kind: 'SALE' })
  );
  assert.deepEqual(result.skipped.map((s) => s.code), ['SAVE_FAILED']);
  assert.equal(result.created.length, 1);
  assert.deepEqual(await counts(user), { invoices: 1, attachments: 1 });
  const leftover = await user.tenant.prisma.invoice.findFirst({ where: { userId: user.userId, accessKey: bad.accessKey } });
  assert.equal(leftover, null);
});

test('si la factura no se puede guardar no queda adjunto', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  // Excede Decimal(14,2): la factura falla al insertarse.
  const doc = makeInvoice({
    net: '9999999999999.00', total: '9999999999999.00',
    lines: [{ code: '0', base: '9999999999999.00', vat: '0.00' }]
  });
  const result = await confirm(user, toConfirm(doc, { kind: 'SALE' }));
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(await counts(user), { invoices: 0, attachments: 0 });
});

test('el adjunto XML guarda los bytes originales y se descarga con attachment y nosniff', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const doc = makeInvoice();
  const { created } = await confirm(user, { ...toConfirm(doc, { kind: 'SALE' }), filename: '../../ma"la\r\nfactura.xml' });
  const list = await (await call('GET', `/attachments?entityType=INVOICE&entityId=${created[0].id}`, user)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].mimeType, 'application/xml');
  assert.equal(list[0].filename, 'malafactura.xml');

  const res = await call('GET', `/attachments/${list[0].id}/file`, user);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), doc.xml);
  assert.match(res.headers.get('content-disposition')!, /^attachment;/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('el nombre del adjunto siempre termina en .xml y pierde control y bidi', async () => {
  const user = await newUser();
  for (const [sent, stored] of [
    ['factura.pdf', 'factura.pdf.xml'],
    ['factura', 'factura.xml'],
    ['FACTURA.XML', 'FACTURA.xml'],
    ['factura\u202Elmx.exe', 'facturalmx.exe.xml'],
    ['\u2066a\u2069\u202Ab\u202C.xml', 'ab.xml'],
    ['a\u0085b\u0007.xml', 'ab.xml'],
    ['\u202E...', 'factura.xml'],
    ['x'.repeat(200), `${'x'.repeat(196)}.xml`]
  ] as const) {
    const { created } = await confirm(user, { ...toConfirm(makeInvoice(), { kind: 'SALE' }), filename: sent });
    const attachment = await user.tenant.prisma.attachment.findFirstOrThrow({ where: { userId: user.userId, entityId: created[0].id } });
    assert.equal(attachment.filename, stored);
  }
});

test('un XML que declara ISO-8859-1 o Windows-1252 se lee en esa codificación', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  for (const label of ['ISO-8859-1', 'iso-8859-1', 'Windows-1252']) {
    const doc = makeInvoice({ buyerName: 'PEÑA' });
    const bytes = Buffer.from(doc.xml.replace('encoding="UTF-8"', `encoding="${label}"`), 'latin1');
    const contentBase64 = bytes.toString('base64');
    const [item] = await preview(user, { filename: doc.filename, contentBase64 });
    assert.equal(item.draft.buyerName, 'PEÑA', label);

    const { created } = await confirm(user, { filename: doc.filename, contentBase64, kind: 'SALE' });
    const row = await user.tenant.prisma.invoice.findFirstOrThrow({ where: { id: created[0].id } });
    assert.equal(row.counterparty, 'PEÑA');
    // El adjunto conserva los bytes originales, no la versión decodificada.
    const attachment = await user.tenant.prisma.attachment.findFirstOrThrow({ where: { userId: user.userId, entityId: row.id } });
    assert.deepEqual(Buffer.from(attachment.data), bytes);
  }
  assert.equal((await preview(user, makeInvoice({ buyerName: 'PEÑA' })))[0].draft.buyerName, 'PEÑA');
});

test('los comprobantes permitidos siguen abriéndose inline y el POST manual no admite XML', async () => {
  const user = await newUser();
  const { row } = await importOne(user);
  const pdf = await call('POST', '/attachments', user, {
    entityType: 'INVOICE', entityId: row.id, filename: 'comprobante "1".pdf', mimeType: 'application/pdf',
    dataBase64: Buffer.from('%PDF-1.4 prueba').toString('base64')
  });
  assert.equal(pdf.status, 201);
  const res = await call('GET', `/attachments/${(await pdf.json()).id}/file`, user);
  const disposition = res.headers.get('content-disposition')!;
  assert.match(disposition, /^inline; filename="comprobante 1\.pdf"/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const xml = await call('POST', '/attachments', user, {
    entityType: 'INVOICE', entityId: row.id, filename: 'a.xml', mimeType: 'application/xml',
    dataBase64: Buffer.from('<a/>').toString('base64')
  });
  assert.equal(xml.status, 400);
});

// ---------- Edición ----------

test('PUT de importada: 409 si cambia un dato del documento', async () => {
  const user = await newUser();
  const { row } = await importOne(user, { ...twoRates, date: '2026-05-31' });
  const put = (patch: Record<string, unknown>) => call('PUT', `/invoices/${row.id}`, user, { ...formPayload(row), ...patch });

  for (const patch of [
    { netAmount: 151 },
    { vatRate: 12 },
    { issueDate: '2026-06-01' },
    { number: '001-001-999999999' },
    { number: null },
    { counterpartyTaxId: '0990000002001' }
  ]) {
    const res = await put(patch);
    assert.equal(res.status, 409, JSON.stringify(patch));
    assert.ok((await res.json()).message.length > 0);
  }
  const stored = await user.tenant.prisma.invoice.findUniqueOrThrow({ where: { id: row.id } });
  assert.deepEqual(stored, row);
});

test('PUT de importada: reenviar los mismos datos da 200 y no recalcula; lo demás sí se edita', async () => {
  const user = await newUser();
  const account = await addAccount(user);
  const entity = await addEntity(user, '0990000002001');
  const { row } = await importOne(user, { ...twoRates, date: '2026-05-31' });

  const res = await call('PUT', `/invoices/${row.id}`, user, {
    ...formPayload(row),
    netAmount: '150.00',
    status: 'PAID',
    counterparty: 'Nombre corregido',
    description: 'Editada',
    notes: 'Nota',
    accountId: account.id,
    entityId: entity.id
  });
  assert.equal(res.status, 200);

  const stored = await user.tenant.prisma.invoice.findUniqueOrThrow({ where: { id: row.id } });
  // computeTotals daría 22.50 y 172.50.
  assert.equal(Number(stored.vatAmount), 17.5);
  assert.equal(Number(stored.total), 167.5);
  assert.equal(stored.issueDate.getTime(), row.issueDate.getTime());
  assert.equal(stored.status, 'PAID');
  assert.equal(stored.counterparty, 'Nombre corregido');
  assert.equal(stored.description, 'Editada');
  assert.equal(stored.notes, 'Nota');
  assert.equal(stored.accountId, account.id);
  assert.equal(stored.entityId, entity.id);

  const [listed] = await (await call('GET', '/invoices', user)).json();
  assert.equal(listed.source, 'SRI_XML');
  assert.equal(listed.accessKey, row.accessKey);
  assert.equal(Number(listed.discount), 0);
  assert.equal(Number(listed.otherCharges), 0);
  assert.equal(listed.vatLines.length, 2);
  assert.equal(listed.issuerTaxId, ISSUER);
  assert.equal(listed.buyerTaxId, BUYER);
});

test('PUT de importada: el tipo no se puede cambiar nunca', async () => {
  const matched = await newUser();
  await addEntity(matched, ISSUER);
  const { row } = await importOne(matched, {}, 'SALE');
  assert.equal((await call('PUT', `/invoices/${row.id}`, matched, { ...formPayload(row), kind: 'PURCHASE' })).status, 409);
  assert.equal((await call('PUT', `/invoices/${row.id}`, matched, formPayload(row))).status, 200);

  // Sin razón social que coincida, igual.
  const free = await newUser();
  const { row: open } = await importOne(free, {}, 'PURCHASE');
  const res = await call('PUT', `/invoices/${open.id}`, free, { ...formPayload(open), kind: 'SALE' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /vuelve a importarla/);
  const stored = await free.tenant.prisma.invoice.findUniqueOrThrow({ where: { id: open.id } });
  assert.equal(stored.kind, 'PURCHASE');
});

test('POST y PUT de facturas rechazan la cuenta o la razón social de otro usuario', async () => {
  const user = await newUser();
  const other = await newUser();
  const foreignAccount = await addAccount(other);
  const foreignEntity = await addEntity(other, null);
  const account = await addAccount(user);
  const entity = await addEntity(user, null);
  const body = { kind: 'SALE', counterparty: 'Cliente', issueDate: '2026-01-15', netAmount: 100, vatRate: 15 };

  assert.equal((await call('POST', '/invoices', user, { ...body, accountId: foreignAccount.id })).status, 400);
  assert.equal((await call('POST', '/invoices', user, { ...body, entityId: foreignEntity.id })).status, 400);
  assert.equal((await counts(user)).invoices, 0);

  const manual = await call('POST', '/invoices', user, { ...body, accountId: account.id, entityId: entity.id });
  assert.equal(manual.status, 201);
  const { id } = await manual.json();
  assert.equal((await call('PUT', `/invoices/${id}`, user, { accountId: foreignAccount.id })).status, 400);
  assert.equal((await call('PUT', `/invoices/${id}`, user, { entityId: foreignEntity.id })).status, 400);
  assert.equal((await call('PUT', `/invoices/${id}`, user, { accountId: account.id, entityId: entity.id })).status, 200);
  assert.equal((await call('PUT', `/invoices/${id}`, user, { accountId: null, entityId: null })).status, 200);

  const { row } = await importOne(user);
  assert.equal((await call('PUT', `/invoices/${row.id}`, user, { ...formPayload(row), entityId: foreignEntity.id })).status, 400);
});

test('PUT de manual sigue recalculando y deja cambiar número, fecha y RUC', async () => {
  const user = await newUser();
  const manual = await (await call('POST', '/invoices', user, {
    kind: 'SALE', number: '1', counterparty: 'Cliente', counterpartyTaxId: BUYER,
    issueDate: '2026-01-15', netAmount: 100, vatRate: 15
  })).json();
  assert.equal(manual.source, 'MANUAL');
  assert.equal(manual.accessKey, null);
  assert.equal(Number(manual.vatAmount), 15);

  const res = await call('PUT', `/invoices/${manual.id}`, user, {
    netAmount: 200, number: '2', issueDate: '2026-02-20', counterpartyTaxId: ISSUER, kind: 'PURCHASE'
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(Number(updated.vatAmount), 30);
  assert.equal(Number(updated.total), 230);
  assert.equal(updated.number, '2');
  assert.equal(updated.counterpartyTaxId, ISSUER);
  assert.equal(updated.kind, 'PURCHASE');
  assert.equal(String(updated.issueDate).slice(0, 10), '2026-02-20');

  // Muchas facturas manuales sin clave conviven con el índice único.
  for (let i = 0; i < 2; i++) {
    const again = await call('POST', '/invoices', user, {
      kind: 'SALE', counterparty: 'Cliente', issueDate: '2026-01-15', netAmount: 10, vatRate: 15
    });
    assert.equal(again.status, 201);
  }
});

test('la auditoría registra cada factura importada', async () => {
  const user = await newUser();
  const { row, doc } = await importOne(user);
  const log = await user.tenant.prisma.auditLog.findFirst({ where: { userId: user.userId, entity: 'invoice', entityId: row.id } });
  assert.equal(log?.action, 'CREATE');
  assert.ok(log?.summary?.includes(doc.number));
});

// ---------- Respaldo ----------

test('el respaldo conserva lo importado y restaurarlo otra vez no duplica ni rompe el índice', async () => {
  const user = await newUser();
  await addEntity(user, ISSUER);
  const { doc } = await importOne(user, twoRates, 'SALE');
  await call('POST', '/invoices', user, {
    kind: 'SALE', number: 'M-1', counterparty: 'Cliente', issueDate: '2026-01-15', netAmount: 100, vatRate: 15
  });
  const backup = await (await call('GET', '/backup/export', user)).json();
  assert.equal(backup.invoices.length, 2);

  // Sobre el mismo usuario: la importada se omite; la manual se agrega, como siempre hizo el respaldo.
  const sameUser = await call('POST', '/backup/import', user, backup);
  assert.equal(sameUser.status, 200);
  assert.equal((await sameUser.json()).imported.facturasOmitidas, 1);
  const rows = await user.tenant.prisma.invoice.findMany({ where: { userId: user.userId } });
  assert.equal(rows.filter((r) => r.accessKey === doc.accessKey).length, 1);
  assert.equal(rows.filter((r) => r.source === 'MANUAL').length, 2);
  assert.equal(await user.tenant.prisma.attachment.count({ where: { userId: user.userId } }), 1);

  // Sobre otra empresa: todo igual que el original, con su adjunto.
  const target = await newUser(tenantB);
  assert.equal((await call('POST', '/backup/import', target, backup)).status, 200);
  const restored = await target.tenant.prisma.invoice.findFirstOrThrow({ where: { userId: target.userId, accessKey: doc.accessKey } });
  assert.equal(restored.source, 'SRI_XML');
  assert.equal(Number(restored.vatAmount), 17.5);
  assert.equal(Number(restored.total), 167.5);
  assert.equal(Number(restored.discount), 0);
  assert.equal(Number(restored.otherCharges), 0);
  assert.equal((restored.vatLines as unknown[]).length, 2);
  assert.equal(restored.issuerTaxId, ISSUER);
  assert.equal(restored.buyerTaxId, BUYER);
  const manual = await target.tenant.prisma.invoice.findFirstOrThrow({ where: { userId: target.userId, source: 'MANUAL' } });
  assert.equal(manual.accessKey, null);

  const attachment = await target.tenant.prisma.attachment.findFirstOrThrow({ where: { userId: target.userId } });
  assert.equal(attachment.entityId, restored.id);
  assert.equal(attachment.mimeType, 'application/xml');
  assert.equal(Buffer.from(attachment.data).toString('utf8'), doc.xml);

  // Tras restaurar sigue protegida.
  const put = await call('PUT', `/invoices/${restored.id}`, target, { ...formPayload(restored), netAmount: 1 });
  assert.equal(put.status, 409);
  assert.equal((await preview(target, doc))[0].status, 'DUPLICATE');
});

test('al restaurar, una importada sin clave de 49 dígitos queda como manual y sin clave', async () => {
  const user = await newUser();
  const key = makeInvoice().accessKey;
  const base = { kind: 'SALE', status: 'ISSUED', counterparty: 'Cliente', issueDate: '2025-01-15T00:00:00.000Z', netAmount: '100.00', vatRate: '15.00', vatAmount: '15.00', total: '115.00' };
  const res = await call('POST', '/backup/import', user, {
    format: 'finanzas-backup',
    movements: [],
    invoices: [
      { ...base, id: 1, number: 'sin-clave', source: 'SRI_XML' },
      { ...base, id: 2, number: 'clave-corta', source: 'SRI_XML', accessKey: '123' },
      { ...base, id: 3, number: 'clave-no-texto', source: 'SRI_XML', accessKey: 123 },
      { ...base, id: 4, number: 'manual-con-clave', source: 'MANUAL', accessKey: key },
      { ...base, id: 5, number: 'valida', source: 'SRI_XML', accessKey: key },
      { ...base, id: 6, number: 'valida-compra', kind: 'PURCHASE', source: 'SRI_XML', accessKey: key }
    ]
  });
  assert.equal(res.status, 200);
  const rows = await user.tenant.prisma.invoice.findMany({ where: { userId: user.userId }, orderBy: { id: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.number, r.source, r.accessKey]), [
    ['sin-clave', 'MANUAL', null],
    ['clave-corta', 'MANUAL', null],
    ['clave-no-texto', 'MANUAL', null],
    ['manual-con-clave', 'MANUAL', null],
    ['valida', 'SRI_XML', key],
    ['valida-compra', 'SRI_XML', key]
  ]);
});

test('un respaldo antiguo, sin los campos nuevos, se restaura como manual', async () => {
  const user = await newUser();
  const res = await call('POST', '/backup/import', user, {
    format: 'finanzas-backup',
    movements: [],
    invoices: [{ id: 1, kind: 'SALE', status: 'ISSUED', number: 'A-1', counterparty: 'Cliente', issueDate: '2025-01-15T00:00:00.000Z', netAmount: '100.00', vatRate: '15.00', vatAmount: '15.00', total: '115.00' }]
  });
  assert.equal(res.status, 200);
  const row = await user.tenant.prisma.invoice.findFirstOrThrow({ where: { userId: user.userId } });
  assert.equal(row.source, 'MANUAL');
  assert.equal(row.accessKey, null);
  assert.equal(row.vatLines, null);
});

// ---------- Cuerpo y carga ----------

function rawPost(path: string, token: string | null, body: string) {
  return fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body
  });
}

test('el cuerpo no se lee sin autenticar y autorizar', async () => {
  const viewer = await newUser(tenantA, { invoices: 'view' });
  const admin = await newUser();
  const malformed = '{ esto no es JSON';
  const huge = 'a'.repeat(13 * 1024 * 1024);

  assert.equal((await rawPost('/invoices/import/preview', null, malformed)).status, 401);
  assert.equal((await rawPost('/invoices/import/preview', viewer.token, malformed)).status, 403);
  assert.equal((await rawPost('/invoices/import/preview', null, huge)).status, 401);
  assert.equal((await rawPost('/invoices/import/preview', viewer.token, huge)).status, 403);

  // Autorizado sí se lee: lo mal formado y lo excesivo llegan al parser.
  assert.equal((await rawPost('/invoices/import/preview', admin.token, malformed)).status, 400);
  assert.equal((await rawPost('/invoices/import/preview', admin.token, huge)).status, 413);
});

test('la importación admite cuerpos sobre el límite global, y el resto de la API lo conserva', async () => {
  const user = await newUser();
  const file = { filename: 'grande.xml', contentBase64: Buffer.alloc(300 * 1024, 'a').toString('base64') };
  assert.equal((await preview(user, file))[0].error.code, 'INVALID_XML');
  const big = await call('POST', '/invoices', user, { kind: 'SALE', counterparty: 'x'.repeat(300 * 1024), issueDate: '2026-01-15', netAmount: 1, vatRate: 0 });
  assert.equal(big.status, 413);
});

test('más de 20 peticiones por minuto de un usuario dan 429; a otro usuario no le afecta', async () => {
  const user = await newUser();
  const body = { files: [{ filename: 'a.xml', contentBase64: 'AAAA' }] };
  for (let i = 0; i < 20; i++) {
    assert.equal((await call('POST', '/invoices/import/preview', user, body)).status, 200, `petición ${i + 1}`);
  }
  const limited = await call('POST', '/invoices/import/confirm', user, { items: [{ ...body.files[0], kind: 'SALE' }] });
  assert.equal(limited.status, 429);
  assert.ok((await limited.json()).message.length > 0);
  assert.equal((await call('POST', '/invoices/import/preview', await newUser(), body)).status, 200);
});

test('una tercera importación simultánea da 429 y los cupos se liberan al cerrar', async () => {
  const payload = JSON.stringify({ files: [{ filename: 'a.xml', contentBase64: 'AAAA' }] });
  // El cupo se toma antes de leer el cuerpo: una petición con el cuerpo a medias lo mantiene ocupado.
  const open = (user: TestUser) => {
    const responded = new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/invoices/import/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
      req.write(payload.slice(0, 1));
      sockets.push(req);
    });
    return responded;
  };
  const sockets: http.ClientRequest[] = [];
  const probe = async () => call('POST', '/invoices/import/preview', await newUser(), JSON.parse(payload));

  const finishing = open(await newUser());
  const aborting = open(await newUser());
  aborting.catch(() => {});
  let message = '';
  await until(async () => {
    const res = await probe();
    if (res.status === 429) message = (await res.json()).message;
    return res.status === 429;
  });
  assert.match(message, /otras importaciones/);

  sockets[0].end(payload.slice(1));
  assert.equal(await finishing, 200);
  sockets[1].destroy();
  await until(async () => (await probe()).status === 200);
});
