// =====================================================
// Composición de URLs de conexión a PostgreSQL.
//
// La BD se configura por PARTES (POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER,
// POSTGRES_PASSWORD, POSTGRES_DB) — no como una URL en una sola línea.
// Aquí derivamos las URLs que Prisma necesita, sólo si no vienen ya armadas.
//
// Importar este módulo (por efecto) ANTES de instanciar cualquier PrismaClient.
// =====================================================
const enc = (v: string) => encodeURIComponent(v);

const host = process.env.POSTGRES_HOST || process.env.PGHOST || process.env.PG_HOST || 'postgres';
const port = process.env.POSTGRES_PORT || process.env.PGPORT || process.env.PG_PORT || '5432';
const user = process.env.POSTGRES_USER || 'finanzas_user';
const password = process.env.POSTGRES_PASSWORD || '';
const globalDb = process.env.POSTGRES_DB || 'finanzas_global';
const adminDb = process.env.POSTGRES_ADMIN_DB || 'postgres';

const credentials = `${enc(user)}:${enc(password)}`;
const hostPort = `${host}:${port}`;

// DB global (registro de empresas, super admins, planes, auditoría).
if (!process.env.GLOBAL_DATABASE_URL) {
  process.env.GLOBAL_DATABASE_URL = `postgresql://${credentials}@${hostPort}/${globalDb}?schema=public`;
}

// DB admin (para CREATE DATABASE/ROLE al provisionar cada empresa nueva).
if (!process.env.POSTGRES_ADMIN_URL) {
  process.env.POSTGRES_ADMIN_URL = `postgresql://${credentials}@${hostPort}/${adminDb}`;
}

// El provisioning de empresas arma la URL de cada DB nueva con PG_HOST/PG_PORT.
process.env.PG_HOST = host;
process.env.PG_PORT = String(port);

export {};
