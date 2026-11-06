import { PrismaClient as TenantPrismaClient } from '.prisma/tenant';
import { globalPrisma } from './globalPrisma';
import { decryptConnection } from './tenantCrypto';
import { logger } from './logger';

export type TenantPrisma = TenantPrismaClient;

interface CacheEntry {
  client: TenantPrismaClient;
  lastUsed: number;
  tenantId: string;
  slug: string;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 30 * 60 * 1000;   // 30 min idle
const MAX_CACHE = 50;
// El dashboard lanza ~13 consultas en paralelo; con 5 conexiones se encolaban y,
// junto a los barridos de fondo, llegaban a agotar el pool (timeout "no carga").
// Configurable por si el Postgres del servidor tiene un max_connections ajustado.
const CONNECTION_LIMIT = Number(process.env.TENANT_DB_CONNECTION_LIMIT || 12);
const POOL_TIMEOUT_S = Number(process.env.TENANT_DB_POOL_TIMEOUT || 20);

// Creaciones en curso: al recargar la página llegan muchas peticiones del mismo
// tenant casi a la vez; sin esto cada una crearía su PROPIO cliente (y su propio
// pool), provocando una tormenta de conexiones que agota Postgres e intermitente-
// mente hace fallar las cargas. Compartimos una sola promesa de creación.
const creating = new Map<string, Promise<TenantPrismaClient>>();

export async function getTenantPrisma(tenantId: string): Promise<TenantPrismaClient> {
  const cached = cache.get(tenantId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.client;
  }
  const inFlight = creating.get(tenantId);
  if (inFlight) return inFlight;

  const promise = createTenantClient(tenantId);
  creating.set(tenantId, promise);
  try {
    return await promise;
  } finally {
    creating.delete(tenantId);
  }
}

async function createTenantClient(tenantId: string): Promise<TenantPrismaClient> {
  const conn = await globalPrisma.tenantConnection.findUnique({
    where: { tenantId },
    include: { tenant: { select: { status: true, slug: true } } }
  });

  if (!conn) {
    const err: any = new Error('Tenant connection not found');
    err.status = 404;
    throw err;
  }
  if (conn.tenant.status !== 'ACTIVE') {
    const err: any = new Error(`Tenant ${conn.tenant.slug} not active (status: ${conn.tenant.status})`);
    err.status = 403;
    throw err;
  }

  const { user, password } = decryptConnection(conn);
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${conn.dbHost}:${conn.dbPort}/${conn.dbName}?schema=public&connection_limit=${CONNECTION_LIMIT}&pool_timeout=${POOL_TIMEOUT_S}`;

  const client = new TenantPrismaClient({
    datasources: { db: { url } },
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error']
  });

  await client.$connect();

  cache.set(tenantId, { client, lastUsed: Date.now(), tenantId, slug: conn.tenant.slug });
  evictIfNeeded();
  logger.info({ tenantId, slug: conn.tenant.slug, dbName: conn.dbName }, 'tenant prisma client created');

  return client;
}

function evictIfNeeded() {
  if (cache.size <= MAX_CACHE) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
  if (oldest) {
    oldest[1].client.$disconnect().catch(() => {});
    cache.delete(oldest[0]);
    logger.info({ tenantId: oldest[0] }, 'tenant prisma client evicted (LRU)');
  }
}

const intervalHandle = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of cache.entries()) {
    if (now - entry.lastUsed > TTL_MS) {
      entry.client.$disconnect().catch(() => {});
      cache.delete(id);
      logger.info({ tenantId: id, slug: entry.slug }, 'tenant prisma client expired (idle)');
    }
  }
}, 5 * 60 * 1000);
intervalHandle.unref();

export async function invalidateTenantClient(tenantId: string): Promise<void> {
  const entry = cache.get(tenantId);
  if (entry) {
    await entry.client.$disconnect().catch(() => {});
    cache.delete(tenantId);
    logger.info({ tenantId, slug: entry.slug }, 'tenant prisma client invalidated');
  }
}

export async function disconnectAllTenantClients(): Promise<void> {
  for (const [id, entry] of cache.entries()) {
    await entry.client.$disconnect().catch(() => {});
    cache.delete(id);
  }
}
