// Pruebas de comportamiento de la memoria de correcciones de la IA, contra Postgres real y el
// PUT real de movimientos. Crean una base global y una de empresa propias, y las borran al terminar.
// Uso: npx tsx --env-file=.env.dev --test tests/ai-memory.test.ts
import 'express-async-errors';
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { Client } from 'pg';
import { lookupCategory, normalizeMemoryKey, recordCategoryCorrection, relevantHints } from '../src/whatsapp/aiMemory';
import { logger } from '../src/lib/logger';

const SUFFIX = randomBytes(4).toString('hex');
const DB_GLOBAL = `finanzas_test_${SUFFIX}`;
const DB_TENANT = `finanzas_test_${SUFFIX}_a`;
const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT } = process.env;
const credentials = `${encodeURIComponent(POSTGRES_USER!)}:${encodeURIComponent(POSTGRES_PASSWORD!)}`;
const urlFor = (db: string) => `postgresql://${credentials}@${POSTGRES_HOST}:${POSTGRES_PORT}/${db}`;
process.env.GLOBAL_DATABASE_URL = `${urlFor(DB_GLOBAL)}?schema=public`;

type TenantClient = import('../src/lib/tenantPrisma').TenantPrisma;
type TestUser = { id: number; token: string };

let server: Server;
let base: string;
let globalPrisma: typeof import('../src/lib/globalPrisma').globalPrisma;
let signToken: typeof import('../src/lib/jwt').signToken;
let disconnectAll: () => Promise<void>;
let prisma: TenantClient;
let tenantId: string;
let counter = 0;

async function sql(db: string, statement: string) {
  const client = new Client({ connectionString: urlFor(db) });
  await client.connect();
  try { await client.query(statement); } finally { await client.end(); }
}

async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, 'la condición no se cumplió a tiempo');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  await sql('postgres', `CREATE DATABASE "${DB_GLOBAL}"`);
  await sql('postgres', `CREATE DATABASE "${DB_TENANT}"`);
  execSync('npx prisma db push --schema=prisma/global/schema.prisma --skip-generate', { stdio: 'ignore', env: process.env });
  execSync('npx prisma db push --schema=prisma/tenant/schema.prisma --skip-generate', {
    stdio: 'ignore',
    env: { ...process.env, TENANT_DATABASE_URL: `${urlFor(DB_TENANT)}?schema=public` }
  });

  ({ globalPrisma } = await import('../src/lib/globalPrisma'));
  ({ signToken } = await import('../src/lib/jwt'));
  const { encryptConnection } = await import('../src/lib/tenantCrypto');
  const { getTenantPrisma, disconnectAllTenantClients } = await import('../src/lib/tenantPrisma');
  disconnectAll = disconnectAllTenantClients;

  const enc = encryptConnection({ user: POSTGRES_USER!, password: POSTGRES_PASSWORD! });
  const tenant = await globalPrisma.tenant.create({ data: { slug: `a-${SUFFIX}`, legalName: 'a', email: 'a@prueba.example' } });
  await globalPrisma.tenantConnection.create({
    data: {
      tenantId: tenant.id, dbHost: POSTGRES_HOST!, dbPort: Number(POSTGRES_PORT), dbName: DB_TENANT,
      dbUserCipher: enc.userCipher, dbPasswordCipher: enc.passwordCipher
    }
  });
  tenantId = tenant.id;
  prisma = await getTenantPrisma(tenant.id);

  const { requireAuth } = await import('../src/middleware/auth');
  const { tenantContext } = await import('../src/middleware/tenantContext');
  const { movementsRouter } = await import('../src/routes/tenant/movements.routes');
  const app = express();
  app.use(express.json());
  app.use('/api/movements', [requireAuth, tenantContext], movementsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await disconnectAll?.();
  await globalPrisma?.$disconnect();
  for (const db of [DB_GLOBAL, DB_TENANT]) await sql('postgres', `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
});

// ---------- Datos inventados ----------

async function newUser(): Promise<TestUser> {
  const email = `u${++counter}-${SUFFIX}@prueba.example`;
  const role = 'ADMIN_EMPRESA';
  const local = await prisma.user.create({ data: { email, name: 'Prueba', role } });
  const membership = await globalPrisma.tenantMembership.create({
    data: { email, passwordHash: 'sin-uso', name: 'Prueba', tenantId, role }
  });
  return { id: local.id, token: signToken({ kind: 'tenant', id: membership.id, email, tenantId, role, tokenVersion: 0 }) };
}

const addCategory = async (user: TestUser) =>
  (await prisma.category.create({ data: { userId: user.id, name: `Categoría ${++counter}` } })).id;

const memoriesOf = (user: TestUser) =>
  prisma.aiCategoryMemory.findMany({ where: { userId: user.id }, orderBy: { key: 'asc' } });

const memory = (user: TestUser, key: string) =>
  prisma.aiCategoryMemory.findUnique({ where: { userId_key: { userId: user.id, key } } });

function movementBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'EXPENSE', amount: 10, movementDate: '2026-01-15', description: 'Compra en Supermercado Central #1234',
    paymentMethod: 'CASH', ...overrides
  };
}

const api = (method: string, path: string, user: TestUser, body?: unknown) =>
  fetch(`${base}/api/movements${path}`, {
    method,
    headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

async function addMovement(user: TestUser, categoryId: number | null, overrides: Record<string, unknown> = {}) {
  const res = await api('POST', '', user, movementBody({ categoryId, ...overrides }));
  assert.equal(res.status, 201);
  return (await res.json()) as { id: number };
}

// ---------- Normalización ----------

test('normaliza a una clave estable, sin términos vacíos ni números sueltos largos', () => {
  assert.equal(normalizeMemoryKey('Compra en Supermercado Central #1234'), 'supermercado central');
  assert.equal(normalizeMemoryKey('SUPERMERCADO   CENTRAL'), 'supermercado central');
  assert.equal(normalizeMemoryKey('súpermercado céntral!!'), 'supermercado central');
  assert.equal(normalizeMemoryKey('Supermercado, Central.'), 'supermercado central');
  assert.equal(normalizeMemoryKey('Farmacia a12'), 'farmacia a12');
});

test('sin clave para lo que queda vacío, corto o sin contenido', () => {
  for (const text of [null, undefined, '', '   ', '#!?', 'ab', 'compra', 'Pago de la factura', 'Compra 12345', 'gasto x']) {
    assert.equal(normalizeMemoryKey(text), null, String(text));
  }
});

test('las palabras genéricas y los plurales no cuentan', () => {
  for (const text of [
    'compras', 'pagos', 'gastos', 'varios', 'otros', 'otras', 'cuenta', 'cuentas', 'tienda', 'local',
    'transferencia', 'depósito', 'ingreso', 'ingresos', 'retiro', 'dinero', 'dólares', 'dólar', 'USD',
    'Depósito de dinero en la cuenta'
  ]) {
    assert.equal(normalizeMemoryKey(text), null, text);
  }
  assert.equal(normalizeMemoryKey('Compras en Tienda Azul'), 'azul');
});

test('una sola palabra de menos de 4 letras no se aprende; dos sí', () => {
  assert.equal(normalizeMemoryKey('bar'), null);
  assert.equal(normalizeMemoryKey('Pago bar #99'), null);
  assert.equal(normalizeMemoryKey('cafe'), 'cafe');
  assert.equal(normalizeMemoryKey('Bar Sol'), 'bar sol');
});

test('la clave no conserva datos personales', () => {
  assert.equal(normalizeMemoryKey('transferencia juan perez cedula'), 'juan perez');
  assert.equal(normalizeMemoryKey('Pago a Juan Perez cédula 0900000000'), 'juan perez');
  assert.equal(normalizeMemoryKey('RUC 0900000000001 Panaderia Azul'), 'panaderia azul');
  assert.equal(normalizeMemoryKey('Panaderia Azul tel 099 000 0000'), 'panaderia azul');
  assert.equal(normalizeMemoryKey('Panaderia Azul teléfono 0990000000 celular'), 'panaderia azul');
  // Todo número puro, de cualquier largo, y toda palabra con 5 dígitos o más.
  assert.equal(normalizeMemoryKey('Farmacia 24'), 'farmacia');
  assert.equal(normalizeMemoryKey('Panaderia 7 Azul 12'), 'panaderia azul');
  assert.equal(normalizeMemoryKey('Panaderia cli0900000000'), 'panaderia');
  assert.equal(normalizeMemoryKey('Panaderia a1b2c3d4e5'), 'panaderia');
  assert.equal(normalizeMemoryKey('Panaderia a1234'), 'panaderia a1234');
});

test('la clave no supera 60 caracteres y no corta palabras si puede evitarlo', () => {
  const long = normalizeMemoryKey(Array.from({ length: 20 }, (_, i) => `palabra${i}`).join(' '))!;
  assert.ok(long.length <= 60);
  assert.ok(long.split(' ').every((word) => /^palabra\d+$/.test(word)), long);
  assert.equal(normalizeMemoryKey('x'.repeat(100)), 'x'.repeat(60));
});

function monthsAgo(months: number) {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

// ---------- Recordar y recuperar ----------

test('recuerda por detalle y por comercio, y prefiere el detalle', async () => {
  const user = await newUser();
  const first = await addCategory(user);
  const second = await addCategory(user);
  await recordCategoryCorrection(prisma, user.id, { vendor: 'Comercio Norte', description: 'Almuerzo oficina', categoryId: first });
  assert.deepEqual((await memoriesOf(user)).map((m) => m.key), ['almuerzo oficina', 'comercio norte']);
  assert.deepEqual(await lookupCategory(prisma, user.id, { description: 'Almuerzo oficina' }), { categoryId: first, key: 'almuerzo oficina', hits: 1 });

  await recordCategoryCorrection(prisma, user.id, { vendor: 'Comercio Norte', categoryId: first });
  assert.deepEqual(await lookupCategory(prisma, user.id, { vendor: 'Comercio Norte' }), { categoryId: first, key: 'comercio norte', hits: 2 });

  await recordCategoryCorrection(prisma, user.id, { description: 'Almuerzo oficina', categoryId: second });
  assert.deepEqual(
    await lookupCategory(prisma, user.id, { vendor: 'Comercio Norte', description: 'Almuerzo oficina' }),
    { categoryId: second, key: 'almuerzo oficina', hits: 1 }
  );
  assert.equal(await lookupCategory(prisma, user.id, { description: 'Comercio del Sur' }), null);
});

test('una sola corrección no extiende la categoría a todo el comercio', async () => {
  const user = await newUser();
  const [hogar, comida] = [await addCategory(user), await addCategory(user)];
  const vendor = 'Supermercado Central';
  await recordCategoryCorrection(prisma, user.id, { description: 'pañales en Supermercado Central', vendor, categoryId: hogar });
  assert.equal(await lookupCategory(prisma, user.id, { description: 'leche en Supermercado Central', vendor }), null);
  assert.equal(await lookupCategory(prisma, user.id, { description: 'leche', vendor }), null);
  assert.equal((await lookupCategory(prisma, user.id, { description: 'pañales en Supermercado Central', vendor }))?.categoryId, hogar);

  // La segunda igual ya lo afianza.
  await recordCategoryCorrection(prisma, user.id, { description: 'detergente', vendor, categoryId: hogar });
  assert.deepEqual(await lookupCategory(prisma, user.id, { description: 'leche', vendor }), { categoryId: hogar, key: 'supermercado central', hits: 2 });

  // Otra categoría reinicia el contador: vuelve a no bastar.
  await recordCategoryCorrection(prisma, user.id, { description: 'yogur', vendor, categoryId: comida });
  assert.equal(await lookupCategory(prisma, user.id, { description: 'leche', vendor }), null);
});

test('un recuerdo por comercio de una categoría ajena no se aplica', async () => {
  const [a, b] = [await newUser(), await newUser()];
  await prisma.aiCategoryMemory.create({ data: { userId: a.id, key: 'comercio norte', categoryId: await addCategory(b), hits: 5 } });
  assert.equal(await lookupCategory(prisma, a.id, { vendor: 'Comercio Norte' }), null);
});

test('gastos e ingresos no comparten recuerdos', async () => {
  const user = await newUser();
  const [gasto, ingreso] = [await addCategory(user), await addCategory(user)];
  const description = 'Panaderia Azul';
  await recordCategoryCorrection(prisma, user.id, { description, categoryId: gasto, type: 'EXPENSE' });
  assert.equal(await lookupCategory(prisma, user.id, { description, type: 'INCOME' }), null);
  assert.deepEqual(await relevantHints(prisma, user.id, 'panaderia', 20, 'INCOME'), []);

  await recordCategoryCorrection(prisma, user.id, { description, categoryId: ingreso, type: 'INCOME' });
  assert.deepEqual((await memoriesOf(user)).map((m) => [m.key, m.categoryId]), [
    ['ingreso:panaderia azul', ingreso],
    ['panaderia azul', gasto]
  ]);
  assert.deepEqual(await lookupCategory(prisma, user.id, { description, type: 'INCOME' }), { categoryId: ingreso, key: 'ingreso:panaderia azul', hits: 1 });

  // Sin tipo o con cualquier otro tipo, se comporta como un gasto.
  for (const type of ['EXPENSE', 'PURCHASE', 'TRANSFER', null, undefined]) {
    assert.equal((await lookupCategory(prisma, user.id, { description, type }))?.categoryId, gasto, String(type));
    assert.deepEqual(await relevantHints(prisma, user.id, 'panaderia', 20, type), [{ texto: 'panaderia azul', categoriaId: gasto }], String(type));
  }

  // Las pistas de ingresos llevan el texto sin prefijo.
  assert.deepEqual(await relevantHints(prisma, user.id, 'panaderia', 20, 'INCOME'), [{ texto: 'panaderia azul', categoriaId: ingreso }]);
});

test('un texto no puede imitar el prefijo de ingresos', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  await recordCategoryCorrection(prisma, user.id, { description: 'ingreso:panaderia azul', categoryId: category });
  assert.deepEqual((await memoriesOf(user)).map((m) => m.key), ['panaderia azul']);
  assert.equal(await lookupCategory(prisma, user.id, { description: 'panaderia azul', type: 'INCOME' }), null);
});

test('las variantes de escritura encuentran el mismo recuerdo y suman', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  await recordCategoryCorrection(prisma, user.id, { description: 'Compra en Supermercado Central #1234', categoryId: category });
  await recordCategoryCorrection(prisma, user.id, { description: 'SUPERMERCADO CÉNTRAL', categoryId: category });
  assert.deepEqual((await memoriesOf(user)).map((m) => [m.key, m.hits]), [['supermercado central', 2]]);
  for (const description of ['supermercado central', 'Súpermercado, Central!', 'pago supermercado central 9988']) {
    assert.equal((await lookupCategory(prisma, user.id, { description }))?.categoryId, category, description);
  }
});

test('la coincidencia es exacta: un texto parecido no aplica la categoría', async () => {
  const user = await newUser();
  await recordCategoryCorrection(prisma, user.id, { description: 'Supermercado Central', categoryId: await addCategory(user) });
  assert.equal(await lookupCategory(prisma, user.id, { description: 'Supermercado' }), null);
  assert.equal(await lookupCategory(prisma, user.id, { description: 'Supermercado Central Norte' }), null);
});

test('el mismo comercio y detalle cuentan una sola corrección', async () => {
  const user = await newUser();
  await recordCategoryCorrection(prisma, user.id, { vendor: 'Panaderia Azul', description: 'panaderia azul', categoryId: await addCategory(user) });
  assert.deepEqual((await memoriesOf(user)).map((m) => [m.key, m.hits]), [['panaderia azul', 1]]);
});

test('la búsqueda actualiza lastUsedAt', async () => {
  const user = await newUser();
  await recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: await addCategory(user) });
  const old = monthsAgo(1);
  await prisma.aiCategoryMemory.updateMany({ where: { userId: user.id }, data: { lastUsedAt: old } });
  await lookupCategory(prisma, user.id, { description: 'Panaderia Azul' });
  await until(async () => (await memory(user, 'panaderia azul'))!.lastUsedAt > old);
});

test('gana la última corrección y reinicia el contador', async () => {
  const user = await newUser();
  const first = await addCategory(user);
  const second = await addCategory(user);
  await recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: first });
  await recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: first });
  assert.equal((await memory(user, 'panaderia azul'))!.hits, 2);
  await recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: second });
  const row = (await memory(user, 'panaderia azul'))!;
  assert.equal(row.categoryId, second);
  assert.equal(row.hits, 1);
});

// ---------- Aislamiento ----------

test('el mismo texto guarda una categoría distinta por usuario', async () => {
  const [a, b] = [await newUser(), await newUser()];
  const [catA, catB] = [await addCategory(a), await addCategory(b)];
  await recordCategoryCorrection(prisma, a.id, { description: 'Panaderia Azul', categoryId: catA });
  assert.equal(await lookupCategory(prisma, b.id, { description: 'Panaderia Azul' }), null);
  await recordCategoryCorrection(prisma, b.id, { description: 'Panaderia Azul', categoryId: catB });
  assert.equal((await lookupCategory(prisma, a.id, { description: 'Panaderia Azul' }))?.categoryId, catA);
  assert.equal((await lookupCategory(prisma, b.id, { description: 'Panaderia Azul' }))?.categoryId, catB);
});

test('rechaza guardar una categoría de otro usuario', async () => {
  const [a, b] = [await newUser(), await newUser()];
  const foreign = await addCategory(b);
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    await recordCategoryCorrection(prisma, a.id, { description: 'Panaderia Azul', categoryId: foreign });
  } finally { warn.mock.restore(); }
  assert.deepEqual(await memoriesOf(a), []);
  assert.deepEqual(await memoriesOf(b), []);
});

test('no devuelve un recuerdo que apunte a una categoría ajena', async () => {
  const [a, b] = [await newUser(), await newUser()];
  // Solo posible por una escritura directa: la clave foránea no comprueba el dueño.
  await prisma.aiCategoryMemory.create({ data: { userId: a.id, key: 'panaderia azul', categoryId: await addCategory(b) } });
  assert.equal(await lookupCategory(prisma, a.id, { description: 'Panaderia Azul' }), null);
  assert.deepEqual(await relevantHints(prisma, a.id, 'panaderia azul'), []);
});

test('sin usuario válido no consulta nada ni ignora el filtro', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  await recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: category });
  const none = undefined as unknown as number;
  assert.equal(await lookupCategory(prisma, none, { description: 'Panaderia Azul' }), null);
  assert.deepEqual(await relevantHints(prisma, none, 'panaderia azul'), []);
  await recordCategoryCorrection(prisma, none, { description: 'Otra Panaderia', categoryId: category });
  assert.equal(await prisma.aiCategoryMemory.count({ where: { key: 'otra panaderia' } }), 0);
});

test('borrar la categoría o el usuario borra sus recuerdos', async () => {
  const user = await newUser();
  const doomed = await addCategory(user);
  const kept = await addCategory(user);
  await recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: doomed });
  await recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Roja', categoryId: kept });
  await prisma.category.delete({ where: { id: doomed } });
  assert.deepEqual((await memoriesOf(user)).map((m) => m.key), ['panaderia roja']);
  assert.equal(await lookupCategory(prisma, user.id, { description: 'Panaderia Azul' }), null);
  await prisma.user.delete({ where: { id: user.id } });
  assert.deepEqual(await memoriesOf(user), []);
});

// ---------- Tope y carreras ----------

test('no pasa de 500 recuerdos: se borran los más antiguos, solo del usuario', async () => {
  const [user, other] = [await newUser(), await newUser()];
  const category = await addCategory(user);
  const otherCategory = await addCategory(other);
  await prisma.aiCategoryMemory.create({
    data: { userId: other.id, key: 'recuerdo ajeno', categoryId: otherCategory, lastUsedAt: new Date('2000-01-01T00:00:00Z') }
  });
  await prisma.aiCategoryMemory.createMany({
    data: Array.from({ length: 500 }, (_, i) => ({
      userId: user.id, key: `panaderia ${i}`, categoryId: category, lastUsedAt: new Date(monthsAgo(1).getTime() + i * 1000)
    }))
  });
  await recordCategoryCorrection(prisma, user.id, { vendor: 'Comercio Nuevo', description: 'Detalle Nuevo', categoryId: category });

  assert.equal(await prisma.aiCategoryMemory.count({ where: { userId: user.id } }), 500);
  assert.equal(await memory(user, 'panaderia 0'), null);
  assert.equal(await memory(user, 'panaderia 1'), null);
  assert.ok(await memory(user, 'panaderia 2'));
  assert.ok(await memory(user, 'comercio nuevo'));
  assert.ok(await memory(user, 'detalle nuevo'));
  assert.ok(await memory(other, 'recuerdo ajeno'));
});

test('correcciones simultáneas iguales suman todas', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  await Promise.all(Array.from({ length: 8 }, () =>
    recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: category })));
  assert.deepEqual((await memoriesOf(user)).map((m) => [m.key, m.hits]), [['panaderia azul', 8]]);
});

test('dos correcciones simultáneas distintas dejan un solo recuerdo coherente', async () => {
  const user = await newUser();
  const [first, second] = [await addCategory(user), await addCategory(user)];
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    await Promise.all([
      recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: first }),
      recordCategoryCorrection(prisma, user.id, { description: 'Panaderia Azul', categoryId: second })
    ]);
    assert.equal(warn.mock.callCount(), 0, 'ninguna corrección debe fallar');
  } finally { warn.mock.restore(); }
  const rows = await memoriesOf(user);
  assert.equal(rows.length, 1);
  assert.ok([first, second].includes(rows[0].categoryId));
  assert.equal(rows[0].hits, 1);
});

// ---------- Caducidad ----------

test('un recuerdo de más de 12 meses no se aplica ni sale como pista; uno de 11 sí', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  await prisma.aiCategoryMemory.createMany({
    data: [
      { userId: user.id, key: 'panaderia vieja', categoryId: category, hits: 9, lastUsedAt: monthsAgo(13) },
      { userId: user.id, key: 'comercio viejo', categoryId: category, hits: 9, lastUsedAt: monthsAgo(13) },
      { userId: user.id, key: 'panaderia vigente', categoryId: category, lastUsedAt: monthsAgo(11) }
    ]
  });
  assert.equal(await lookupCategory(prisma, user.id, { description: 'Panaderia Vieja' }), null);
  assert.equal(await lookupCategory(prisma, user.id, { vendor: 'Comercio Viejo' }), null);
  assert.equal((await lookupCategory(prisma, user.id, { description: 'Panaderia Vigente' }))?.categoryId, category);
  assert.deepEqual(await relevantHints(prisma, user.id, 'panaderia'), [{ texto: 'panaderia vigente', categoriaId: category }]);

  // Consultar no lo revive: sigue caducado y solo se purga al guardar.
  assert.ok((await memory(user, 'panaderia vieja'))!.lastUsedAt < monthsAgo(12));
});

test('guardar una corrección purga los caducados, solo del usuario', async () => {
  const [user, other] = [await newUser(), await newUser()];
  const category = await addCategory(user);
  await prisma.aiCategoryMemory.createMany({
    data: [
      { userId: user.id, key: 'panaderia vieja', categoryId: category, lastUsedAt: monthsAgo(13) },
      { userId: user.id, key: 'panaderia vigente', categoryId: category, lastUsedAt: monthsAgo(11) }
    ]
  });
  await prisma.aiCategoryMemory.create({
    data: { userId: other.id, key: 'recuerdo ajeno', categoryId: await addCategory(other), lastUsedAt: monthsAgo(13) }
  });
  await recordCategoryCorrection(prisma, user.id, { description: 'Comercio Nuevo', categoryId: category });
  assert.deepEqual((await memoriesOf(user)).map((m) => m.key), ['comercio nuevo', 'panaderia vigente']);
  assert.ok(await memory(other, 'recuerdo ajeno'));
});

test('corregir sobre un recuerdo caducado empieza de cero', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  await prisma.aiCategoryMemory.create({
    data: { userId: user.id, key: 'comercio viejo', categoryId: category, hits: 9, lastUsedAt: monthsAgo(13) }
  });
  await recordCategoryCorrection(prisma, user.id, { vendor: 'Comercio Viejo', categoryId: category });
  assert.equal((await memory(user, 'comercio viejo'))!.hits, 1);
  assert.equal(await lookupCategory(prisma, user.id, { vendor: 'Comercio Viejo' }), null);
});

// ---------- Pistas ----------

test('las pistas son del usuario, comparten palabra y solo llevan texto y categoría', async () => {
  const [a, b] = [await newUser(), await newUser()];
  const [catA, catB] = [await addCategory(a), await addCategory(b)];
  await recordCategoryCorrection(prisma, a.id, { description: 'Supermercado Central', categoryId: catA });
  await recordCategoryCorrection(prisma, a.id, { description: 'Farmacia Norte', categoryId: catA });
  await recordCategoryCorrection(prisma, b.id, { description: 'Supermercado Sur', categoryId: catB });

  assert.deepEqual(await relevantHints(prisma, a.id, 'fui al SUPERMERCADO ayer'), [{ texto: 'supermercado central', categoriaId: catA }]);
  assert.deepEqual(await relevantHints(prisma, b.id, 'supermercado'), [{ texto: 'supermercado sur', categoriaId: catB }]);
  assert.deepEqual(await relevantHints(prisma, a.id, 'hoy no hay coincidencias'), []);
  // Una parte de una palabra no cuenta como compartirla.
  assert.deepEqual(await relevantHints(prisma, a.id, 'centro'), []);
  // Las palabras de menos de 4 letras no bastan.
  await recordCategoryCorrection(prisma, a.id, { description: 'Bar Sol', categoryId: catA });
  assert.deepEqual(await relevantHints(prisma, a.id, 'bar sol'), []);
  assert.deepEqual(await relevantHints(prisma, a.id, ''), []);
});

test('las pistas salen por más usadas y respetan el límite y el tope de 30', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  await prisma.aiCategoryMemory.createMany({
    data: Array.from({ length: 40 }, (_, i) => ({ userId: user.id, key: `panaderia ${i}`, categoryId: category, hits: i + 1 }))
  });
  const three = await relevantHints(prisma, user.id, 'panaderia', 3);
  assert.deepEqual(three.map((h) => h.texto), ['panaderia 39', 'panaderia 38', 'panaderia 37']);
  assert.equal((await relevantHints(prisma, user.id, 'panaderia')).length, 20);
  assert.equal((await relevantHints(prisma, user.id, 'panaderia', 500)).length, 30);
  assert.deepEqual(await relevantHints(prisma, user.id, 'panaderia', 0), []);
  assert.deepEqual(await relevantHints(prisma, user.id, 'panaderia', -5), []);
});

test('un texto vacío o solo con términos vacíos no guarda nada', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  for (const description of ['', '   ', 'compra', 'Pago de la factura #123456', null, undefined]) {
    await recordCategoryCorrection(prisma, user.id, { description, vendor: description, categoryId: category });
  }
  assert.deepEqual(await memoriesOf(user), []);
});

// ---------- Tolerancia a fallos ----------

const SECRET_TEXT = 'Supermercado Central';

function brokenPrisma() {
  const fail = async () => {
    throw Object.assign(new Error(`fallo citando ${SECRET_TEXT.toLowerCase()} y ${SECRET_TEXT}`), { code: 'P9999' });
  };
  return {
    category: { findFirst: fail },
    aiCategoryMemory: { findFirst: fail, findMany: fail, updateMany: fail, deleteMany: fail },
    $executeRaw: fail
  };
}

test('si la base falla, nada lanza y el registro no incluye el texto', async () => {
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    const broken = brokenPrisma();
    assert.equal(await lookupCategory(broken, 1, { description: SECRET_TEXT }), null);
    assert.deepEqual(await relevantHints(broken, 1, SECRET_TEXT), []);
    await recordCategoryCorrection(broken, 1, { description: SECRET_TEXT, categoryId: 1 });
    await recordCategoryCorrection({ ...broken, category: { findFirst: async () => ({ id: 1 }) } }, 1, { description: SECRET_TEXT, categoryId: 1 });
    assert.equal(warn.mock.callCount(), 4);
    const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
    assert.ok(!/supermercado|central/i.test(logged), logged);
    assert.ok(logged.includes('P9999'));
  } finally { warn.mock.restore(); }
});

test('la búsqueda responde aunque actualizar lastUsedAt falle o no termine', async () => {
  const found = { categoryId: 7, hits: 1, category: { userId: 1 } };
  const expected = { categoryId: 7, key: 'panaderia azul', hits: 1 };
  const warn = mock.method(logger, 'warn', () => undefined);
  try {
    const failing = { aiCategoryMemory: { findFirst: async () => found, updateMany: async () => { throw new Error('fallo'); } } };
    assert.deepEqual(await lookupCategory(failing, 1, { description: 'Panaderia Azul' }), expected);
    const throwing = { aiCategoryMemory: { findFirst: async () => found, updateMany: () => { throw new Error('fallo'); } } };
    assert.deepEqual(await lookupCategory(throwing, 1, { description: 'Panaderia Azul' }), expected);
    const hanging = { aiCategoryMemory: { findFirst: async () => found, updateMany: () => new Promise(() => undefined) } };
    assert.deepEqual(await lookupCategory(hanging, 1, { description: 'Panaderia Azul' }), expected);
    await pause(20);
    assert.equal(warn.mock.callCount(), 2);
  } finally { warn.mock.restore(); }
});

// ---------- PUT de movimientos, por la API real ----------

test('un PUT que cambia la categoría aprende, también desde sin categoría', async () => {
  const user = await newUser();
  const [first, second] = [await addCategory(user), await addCategory(user)];
  const movement = await addMovement(user, null, { vendor: 'Comercio Norte' });

  const res = await api('PUT', `/${movement.id}`, user, movementBody({ categoryId: first, vendor: 'Comercio Norte' }));
  assert.equal(res.status, 200);
  await until(async () => (await memoriesOf(user)).length === 2);
  assert.deepEqual((await memoriesOf(user)).map((m) => [m.key, m.categoryId, m.hits]), [
    ['comercio norte', first, 1],
    ['supermercado central', first, 1]
  ]);

  // Aprende de lo guardado tras actualizar, no del texto anterior.
  const changed = await api('PUT', `/${movement.id}`, user, movementBody({ categoryId: second, vendor: null, description: 'Detalle Corregido' }));
  assert.equal(changed.status, 200);
  await until(async () => (await memory(user, 'detalle corregido'))?.categoryId === second);
  assert.equal((await memory(user, 'comercio norte'))!.categoryId, first);
});

test('un PUT sobre un ingreso aprende aparte de los gastos', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  const body = { type: 'INCOME', description: 'Honorarios Panaderia Azul' };
  const movement = await addMovement(user, null, body);
  const res = await api('PUT', `/${movement.id}`, user, movementBody({ ...body, categoryId: category }));
  assert.equal(res.status, 200);
  await until(async () => (await memoriesOf(user)).length === 1);
  assert.deepEqual((await memoriesOf(user)).map((m) => m.key), ['ingreso:honorarios panaderia azul']);
  assert.equal(await lookupCategory(prisma, user.id, { description: body.description }), null);
  assert.equal((await lookupCategory(prisma, user.id, { description: body.description, type: 'INCOME' }))?.categoryId, category);
});

test('no aprende al crear, si la categoría no cambia, ni al quitarla', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  const movement = await addMovement(user, category);
  await pause(300);
  assert.deepEqual(await memoriesOf(user), [], 'crear no aprende');

  const same = await api('PUT', `/${movement.id}`, user, movementBody({ categoryId: category, amount: 25 }));
  assert.equal(same.status, 200);
  await pause(300);
  assert.deepEqual(await memoriesOf(user), [], 'sin cambio de categoría no aprende');

  const cleared = await api('PUT', `/${movement.id}`, user, movementBody({ categoryId: null }));
  assert.equal(cleared.status, 200);
  await pause(300);
  assert.deepEqual(await memoriesOf(user), [], 'quitar la categoría no aprende');
});

test('un PUT con categoría ajena falla y no aprende', async () => {
  const [user, other] = [await newUser(), await newUser()];
  const movement = await addMovement(user, await addCategory(user));
  // assertOwnership rechaza; sin el manejador de errores de index.ts, express responde 500.
  const res = await api('PUT', `/${movement.id}`, user, movementBody({ categoryId: await addCategory(other) }));
  assert.notEqual(res.status, 200);
  await pause(200);
  assert.deepEqual(await memoriesOf(user), []);
});

test('un fallo de la memoria no rompe el PUT', async () => {
  const user = await newUser();
  const category = await addCategory(user);
  const movement = await addMovement(user, null);
  const warn = mock.method(logger, 'warn', () => undefined);
  // Fallo real: la tabla no está, igual que en una empresa aún sin sincronizar.
  await sql(DB_TENANT, 'ALTER TABLE "AiCategoryMemory" RENAME TO "AiCategoryMemoryOculta"');
  try {
    const res = await api('PUT', `/${movement.id}`, user, movementBody({ categoryId: category }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { categoryId: number }).categoryId, category);
    await until(async () => warn.mock.callCount() > 0);
    const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
    assert.ok(!/supermercado/i.test(logged), logged);
  } finally {
    await sql(DB_TENANT, 'ALTER TABLE "AiCategoryMemoryOculta" RENAME TO "AiCategoryMemory"');
    warn.mock.restore();
  }
  assert.equal((await prisma.movement.findUnique({ where: { id: movement.id } }))!.categoryId, category);
});
