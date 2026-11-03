// Pruebas de los límites de cuerpo y de la liquidación de IVA. No usan base de datos.
// Uso: npm run test:limits
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { boundedJson, createBodyGate, holdBodyGate, LARGE_BODY_ROUTES, skipBodyFor } from '../src/middleware/bodyLimits';
import { settleVatByEntity } from '../src/lib/vat';

async function serve(app: express.Express) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('el cupo rechaza con 429 lo que excede, deja pasar GET y se libera al cerrar', async () => {
  const app = express();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  app.use(createBodyGate(1, 'ocupado'));
  app.post('/x', async (_req, res) => { await held; res.json({ ok: true }); });
  app.get('/x', (_req, res) => { res.json({ ok: true }); });
  const { server, base } = await serve(app);
  try {
    const first = fetch(`${base}/x`, { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rejected = await fetch(`${base}/x`, { method: 'POST' });
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).message, 'ocupado');
    assert.equal(rejected.headers.get('retry-after'), '5');
    assert.equal((await fetch(`${base}/x`)).status, 200);

    release();
    assert.equal((await first).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fetch(`${base}/x`, { method: 'POST' })).status, 200);
  } finally {
    server.close();
  }
});

test('el cupo se libera si el cliente corta la conexión', async () => {
  const app = express();
  app.use(createBodyGate(1, 'ocupado'));
  app.post('/x', () => { /* nunca responde: simula un trabajo en curso */ });
  app.get('/', (_req, res) => { res.json({ ok: true }); });
  const { server, base } = await serve(app);
  try {
    const req = http.request(`${base}/x`, { method: 'POST' });
    req.on('error', () => {});
    req.end();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await fetch(`${base}/x`, { method: 'POST', signal: AbortSignal.timeout(2000) })).status, 429);
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(fetch(`${base}/x`, { method: 'POST', signal: AbortSignal.timeout(300) }));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('las rutas excluidas no pasan por el parser global: un cuerpo grande no da 413 antes de autenticar', async () => {
  const app = express();
  app.use(skipBodyFor(LARGE_BODY_ROUTES, express.json({ limit: '1kb' })));
  const reject = (_req: express.Request, res: express.Response) => { res.status(401).json({ message: 'sin sesión' }); };
  app.post('/api/attachments', reject);
  app.post('/api/backup/import', reject);
  app.post('/api/otra', reject);
  const { server, base } = await serve(app);
  const post = (path: string) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(5000) })
  });
  try {
    assert.equal((await post('/api/attachments')).status, 401);
    assert.equal((await post('/API/BACKUP/IMPORT')).status, 401);
    assert.notEqual((await post('/api/otra')).status, 401);
  } finally {
    server.close();
  }
});

test('el parser rechaza por cantidad de objetos, no por tamaño, y no lee el cuerpo de un GET', async () => {
  const app = express();
  app.use(boundedJson({ limit: '1mb', maxContainers: 10 }));
  app.all('/x', (req, res) => { res.json({ body: req.body ?? null }); });
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ message: err.message });
  });
  const { server, base } = await serve(app);
  const post = (body: string) => fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  try {
    const many = await post(`[${'{},'.repeat(50)}{}]`);
    assert.equal(many.status, 413);
    assert.match((await many.json()).message, /demasiados elementos/);
    const long = await post(JSON.stringify({ data: 'QUJD'.repeat(100_000) }));
    assert.equal(long.status, 200);
    assert.equal((await long.json()).body.data.length, 400_000);
    assert.equal((await post(`{"a":"${'x'.repeat(2 * 1024 * 1024)}"}`)).status, 413);

    const payload = `[${'{},'.repeat(50)}{}]`;
    const reply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(`${base}/x`, { method: 'GET', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    assert.equal(reply.status, 200);
    assert.ok(!reply.text.includes('{},'));
  } finally {
    server.close();
  }
});

test('con holdBodyGate el cupo sigue ocupado tras cortar la conexión, hasta terminar el trabajo', async () => {
  const app = express();
  let finishWork: () => void = () => {};
  const work = new Promise<void>((resolve) => { finishWork = resolve; });
  app.use(createBodyGate(1, 'ocupado'));
  app.post('/x', async (_req, res) => {
    const release = holdBodyGate(res);
    try { await work; } finally { release(); }
    res.json({ ok: true });
  });
  const { server, base } = await serve(app);
  try {
    const req = http.request(`${base}/x`, { method: 'POST' });
    req.on('error', () => {});
    req.end();
    await new Promise((resolve) => setTimeout(resolve, 100));
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await fetch(`${base}/x`, { method: 'POST' })).status, 429);
    finishWork();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fetch(`${base}/x`, { method: 'POST' })).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

const group = (entityId: number | null, kind: 'SALE' | 'PURCHASE', vatAmount: unknown) => ({ entityId, kind, _sum: { vatAmount } });

test('el IVA se liquida por razón social y no entre RUC distintos', () => {
  assert.deepEqual(settleVatByEntity([group(1, 'SALE', 15), group(2, 'PURCHASE', 15)]), { vatToPay: 15, vatCredit: 15 });
  assert.deepEqual(settleVatByEntity([group(1, 'SALE', 15), group(1, 'PURCHASE', 6)]), { vatToPay: 9, vatCredit: 0 });
  assert.deepEqual(settleVatByEntity([group(null, 'SALE', 3), group(null, 'PURCHASE', 15), group(1, 'SALE', 9)]), { vatToPay: 9, vatCredit: 12 });
});

test('la liquidación tolera vacíos, nulos, decimales de Prisma y centavos', () => {
  assert.deepEqual(settleVatByEntity([]), { vatToPay: 0, vatCredit: 0 });
  assert.deepEqual(settleVatByEntity([group(1, 'SALE', null)]), { vatToPay: 0, vatCredit: 0 });
  assert.deepEqual(settleVatByEntity([group(1, 'SALE', '0.10'), group(1, 'SALE', '0.20')]), { vatToPay: 0.3, vatCredit: 0 });
});
