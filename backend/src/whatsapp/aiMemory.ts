// =====================================================
// Memoria de correcciones: recuerda qué categoría eligió el usuario para un comercio
// o detalle, para no volver a equivocarse. Es por usuario y dentro de su empresa.
// =====================================================
import { logger } from '../lib/logger';

export interface MemoryHint {
  texto: string;       // detalle o comercio normalizado
  categoriaId: number;
}

const STOP_WORDS = new Set([
  'compra', 'compras', 'pago', 'pagos', 'gasto', 'gastos', 'de', 'del', 'en', 'el', 'la', 'los', 'las',
  'un', 'una', 'por', 'para', 'con', 'al', 'a', 'y', 'mi', 'factura', 'varios', 'otros', 'otras',
  'cuenta', 'cuentas', 'tienda', 'local', 'transferencia', 'deposito', 'ingreso', 'ingresos', 'retiro',
  'dinero', 'dolares', 'dolar', 'usd',
  // Delatan un dato personal: el número ya se elimina, tampoco se guarda de qué era.
  'cedula', 'ruc', 'tel', 'telefono', 'celular'
]);
const INCOME_PREFIX = 'ingreso:'; // normalizeMemoryKey quita los dos puntos: un texto no puede imitarlo
const MIN_KEY_LENGTH = 3;
const MIN_SINGLE_WORD_LENGTH = 4;
const MAX_WORD_DIGITS = 4;
const MIN_VENDOR_HITS = 2;
const MEMORY_LIFETIME_MONTHS = 12;
const MAX_KEY_LENGTH = 60;
const MAX_MEMORIES_PER_USER = 500;
const MAX_HINTS = 30;
const MIN_HINT_WORD_LETTERS = 4;

/** Palabras en minúsculas, sin acentos ni signos. */
function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function isUserId(userId: unknown): userId is number {
  // Con userId undefined, Prisma ignoraría el filtro y la consulta vería a todos los usuarios.
  return Number.isInteger(userId);
}

/** Solo nombre y código: el mensaje de un error de Prisma puede citar los valores consultados. */
function logFailure(action: string, err: unknown) {
  const { name, code } = (err ?? {}) as { name?: unknown; code?: unknown };
  logger.warn({ errName: name, errCode: code }, `aiMemory: falló ${action}`);
}

/** Normaliza un detalle o comercio a una clave estable; null si no sirve para recordar. */
export function normalizeMemoryKey(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  let key = tokenize(text).filter(isMemoryWord).join(' ');
  if (key.length > MAX_KEY_LENGTH) {
    // Corta por palabra si puede: media palabra daría una clave que no se repite.
    const space = key.lastIndexOf(' ', MAX_KEY_LENGTH);
    key = space > 0 ? key.slice(0, space) : key.slice(0, MAX_KEY_LENGTH);
  }
  const minLength = key.includes(' ') ? MIN_KEY_LENGTH : MIN_SINGLE_WORD_LENGTH;
  return key.length >= minLength ? key : null;
}

/** Sin términos vacíos, números puros ni palabras con tantos dígitos que pueden ser un dato personal. */
function isMemoryWord(word: string): boolean {
  if (STOP_WORDS.has(word) || /^\p{N}+$/u.test(word)) return false;
  return word.replace(/\P{N}/gu, '').length <= MAX_WORD_DIGITS;
}

/** Clave guardada: los ingresos llevan prefijo para no mezclarse con los gastos. */
function storedKey(key: string | null, type: string | null | undefined): string | null {
  return key !== null && type === 'INCOME' ? INCOME_PREFIX + key : key;
}

/** Fecha desde la que un recuerdo sigue vigente. */
function oldestValidDate(): Date {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - MEMORY_LIFETIME_MONTHS);
  return date;
}

/** Marca el recuerdo como usado, sin que la respuesta dependa de ello. */
function touch(prisma: any, userId: number, key: string) {
  void (async () => {
    await prisma.aiCategoryMemory.updateMany({ where: { userId, key }, data: { lastUsedAt: new Date() } });
  })().catch((err) => logFailure('actualizar lastUsedAt', err));
}

/**
 * Categoría recordada, si existe y sigue vigente. El detalle basta con una corrección; el comercio
 * necesita dos, porque en un mismo comercio se compran cosas de categorías distintas.
 */
export async function lookupCategory(
  prisma: any,
  userId: number,
  input: { description?: string | null; vendor?: string | null; type?: string | null }
): Promise<{ categoryId: number; key: string; hits: number } | null> {
  if (!isUserId(userId)) return null;
  const candidates = [
    { key: storedKey(normalizeMemoryKey(input.description), input.type), minHits: 1 },
    { key: storedKey(normalizeMemoryKey(input.vendor), input.type), minHits: MIN_VENDOR_HITS }
  ];
  try {
    const lastUsedAt = { gte: oldestValidDate() };
    for (const { key, minHits } of candidates) {
      if (key === null) continue;
      const memory = await prisma.aiCategoryMemory.findFirst({
        where: { userId, key, lastUsedAt },
        select: { categoryId: true, hits: true, category: { select: { userId: true } } }
      });
      if (memory && memory.hits >= minHits && memory.category?.userId === userId) {
        touch(prisma, userId, key);
        return { categoryId: memory.categoryId, key, hits: memory.hits };
      }
    }
  } catch (err) {
    logFailure('la búsqueda', err);
  }
  return null;
}

/** Recuerdos vigentes y del mismo tipo relacionados con el texto, como pista para la IA. */
export async function relevantHints(
  prisma: any,
  userId: number,
  text: string,
  limit = 20,
  type?: string | null
): Promise<MemoryHint[]> {
  const max = Math.min(Math.trunc(limit), MAX_HINTS);
  if (!isUserId(userId) || !(max > 0) || typeof text !== 'string') return [];
  const isHintWord = (word: string) =>
    !STOP_WORDS.has(word) && word.replace(/\P{L}/gu, '').length >= MIN_HINT_WORD_LETTERS;
  const words = new Set(tokenize(text).filter(isHintWord));
  if (!words.size) return [];
  const isIncome = type === 'INCOME';
  try {
    // Filtrar aquí es barato: son a lo sumo unos 500 recuerdos por usuario.
    const memories: Array<{ key: string; categoryId: number; category: { userId: number } | null }> =
      await prisma.aiCategoryMemory.findMany({
        where: { userId, lastUsedAt: { gte: oldestValidDate() } },
        select: { key: true, categoryId: true, category: { select: { userId: true } } },
        orderBy: [{ hits: 'desc' }, { lastUsedAt: 'desc' }, { id: 'desc' }]
      });
    return memories
      .filter((m) => m.category?.userId === userId && m.key.startsWith(INCOME_PREFIX) === isIncome)
      .map((m) => ({ texto: isIncome ? m.key.slice(INCOME_PREFIX.length) : m.key, categoriaId: m.categoryId }))
      .filter((hint) => hint.texto.split(' ').some((word) => words.has(word)))
      .slice(0, max);
  } catch (err) {
    logFailure('la lectura de pistas', err);
    return [];
  }
}

/** Guarda una corrección del usuario. Un fallo aquí nunca debe impedir registrar el movimiento. */
export async function recordCategoryCorrection(
  prisma: any,
  userId: number,
  input: { description?: string | null; vendor?: string | null; categoryId: number; type?: string | null }
): Promise<void> {
  try {
    if (!isUserId(userId)) return;
    const keys = [...new Set(
      [input.vendor, input.description]
        .map((text) => storedKey(normalizeMemoryKey(text), input.type))
        .filter((key): key is string => key !== null)
    )];
    if (!keys.length) return;
    const category = await prisma.category.findFirst({ where: { id: input.categoryId, userId }, select: { id: true } });
    if (!category) {
      logger.warn('aiMemory: la categoría no pertenece al usuario, no se guarda');
      return;
    }
    // Antes de guardar: una corrección nueva no debe sumar a un recuerdo ya caducado.
    await prisma.aiCategoryMemory.deleteMany({ where: { userId, lastUsedAt: { lt: oldestValidDate() } } });
    for (const key of keys) {
      // ON CONFLICT decide en una sola sentencia: dos correcciones a la vez no chocan por la
      // clave única ni se pisan el contador. El upsert de Prisma no sirve aquí porque la
      // actualización depende de la categoría ya guardada.
      await prisma.$executeRaw`
        INSERT INTO "AiCategoryMemory" ("userId", "key", "categoryId")
        VALUES (${userId}, ${key}, ${category.id})
        ON CONFLICT ("userId", "key") DO UPDATE SET
          "hits" = CASE WHEN "AiCategoryMemory"."categoryId" = EXCLUDED."categoryId"
                        THEN "AiCategoryMemory"."hits" + 1 ELSE 1 END,
          "categoryId" = EXCLUDED."categoryId",
          "lastUsedAt" = CURRENT_TIMESTAMP`;
    }
    const excess: Array<{ id: number }> = await prisma.aiCategoryMemory.findMany({
      where: { userId },
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
      skip: MAX_MEMORIES_PER_USER,
      select: { id: true }
    });
    if (excess.length) {
      await prisma.aiCategoryMemory.deleteMany({ where: { userId, id: { in: excess.map((m) => m.id) } } });
    }
  } catch (err) {
    logFailure('guardar la corrección', err);
  }
}
