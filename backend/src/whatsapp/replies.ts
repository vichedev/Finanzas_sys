// =====================================================
// Lectura estricta de las respuestas del usuario en WhatsApp. Lo que no sea exactamente
// lo que se espera devuelve null, para volver a preguntar en lugar de adivinar. Va aparte
// porque lo usan pipeline.ts y entities.ts, y pipeline.ts ya importa entities.ts.
// =====================================================

const YES_WORD = String.raw`(?:s[ií]|dale|ok(?:ay)?|conf[ií]rmo|correcto|listo|va|h[aá]zlo|reg[ií]stra(?:lo)?|de una)`;
const YES_EMOJI = String.raw`(?:👍|✅)[\u{1F3FB}-\u{1F3FF}\u{FE0F}]*`;
const NO_WORD = String.raw`(?:no|nel|nop|cancela(?:r)?|olv[ií]dalo)`;
const NO_EMOJI = String.raw`❌\u{FE0F}*`;
const CLOSING = String.raw`[\s!.…]*`;

function wholeMessage(word: string, emoji: string, courtesy: string): RegExp {
  const words = `${word}(?:[\\s,]+${word})*(?:[\\s,]+${courtesy})?${CLOSING}(?:${emoji}${CLOSING})*`;
  return new RegExp(`^[\\s¡!]*(?:${words}|(?:${emoji}${CLOSING})+)$`, 'iu');
}

/** El mensaje ENTERO es afirmativo. "sí, pero son 30", "sí?" o "dale no" no lo son. */
export const STRICT_YES = wholeMessage(YES_WORD, YES_EMOJI, 'por favor');
/** El mensaje ENTERO es negativo. */
export const STRICT_NO = wholeMessage(NO_WORD, NO_EMOJI, 'gracias');
/** Un "no" suelto, que en una pregunta no significa anular. */
export const BARE_NO = /^\s*(no|nel|nop)\s*[.!]?\s*$/i;
/** Pide salir del flujo: "cancelar", "cancela los 30", "olvídalo". */
export const CANCEL_REQUEST = /^\s*(?:no[\s,]+)?(?:cancel\p{L}*|olv[ií]dalo|❌)(?![\p{L}\p{N}_])/iu;

const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Número con separadores: un separador con 3 dígitos detrás es de miles. */
export function readNumber(raw: string): number {
  let s = raw;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    const parts = s.split(',');
    s = parts.length === 2 && parts[1].length <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (hasDot) {
    const parts = s.split('.');
    if (!(parts.length === 2 && parts[1].length <= 2)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isNaN(n) ? NaN : n;
}

/** "2", "la 2", "el 2", "2 por favor", "no, la 2", "la opción 2" => 2. Sin comprobar el rango. */
export function parseOptionIndex(text: string): number | null {
  const m = plain(text).match(/^(?:no[\s,]+)?(?:(?:la|el)\s+)?(?:(?:opcion|numero)\s+)?(\d{1,2})[.)]?(?:[\s,]+por favor)?[.!]*$/);
  return m ? Number(m[1]) : null;
}

const CURRENCY = String.raw`(?:\$|dolares?|usd|dls)`;
const AMOUNT = new RegExp(
  String.raw`^(?:\$\s*)?(\d[\d.,]*?)(?:\s*mil(?:\s+(\d{1,3}))?)?(?:\s*${CURRENCY})?(?:\s+con\s+(\d{1,2})(?:\s*(?:centavos?|ctvs?))?)?(?:\s*${CURRENCY})?$`
);

function readWholeAmount(text: string): number | null {
  const m = text.match(AMOUNT);
  if (!m) return null;
  let n = readNumber(m[1]);
  if (/mil/.test(text)) n = n * 1000 + Number(m[2] ?? 0);
  if (m[3]) n += Number(m[3]) / (m[3].length === 1 ? 10 : 100);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Monto solo si el mensaje entero es un monto, con prefijo y moneda opcionales: "no, 3 mil",
 * "son 3 mil 98", "24 con 50", "no son 30 son 40". "pagué 15 de taxi" devuelve null.
 */
export function parseAmountReply(text: string): number | null {
  const t = plain(text).replace(/[.!]+$/, '').replace(/^(?:no[\s,:-]+)?(?:(?:son|eran|era|es|fueron|fue)\s+)?/, '');
  const corrected = t.match(/^(.+?)[\s,]+(?:son|eran|era|sino)\s+(.+)$/);
  if (corrected) return readWholeAmount(corrected[1]) === null ? null : readWholeAmount(corrected[2]);
  return readWholeAmount(t);
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MAX_DATE_AGE_DAYS = 365;
const DAY_MS = 86_400_000;

function dayOf(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms / DAY_MS : null;
}

export type DateReply = { date: string } | { outOfRange: true };

/**
 * Fecha escrita: ayer, hoy, anteayer, el 15, 15/03, 15/03/2026, 15 de marzo. Una fecha futura
 * o de más de un año devuelve outOfRange. Lo que no sea una fecha devuelve null.
 */
export function parseDateReply(text: string, today: string): DateReply | null {
  const [year, month, day] = today.split('-').map(Number);
  const now = dayOf(year, month, day);
  if (now === null) return null;
  const t = plain(text).replace(/[.!]+$/, '').replace(/^(?:no[\s,:-]+)?(?:(?:era|fue|es)\s+)?(?:(?:el|del)\s+)?(?:dia\s+)?/, '');

  let target: number | null = null;
  const numeric = t.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  const named = t.match(/^(\d{1,2})\s+de\s+(\p{L}+)(?:\s+(?:de|del)\s+(\d{4}))?$/u);
  if (t === 'hoy') target = now;
  else if (t === 'ayer') target = now - 1;
  else if (t === 'anteayer' || t === 'antier' || t === 'antes de ayer') target = now - 2;
  else if (/^\d{1,2}$/.test(t)) target = dayOf(year, month, Number(t));
  else if (numeric) {
    const y = numeric[3] ? Number(numeric[3]) + (numeric[3].length === 2 ? 2000 : 0) : year;
    target = dayOf(y, Number(numeric[2]), Number(numeric[1]));
  } else if (named && MONTHS.includes(named[2].replace('setiembre', 'septiembre'))) {
    const m = MONTHS.indexOf(named[2].replace('setiembre', 'septiembre')) + 1;
    target = dayOf(named[3] ? Number(named[3]) : year, m, Number(named[1]));
  }
  if (target === null) return null;
  if (target > now || now - target > MAX_DATE_AGE_DAYS) return { outOfRange: true };
  return { date: new Date(target * DAY_MS).toISOString().slice(0, 10) };
}

const NOT_A_CATEGORY = /^(?:ningun[oa]?|nada|otr[oa]|sin|categorias?|ya|si|no|ok|okay|listo|dale|va|correcto)$/;
const MOVEMENT_PHRASE = /^(?:gast|pagu|pague|compr|retir|transfer|deposit|ingres|cobr|me\s)/;

/** ¿Sirve como nombre de una categoría nueva? Una respuesta o una frase no deben crear una. */
export function isValidCategoryName(text: string): boolean {
  const name = text.trim();
  if (name.length < 2 || name.length > 40) return false;
  if (!/^[\p{L}\p{N} ]+$/u.test(name) || !/\p{L}/u.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 4 || words.some((w) => /^\d+$/.test(w))) return false;
  const t = plain(name);
  return !NOT_A_CATEGORY.test(t) && !MOVEMENT_PHRASE.test(t);
}

/** Forma normalizada para ver si un nombre aparece, como palabras completas, en un texto. */
export function mentions(text: string, name: string): boolean {
  const words = (s: string) => plain(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
  const needle = words(name);
  return !!needle && ` ${words(text)} `.includes(` ${needle} `);
}
