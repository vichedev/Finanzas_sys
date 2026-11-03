// =====================================================
// Seguridad del login: bloqueo de cuentas, bloqueo de IP y registro de eventos.
//
// Cuenta: 5 intentos fallidos en 15 min bloquean la cuenta 15 min.
// IP: 20 fallos sobre 5 o más cuentas distintas en 15 min bloquean la IP.
//     Exigir cuentas distintas evita castigar a quienes comparten IP (CGNAT,
//     oficinas) cuando alguien solo se equivoca con su propia contraseña.
//
// Todo el tiempo se calcula en SQL y en UTC: las columnas DateTime de Prisma
// guardan UTC y así el resultado no depende de la zona horaria de la sesión.
// =====================================================
import net from 'node:net';
import type { Request } from 'express';
import { globalPrisma } from './globalPrisma';
import { logger } from './logger';

export const MAX_FAILED_ATTEMPTS = 5;
export const IP_WINDOW_MINUTES = 15;
export const IP_MAX_FAILURES = 20;
export const IP_MIN_DISTINCT_ACCOUNTS = 5;
export const RETENTION_DAYS = 90;

const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;
const FRESH_COUNT = `CASE WHEN "lastFailedAt" IS NULL OR "lastFailedAt" < ${UTC_NOW} - interval '15 minutes' THEN 1 ELSE "failedAttempts" + 1 END`;

export type LoginEventType =
  | 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'LOCKED_ATTEMPT' | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_UNLOCKED' | 'IP_BLOCKED' | 'IP_UNBLOCKED';

export type AccountTable = 'SuperAdmin' | 'TenantMembership';

export type AttemptClaim = { claimed: boolean; lockedNow: boolean };

/**
 * Reserva un intento ANTES de comparar la contraseña. Al ser un único UPDATE,
 * los intentos en paralelo se serializan por la fila: una vez alcanzado el
 * límite, el resto no obtiene reserva y no llega a probar ninguna contraseña.
 * Una cuenta ya bloqueada no se toca, así que insistir no alarga su bloqueo.
 */
export async function claimAttempt(table: AccountTable, id: string): Promise<AttemptClaim> {
  const rows = await globalPrisma.$queryRawUnsafe<Array<{ locked_now: boolean }>>(
    `UPDATE "${table}" SET
       "failedAttempts" = CASE WHEN ${FRESH_COUNT} >= ${MAX_FAILED_ATTEMPTS} THEN 0 ELSE ${FRESH_COUNT} END,
       "lockedUntil" = CASE WHEN ${FRESH_COUNT} >= ${MAX_FAILED_ATTEMPTS} THEN ${UTC_NOW} + interval '15 minutes' ELSE NULL END,
       "lastFailedAt" = ${UTC_NOW}
     WHERE id = $1 AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${UTC_NOW})
     RETURNING "lockedUntil" IS NOT NULL AS locked_now`,
    id
  );
  return rows.length ? { claimed: true, lockedNow: rows[0].locked_now } : { claimed: false, lockedNow: false };
}

/**
 * Devuelve un intento reservado que resultó no ser un fallo: el login fue correcto
 * con otra credencial del mismo correo. Deshace también el bloqueo si lo causó este intento.
 */
export async function releaseAttempt(table: AccountTable, id: string, lockedNow: boolean): Promise<void> {
  await globalPrisma.$executeRawUnsafe(
    lockedNow
      ? `UPDATE "${table}" SET "failedAttempts" = ${MAX_FAILED_ATTEMPTS - 1}, "lockedUntil" = NULL WHERE id = $1`
      : `UPDATE "${table}" SET "failedAttempts" = GREATEST("failedAttempts" - 1, 0) WHERE id = $1`,
    id
  );
}

/** Normaliza la IP: IPv4 mapeada a IPv4 e IPv6 a su /64, que es lo que controla un solo cliente. */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const ip = raw.split('%')[0].trim();
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) return ip.slice(7);
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return null;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Interpreta TRUST_PROXY: número de proxies delante, "false" o lista de redes. */
export function parseTrustProxy(value: string | undefined): number | boolean | string {
  const v = (value ?? '').trim();
  if (!v) return 1;
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'false') return false;
  // "true" haría que cualquiera pudiera falsear su IP con X-Forwarded-For.
  if (v === 'true') {
    logger.warn('TRUST_PROXY=true no es seguro; se usa 1');
    return 1;
  }
  return v;
}

type EventInput = {
  type: LoginEventType;
  email?: string | null;
  ip?: string | null;
  reason?: string;
  tenantIds?: string[];
  metadata?: Record<string, unknown>;
  req?: Request;
};

/** Registra un evento. Un fallo aquí nunca debe impedir el login. */
export async function recordLoginEvent(e: EventInput): Promise<void> {
  try {
    await globalPrisma.loginEvent.create({
      data: {
        type: e.type,
        email: e.email ?? null,
        ip: e.ip ?? null,
        reason: e.reason ?? null,
        tenantIds: e.tenantIds ?? [],
        userAgent: (e.req?.headers['user-agent'] as string | undefined)?.slice(0, 300) ?? null,
        ...(e.metadata ? { metadata: e.metadata as object } : {})
      }
    });
  } catch (err) {
    logger.error({ err, type: e.type }, 'no se pudo registrar el evento de login');
  }
}

/** Devuelve el bloqueo activo de una IP y cuenta el intento rechazado. */
export async function checkIpBlock(ip: string | null): Promise<{ retryAfterSeconds: number } | null> {
  if (!ip) return null;
  // Un contador, no un evento por intento: una IP bloqueada no debe poder llenar la tabla.
  const rows = await globalPrisma.$queryRawUnsafe<Array<{ seconds: number }>>(
    `UPDATE "IpBlock" SET "blockedAttempts" = "blockedAttempts" + 1
     WHERE ip = $1 AND "blockedUntil" > ${UTC_NOW}
     RETURNING GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("blockedUntil" - ${UTC_NOW}))))::int AS seconds`,
    ip
  );
  return rows.length ? { retryAfterSeconds: rows[0].seconds } : null;
}

/** Bloquea la IP si superó el umbral. Reincidir alarga el bloqueo: 1 h, 6 h y 24 h. */
export async function evaluateIpBlock(ip: string | null, req?: Request): Promise<void> {
  if (!ip) return;
  try {
    // Solo cuentan los fallos posteriores al último bloqueo; si no, una IP
    // recién desbloqueada volvería a caer con su primer error.
    const [stats] = await globalPrisma.$queryRawUnsafe<Array<{ total: number; accounts: number }>>(
      `SELECT count(*)::int AS total, count(DISTINCT email)::int AS accounts
       FROM "LoginEvent"
       WHERE ip = $1 AND type IN ('LOGIN_FAILED', 'LOCKED_ATTEMPT')
         AND "createdAt" > GREATEST(
           ${UTC_NOW} - interval '${IP_WINDOW_MINUTES} minutes',
           COALESCE((SELECT "blockedUntil" FROM "IpBlock" WHERE ip = $1), '-infinity'::timestamp)
         )`,
      ip
    );
    if (stats.total < IP_MAX_FAILURES || stats.accounts < IP_MIN_DISTINCT_ACCOUNTS) return;

    const nextStrikes = `CASE WHEN "IpBlock"."blockedUntil" < ${UTC_NOW} - interval '30 days' THEN 1 ELSE LEAST("IpBlock".strikes + 1, 3) END`;
    const rows = await globalPrisma.$queryRawUnsafe<Array<{ strikes: number; until: Date }>>(
      `INSERT INTO "IpBlock" (ip, "blockedUntil", strikes, "failureCount", "accountCount", "createdAt", "updatedAt")
       VALUES ($1, ${UTC_NOW} + interval '1 hour', 1, $2, $3, ${UTC_NOW}, ${UTC_NOW})
       ON CONFLICT (ip) DO UPDATE SET
         "blockedUntil" = ${UTC_NOW} + (CASE ${nextStrikes} WHEN 1 THEN interval '1 hour' WHEN 2 THEN interval '6 hours' ELSE interval '24 hours' END),
         strikes = ${nextStrikes},
         "failureCount" = EXCLUDED."failureCount",
         "accountCount" = EXCLUDED."accountCount",
         "blockedAttempts" = 0,
         "updatedAt" = ${UTC_NOW}
       WHERE "IpBlock"."blockedUntil" <= ${UTC_NOW}
       RETURNING strikes, "blockedUntil" AS until`,
      ip, stats.total, stats.accounts
    );
    if (rows.length) {
      await recordLoginEvent({
        type: 'IP_BLOCKED', ip, req,
        metadata: { failures: stats.total, accounts: stats.accounts, strikes: rows[0].strikes, until: rows[0].until }
      });
    }
  } catch (err) {
    logger.error({ err }, 'no se pudo evaluar el bloqueo de IP');
  }
}

/** Levanta el bloqueo y perdona la reincidencia. La fila se conserva para que evaluateIpBlock ignore los fallos anteriores. */
export async function unblockIp(ip: string): Promise<boolean> {
  const count = await globalPrisma.$executeRawUnsafe(
    `UPDATE "IpBlock" SET "blockedUntil" = ${UTC_NOW}, strikes = 0, "updatedAt" = ${UTC_NOW}
     WHERE ip = $1 AND "blockedUntil" > ${UTC_NOW}`,
    ip
  );
  return count > 0;
}

/** Borra lo que ya superó la retención, para que la tabla no crezca sin límite. */
export async function purgeOldSecurityData(): Promise<void> {
  const limit = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await globalPrisma.loginEvent.deleteMany({ where: { createdAt: { lt: limit } } });
  await globalPrisma.ipBlock.deleteMany({ where: { blockedUntil: { lt: limit } } });
}
