// Pruebas de comportamiento del login. Crean una base de datos propia y la borran al terminar.
// Uso: npm run test:security
import 'express-async-errors';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { Client } from 'pg';

const TEST_DB = `finanzas_test_${randomBytes(4).toString('hex')}`;
const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT } = process.env;
const adminUrl = `postgresql://${encodeURIComponent(POSTGRES_USER!)}:${encodeURIComponent(POSTGRES_PASSWORD!)}@${POSTGRES_HOST}:${POSTGRES_PORT}/postgres`;
process.env.GLOBAL_DATABASE_URL = `postgresql://${encodeURIComponent(POSTGRES_USER!)}:${encodeURIComponent(POSTGRES_PASSWORD!)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${TEST_DB}?schema=public`;

const PASSWORD = 'clave-correcta-de-prueba';
let hash: string;
let server: Server;
let base: string;
let prisma: typeof import('../src/lib/globalPrisma').globalPrisma;
let security: typeof import('../src/lib/loginSecurity');
let tenantA: string;
let tenantB: string;
let ipCounter = 0;

const nextIp = () => `198.51.100.${++ipCounter}`;

async function admin(sql: string) {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

function login(email: string, password: string, ip: string) {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password })
  });
}

async function token(email: string) {
  const res = await login(email, PASSWORD, nextIp());
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

const api = (path: string, bearer: string, body?: unknown) => fetch(`${base}/api/security${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
});

const addMember = (email: string, tenantId: string, role: 'ADMIN_EMPRESA' | 'USUARIO_EMPRESA' = 'ADMIN_EMPRESA') =>
  prisma.tenantMembership.create({ data: { email, passwordHash: hash, name: 'Prueba', tenantId, role } });

const member = (email: string) => prisma.tenantMembership.findFirstOrThrow({ where: { email } });

async function spray(ip: string, accounts: number, total: number) {
  for (let i = 0; i < total; i++) await login(`spray-${i % accounts}@prueba.example`, 'mal', ip);
}

before(async () => {
  await admin(`CREATE DATABASE "${TEST_DB}"`);
  execSync('npx prisma db push --schema=prisma/global/schema.prisma --skip-generate', { stdio: 'ignore', env: process.env });
  hash = await bcrypt.hash(PASSWORD, 12);
  ({ globalPrisma: prisma } = await import('../src/lib/globalPrisma'));
  security = await import('../src/lib/loginSecurity');
  const { globalAuthRouter } = await import('../src/routes/global/auth.routes');
  const { securityRouter } = await import('../src/routes/global/security.routes');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', globalAuthRouter);
  app.use('/api/security', securityRouter);
  // Igual que index.ts: sin esto, un error de validación deja la petición colgada.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ message: 'Datos inválidos' });
    return next(err);
  });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await prisma.loginEvent.deleteMany();
  await prisma.ipBlock.deleteMany();
  await prisma.superAdminAuditLog.deleteMany();
  await prisma.superAdmin.deleteMany();
  await prisma.tenant.deleteMany();
  const suffix = randomBytes(4).toString('hex');
  const make = (name: string) => prisma.tenant.create({ data: { slug: `${name}-${suffix}`, legalName: name, email: `${name}-${suffix}@prueba.example` } });
  tenantA = (await make('a')).id;
  tenantB = (await make('b')).id;
});

after(async () => {
  server?.close();
  await prisma?.$disconnect();
  await admin(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
});

test('la cuenta se bloquea a los 5 fallos y rechaza incluso la contraseña correcta', async () => {
  await addMember('u@prueba.example', tenantA);
  const ip = nextIp();
  for (let i = 0; i < 5; i++) assert.equal((await login('u@prueba.example', 'mal', ip)).status, 401);
  assert.ok((await member('u@prueba.example')).lockedUntil);
  assert.equal((await login('u@prueba.example', PASSWORD, ip)).status, 401);
  const types = (await prisma.loginEvent.findMany()).map((e) => e.type);
  assert.ok(types.includes('ACCOUNT_LOCKED'));
  assert.ok(types.includes('LOCKED_ATTEMPT'));
});

test('los intentos en paralelo cuentan todos: solo 5 llegan a probar la contraseña', async () => {
  await addMember('u@prueba.example', tenantA);
  const ip = nextIp();
  await Promise.all(Array.from({ length: 12 }, () => login('u@prueba.example', 'mal', ip)));
  assert.ok((await member('u@prueba.example')).lockedUntil);
  const events = await prisma.loginEvent.findMany();
  assert.equal(events.filter((e) => e.reason === 'BAD_CREDENTIALS').length, 5);
  assert.equal(events.filter((e) => e.type === 'LOCKED_ATTEMPT').length, 7);
});

test('la contraseña correcta en el quinto intento entra y limpia el bloqueo', async () => {
  await addMember('u@prueba.example', tenantA);
  const ip = nextIp();
  for (let i = 0; i < 4; i++) await login('u@prueba.example', 'mal', ip);
  assert.equal((await login('u@prueba.example', PASSWORD, ip)).status, 200);
  const m = await member('u@prueba.example');
  assert.equal(m.failedAttempts, 0);
  assert.equal(m.lockedUntil, null);
});

test('los fallos durante el bloqueo no lo alargan', async () => {
  await prisma.superAdmin.create({ data: { email: 's@prueba.example', passwordHash: hash, name: 'Super' } });
  const ip = nextIp();
  for (let i = 0; i < 5; i++) await login('s@prueba.example', 'mal', ip);
  const first = (await prisma.superAdmin.findFirstOrThrow()).lockedUntil;
  assert.ok(first);
  for (let i = 0; i < 6; i++) await login('s@prueba.example', 'mal', ip);
  assert.deepEqual((await prisma.superAdmin.findFirstOrThrow()).lockedUntil, first);
});

test('una cuenta bloqueada tarda como las demás en responder', async () => {
  await addMember('u@prueba.example', tenantA);
  const ip = nextIp();
  for (let i = 0; i < 5; i++) await login('u@prueba.example', 'mal', ip);
  const start = performance.now();
  await login('u@prueba.example', 'mal', ip);
  assert.ok(performance.now() - start > 50, 'la respuesta debe incluir la comparación bcrypt');
});

test('los fallos antiguos caducan', async () => {
  const m = await addMember('u@prueba.example', tenantA);
  await prisma.tenantMembership.update({
    where: { id: m.id },
    data: { failedAttempts: 4, lastFailedAt: new Date(Date.now() - 60 * 60 * 1000) }
  });
  await login('u@prueba.example', 'mal', nextIp());
  const after = await member('u@prueba.example');
  assert.equal(after.failedAttempts, 1);
  assert.equal(after.lockedUntil, null);
});

test('un ataque repartido entre cuentas bloquea la IP, incluso con la contraseña correcta', async () => {
  await addMember('u@prueba.example', tenantA);
  const ip = nextIp();
  await spray(ip, 5, 20);
  const res = await login('u@prueba.example', PASSWORD, ip);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 3000);
  assert.equal(await prisma.loginEvent.count({ where: { type: 'IP_BLOCKED', ip } }), 1);
  assert.equal((await prisma.ipBlock.findUniqueOrThrow({ where: { ip } })).blockedAttempts, 1);
  assert.equal((await login('u@prueba.example', PASSWORD, nextIp())).status, 200);
});

test('muchos fallos sobre una sola cuenta no bloquean la IP compartida', async () => {
  await addMember('u@prueba.example', tenantA);
  await addMember('otro@prueba.example', tenantA);
  const ip = nextIp();
  for (let i = 0; i < 25; i++) await login('u@prueba.example', 'mal', ip);
  assert.equal(await prisma.ipBlock.count(), 0);
  assert.equal((await login('otro@prueba.example', PASSWORD, ip)).status, 200);
});

test('reincidir alarga el bloqueo y desbloquear no vuelve a bloquear al primer error', async () => {
  await prisma.superAdmin.create({ data: { email: 's@prueba.example', passwordHash: hash, name: 'Super' } });
  const bearer = await token('s@prueba.example');
  const ip = nextIp();
  await spray(ip, 5, 20);

  assert.equal((await api('/ips/unblock', bearer, { ip })).status, 200);
  assert.equal((await login('otra@prueba.example', 'mal', ip)).status, 401);
  assert.equal((await prisma.ipBlock.findUniqueOrThrow({ where: { ip } })).strikes, 0);

  await prisma.ipBlock.update({ where: { ip }, data: { strikes: 1, blockedUntil: new Date(Date.now() - 16 * 60 * 1000) } });
  await prisma.loginEvent.deleteMany({ where: { ip } });
  await spray(ip, 5, 20);
  const block = await prisma.ipBlock.findUniqueOrThrow({ where: { ip } });
  assert.equal(block.strikes, 2);
  assert.ok(block.blockedUntil.getTime() - Date.now() > 5 * 60 * 60 * 1000);
});

test('el admin de empresa solo ve y desbloquea lo de su empresa', async () => {
  await addMember('admin-a@prueba.example', tenantA);
  await addMember('user-a@prueba.example', tenantA, 'USUARIO_EMPRESA');
  await addMember('victima-a@prueba.example', tenantA);
  await addMember('victima-b@prueba.example', tenantB);
  const bearer = await token('admin-a@prueba.example');
  const ip = nextIp();
  for (let i = 0; i < 5; i++) {
    await login('victima-a@prueba.example', 'mal', ip);
    await login('victima-b@prueba.example', 'mal', ip);
  }
  await login('no-existe@prueba.example', 'mal', ip);

  const { events } = await (await api('/events?limit=200', bearer)).json();
  const emails = new Set(events.map((e: { email: string }) => e.email));
  assert.ok(emails.has('victima-a@prueba.example'));
  assert.ok(!emails.has('victima-b@prueba.example'));
  assert.ok(!emails.has('no-existe@prueba.example'));

  const blocks = await (await api('/blocks', bearer)).json();
  assert.deepEqual(blocks.accounts.map((a: { email: string }) => a.email), ['victima-a@prueba.example']);
  assert.deepEqual(blocks.ips, []);

  const b = await member('victima-b@prueba.example');
  assert.equal((await api('/accounts/unlock', bearer, { kind: 'membership', id: b.id })).status, 404);
  assert.ok((await member('victima-b@prueba.example')).lockedUntil);
  assert.equal((await api('/ips/unblock', bearer, { ip })).status, 403);

  const a = await member('victima-a@prueba.example');
  assert.equal((await api('/accounts/unlock', bearer, { kind: 'membership', id: a.id })).status, 200);
  assert.equal((await member('victima-a@prueba.example')).lockedUntil, null);

  const userToken = await token('user-a@prueba.example');
  assert.equal((await api('/events', userToken)).status, 403);
  assert.equal((await fetch(`${base}/api/security/events`)).status, 401);
});

test('el superadmin ve los eventos de todas las empresas', async () => {
  await prisma.superAdmin.create({ data: { email: 's@prueba.example', passwordHash: hash, name: 'Super' } });
  await addMember('u@prueba.example', tenantB);
  const ip = nextIp();
  await login('u@prueba.example', 'mal', ip);
  await login('no-existe@prueba.example', 'mal', ip);
  const bearer = await token('s@prueba.example');
  const { events } = await (await api('/events?type=LOGIN_FAILED', bearer)).json();
  assert.equal(events.length, 2);
  const filtered = await (await api('/events?search=no-existe', bearer)).json();
  assert.equal(filtered.total, 1);
});

const selectTenant = (bearer: string, choice: string) => fetch(`${base}/api/auth/select-tenant`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ choice })
});

async function addMemberWithPassword(email: string, tenantId: string, password: string) {
  return prisma.tenantMembership.create({
    data: { email, passwordHash: await bcrypt.hash(password, 12), name: 'Prueba', tenantId, role: 'ADMIN_EMPRESA' }
  });
}

test('un usuario creado con el correo de otra empresa no da acceso a esa empresa', async () => {
  await addMember('victima@prueba.example', tenantB);
  await addMemberWithPassword('victima@prueba.example', tenantA, 'clave-de-la-trampa');

  const res = await login('victima@prueba.example', 'clave-de-la-trampa', nextIp());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.pending, undefined);
  assert.equal(data.user.tenant.id, tenantA);
  assert.equal((await selectTenant(data.token, tenantB)).status, 400);
});

test('el dueño real entra solo a la empresa de su contraseña', async () => {
  await addMember('victima@prueba.example', tenantB);
  await addMemberWithPassword('victima@prueba.example', tenantA, 'clave-de-la-trampa');
  const data = await (await login('victima@prueba.example', PASSWORD, nextIp())).json();
  assert.equal(data.user.tenant.id, tenantB);
});

test('con la misma contraseña en dos empresas se puede elegir entre ambas', async () => {
  await addMember('doble@prueba.example', tenantA);
  await addMember('doble@prueba.example', tenantB);
  const data = await (await login('doble@prueba.example', PASSWORD, nextIp())).json();
  assert.equal(data.pending, true);
  assert.deepEqual(data.tenants.map((t: { id: string }) => t.id).sort(), [tenantA, tenantB].sort());
  assert.equal((await selectTenant(data.token, tenantB)).status, 200);
});

test('no se ofrece una empresa bloqueada aunque la contraseña coincida', async () => {
  await addMember('doble@prueba.example', tenantA);
  const b = await addMember('doble@prueba.example', tenantB);
  await prisma.tenantMembership.update({ where: { id: b.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } });
  const data = await (await login('doble@prueba.example', PASSWORD, nextIp())).json();
  assert.equal(data.user.tenant.id, tenantA);
});

test('una cuenta con el correo del superadmin no da acceso de superadmin', async () => {
  await prisma.superAdmin.create({ data: { email: 's@prueba.example', passwordHash: hash, name: 'Super' } });
  await addMemberWithPassword('s@prueba.example', tenantA, 'clave-de-la-trampa');
  const data = await (await login('s@prueba.example', 'clave-de-la-trampa', nextIp())).json();
  assert.equal(data.user.kind, 'tenant');
  assert.equal(data.superAvailable, undefined);
  assert.equal((await selectTenant(data.token, 'super')).status, 400);
});

test('un superadmin inactivo no entra a una empresa con su contraseña de plataforma', async () => {
  await prisma.superAdmin.create({ data: { email: 's@prueba.example', passwordHash: hash, name: 'Super', isActive: false } });
  await addMemberWithPassword('s@prueba.example', tenantA, 'otra-clave-distinta');
  assert.equal((await login('s@prueba.example', PASSWORD, nextIp())).status, 401);
});

test('entrar con la clave de una empresa no limpia ni bloquea la cuenta de la otra', async () => {
  const victim = await addMember('victima@prueba.example', tenantB);
  await addMemberWithPassword('victima@prueba.example', tenantA, 'clave-de-la-trampa');
  const ip = nextIp();

  for (let i = 0; i < 3; i++) await login('victima@prueba.example', 'mal', ip);
  assert.equal((await login('victima@prueba.example', 'clave-de-la-trampa', ip)).status, 200);
  assert.equal((await prisma.tenantMembership.findUniqueOrThrow({ where: { id: victim.id } })).failedAttempts, 3);

  await login('victima@prueba.example', 'mal', ip);
  assert.equal((await login('victima@prueba.example', 'clave-de-la-trampa', ip)).status, 200);
  const state = await prisma.tenantMembership.findUniqueOrThrow({ where: { id: victim.id } });
  assert.equal(state.failedAttempts, 4);
  assert.equal(state.lockedUntil, null);

  await login('victima@prueba.example', 'mal', ip);
  assert.ok((await prisma.tenantMembership.findUniqueOrThrow({ where: { id: victim.id } })).lockedUntil);
});

async function superToken() {
  await prisma.superAdmin.create({ data: { email: 'super@prueba.example', passwordHash: hash, name: 'Super' } });
  return token('super@prueba.example');
}

test('el bloqueo manual impide entrar, cierra la sesión abierta y se puede levantar', async () => {
  await addMember('jefe@prueba.example', tenantA);
  await addMember('u@prueba.example', tenantA, 'USUARIO_EMPRESA');
  const jefe = await token('jefe@prueba.example');
  await addMember('otro-admin@prueba.example', tenantA);
  const abierta = await token('otro-admin@prueba.example');

  const res = await api('/accounts/lock', jefe, { email: 'otro-admin@prueba.example', minutes: 60 });
  assert.equal(res.status, 200);
  assert.equal((await login('otro-admin@prueba.example', PASSWORD, nextIp())).status, 401);
  assert.equal((await api('/events', abierta)).status, 401);

  const events = (await (await api('/events?type=ACCOUNT_LOCKED', jefe)).json()).events;
  assert.equal(events[0].metadata.by, 'jefe@prueba.example');
  assert.equal(events[0].account.locked, true);

  assert.equal((await api('/accounts/unlock-email', jefe, { email: 'otro-admin@prueba.example' })).status, 200);
  assert.equal((await login('otro-admin@prueba.example', PASSWORD, nextIp())).status, 200);
});

test('el admin de empresa no alcanza cuentas de otra empresa, ni con el mismo correo', async () => {
  await addMember('jefe@prueba.example', tenantA);
  await addMember('ajeno@prueba.example', tenantB);
  await addMember('doble@prueba.example', tenantA);
  const ajena = await addMember('doble@prueba.example', tenantB);
  const jefe = await token('jefe@prueba.example');

  assert.equal((await api('/accounts/lock', jefe, { email: 'ajeno@prueba.example', minutes: 60 })).status, 404);
  assert.equal((await member('ajeno@prueba.example')).lockedUntil, null);

  assert.equal((await api('/accounts/lock', jefe, { email: 'doble@prueba.example', minutes: 60 })).status, 200);
  const state = await prisma.tenantMembership.findUniqueOrThrow({ where: { id: ajena.id } });
  assert.equal(state.lockedUntil, null);
  assert.equal(state.tokenVersion, ajena.tokenVersion);

  await prisma.tenantMembership.update({ where: { id: ajena.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } });
  await api('/accounts/unlock-email', jefe, { email: 'doble@prueba.example' });
  assert.ok((await prisma.tenantMembership.findUniqueOrThrow({ where: { id: ajena.id } })).lockedUntil);
});

test('nadie se bloquea a sí mismo y un usuario normal no puede bloquear', async () => {
  await addMember('jefe@prueba.example', tenantA);
  await addMember('u@prueba.example', tenantA, 'USUARIO_EMPRESA');
  const jefe = await token('jefe@prueba.example');
  assert.equal((await api('/accounts/lock', jefe, { email: 'JEFE@prueba.example', minutes: 60 })).status, 400);
  assert.equal((await api('/accounts/lock', await token('u@prueba.example'), { email: 'jefe@prueba.example', minutes: 60 })).status, 403);
});

test('una duración no permitida se rechaza', async () => {
  await addMember('jefe@prueba.example', tenantA);
  await addMember('u@prueba.example', tenantA);
  const jefe = await token('jefe@prueba.example');
  assert.equal((await api('/accounts/lock', jefe, { email: 'u@prueba.example', minutes: 999999999 })).status, 400);
});

test('una selección de empresa pendiente no completa el acceso si la cuenta se bloqueó', async () => {
  await addMember('doble@prueba.example', tenantA);
  await addMember('doble@prueba.example', tenantB);
  const pending = (await (await login('doble@prueba.example', PASSWORD, nextIp())).json()).token;
  assert.equal((await api('/accounts/lock', await superToken(), { email: 'doble@prueba.example', minutes: 60 })).status, 200);
  assert.equal((await selectTenant(pending, tenantA)).status, 403);
});

test('el superadmin bloquea y desbloquea una IP a mano', async () => {
  await addMember('u@prueba.example', tenantA);
  const su = await superToken();
  const ip = nextIp();
  assert.equal((await login('u@prueba.example', PASSWORD, ip)).status, 200);

  assert.equal((await api('/ips/block', su, { ip, minutes: 60 })).status, 200);
  assert.equal((await login('u@prueba.example', PASSWORD, ip)).status, 429);
  assert.equal((await login('u@prueba.example', PASSWORD, nextIp())).status, 200);

  const events = (await (await api(`/events?search=${ip}`, su)).json()).events;
  assert.ok(events.every((e: { ipBlocked: boolean }) => e.ipBlocked));

  assert.equal((await api('/ips/unblock', su, { ip })).status, 200);
  assert.equal((await login('u@prueba.example', PASSWORD, ip)).status, 200);
});

test('una IPv6 se bloquea con el mismo valor /64 que muestra el panel', async () => {
  await addMember('u@prueba.example', tenantA);
  const su = await superToken();
  assert.equal((await api('/ips/block', su, { ip: '2001:db8:5:6::/64', minutes: 60 })).status, 200);
  assert.equal((await login('u@prueba.example', PASSWORD, '2001:db8:5:6::abcd')).status, 429);
});

test('el bloqueo de IP exige superadmin, una IP válida y que no sea la propia', async () => {
  await addMember('jefe@prueba.example', tenantA);
  const jefe = await token('jefe@prueba.example');
  const su = await superToken();
  assert.equal((await api('/ips/block', jefe, { ip: '203.0.113.9', minutes: 60 })).status, 403);
  assert.equal((await api('/ips/block', su, { ip: 'no-es-una-ip', minutes: 60 })).status, 400);
  const own = await fetch(`${base}/api/security/ips/block`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${su}`, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
    body: JSON.stringify({ ip: '203.0.113.7', minutes: 60 })
  });
  assert.equal(own.status, 400);
});

test('el admin de empresa no recibe el estado de las IP', async () => {
  await addMember('jefe@prueba.example', tenantA);
  const ip = nextIp();
  assert.equal((await login('jefe@prueba.example', PASSWORD, ip)).status, 200);
  await security.blockIp(ip, 60);
  const events = (await (await api('/events', await token('jefe@prueba.example'))).json()).events;
  assert.ok(events.length > 0);
  assert.ok(events.every((e: { ipBlocked: boolean }) => e.ipBlocked === false));
});

test('la retención borra solo lo antiguo', async () => {
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  await prisma.loginEvent.create({ data: { type: 'LOGIN_FAILED', createdAt: old } });
  await prisma.loginEvent.create({ data: { type: 'LOGIN_FAILED' } });
  await prisma.ipBlock.create({ data: { ip: '198.51.100.250', blockedUntil: old } });
  await security.purgeOldSecurityData();
  assert.equal(await prisma.loginEvent.count(), 1);
  assert.equal(await prisma.ipBlock.count(), 0);
});

test('normalizeIp agrupa IPv6 por /64 y limpia IPv4 mapeada', () => {
  assert.equal(security.normalizeIp('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(security.normalizeIp('198.51.100.7'), '198.51.100.7');
  assert.equal(security.normalizeIp('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(security.normalizeIp('2001:0db8:0001:0002:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
  assert.equal(security.normalizeIp('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(security.normalizeIp('no-es-ip'), null);
  assert.equal(security.normalizeIp(undefined), null);
});

test('parseTrustProxy nunca confía en cualquier origen', () => {
  assert.equal(security.parseTrustProxy(undefined), 1);
  assert.equal(security.parseTrustProxy('2'), 2);
  assert.equal(security.parseTrustProxy('false'), false);
  assert.equal(security.parseTrustProxy('true'), 1);
  assert.equal(security.parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
});
