// Pruebas de comportamiento del bot de WhatsApp con la IA falsa: se intercepta fetch y todo lo
// demás es real (reglas, memoria, creación de movimientos y PostgreSQL). Crean una base global y
// una de empresa propias, y las borran al terminar. No usan clave ni llaman a ningún proveedor.
// Uso: npm run test:ai
process.env.TZ = 'UTC'; // como un contenedor: de noche en Ecuador, aquí ya es el día siguiente.
process.env.LOG_LEVEL = 'silent';

import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import sharp from 'sharp';
import { EVAL_CATALOG } from '../evals/catalog';
import { resolveExpectedDate, scoreCase, validateCases, type EvalCase } from '../evals/score';
import { computeAmountStats, type ParsedMovement } from '../src/whatsapp/parser';
import type { IncomingMessage } from '../src/whatsapp/gateway';
import { fieldsInDoubt } from '../evals/score';
import { STRICT_NO, STRICT_YES, isValidCategoryName, parseAmountReply, parseDateReply, parseOptionIndex } from '../src/whatsapp/replies';

const SUFFIX = randomBytes(4).toString('hex');
const DB_GLOBAL = `finanzas_test_ai_${SUFFIX}`;
const DB_TENANT = `finanzas_test_ai_${SUFFIX}_t`;
const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT } = process.env;
const credentials = `${encodeURIComponent(POSTGRES_USER!)}:${encodeURIComponent(POSTGRES_PASSWORD!)}`;
const urlFor = (db: string) => `postgresql://${credentials}@${POSTGRES_HOST}:${POSTGRES_PORT}/${db}`;
process.env.GLOBAL_DATABASE_URL = `${urlFor(DB_GLOBAL)}?schema=public`;

const FAKE_KEY = 'clave-falsa-de-prueba';
const realFetch = globalThis.fetch;

let handleIncoming: typeof import('../src/whatsapp/pipeline').handleIncoming;
let parseMovement: typeof import('../src/whatsapp/parser').parseMovement;
let recordCategoryCorrection: typeof import('../src/whatsapp/aiMemory').recordCategoryCorrection;
let runEval: typeof import('../evals/run-movement-eval').runEval;
let formatReport: typeof import('../evals/run-movement-eval').formatReport;
let isProtectedPath: typeof import('../evals/run-movement-eval').isProtectedPath;
let todayEcuador: typeof import('../src/lib/ecuadorDate').todayEcuador;
let globalPrisma: typeof import('../src/lib/globalPrisma').globalPrisma;
let disconnectAll: () => Promise<void>;
let prisma: any;
let tenantId: string;
let counter = 0;

// ---- IA falsa ----
const llm = {
  answer: {} as Record<string, unknown>,
  respond: null as null | ((body: any) => Response),
  target: 'movement',
  transcript: '',
  prompts: [] as string[],
  users: [] as string[]
};

function fakeFetch(input: any, init?: any): Promise<Response> {
  const url = String(input?.url ?? input);
  if (url.endsWith('/audio/transcriptions')) return Promise.resolve(new Response(JSON.stringify({ text: llm.transcript }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  if (!url.endsWith('/chat/completions')) throw new Error(`Llamada de red inesperada: ${url}`);
  const body = JSON.parse(init.body);
  const system: string = body.messages[0].content;
  if (llm.respond) return Promise.resolve(llm.respond(body));
  const content = system.startsWith('Eres un enrutador')
    ? JSON.stringify({ target: llm.target })
    : JSON.stringify(llm.answer);
  if (!system.startsWith('Eres un enrutador')) { llm.prompts.push(system); llm.users.push(body.messages[1].content); }
  return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

/** Respuesta de la IA para un gasto en efectivo, sin cuenta ni categoría. */
function aiSays(over: Partial<ParsedMovement> = {}): void {
  llm.prompts = [];
  llm.users = [];
  llm.respond = null;
  llm.target = 'movement';
  llm.answer = {
    understood: true, intent: 'register', type: 'EXPENSE', amount: 20, description: 'Supermercado', bankHint: null,
    accountId: null, toAccountId: null, cardId: null, categoryId: null, categoryCandidates: [], paymentMethod: 'CASH',
    date: null, isCredit: false, vendor: null, familyMember: null, notes: null, clarification: null, ...over
  };
}

// ---- Base de datos ----
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

/** Da tiempo a que termine lo que se lanza sin esperar, para comprobar que no ocurrió. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Usuario nuevo con su propio catálogo: cada prueba tiene su historial y su memoria. */
async function newUser() {
  const n = ++counter;
  const user = await prisma.user.create({ data: { email: `usuario${n}@prueba.example`, name: 'Usuario de prueba' } });
  const account = (name: string, bankName: string, accountKind: string, accountNumber: string) =>
    prisma.account.create({ data: { userId: user.id, name, type: 'BANK', bankName, accountKind, accountNumber, initialBalance: 1000, currentBalance: 1000 } });
  const ahorros = await account('Ahorros Andino', 'Banco Andino', 'SAVINGS', '2200001234');
  const corriente = await account('Corriente Andino', 'Banco Andino', 'CHECKING', '3300005678');
  const category = (name: string) => prisma.category.create({ data: { userId: user.id, name } });
  const comida = await category('Alimentación');
  const salud = await category('Salud');
  const hogar = await category('Hogar');
  const chatId = `chat-${n}@prueba`;

  /** Envía un mensaje al bot real y devuelve lo que contestó. */
  const send = async (fields: Pick<IncomingMessage, 'text' | 'audio' | 'image'>): Promise<string> => {
    const replies: string[] = [];
    await handleIncoming({ tenantId, userId: user.id, chatId, ...fields, reply: async (r) => { replies.push(r); } });
    return replies.join('\n');
  };
  const say = (text: string) => send({ text, audio: null, image: null });
  const movements = () => prisma.movement.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
  const memories = () => prisma.aiCategoryMemory.findMany({ where: { userId: user.id } });
  return { user, ahorros, corriente, comida, salud, hogar, say, send, movements, memories };
}

before(async () => {
  await sql('postgres', `CREATE DATABASE "${DB_GLOBAL}"`);
  await sql('postgres', `CREATE DATABASE "${DB_TENANT}"`);
  execSync('npx prisma db push --schema=prisma/global/schema.prisma --skip-generate', { stdio: 'ignore', env: process.env });
  execSync('npx prisma db push --schema=prisma/tenant/schema.prisma --skip-generate', {
    stdio: 'ignore',
    env: { ...process.env, TENANT_DATABASE_URL: `${urlFor(DB_TENANT)}?schema=public` }
  });

  ({ globalPrisma } = await import('../src/lib/globalPrisma'));
  const { encryptConnection, encryptString } = await import('../src/lib/tenantCrypto');
  const tenantPrisma = await import('../src/lib/tenantPrisma');
  disconnectAll = tenantPrisma.disconnectAllTenantClients;
  ({ handleIncoming } = await import('../src/whatsapp/pipeline'));
  ({ parseMovement } = await import('../src/whatsapp/parser'));
  ({ recordCategoryCorrection } = await import('../src/whatsapp/aiMemory'));
  ({ runEval, formatReport, isProtectedPath } = await import('../evals/run-movement-eval'));
  ({ todayEcuador } = await import('../src/lib/ecuadorDate'));

  const enc = encryptConnection({ user: POSTGRES_USER!, password: POSTGRES_PASSWORD! });
  const tenant = await globalPrisma.tenant.create({ data: { slug: `ai-${SUFFIX}`, legalName: 'Empresa de prueba', email: 'empresa@prueba.example' } });
  await globalPrisma.tenantConnection.create({
    data: { tenantId: tenant.id, dbHost: POSTGRES_HOST!, dbPort: Number(POSTGRES_PORT), dbName: DB_TENANT, dbUserCipher: enc.userCipher, dbPasswordCipher: enc.passwordCipher }
  });
  tenantId = tenant.id;
  prisma = await tenantPrisma.getTenantPrisma(tenantId);
  await prisma.aiConfig.create({ data: { id: 1, provider: 'groq', apiKeyEnc: encryptString(FAKE_KEY), model: 'modelo-de-prueba', enabled: true } });
  globalThis.fetch = fakeFetch as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await disconnectAll?.();
  await globalPrisma?.$disconnect();
  await sql('postgres', `DROP DATABASE IF EXISTS "${DB_TENANT}" WITH (FORCE)`);
  await sql('postgres', `DROP DATABASE IF EXISTS "${DB_GLOBAL}" WITH (FORCE)`);
});

// ---- Registro normal ----
test('registrar lo normal no añade preguntas: resumen, SÍ y queda creado', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id, categoryCandidates: [u.comida.id] });

  const summary = await u.say('gasté 20 en el súper en efectivo');
  assert.match(summary, /Alimentación/);
  assert.match(summary, /Responde \*SÍ\* o \*NO\*, o \*CATEGORÍA\* para cambiarla\./);
  assert.doesNotMatch(summary, /\?\n1\./);

  assert.match(await u.say('sí'), /Registrado/);
  const [row] = await u.movements();
  assert.equal(Number(row.amount), 20);
  assert.equal(row.categoryId, u.comida.id);
  assert.equal(row.paymentMethod, 'CASH');
});

test('la confirmación admite SÍ con y sin tilde, y no la confunde con otra palabra', async () => {
  for (const yes of ['sí', 'SÍ', 'si', 'Sí, dale', 'ok', '👍']) {
    const u = await newUser();
    aiSays({ categoryId: u.comida.id });
    await u.say('gasté 20 en el súper en efectivo');
    assert.match(await u.say(yes), /Registrado/, yes);
  }
  const u = await newUser();
  aiSays({ categoryId: u.comida.id });
  await u.say('gasté 20 en el súper en efectivo');
  assert.match(await u.say('sino mejor otro gasto'), /Aún no registré nada/);
  assert.equal((await u.movements()).length, 0);
});

test('en la confirmación, solo un SÍ entero registra; lo demás no registra ni reemplaza el borrador', async () => {
  const phrases = ['sí, pero son 30', 'va a ser 30', 'ok gasté 99 en taxi', 'si no me equivoco fueron 30', 'sí?', 'correcto no', 'dale no', 'gasté 15 en taxi', 'no sé', 'no, espera'];
  const u = await newUser();
  aiSays({ categoryId: u.comida.id });
  await u.say('gasté 20 en el súper en efectivo');
  const calls = llm.prompts.length;
  for (const phrase of phrases) {
    const reply = await u.say(phrase);
    assert.match(reply, /Aún no registré nada\. Responde \*SÍ\*, \*NO\* o \*CATEGORÍA\*\./, phrase);
    assert.equal((await u.movements()).length, 0, phrase);
  }
  assert.equal(llm.prompts.length, calls, 'no se volvió a interpretar nada');
  // El borrador sigue siendo el original.
  assert.match(await u.say('¡Sí!'), /Registrado: \*Gasto\* \$20,00/);
  assert.equal((await u.movements()).length, 1);
});

test('NO y cancelar enteros anulan en la confirmación', async () => {
  for (const no of ['no', 'NO.', 'cancelar', 'cancela', 'no, gracias', '❌']) {
    const u = await newUser();
    aiSays({ categoryId: u.comida.id });
    await u.say('gasté 20 en el súper en efectivo');
    assert.match(await u.say(no), /Cancelado/, no);
    assert.equal((await u.movements()).length, 0, no);
  }
});

test('los regex estrictos aceptan el mensaje entero y nada más', () => {
  for (const yes of ['sí', 'SÍ', 'si', 'Sí.', '¡sí!', 'ok', 'okay', 'dale', 'listo', 'correcto', 'confirmo', 'regístralo', 'de una', 'sí, dale', 'sí por favor', 'sí 👍', '👍', '👍🏽', '✅']) assert.ok(STRICT_YES.test(yes), yes);
  for (const notYes of ['sí, pero son 30', 'va a ser 30', 'ok gasté 99 en taxi', 'si no me equivoco fueron 30', 'sí?', '¿sí?', 'correcto no', 'dale no', 'sino', 'vamos', '']) assert.ok(!STRICT_YES.test(notYes), notYes);
  for (const no of ['no', 'No.', 'cancelar', 'cancela', 'no no', 'olvídalo', 'no, gracias', '❌']) assert.ok(STRICT_NO.test(no), no);
  for (const notNo of ['no sé', 'no son 30', 'cancela los 30', 'nota', 'no?']) assert.ok(!STRICT_NO.test(notNo), notNo);
});

test('entities: "sí" con tilde confirma, y una respuesta a medias no', async () => {
  const u = await newUser();
  const count = () => prisma.debt.count({ where: { userId: u.user.id } });
  await u.say('2');              // menú: deuda o cobro
  await u.say('1');              // por cobrar
  await u.say('500');
  await u.say('Cliente de prueba');
  assert.match(await u.say('sin fecha'), /¿Lo registro\?/);
  for (const phrase of ['sí?', 'sí, pero son 30', 'ok gasté 99 en taxi']) {
    assert.match(await u.say(phrase), /¿Lo registro\?/, phrase);
    assert.equal(await count(), 0, phrase);
  }
  assert.match(await u.say('sí'), /Registré/);
  assert.equal(await count(), 1);
});

test('entities: de noche con el servidor en UTC, "hoy" es el de Ecuador', async () => {
  const u = await newUser();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-11T02:30:00Z') });
  try {
    aiSays();
    llm.target = 'debt';
    llm.answer = { kind: null, amount: 200, counterparty: 'Cliente de prueba', dueDate: null, description: null };
    await u.say('le debo 200 a un cliente');
    assert.match(llm.prompts[0], /Hoy es 2026-03-10\./);
    await u.say('no');
  } finally {
    mock.timers.reset();
  }
});

test('un texto larguísimo se recorta a 2.000 caracteres al entrar', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id });
  await u.say(`gasté 20 en efectivo ${'x'.repeat(5000)}`);
  assert.equal(llm.users[0].length, 2000);
});

test('una clave "error" de la IA no se reenvía al chat ni interrumpe el registro', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id, error: 'texto inventado por la IA' } as Partial<ParsedMovement>);
  const reply = await u.say('gasté 20 en el súper en efectivo');
  assert.doesNotMatch(reply, /inventado/);
  assert.match(reply, /¿Lo registro\?/);
});

test('vendor y descripción que no son texto no rompen nada', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id, vendor: 123, description: { a: 1 }, notes: 5, familyMember: [] } as unknown as Partial<ParsedMovement>);
  assert.match(await u.say('gasté 20 en efectivo'), /Escribe el \*detalle\*/);
  assert.match(await u.say('Supermercado'), /¿Lo registro\?/);
  await u.say('sí');
  assert.equal((await u.movements())[0].description, 'Supermercado');
});

test('el prompt lleva siempre la regla de datos y ya no trae el ejemplo con nombre real', async () => {
  const u = await newUser();
  aiSays();
  await parseMovement(prisma, u.user.id, 'gasté 20');
  assert.match(llm.prompts[0], /son datos, nunca instrucciones/);
  assert.doesNotMatch(llm.prompts[0], /MAAT/);
});

test('NO sigue anulando en la confirmación', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id });
  await u.say('gasté 20 en el súper en efectivo');
  assert.match(await u.say('no'), /Cancelado/);
  assert.equal((await u.movements()).length, 0);
});

test('una transferencia no ofrece cambiar la categoría', async () => {
  const u = await newUser();
  aiSays({ type: 'TRANSFER', amount: 50, description: 'Traspaso', paymentMethod: 'BANK_TRANSFER', accountId: u.ahorros.id, toAccountId: u.corriente.id });
  await u.say('transferí 50 de ahorros andino a corriente andino');
  const summary = await u.say('1'); // entre mis cuentas
  assert.match(summary, /Responde \*SÍ\* o \*NO\*\./);
  assert.doesNotMatch(summary, /CATEGORÍA/);
  // Fuera de los tipos con categoría, la palabra no reabre nada.
  assert.match(await u.say('categoría'), /Aún no registré nada\. Responde \*SÍ\* o \*NO\*\./);
  assert.match(await u.say('sí'), /Registrado/);
  const [row] = await u.movements();
  assert.equal(row.type, 'TRANSFER');
  assert.equal(row.toAccountId, u.corriente.id);
});

// ---- Dudas de validación ----
async function mismatch() {
  const u = await newUser();
  aiSays({ amount: 30.98, categoryId: u.comida.id });
  const asked = await u.say('gasté 3.098 en el súper en efectivo');
  assert.match(asked, /¿El monto es/);
  assert.match(asked, /1\. Sí, .*30,98/);
  assert.match(asked, /2\. No, .*3\.098/);
  assert.match(asked, /escribe el monto correcto/);
  return u;
}

test('monto que no coincide: se resuelve por número de opción', async () => {
  const u = await mismatch();
  assert.match(await u.say('2'), /¿Lo registro\?/);
  assert.match(await u.say('sí'), /Registrado/);
  assert.equal(Number((await u.movements())[0].amount), 3098);
});

test('monto que no coincide: la opción 1 conserva lo entendido', async () => {
  const u = await mismatch();
  await u.say('1');
  await u.say('sí');
  assert.equal(Number((await u.movements())[0].amount), 30.98);
});

test('monto que no coincide: se puede escribir el monto, y una cifra con miles no es una opción', async () => {
  for (const [typed, expected] of [['3.100', 3100], ['2.500', 2500], ['1,250.50', 1250.5], ['no, son 45,20', 45.2], ['20', 20]] as const) {
    const u = await mismatch();
    assert.match(await u.say(typed), /¿Lo registro\?/, typed);
    await u.say('sí');
    assert.equal(Number((await u.movements())[0].amount), expected, typed);
  }
});

test('monto que no coincide: responde con palabras', async () => {
  for (const [typed, expected] of [['sí', 30.98], ['no', 3098]] as const) {
    const u = await mismatch();
    assert.match(await u.say(typed), /¿Lo registro\?/, typed);
    await u.say('sí');
    assert.equal(Number((await u.movements())[0].amount), expected, typed);
  }
});

test('monto que no coincide: las frases exactas de opción y de monto', async () => {
  const table = [['la 2', 3098], ['el 2', 3098], ['2 por favor', 3098], ['no, la 2', 3098], ['la opción 2', 3098], ['la 1', 30.98], ['no, 3 mil', 3000], ['son 3 mil 98', 3098], ['24 con 50', 24.5], ['no son 30 son 40', 40]] as const;
  for (const [typed, expected] of table) {
    const u = await mismatch();
    assert.match(await u.say(typed), /¿Lo registro\?/, typed);
    await u.say('sí');
    assert.equal(Number((await u.movements())[0].amount), expected, typed);
  }
});

test('una frase en una pregunta de monto vuelve a preguntar sin tocar el borrador', async () => {
  const u = await mismatch();
  const calls = llm.prompts.length;
  for (const phrase of ['pagué 15 de taxi', 'quizá', 'sí, pero son 30', 'va a ser 30', 'si no me equivoco fueron 30', 'la 7', 'no', 'no sé']) {
    const reply = await u.say(phrase);
    if (phrase === 'no') { // "No, $3.098" es la única opción negativa: se elige.
      assert.match(reply, /¿Lo registro\?/);
      break;
    }
    assert.match(reply, /No te entendí\. Para anular el movimiento escribe \*cancelar\*[\s\S]*¿El monto es/, phrase);
  }
  assert.equal(llm.prompts.length, calls);
  await u.say('sí');
  assert.equal(Number((await u.movements())[0].amount), 3098);
});

test('"cancelar" y "cancela los 30" anulan en una duda', async () => {
  for (const phrase of ['cancelar', 'cancela los 30']) {
    const u = await mismatch();
    assert.match(await u.say(phrase), /Cancelado/, phrase);
    assert.equal((await u.movements()).length, 0, phrase);
  }
});

const smallPng = () => sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } }).png().toBuffer();

test('un pie de foto durante una duda no es una respuesta: guarda la foto y repite la pregunta', async () => {
  const u = await mismatch();
  const image = { buffer: await smallPng(), mimetype: 'image/png' };
  for (const caption of ['2', 'sí', 'cancelar']) {
    const reply = await u.send({ text: caption, audio: null, image });
    assert.match(reply, /Foto guardada/, caption);
    assert.match(reply, /¿El monto es/, caption);
  }
  assert.match(await u.say('2'), /¿Lo registro\?/);
  assert.match(await u.say('sí'), /3 comprobantes adjuntados/);
  const [row] = await u.movements();
  assert.equal(Number(row.amount), 3098);
  assert.equal(await prisma.attachment.count({ where: { userId: u.user.id, entityId: row.id } }), 3);
});

test('un pie de foto "sí" en la confirmación no registra', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id });
  await u.say('gasté 20 en el súper en efectivo');
  const reply = await u.send({ text: 'sí', audio: null, image: { buffer: await smallPng(), mimetype: 'image/png' } });
  assert.match(reply, /Foto guardada[\s\S]*Responde \*SÍ\*, \*NO\* o \*CATEGORÍA\*/);
  assert.equal((await u.movements()).length, 0);
  assert.match(await u.say('sí'), /1 comprobante adjuntado/);
});

test('por audio: un SÍ confirma, y una instrucción nueva no reemplaza el borrador', async () => {
  const u = await newUser();
  const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/ogg' };
  aiSays({ categoryId: u.comida.id });
  await u.say('gasté 20 en el súper en efectivo');
  llm.transcript = 'Gasté 15 en taxi.';
  assert.match(await u.send({ text: null, audio, image: null }), /Aún no registré nada/);
  llm.transcript = 'Sí.';
  assert.match(await u.send({ text: null, audio, image: null }), /Registrado: \*Gasto\* \$20,00/);
});

test('fecha dudosa: acepta la fecha escrita, y "no, era ayer" no cancela', async () => {
  const table = [['ayer', '2026-03-19'], ['hoy', '2026-03-20'], ['anteayer', '2026-03-18'], ['el 15', '2026-03-15'], ['15/03', '2026-03-15'], ['15/03/2026', '2026-03-15'], ['15 de marzo', '2026-03-15'], ['no, era ayer', '2026-03-19']] as const;
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-20T15:00:00Z') });
  try {
    for (const [typed, expected] of table) {
      const u = await newUser();
      aiSays({ categoryId: u.comida.id, date: '2026-04-01' });
      assert.match(await u.say('gasté 20 en el súper en efectivo'), /es futura/, typed);
      assert.match(await u.say(typed), /¿Lo registro\?/, typed);
      await u.say('sí');
      assert.equal((await u.movements())[0].movementDate.toISOString().slice(0, 10), expected, typed);
    }
  } finally {
    mock.timers.reset();
  }
});

test('fecha dudosa: una fecha futura o de hace más de un año, o un texto, vuelve a preguntar', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-20T15:00:00Z') });
  try {
    const u = await newUser();
    aiSays({ categoryId: u.comida.id, date: '2026-04-01' });
    await u.say('gasté 20 en el súper en efectivo');
    for (const typed of ['25/03', 'el 25', '15/03/2024', '19/03/2025']) assert.match(await u.say(typed), /futura o tiene más de un año[\s\S]*es futura/, typed);
    assert.match(await u.say('quién sabe'), /No te entendí/);
    assert.match(await u.say('20/03/2025'), /¿Lo registro\?/); // 365 días exactos todavía valen
  } finally {
    mock.timers.reset();
  }
});

test('lectores de respuestas: casos límite', () => {
  assert.equal(parseOptionIndex('no, la 2'), 2);
  assert.equal(parseOptionIndex('2.'), 2);
  assert.equal(parseOptionIndex('3.098'), null);
  assert.equal(parseOptionIndex('gasté 2 en taxi'), null);
  assert.equal(parseAmountReply('$3.098,50'), 3098.5);
  assert.equal(parseAmountReply('20 dólares'), 20);
  assert.equal(parseAmountReply('24 dólares con 50 centavos'), 24.5);
  assert.equal(parseAmountReply('no, son 45,20'), 45.2);
  assert.equal(parseAmountReply('pagué 15 de taxi'), null);
  assert.equal(parseAmountReply('no'), null);
  assert.equal(parseAmountReply('0'), null);
  assert.deepEqual(parseDateReply('31/02', '2026-03-20'), null);
  assert.deepEqual(parseDateReply('no sé', '2026-03-20'), null);
  assert.deepEqual(parseDateReply('15 de enero del 2026', '2026-03-20'), { date: '2026-01-15' });
  assert.deepEqual(parseDateReply('ayer', '2026-01-01'), { date: '2025-12-31' });
  assert.ok(isValidCategoryName('Plan 5G'));
  assert.ok(!isValidCategoryName('a'.repeat(41)));
  assert.ok(!isValidCategoryName('una dos tres cuatro cinco'));
  assert.ok(!isValidCategoryName('salud!'));
});

test('monto inusual: con una sola opción no se autorresuelve, y admite número o monto escrito', async () => {
  for (const [typed, expected] of [['1', 5000], ['50', 50], ['sí', 5000]] as const) {
    const u = await newUser();
    await prisma.movement.createMany({
      data: Array.from({ length: 12 }, () => ({ userId: u.user.id, type: 'EXPENSE', amount: 10, movementDate: new Date('2026-01-10'), description: 'Historial', paymentMethod: 'CASH' }))
    });
    aiSays({ amount: 5000, categoryId: u.comida.id });
    const asked = await u.say('gasté 5000 en el súper en efectivo');
    assert.match(asked, /monto inusual/, typed);
    assert.match(asked, /1\. Sí/, typed);
    assert.match(await u.say(typed), /¿Lo registro\?/, typed);
    await u.say('sí');
    assert.equal(Number((await u.movements()).at(-1).amount), expected, typed);
  }
});

test('fecha futura: se pregunta antes que nada y aplica a la fecha del movimiento', async () => {
  const today = todayEcuador();
  const future = resolveExpectedDate('hoy-0', today).replace(/^\d{4}/, (y) => String(Number(y) + 1));
  for (const [typed, expected] of [['2', today], ['usar hoy', today], ['no, usar hoy', today], ['1', future], ['sí', future]] as const) {
    const u = await newUser();
    aiSays({ date: future, paymentMethod: null }); // faltan método y categoría: van después
    const asked = await u.say('gasté 20 en el súper');
    assert.match(asked, /es futura/, typed);
    assert.doesNotMatch(asked, /método de pago/, typed);
    assert.match(await u.say(typed), /método de pago/, typed);
    await u.say('1'); // efectivo
    await u.say('Alimentación');
    await u.say('sí');
    assert.equal((await u.movements())[0].movementDate.toISOString().slice(0, 10), expected, typed);
  }
});

test('un monto dudoso y una fecha dudosa se preguntan por orden', async () => {
  const u = await newUser();
  const today = todayEcuador();
  const future = today.replace(/^\d{4}/, (y) => String(Number(y) + 1));
  aiSays({ amount: 30.98, date: future, categoryId: u.comida.id });
  assert.match(await u.say('gasté 3.098 en el súper en efectivo'), /¿El monto es/);
  assert.match(await u.say('2'), /es futura/);
  assert.match(await u.say('2'), /¿Lo registro\?/);
  await u.say('sí');
  const [row] = await u.movements();
  assert.equal(Number(row.amount), 3098);
  assert.equal(row.movementDate.toISOString().slice(0, 10), today);
});

test('una cuenta que el usuario no mencionó se quita y pasa a preguntarse', async () => {
  const u = await newUser();
  aiSays({ accountId: u.corriente.id, paymentMethod: 'BANK_TRANSFER', categoryId: u.comida.id });
  const asked = await u.say('pagué 20 del súper por transferencia');
  assert.match(asked, /¿De qué \*cuenta\*\?/);
  assert.match(asked, /Ahorros Andino/);
  assert.match(asked, /Corriente Andino/);
  await u.say('1'); // el orden es alfabético: Ahorros Andino
  await u.say('sí');
  assert.equal((await u.movements())[0].accountId, u.ahorros.id);
});

test('una cuenta mencionada no se pregunta', async () => {
  const u = await newUser();
  aiSays({ accountId: u.corriente.id, paymentMethod: 'BANK_TRANSFER', categoryId: u.comida.id });
  assert.match(await u.say('pagué 20 del súper por transferencia de corriente andino'), /¿Lo registro\?/);
});

// ---- Corregir y aprender ----
test('CATEGORÍA reabre la pregunta con candidatas, vuelve a confirmar y aprende', async () => {
  const u = await newUser();
  aiSays({ description: 'Veterinaria Patitas', vendor: 'Veterinaria Patitas', categoryId: u.comida.id, categoryCandidates: [u.comida.id, u.salud.id] });
  await u.say('gasté 20 en Veterinaria Patitas en efectivo');

  const reopened = await u.say('CATEGORÍA');
  assert.match(reopened, /¿Qué \*categoría\*\?/);
  assert.match(reopened, /1\. Alimentación/);
  assert.match(reopened, /2\. Salud/);
  assert.doesNotMatch(reopened, /Hogar/);

  const again = await u.say('2');
  assert.match(again, /Salud/);
  assert.match(again, /¿Lo registro\?/);
  await u.say('sí');
  assert.equal((await u.movements())[0].categoryId, u.salud.id);

  await until(async () => (await u.memories()).length > 0);
  const memories = await u.memories();
  assert.ok(memories.every((m: any) => m.categoryId === u.salud.id));
  assert.ok(memories.some((m: any) => m.key === 'veterinaria patitas'));
});

test('el comercio se aprende aunque el tipo de movimiento no lo guarde', async () => {
  const u = await newUser();
  aiSays({ description: 'Comida', vendor: 'Bodega Luna', categoryId: u.comida.id });
  await u.say('gasté 20 en Bodega Luna en efectivo');
  await u.say('categoría');
  await u.say('Salud');
  await u.say('sí');
  assert.equal((await u.movements())[0].vendor, null);
  await until(async () => (await u.memories()).some((m: any) => m.key === 'bodega luna'));
});

test('tras CATEGORÍA, escribir "sí" deja la que estaba, sin crear una categoría ni aprender', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id, categoryCandidates: [u.comida.id] });
  await u.say('gasté 20 en el súper en efectivo');
  await u.say('categoria');
  assert.match(await u.say('listo'), /¿Lo registro\?/);
  await u.say('sí');
  assert.equal((await u.movements())[0].categoryId, u.comida.id);
  assert.equal(await prisma.category.count({ where: { userId: u.user.id, name: 'listo' } }), 0);
  await settle();
  assert.equal((await u.memories()).length, 0);
});

test('CATEGORÍA y volver a elegir la propuesta no enseña nada', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id, categoryCandidates: [u.comida.id, u.salud.id] });
  await u.say('gasté 20 en el súper en efectivo');
  await u.say('CATEGORÍA');
  await u.say('1');
  await u.say('sí');
  await settle();
  assert.equal((await u.memories()).length, 0);
});

test('una categoría creada por texto libre se usa pero no se aprende', async () => {
  const u = await newUser();
  aiSays({ description: 'Peluquería canina', categoryId: u.comida.id, categoryCandidates: [u.comida.id] });
  await u.say('gasté 20 en peluquería canina en efectivo');
  await u.say('CATEGORÍA');
  assert.match(await u.say('Mascotas'), /Categoría \*Mascotas\* creada/);
  await u.say('sí');
  const created = await prisma.category.findFirst({ where: { userId: u.user.id, name: 'Mascotas' } });
  assert.equal((await u.movements())[0].categoryId, created.id);
  await settle();
  assert.equal((await u.memories()).length, 0);
});

test('la categoría creada con la opción "Crear nueva" es una elección deliberada: se aprende', async () => {
  const u = await newUser();
  aiSays({ description: 'Peluquería canina' });
  const asked = await u.say('gasté 20 en peluquería canina en efectivo');
  const option = asked.match(/(\d+)\. ➕ Crear nueva categoría/)![1];
  assert.match(await u.say(option), /nombre\* de la nueva categoría/);
  assert.match(await u.say('gasté 15 en taxi'), /Ese nombre no me sirve/);
  assert.match(await u.say('no'), /Ese nombre no me sirve/);
  await u.say('Mascotas');
  await u.say('sí');
  const created = await prisma.category.findFirst({ where: { userId: u.user.id, name: 'Mascotas' } });
  await until(async () => (await u.memories()).some((m: any) => m.categoryId === created.id));
});

test('en la pregunta de categoría, una respuesta o una frase no crea categoría: repregunta', async () => {
  const u = await newUser();
  aiSays({ description: 'Varios' });
  await u.say('gasté 20 en varios en efectivo');
  const before = await prisma.category.count({ where: { userId: u.user.id } });
  for (const phrase of ['ninguna', 'listo', 'sí', 'no', 'gasté 15 en taxi', 'gasté 15 en salud', 'gasté en taxi', 'esto tiene muchas palabras de más', 'a@b', 'a'.repeat(41)]) {
    const reply = await u.say(phrase);
    assert.match(reply, /No te entendí[\s\S]*¿Qué \*categoría\*\?/, phrase);
    assert.doesNotMatch(reply, /creada/, phrase);
  }
  assert.equal(await prisma.category.count({ where: { userId: u.user.id } }), before);
  assert.match(await u.say('cancelar'), /Cancelado/);
});

test('al reabrir, "sí, salud" elige Salud; "sí, algo" repregunta sin conservar en silencio', async () => {
  const u = await newUser();
  aiSays({ description: 'Consulta', categoryId: u.comida.id, categoryCandidates: [u.comida.id] });
  await u.say('gasté 20 en consulta en efectivo');
  await u.say('categoría');
  assert.match(await u.say('sí, otra cosa'), /No te entendí[\s\S]*¿Qué \*categoría\*\?/);
  const summary = await u.say('sí, salud');
  assert.match(summary, /Salud/);
  await u.say('sí');
  assert.equal((await u.movements())[0].categoryId, u.salud.id);
  assert.equal(await prisma.category.count({ where: { userId: u.user.id, name: { contains: 'otra' } } }), 0);
});

test('el comercio que la IA supuso no se aprende; el que el usuario dijo, sí', async () => {
  const u = await newUser();
  aiSays({ description: 'Compra varia', vendor: 'Comercio Supuesto', categoryId: u.comida.id });
  await u.say('gasté 20 en compra varia en efectivo');
  await u.say('categoría');
  await u.say('Salud');
  await u.say('sí');
  await until(async () => (await u.memories()).length > 0);
  const keys = (await u.memories()).map((m: any) => m.key);
  assert.ok(keys.includes('varia'), keys.join());
  assert.ok(!keys.some((k: string) => k.includes('supuesto')), keys.join());
});

test('los recuerdos respetan el tipo: lo aprendido en un ingreso no se aplica a un gasto', async () => {
  const u = await newUser();
  aiSays({ type: 'INCOME', description: 'Trabajo extra' });
  await u.say('me pagaron 20 por trabajo extra en efectivo');
  await u.say('Salud');
  await u.say('sí');
  await until(async () => (await u.memories()).length > 0);

  aiSays({ type: 'EXPENSE', description: 'Trabajo extra', categoryId: u.comida.id });
  const expense = await parseMovement(prisma, u.user.id, 'gasté 20 en trabajo extra') as ParsedMovement;
  assert.equal(expense.categoryId, u.comida.id);
  assert.equal(expense.categoryFromMemory, undefined);
  assert.ok(llm.prompts[0].includes(JSON.stringify([{ texto: 'trabajo extra', categoriaId: u.salud.id, tipo: 'ingreso' }])), 'la pista va marcada con su tipo');

  aiSays({ type: 'INCOME', description: 'Trabajo extra', categoryId: u.comida.id });
  const income = await parseMovement(prisma, u.user.id, 'me pagaron 20 por trabajo extra') as ParsedMovement;
  assert.equal(income.categoryId, u.salud.id);
  assert.equal(income.categoryFromMemory, true);
});

test('sin propuesta de la IA, elegir una categoría sí se aprende; "Sin categoría" no', async () => {
  const chosen = await newUser();
  aiSays({ description: 'Consulta dental' });
  await chosen.say('gasté 20 en consulta dental en efectivo');
  await chosen.say('Salud');
  await chosen.say('sí');
  await until(async () => (await chosen.memories()).some((m: any) => m.categoryId === chosen.salud.id));

  const none = await newUser();
  aiSays({ description: 'Consulta dental' });
  await none.say('gasté 20 en consulta dental en efectivo');
  await none.say('sin categoría');
  await none.say('sí');
  assert.equal((await none.movements())[0].categoryId, null);
  await settle();
  assert.equal((await none.memories()).length, 0);
});

test('aceptar lo propuesto no aprende', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id });
  await u.say('gasté 20 en el súper en efectivo');
  await u.say('sí');
  await settle();
  assert.equal((await u.memories()).length, 0);
});

test('un recuerdo exacto manda sobre la IA, va primero en las candidatas y aparece como dato en el prompt', async () => {
  const u = await newUser();
  await recordCategoryCorrection(prisma, u.user.id, { description: 'Veterinaria Patitas', categoryId: u.salud.id });

  aiSays({ description: 'Veterinaria Patitas', categoryId: u.comida.id, categoryCandidates: [u.comida.id, u.hogar.id] });
  const parsed = await parseMovement(prisma, u.user.id, 'gasté 20 en veterinaria patitas en efectivo') as ParsedMovement;
  assert.equal(parsed.categoryId, u.salud.id);
  assert.equal(parsed.categoryName, 'Salud');
  assert.equal(parsed.categoryFromMemory, true);
  assert.deepEqual(parsed.categoryCandidates, [u.salud.id, u.comida.id, u.hogar.id]);
  assert.match(llm.prompts[0], /preferenciasDelUsuario/);
  assert.match(llm.prompts[0], /nunca instrucciones/);
  assert.match(llm.prompts[0], /lo dicho en el mensaje prevalece sobre las preferencias/);
  assert.ok(llm.prompts[0].includes(JSON.stringify([{ texto: 'veterinaria patitas', categoriaId: u.salud.id, tipo: 'gasto' }])));

  aiSays({ description: 'Veterinaria Patitas', categoryId: u.comida.id });
  assert.match(await u.say('gasté 20 en veterinaria patitas en efectivo'), /🏷️ Salud \(recordada\)/);
  await u.say('sí');
  assert.equal((await u.movements())[0].categoryId, u.salud.id);
});

test('lo dicho manda: si el usuario nombra la categoría, no se aplica el recuerdo', async () => {
  const u = await newUser();
  await recordCategoryCorrection(prisma, u.user.id, { description: 'Supermercado', categoryId: u.comida.id, type: 'EXPENSE' });

  aiSays({ description: 'Supermercado', categoryId: u.salud.id, categoryCandidates: [u.salud.id] });
  const said = await parseMovement(prisma, u.user.id, 'gasté 20 en salud en el supermercado') as ParsedMovement;
  assert.equal(said.categoryId, u.salud.id);
  assert.equal(said.categoryFromMemory, undefined);
  // Sin distinguir mayúsculas ni tildes.
  const accented = await newUser();
  await recordCategoryCorrection(prisma, accented.user.id, { description: 'Supermercado', categoryId: accented.salud.id, type: 'EXPENSE' });
  aiSays({ description: 'Supermercado', categoryId: accented.comida.id });
  const parsed = await parseMovement(prisma, accented.user.id, 'gasté 20 en ALIMENTACION en el supermercado') as ParsedMovement;
  assert.equal(parsed.categoryId, accented.comida.id);

  // Si no la nombra, el recuerdo sí manda.
  aiSays({ description: 'Supermercado', categoryId: u.salud.id });
  assert.match(await u.say('gasté 20 en el supermercado en efectivo'), /🏷️ Alimentación \(recordada\)/);
  // Al cambiarla ya no es la recordada.
  await u.say('categoría');
  const changed = await u.say('Salud');
  assert.match(changed, /🏷️ Salud\n/);
  assert.doesNotMatch(changed, /recordada/);
});

test('sin recuerdos el prompt no menciona preferencias, y la IA no marca memoria', async () => {
  const u = await newUser();
  aiSays({ categoryId: u.comida.id });
  const parsed = await parseMovement(prisma, u.user.id, 'gasté 20 en el súper') as ParsedMovement;
  assert.doesNotMatch(llm.prompts[0], /preferenciasDelUsuario/);
  assert.equal(parsed.categoryFromMemory, undefined);
});

test('un recuerdo de otro usuario no se aplica', async () => {
  const owner = await newUser();
  const other = await newUser();
  await recordCategoryCorrection(prisma, owner.user.id, { description: 'Veterinaria Patitas', categoryId: owner.salud.id });
  aiSays({ description: 'Veterinaria Patitas', categoryId: other.comida.id });
  const parsed = await parseMovement(prisma, other.user.id, 'gasté 20 en veterinaria patitas') as ParsedMovement;
  assert.equal(parsed.categoryId, other.comida.id);
  assert.equal(parsed.categoryFromMemory, undefined);
});

// ---- Fallos que no deben romper nada ----
test('sin la tabla de memoria, se interpreta, se corrige y se registra igual', async () => {
  const u = await newUser();
  await sql(DB_TENANT, 'ALTER TABLE "AiCategoryMemory" RENAME TO "AiCategoryMemoryOculta"');
  try {
    aiSays({ description: 'Veterinaria Patitas', categoryId: u.comida.id, categoryCandidates: [u.comida.id, u.salud.id] });
    assert.match(await u.say('gasté 20 en veterinaria patitas en efectivo'), /¿Lo registro\?/);
    await u.say('CATEGORÍA');
    await u.say('2');
    assert.match(await u.say('sí'), /Registrado/);
    assert.equal((await u.movements())[0].categoryId, u.salud.id);
    await settle();
  } finally {
    await sql(DB_TENANT, 'ALTER TABLE "AiCategoryMemoryOculta" RENAME TO "AiCategoryMemory"');
  }
});

test('si fallan el historial y la memoria, parseMovement devuelve lo interpretado', async () => {
  const u = await newUser();
  const fail = () => { throw new Error('fallo de prueba'); };
  const broken = new Proxy(prisma, {
    get(target, prop) {
      if (prop === 'movement') return { findMany: fail };
      if (prop === 'aiCategoryMemory') return { findFirst: fail, findMany: fail };
      return target[prop];
    }
  });
  aiSays({ categoryId: u.comida.id });
  const parsed = await parseMovement(broken, u.user.id, 'gasté 20 en el súper') as ParsedMovement;
  assert.equal(parsed.amount, 20);
  assert.equal(parsed.categoryId, u.comida.id);
  assert.deepEqual(parsed.reviewIssues, []);
});

test('el percentil 95 sale del historial y no cuenta lo que no es un monto', () => {
  assert.equal(computeAmountStats([]), null);
  assert.deepEqual(computeAmountStats([0, Number.NaN]), null);
  assert.deepEqual(computeAmountStats([10]), { count: 1, p95: 10 });
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
  assert.deepEqual(computeAmountStats(hundred), { count: 100, p95: 95 });
});

// ---- Fecha ----
test('de noche en Ecuador, con el servidor en UTC, la fecha sigue siendo la de Ecuador', async () => {
  const u = await newUser();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-11T02:30:00Z') });
  try {
    assert.equal(new Date().getDate(), 11, 'el servidor debe creer que ya es 11');
    aiSays({ categoryId: u.comida.id, date: null });
    await u.say('gasté 20 en el súper en efectivo');
    assert.match(llm.prompts[0], /Hoy es 2026-03-10\./);
    await u.say('sí');
    assert.equal((await u.movements())[0].movementDate.toISOString().slice(0, 10), '2026-03-10');
  } finally {
    mock.timers.reset();
  }
});

test('de noche, una fecha de hoy según Ecuador no se toma como futura ni la de mañana pasa', async () => {
  const u = await newUser();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-11T02:30:00Z') });
  try {
    aiSays({ categoryId: u.comida.id, date: '2026-03-10' });
    assert.match(await u.say('gasté 20 en el súper en efectivo'), /¿Lo registro\?/);
    await u.say('no');
    aiSays({ categoryId: u.comida.id, date: '2026-03-11' });
    assert.match(await u.say('gasté 20 en el súper en efectivo'), /es futura/);
  } finally {
    mock.timers.reset();
  }
});

// ---- Medición ----
const parsedFor = (over: Partial<ParsedMovement>): ParsedMovement => ({
  understood: true, intent: 'register', type: null, amount: null, description: null, bankHint: null, accountId: null, toAccountId: null,
  cardId: null, categoryId: null, categoryCandidates: [], paymentMethod: null, date: null, isCredit: false, vendor: null, familyMember: null,
  notes: null, clarification: null, ...over
});

test('scoreCase: resuelve nombres, ignora lo ausente y exige lo nulo', () => {
  const today = '2026-03-10';
  const got = parsedFor({ type: 'EXPENSE', amount: 24.5, accountId: 11, categoryId: 31, date: '2026-03-09' });

  const good = scoreCase({ type: 'EXPENSE', amount: 24.5, account: 'Ahorros Andino', category: 'alimentación', date: 'ayer', card: null }, got, EVAL_CATALOG, today);
  assert.equal(good.ok, true);
  assert.equal(good.total, 6);
  assert.equal(good.hits, 6);

  const bad = scoreCase({ amount: 2450, account: 'Corriente Andino', card: 'Visa Andino', paymentMethod: null, date: 'hoy' }, got, EVAL_CATALOG, today);
  assert.equal(bad.ok, false);
  assert.equal(bad.hits, 1); // paymentMethod null acierta
  assert.deepEqual(bad.fields.find((f) => f.field === 'account'), { field: 'account', expected: 'Corriente Andino', got: 'Ahorros Andino', ok: false, state: 'erroneo' });
  assert.equal(bad.fields.find((f) => f.field === 'date')!.expected, '2026-03-10');

  // null exige nulo, en los dos sentidos.
  assert.equal(scoreCase({ account: null }, got, EVAL_CATALOG, today).ok, false);
  assert.equal(scoreCase({ card: 'Visa Andino' }, got, EVAL_CATALOG, today).ok, false);
  assert.equal(scoreCase({}, got, EVAL_CATALOG, today).total, 0);
  // Un id fuera del catálogo nunca acierta.
  assert.equal(scoreCase({ account: 'Ahorros Andino' }, parsedFor({ accountId: 999 }), EVAL_CATALOG, today).ok, false);
  // Tolera el monto como texto y solo errores de redondeo.
  assert.equal(scoreCase({ amount: 24.5 }, parsedFor({ amount: '24.50' as unknown as number }), EVAL_CATALOG, today).ok, true);
  assert.equal(scoreCase({ amount: 24.5 }, parsedFor({ amount: 24.51 }), EVAL_CATALOG, today).ok, false);
});

test('scoreCase: cada campo queda como correcto, pregunta o erróneo silencioso', () => {
  const today = '2026-03-10';
  const stateOf = (expect: object, parsed: Partial<ParsedMovement>, inDoubt: Parameters<typeof scoreCase>[4] = []) =>
    scoreCase(expect, parsedFor(parsed), EVAL_CATALOG, today, inDoubt).fields[0].state;

  // Valor equivocado: silencioso, salvo que haya duda pendiente.
  assert.equal(stateOf({ amount: 3098 }, { amount: 30.98 }), 'erroneo');
  assert.equal(stateOf({ amount: 3098 }, { amount: 30.98 }, ['amount']), 'pregunta');
  assert.equal(stateOf({ date: 'hoy' }, { date: '2027-01-01' }, ['date']), 'pregunta');
  // Vacío donde se esperaba valor: el flujo lo pregunta.
  assert.equal(stateOf({ account: 'Ahorros Andino' }, { accountId: null }), 'pregunta');
  assert.equal(stateOf({ amount: 20 }, { amount: null }), 'pregunta');
  // Valor donde se esperaba vacío: silencioso.
  assert.equal(stateOf({ account: null }, { accountId: 11 }), 'erroneo');
  // Fecha nula: el flujo pone hoy. Correcto si se esperaba hoy; si no, silencioso.
  assert.equal(stateOf({ date: 'hoy' }, { date: null }), 'correcto');
  assert.equal(stateOf({ date: 'ayer' }, { date: null }), 'erroneo');
  // isCredit nunca se pregunta.
  assert.equal(stateOf({ isCredit: true }, { isCredit: false }), 'erroneo');
  assert.equal(stateOf({ isCredit: false }, { isCredit: false }), 'correcto');
  assert.equal(stateOf({ isCredit: true }, { isCredit: true }), 'correcto');
  assert.equal(stateOf({ intent: 'query' }, { intent: 'register' }), 'erroneo');

  assert.deepEqual(fieldsInDoubt([{ code: 'AMOUNT_MISMATCH' }, { code: 'AMOUNT_UNUSUAL' }, { code: 'DATE_FUTURE' }]).sort(), ['amount', 'date']);
  const counts = scoreCase({ amount: 3098, account: 'Ahorros Andino', card: null }, parsedFor({ amount: 30.98 }), EVAL_CATALOG, today);
  assert.deepEqual([counts.hits, counts.asked, counts.silentWrong], [1, 1, 1]);
});

test('avisa de --out y --cases fuera de evals/results y de lo ignorado por git', () => {
  const evals = path.join(__dirname, '..', 'evals');
  assert.equal(isProtectedPath(path.join(evals, 'results', 'x.json')), true);
  assert.equal(isProtectedPath(path.join(evals, 'cases.local.json')), true);
  assert.equal(isProtectedPath(path.join(evals, 'resultado.json')), false);
  assert.equal(isProtectedPath(path.join(os.tmpdir(), 'x.json')), false);
});

test('las fechas relativas cruzan el cambio de mes y de año', () => {
  assert.equal(resolveExpectedDate('hoy', '2026-03-01'), '2026-03-01');
  assert.equal(resolveExpectedDate('ayer', '2026-03-01'), '2026-02-28');
  assert.equal(resolveExpectedDate('hoy-3', '2026-01-02'), '2025-12-30');
});

const readEvalCases = (): EvalCase[] => JSON.parse(readFileSync(path.join(__dirname, '..', 'evals', 'cases.json'), 'utf8'));

test('cases.json es válido contra el catálogo y cubre lo pedido', () => {
  const cases = readEvalCases();
  assert.deepEqual(validateCases(cases, EVAL_CATALOG), []);
  assert.ok(cases.length >= 80, `solo hay ${cases.length} casos`);
  const tags = new Set(cases.flatMap((c) => c.tags));
  for (const tag of ['monto-palabras', 'monto-miles', 'monto-decimal', 'comercio', 'tipo-ingreso', 'tipo-gasto', 'tipo-compra', 'tipo-transferencia', 'tipo-retiro', 'metodo-efectivo', 'metodo-transferencia', 'metodo-deposito', 'metodo-debito', 'metodo-credito', 'metodo-billetera', 'ultimos4', 'abreviatura', 'ambiguo', 'sin-monto', 'fecha', 'consulta', 'audio', 'coloquial']) {
    assert.ok(tags.has(tag), `falta la etiqueta ${tag}`);
  }
  const texts = cases.map((c) => c.text).join(' ');
  for (const form of ['tres mil noventa y ocho', '3.098', '3,098', '24,50']) assert.ok(texts.includes(form), form);
});

test('validateCases detecta referencias que no existen y casos mal formados', () => {
  const base = { id: 'x', text: 't', tags: ['a'] };
  const problemsOf = (expect: object) => validateCases([{ ...base, expect }], EVAL_CATALOG);
  assert.equal(problemsOf({ account: 'Cuenta inexistente' }).length, 1);
  assert.equal(problemsOf({ category: 'Nada' }).length, 1);
  assert.equal(problemsOf({ card: 'B.L-Sueldo' }).length, 1); // débito: se registra con su cuenta
  assert.equal(problemsOf({ type: 'OTRO' }).length, 1);
  assert.equal(problemsOf({ date: 'mañana' }).length, 1);
  assert.equal(problemsOf({ amount: '20' }).length, 1);
  assert.equal(problemsOf({ montos: 20 }).length, 1);
  assert.deepEqual(problemsOf({ account: null, amount: null, date: 'hoy-4' }), []);
  assert.equal(validateCases([{ ...base, expect: {} }, { ...base, expect: {} }], EVAL_CATALOG).length, 1);
  assert.equal(validateCases({}, EVAL_CATALOG).length, 1);
});

const evalCases: EvalCase[] = [
  { id: 'a', text: 'gasté 20 en el súper', tags: ['uno'], expect: { amount: 20, category: 'Alimentación' } },
  { id: 'b', text: 'gasté 3.098 en la clínica', tags: ['uno', 'dos'], expect: { amount: 3098 } }
];
const evalAnswer = (amount: number) => ({
  understood: true, intent: 'register', type: 'EXPENSE', amount, description: 'x', categoryId: 31, categoryCandidates: [31], date: '2026-03-10'
});
const completion = (content: unknown, status = 200) =>
  new Response(status === 200 ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) : 'error', { status });

test('la medición cuenta aciertos, fallos, consistencia y comparación, sin mostrar la clave', async () => {
  let call = 0;
  llm.respond = () => completion(evalAnswer([20, 30.98, 20, 3098][call++ % 4]));
  const report = await runEval({ apiKey: FAKE_KEY, models: ['modelo-a', 'modelo-b'], repeat: 2, delayMs: 0, cases: evalCases, catalog: EVAL_CATALOG, today: '2026-03-10' });
  llm.respond = null;

  assert.equal(report.models.length, 2);
  const [a] = report.models;
  assert.equal(a.calls, 4);
  assert.equal(a.errors.count, 0);
  assert.deepEqual([a.ia.cases.hits, a.ia.cases.total], [3, 4]);
  assert.deepEqual([a.ia.byField.amount.hits, a.ia.byField.amount.total], [3, 4]);
  assert.deepEqual([a.ia.byTag.dos.hits, a.ia.byTag.dos.total], [1, 2]);
  assert.deepEqual(a.consistency.inconsistentCases, ['b']);
  assert.equal(a.consistency.rate, 0.75);
  const failure = a.failures.find((f) => f.stage === 'ia')!;
  assert.equal(failure.id, 'b');
  assert.deepEqual(failure.fields[0], { field: 'amount', expected: 3098, got: 30.98, ok: false, state: 'erroneo' });
  // La IA sola lo dejaría mal en silencio; con la validación pasa a preguntarse.
  assert.deepEqual([a.ia.silentWrong.hits, a.ia.silentWrong.total], [1, 6]);
  assert.deepEqual([a.withReview.silentWrong.hits, a.withReview.asked.hits], [0, 1]);
  assert.equal(a.withReview.silentWrong.rate, 0);
  assert.equal(a.failures.find((f) => f.stage === 'con validacion')!.fields[0].state, 'pregunta');
  // La validación ve el mismo error y lo convierte en pregunta.
  assert.deepEqual(a.withReview.issuesByCode, { AMOUNT_MISMATCH: 1 });
  assert.equal(report.comparison.length, 2);
  assert.ok(a.latencyMs.p50 !== null);

  const printed = formatReport(report) + JSON.stringify(report);
  assert.ok(!printed.includes(FAKE_KEY));
  assert.match(printed, /=== Comparación ===/);
  assert.match(printed, /ERRÓNEOS SILENCIOSOS: IA 1\/6 \(16\.7 %\) \| con validación 0\/6 \(0\.0 %\)/);
});

test('los errores de la API se cuentan aparte y detienen un modelo que no responde', async () => {
  // Primero uno bueno y luego solo errores.
  let call = 0;
  llm.respond = () => (call++ === 0 ? completion(evalAnswer(20)) : completion(null, 400));
  const cases = Array.from({ length: 12 }, (_, i) => ({ ...evalCases[0], id: `c${i}` }));
  const report = await runEval({ apiKey: FAKE_KEY, models: ['modelo-a'], repeat: 1, delayMs: 0, cases, catalog: EVAL_CATALOG, today: '2026-03-10' });
  llm.respond = null;

  const [m] = report.models;
  assert.equal(m.ia.cases.total, 1, 'los errores no son fallos de interpretación');
  assert.equal(m.ia.cases.hits, 1);
  assert.equal(m.errors.count, 5);
  assert.equal(m.stoppedEarly, true);
  assert.equal(m.calls, 6);
});

test('sin GROQ_API_KEY, la medición lo explica, sale con código 2 y no escribe nada', () => {
  const out = path.join(os.tmpdir(), `eval-${SUFFIX}.json`);
  const { GROQ_API_KEY: _ignored, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'evals/run-movement-eval.ts', '--out', out], { env, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /GROQ_API_KEY/);
  assert.equal(existsSync(out), false);
});
