// =====================================================
// Revisión determinista de lo que entendió la IA, antes de armar el borrador.
// Si algo es dudoso, se quita el dato para que el flujo lo pregunte, o se devuelve
// una pregunta de confirmación. No llama a la IA ni escribe en la base.
// =====================================================
import type { ParsedMovement } from './parser';

export type ReviewIssueCode = 'AMOUNT_MISMATCH' | 'AMOUNT_UNSUPPORTED' | 'AMOUNT_UNUSUAL' | 'DATE_FUTURE' | 'DATE_TOO_OLD';

export interface ReviewIssue {
  code: ReviewIssueCode;
  question: string; // en español, lista para enviar por WhatsApp
  options: { label: string; patch: Partial<Pick<ParsedMovement, 'amount' | 'date'>> }[]; // la primera conserva el valor
  free?: 'amount' | 'date'; // además de las opciones, se puede escribir el monto o la fecha
}

export interface ReviewContext {
  text: string;            // lo que escribió o dijo el usuario
  today: string;           // YYYY-MM-DD en hora de Ecuador
  accounts: { id: number; name: string; bankName?: string | null; accountKind?: string | null; accountNumber?: string | null }[];
  cards: { id: number; name: string; bankName?: string | null; last4?: string | null; type?: string | null }[];
  categoryIds: number[];
  walletIds?: number[];
  amountStats: { count: number; p95: number } | null; // historial del mismo tipo de movimiento
}

export interface ReviewResult {
  parsed: ParsedMovement;
  issues: ReviewIssue[];
  dropped: string[]; // campos quitados por dudosos, para registro y mediciones
}

const MAX_AMOUNT_OPTIONS = 3;
const MIN_HISTORY = 10;
const UNUSUAL_FACTOR = 10;
const UNUSUAL_FLOOR = 100;
const UNUSUAL_NO_HISTORY = 100000;
const MAX_AGE_DAYS = 365;
const DAY_MS = 86400000;
const EPSILON = 0.005;
const MAX_TEXT = 2000;
const MAX_FACTORS = 24; // tope de números distintos al probar productos y restas
const VALID_TYPES = new Set(['INCOME', 'EXPENSE', 'PURCHASE', 'TRANSFER', 'WITHDRAWAL']);

const fmtMoney = (v: number) =>
  new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(v).replace(/\s/g, '');
const fmtDate = (ymd: string) => ymd.split('-').reverse().join('/');
const same = (a: number, b: number) => Math.abs(a - b) < EPSILON;

/** Minúsculas, sin acentos, espacios simples. */
function normalize(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Montos ----

/** Misma regla que parseAmount de pipeline.ts: un separador con 3 dígitos detrás = miles. */
function parseNumber(raw: string): number {
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
  return Number(s);
}

const NUM = String.raw`\d{1,15}(?:[.,]\d{1,15}){0,8}`;
const NOT_INSIDE_WORD = String.raw`(?<![a-z\d])(?<![a-z]-)`;
const MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const WEEKDAYS = 'lunes|martes|miercoles|jueves|viernes|sabado|domingo';
const CURRENCY = 'dolares|dolar|usd|dls';
const CENTS = 'centavos|centavo|ctvs|cts|cents';
const NOT_MONEY_AFTER = String.raw`(?![.,]?\d)(?!\s*(?:\$|%|${CURRENCY}|${CENTS}|mil\b|k\b))`;

// Números en palabras: [valor, nivel]. El nivel impide unir palabras que no forman un solo número ("dos tres").
const WORD_VALUES = new Map<string, [number, number]>([
  ['un', [1, 1]], ['una', [1, 1]], ['uno', [1, 1]], ['dos', [2, 1]], ['tres', [3, 1]], ['cuatro', [4, 1]], ['cinco', [5, 1]],
  ['seis', [6, 1]], ['siete', [7, 1]], ['ocho', [8, 1]], ['nueve', [9, 1]], ['diez', [10, 1]], ['once', [11, 1]], ['doce', [12, 1]],
  ['trece', [13, 1]], ['catorce', [14, 1]], ['quince', [15, 1]], ['dieciseis', [16, 1]], ['diecisiete', [17, 1]], ['dieciocho', [18, 1]],
  ['diecinueve', [19, 1]], ['veinte', [20, 2]], ['veintiun', [21, 1]], ['veintiuno', [21, 1]], ['veintiuna', [21, 1]], ['veintidos', [22, 1]],
  ['veintitres', [23, 1]], ['veinticuatro', [24, 1]], ['veinticinco', [25, 1]], ['veintiseis', [26, 1]], ['veintisiete', [27, 1]],
  ['veintiocho', [28, 1]], ['veintinueve', [29, 1]], ['treinta', [30, 2]], ['cuarenta', [40, 2]], ['cincuenta', [50, 2]], ['sesenta', [60, 2]],
  ['setenta', [70, 2]], ['ochenta', [80, 2]], ['noventa', [90, 2]], ['cien', [100, 3]], ['ciento', [100, 3]], ['doscientos', [200, 3]],
  ['doscientas', [200, 3]], ['trescientos', [300, 3]], ['trescientas', [300, 3]], ['cuatrocientos', [400, 3]], ['cuatrocientas', [400, 3]],
  ['quinientos', [500, 3]], ['quinientas', [500, 3]], ['seiscientos', [600, 3]], ['seiscientas', [600, 3]], ['setecientos', [700, 3]],
  ['setecientas', [700, 3]], ['ochocientos', [800, 3]], ['ochocientas', [800, 3]], ['novecientos', [900, 3]], ['novecientas', [900, 3]]
]);
const isThousand = (w: string | undefined) => w === 'mil';
const isMillion = (w: string | undefined) => w === 'millon' || w === 'millones';
const isNumberWord = (w: string | undefined) => !!w && (WORD_VALUES.has(w) || isThousand(w) || isMillion(w));
const isOne = (w: string | undefined) => w === 'un' || w === 'una' || w === 'uno';
const CURRENCY_WORDS = new Set(CURRENCY.split('|'));

/** Pasa a cifras los números en palabras: "tres mil noventa y ocho" => "3098", "tres mil 98" => "3 mil 98". */
function convertNumberWords(text: string): { text: string; values: number[] } {
  const segments = text.match(/[a-z]+|[^a-z]+/g) ?? [];
  const values: number[] = [];
  const out: string[] = [];
  const isGap = (s: string | undefined) => s === ' ';

  let i = 0;
  while (i < segments.length) {
    const word = segments[i];
    const next = isGap(segments[i + 1]) ? segments[i + 2] : undefined;
    const afterDigit = /\d\s*$/.test(out.slice(-1)[0] ?? '');
    // "un", "una" y "uno" solo son número cuando acompañan a una cantidad ("un dólar", "un mil", "uno con 50").
    const articleLike = (word === 'un' || word === 'una') && !(next && (CURRENCY_WORDS.has(next) || isThousand(next) || next === 'con'));
    const pronounLike = word === 'uno' && !(next === 'con' || (isNumberWord(next) && !isOne(next)));
    const unitAfterDigit = afterDigit && (isThousand(word) || isMillion(word));
    if (!isNumberWord(word) || articleLike || pronounLike || unitAfterDigit) {
      out.push(word);
      i++;
      continue;
    }

    let total = 0;
    let current = 0;
    let lastLevel = 4;
    let j = i;
    let end = i;
    for (;;) {
      const w = segments[j];
      if (isThousand(w)) {
        if (total >= 1000) break;
        total += (current || 1) * 1000;
        current = 0;
        lastLevel = 4;
      } else if (isMillion(w)) {
        total = (total + (current || 1)) * 1000000;
        current = 0;
        lastLevel = 4;
      } else {
        const entry = WORD_VALUES.get(w);
        if (!entry || entry[1] >= lastLevel) break;
        current += entry[0];
        lastLevel = entry[1];
      }
      end = j;
      if (!isGap(segments[j + 1])) break;
      const following = segments[j + 2];
      const unit = isGap(segments[j + 3]) ? WORD_VALUES.get(segments[j + 4]) : undefined;
      if (following === 'y' && lastLevel === 2 && unit && unit[0] < 10) j += 4;
      else if (isNumberWord(following)) j += 2;
      else break;
    }
    const value = total + current;
    values.push(value);
    // Un "mil" final seguido de cifras se deja para que se lea junto a ellas.
    const endsInThousand = isThousand(segments[end]) && current === 0;
    const digitsFollow = isGap(segments[end + 1]) && /^\d/.test(segments[end + 2] ?? '');
    out.push(endsInThousand && digitsFollow ? `${value / 1000} mil` : String(value));
    i = end + 1;
  }
  return { text: out.join(''), values };
}

// Números que son claramente otra cosa y que no tiene sentido ofrecer como monto.
const NEVER_AMOUNT: RegExp[] = [
  // Últimos dígitos de un instrumento.
  /\b(?:termina\w*|terminacion|finaliza\w*|acaba\w*)\s+(?:en|con)?\s*\d+/g,
  /\b(?:ultimos?|ultimas?)\s+(?:\d+\s+)?(?:digitos?\s*)?(?:son\s+|de\s+)?\d*/g,
  /(?<![*x•])[*x•]{2,}\s*\d+/g,
  /\b(?:la|el|mi)\s+\d{4}\b(?![.,]\d)/g,
  /\b(?:cuenta|cta|tarjeta|visa|mastercard|master|diners|amex|debito|credito)\s*(?:terminada\s+en\s*)?\d{4,}/g,
  // Fechas completas.
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
  // Horas.
  /\b\d{1,2}:\d{2}(?::\d{2})?\b(?:\s*(?:am|pm|h|hrs)\b)?/g,
  /\ba\s+las?\s+\d{1,2}\b/g,
  /\b\d{1,2}\s*(?:am|pm|hrs?)\b/g,
  // Porcentajes y números largos de identificación (teléfonos, cuentas completas).
  new RegExp(String.raw`(?<![\d.,])${NUM}\s*(?:%|por\s+ciento\b)`, 'g'),
  /\b0\d{6,}\b/g,
  /\b\d{9,}\b/g
];

// Probablemente no son el monto, pero sí pueden serlo si el texto no trae otro ("recibo 40", "enero 85").
const PROBABLY_NOT_AMOUNT: RegExp[] = [
  // Factura, comprobante y demás documentos.
  /\b(?:factura|fact|fac|comprobante|recibo|voucher|ticket|orden|pedido|referencia|ref|cedula|ruc|telefono|tel|celular|cel|placa|lote)\b\.?\s*(?:(?:n|no|nro|num|numero)\b\.?)?\s*[°º#:]?\s*\d[\d-]*/g,
  /\b(?:nro|num|numero)\b\.?\s*[°º#:]?\s*\d[\d-]*/g,
  /\bn\s*[°º]\s*\d[\d-]*/g,
  /#\s*\d[\d-]*/g,
  // Fechas y plazos.
  new RegExp(String.raw`\b\d{1,2}\s*(?:de\s+)?(?:${MONTHS})\b(?:\s*(?:de|del)?\s*\d{4}\b)?`, 'g'),
  new RegExp(String.raw`\b(?:${MONTHS})\s+(?:(?:de|del)\s+)?(?:\d{1,2}|\d{4})\b(?![.,]\d)`, 'g'),
  /\bdel\s+\d{1,2}\s+al\s+\d{1,2}\b/g,
  new RegExp(String.raw`\b(?:el|del|dia|${WEEKDAYS})\s+(?:0?[1-9]|[12]\d|3[01])\b${NOT_MONEY_AFTER}`, 'g'),
  /\b(?:del|ano)\s+20\d{2}\b/g,
  /\b(?:hace\s+)?\d+\s*(?:dias?|semanas?|anos?)\b(?:\s+atras)?/g,
  /\bhace\s+\d+\s*(?:meses|mes|horas?|minutos?)\b/g
];

// Cantidades con unidad: no son el monto, pero sí pueden multiplicarse ("5 galones a 3").
const QUANTITY = /(?<![a-z\d])(\d{1,15}(?:[.,]\d{1,15})?)\s*(?:galones|galon|gal|litros?|lts?|kilos?|kg|libras?|lbs?|km|kilometros?|gb|mb|cuotas?|meses|quincenas?|personas?|unidades|unidad|uds?|cajas?|sacos?|fundas?|botellas?|horas?|hrs?|noches?)\b/g;

const CURRENCY_AFTER = new RegExp(String.raw`${NOT_INSIDE_WORD}(${NUM})\s*(?:\$|(?:${CURRENCY}|us)\b)`, 'g');
const CURRENCY_BEFORE = new RegExp(String.raw`(?:\$|\b(?:usd|dolares)\s)\s*(${NUM})`, 'g');
const PRICE_AT_END = new RegExp(String.raw`\bpor\s+\$?(${NUM})(?=\s*(?:$|[.,;!?]|(?:con|en|de|del|el|hoy|ayer|${CURRENCY})\b))`, 'g');
const VERB_BEFORE_NUMBER = /\b(?:pague|pago|gaste|gasto|cobre|cobraron|pagaron|deposite|retire)\s+\$?\d/;
const UNIT_PRICE_BEFORE = /(?:\b(?:a|cada)\s+|\d\s+[a-z]+\s+de\s+)$/;
const UNIT_PRICE_AFTER = /^\s*(?:cada|c\/u)\b/;

interface AmountEvidence {
  numbers: number[];   // candidatos a monto, en el orden del texto
  readings: number[];  // otras lecturas válidas que no se ofrecen como opción ("20 con 50")
  factors: number[];   // cantidades que solo sirven para multiplicar
  strong: number[];    // total explícito: con moneda ("20 dólares", "$20") o precio ("por 800")
  fromWords: number[]; // valores escritos en palabras
  all: number[];       // todas las cifras del mensaje, también las ignoradas
  offerable: number[]; // cifras ignoradas que tiene sentido ofrecer si no hay otra evidencia
}

function plainNumbers(t: string): number[] {
  const plain = new RegExp(String.raw`${NOT_INSIDE_WORD}(${NUM})(?:(?=(?:${CURRENCY}|us)\b)|(?![a-z\d]))`, 'g');
  const out: number[] = [];
  for (const m of t.matchAll(plain)) out.push(parseNumber(m[1]));
  return out.filter((n) => Number.isFinite(n) && n > 0);
}

function strongNumbers(t: string): number[] {
  const out: number[] = [];
  for (const re of [CURRENCY_AFTER, CURRENCY_BEFORE]) {
    for (const m of t.matchAll(re)) {
      const start = m.index as number;
      const before = t.slice(Math.max(0, start - 30), start);
      const after = t.slice(start + m[0].length, start + m[0].length + 12);
      if (!UNIT_PRICE_BEFORE.test(before) && !UNIT_PRICE_AFTER.test(after)) out.push(parseNumber(m[1]));
    }
  }
  if (!VERB_BEFORE_NUMBER.test(t)) {
    for (const m of t.matchAll(PRICE_AT_END)) out.push(parseNumber(m[1]));
  }
  return out.filter((n) => Number.isFinite(n) && n > 0);
}

function readAmounts(normalizedText: string, last4s: Set<string>): AmountEvidence {
  const converted = convertNumberWords(normalizedText);
  let t = converted.text;
  const numbers: number[] = [];
  const readings: number[] = [];
  const factors: number[] = [];
  const all = plainNumbers(t.replace(/[a-z]+/g, ' '));

  for (const re of NEVER_AMOUNT) t = t.replace(re, ' ');
  // Un número de 4 dígitos que coincide con un instrumento del usuario son sus últimos 4.
  t = t.replace(new RegExp(`${NOT_INSIDE_WORD}\\d{4}(?![\\d.,]{0,20}\\d)(?![a-z])`, 'g'), (m) => (last4s.has(m) ? ' ' : m));
  const offerable = plainNumbers(t.replace(/\d+(?:-\d+)+/g, ' '));
  for (const re of PROBABLY_NOT_AMOUNT) t = t.replace(re, ' ');
  t = t.replace(QUANTITY, (_m, n) => { factors.push(parseNumber(n)); return ' '; });

  // Montos con centavos: "2 dólares con 50 centavos", "2 dólares 50", "50 centavos", "medio dólar".
  t = t.replace(
    new RegExp(String.raw`${NOT_INSIDE_WORD}(\d{1,15})(?:\s*(?:\$|${CURRENCY}))?\s+(?:(?:con|y)\s+)?(\d{1,2})\s*(?:${CENTS})\b`, 'g'),
    (_m, a, b) => { numbers.push(Number(a) + Number(b) / 100); return ' '; }
  );
  t = t.replace(
    new RegExp(String.raw`${NOT_INSIDE_WORD}(\d{1,15})\s*(?:${CURRENCY})\s+(?:(?:con|y)\s+)?(\d{2})\b(?![.,]?\d)(?!\s*(?:\$|${CURRENCY}))`, 'g'),
    (_m, a, b) => { numbers.push(Number(a) + Number(b) / 100); return ' '; }
  );
  t = t.replace(
    new RegExp(String.raw`${NOT_INSIDE_WORD}(\d{1,3})\s*(?:${CENTS})\b`, 'g'),
    (_m, a) => { numbers.push(Number(a) / 100); return ' '; }
  );
  t = t.replace(new RegExp(String.raw`\bmedio\s+(?:${CURRENCY})\b`, 'g'), () => { numbers.push(0.5); return ' '; });

  // Miles escritos mixtos: "3 mil", "3 mil 98", "20k", "2 millones".
  t = t.replace(new RegExp(String.raw`${NOT_INSIDE_WORD}(${NUM})\s*(?:millones|millon)\b`, 'g'), (_m, n) => {
    numbers.push(parseNumber(n) * 1000000);
    return ' ';
  });
  t = t.replace(new RegExp(String.raw`${NOT_INSIDE_WORD}(${NUM})\s*(?:mil\b|k\b)(?:\s+(\d{1,3})\b(?![.,]?\d))?`, 'g'), (_m, n, rest) => {
    numbers.push(parseNumber(n) * 1000 + Number(rest ?? 0));
    return ' ';
  });

  // Lecturas habladas que no sustituyen a los números: "20 con 50", "20 y 50", "24 50", "3 y medio".
  for (const m of t.matchAll(new RegExp(String.raw`${NOT_INSIDE_WORD}(\d{1,15})(?:\s*(?:\$|${CURRENCY}))?\s+con\s+(\d{1,2})\b(?![.,]?\d)`, 'g'))) {
    readings.push(Number(m[1]) + Number(m[2]) / (m[2].length === 1 ? 10 : 100));
  }
  for (const m of t.matchAll(new RegExp(String.raw`${NOT_INSIDE_WORD}(\d{1,15})\s+(?:y\s+)?(\d{2})\b(?![.,]?\d)`, 'g'))) {
    readings.push(Number(m[1]) + Number(m[2]) / 100);
  }
  for (const m of t.matchAll(new RegExp(String.raw`${NOT_INSIDE_WORD}(\d{1,15})(?:\s*(?:\$|${CURRENCY}))?\s+y\s+medio\b`, 'g'))) {
    readings.push(Number(m[1]) + 0.5);
  }

  // Miles separados por espacio ("3 098") y decimales sin cero (".50").
  for (const m of t.matchAll(new RegExp(String.raw`${NOT_INSIDE_WORD}(\d{1,3})\s(\d{3})\b(?![.,]?\d)`, 'g'))) {
    readings.push(Number(m[1] + m[2]));
  }
  for (const m of t.matchAll(/(?<![a-z\d.,])[.,](\d{1,2})\b/g)) readings.push(Number(`0.${m[1]}`));

  const strong = strongNumbers(t);
  // Números sueltos; los pegados a letras son otra cosa ("95octanos", "5g", "20w50"), salvo la moneda.
  numbers.push(...plainNumbers(t));

  return {
    numbers: numbers.filter((n) => Number.isFinite(n) && n > 0),
    readings,
    factors,
    strong,
    fromWords: converted.values,
    all,
    offerable
  };
}

const distinct = (list: number[]) => Array.from(new Set(list));

function fitsSumOrDifference(amount: number, e: AmountEvidence): boolean {
  if (e.numbers.length > 1 && same(e.numbers.reduce((a, b) => a + b, 0), amount)) return true;
  const first = e.numbers.slice(0, MAX_FACTORS);
  for (const x of first) {
    for (const y of first) if (x > y && same(x - y, amount)) return true;
  }
  return false;
}

/** Coherente si coincide con un número, su suma, el producto de dos ("3 cafés a 2") o su resta ("100 menos 20"). */
function amountFitsText(amount: number, e: AmountEvidence): boolean {
  if (e.numbers.some((n) => same(n, amount)) || e.readings.some((n) => same(n, amount))) return true;
  if (fitsSumOrDifference(amount, e)) return true;
  const factors = [...e.numbers, ...e.factors].slice(0, MAX_FACTORS);
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) if (same(factors[i] * factors[j], amount)) return true;
  }
  return false;
}

/** Con un total explícito solo vale ese total, sus lecturas, la suma o la resta; multiplicar ya no. */
function amountFitsStrong(amount: number, e: AmountEvidence): boolean {
  if (e.strong.some((n) => same(n, amount)) || e.readings.some((n) => same(n, amount))) return true;
  if (e.strong.length > 1 && same(e.strong.reduce((a, b) => a + b, 0), amount)) return true;
  return fitsSumOrDifference(amount, e);
}

/** El monto solo pasaría por casualidad, o el mensaje no lo respalda. */
function unsupportedIssue(amount: number, candidates: number[]): ReviewIssue {
  const others = distinct(candidates).filter((n) => !same(n, amount)).slice(0, MAX_AMOUNT_OPTIONS);
  return {
    code: 'AMOUNT_UNSUPPORTED',
    question: `No veo ${fmtMoney(amount)} en tu mensaje. ¿Es correcto? Si no, escribe el monto.`,
    options: [
      { label: `Sí, ${fmtMoney(amount)}`, patch: { amount } },
      ...others.map((n) => ({ label: `No, ${fmtMoney(n)}`, patch: { amount: n } }))
    ],
    free: 'amount'
  };
}

/** Las cifras escritas con números se ofrecen antes que las palabras ("Tres Hermanos" no es un monto). */
function offerFrom(e: AmountEvidence): number[] {
  const digits = e.numbers.filter((n) => !e.fromWords.includes(n));
  return digits.length ? digits : e.numbers;
}

function amountIssue(amount: number, e: AmountEvidence): ReviewIssue | null {
  if (e.strong.length) {
    if (amountFitsStrong(amount, e)) return null;
    if (amountFitsText(amount, e)) return unsupportedIssue(amount, e.strong);
  } else if (amountFitsText(amount, e)) {
    return null;
  }

  // Tras quitar lo ignorado no queda nada: se compara con las cifras tal como vienen en el mensaje.
  if (!e.numbers.length) {
    if (e.all.some((n) => same(n, amount))) return null;
    return unsupportedIssue(amount, e.offerable);
  }
  if (e.fromWords.length) return unsupportedIssue(amount, offerFrom(e));

  const others = distinct(e.numbers).slice(0, MAX_AMOUNT_OPTIONS);
  return {
    code: 'AMOUNT_MISMATCH',
    question: `¿El monto es ${fmtMoney(amount)}?`,
    options: [
      { label: `Sí, ${fmtMoney(amount)}`, patch: { amount } },
      ...others.map((n) => ({ label: `No, ${fmtMoney(n)}`, patch: { amount: n } }))
    ]
  };
}

function reviewAmount(p: ParsedMovement, ctx: ReviewContext, normalizedText: string, last4s: Set<string>, out: ReviewResult): void {
  if (p.amount === null) return;
  const raw: unknown = p.amount;
  // La IA a veces devuelve el monto como texto: "20".
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    p.amount = null;
    out.dropped.push('amount');
    return;
  }
  p.amount = value;
  const amount = value;

  // Sin texto (por ejemplo, una imagen sin pie) no hay con qué comparar.
  if (normalizedText) {
    const issue = amountIssue(amount, readAmounts(normalizedText, last4s));
    if (issue) {
      out.issues.push(issue);
      return;
    }
  }

  const stats = ctx.amountStats;
  const hasHistory = !!stats && stats.count >= MIN_HISTORY && Number.isFinite(stats.p95);
  const unusual = hasHistory ? amount > Math.max(stats!.p95 * UNUSUAL_FACTOR, UNUSUAL_FLOOR) : amount >= UNUSUAL_NO_HISTORY;
  if (unusual) {
    out.issues.push({
      code: 'AMOUNT_UNUSUAL',
      question: `${fmtMoney(amount)} es un monto inusual. ¿Es correcto? Si no, escribe el monto.`,
      options: [{ label: `Sí, ${fmtMoney(amount)}`, patch: { amount } }],
      free: 'amount'
    });
  }
}

// ---- Fechas ----

/** Días desde 1970 de una fecha YYYY-MM-DD real; null si el formato o la fecha no existen. */
function dayNumber(ymd: unknown): number | null {
  if (typeof ymd !== 'string') return null;
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

function reviewDate(p: ParsedMovement, today: unknown, out: ReviewResult): void {
  if (p.date === null) return;
  const day = dayNumber(p.date);
  if (day === null) {
    p.date = null;
    out.dropped.push('date');
    return;
  }
  const now = dayNumber(today);
  if (now === null) return;
  const date = p.date;
  const options = [
    { label: `Sí, ${fmtDate(date)}`, patch: { date } },
    { label: `Usar hoy (${fmtDate(today as string)})`, patch: { date: today as string } }
  ];
  if (day > now) {
    out.issues.push({ code: 'DATE_FUTURE', question: `La fecha ${fmtDate(date)} es futura. ¿Es correcta?`, options, free: 'date' });
  } else if (now - day > MAX_AGE_DAYS) {
    out.issues.push({ code: 'DATE_TOO_OLD', question: `La fecha ${fmtDate(date)} tiene más de un año. ¿Es correcta?`, options, free: 'date' });
  }
}

// ---- Cuentas y tarjetas ----

type Kind = 'ahorros' | 'corriente' | 'credito' | 'debito';
const ACCOUNT_KINDS: Kind[] = ['ahorros', 'corriente'];
const CARD_KINDS: Kind[] = ['credito', 'debito'];
const KIND_ALIASES = new Map<string, Kind>([
  ['ahorros', 'ahorros'], ['ahorro', 'ahorros'], ['aho', 'ahorros'],
  ['corriente', 'corriente'], ['cte', 'corriente'],
  ['credito', 'credito'], ['debito', 'debito']
]);

interface Instrument {
  id: number;
  words: Set<string>;  // palabras significativas y abreviaturas
  last4: string[];     // últimos 4 propios y, en cuentas, los de sus tarjetas de débito
  kind: Kind | null;
}

const GENERIC_WORDS = new Set([
  'cuenta', 'cuentas', 'cta', 'tarjeta', 'tarjetas', 'banco', 'de', 'del', 'la', 'el', 'las', 'los', 'y', 'en', 'con', 'mi', 'mis',
  ...KIND_ALIASES.keys()
]);
const KIND_AND_TYPE_WORDS = new Set([...KIND_ALIASES.keys(), 'cuenta', 'tarjeta']);
// Palabras comunes que no cuentan como mención ni como abreviatura.
const COMMON_SHORT = new Set([
  'a', 'o', 'y', 'e', 'u', 'al', 'de', 'el', 'en', 'es', 'ha', 'la', 'le', 'lo', 'me', 'mi', 'no', 'se', 'si', 'su', 'te', 'tu', 'un', 'ya', 'yo',
  'con', 'del', 'las', 'les', 'los', 'mas', 'por', 'que', 'sin', 'una', 'uno'
]);

// Usos de "cuenta", "tarjeta" y "corriente" que no se refieren a un instrumento del usuario.
const NOT_INSTRUMENT = [
  /\bcuentas?\s+(?:de|del)\s+(?:(?:la|el)\s+)?(?:luz|agua|telefono|celular|internet|gas|restaurante|hotel|comida|almuerzo|cena)\b/g,
  /\bpag\w*\s+(?:la|esa|una)\s+cuenta\b(?!\s+(?:de\s+)?(?:ahorros?|corriente|bancaria)\b)/g,
  /\b(?:a|por)\s+cuenta\s+de\b/g,
  /\bdarse\s+cuenta\b|\bme\s+di\s+cuenta\b|\bteniendo\s+en\s+cuenta\b/g,
  /\btarjetas?\s+de\s+(?:navidad|regalo|cumpleanos|presentacion|recarga|invitacion|memoria|sonido|video|red)\b/g,
  /\b(?:mes|ano|agua|luz)\s+corriente\b/g
];

function cleanedText(normalizedText: string): string {
  let t = normalizedText;
  for (const re of NOT_INSTRUMENT) t = t.replace(re, ' ');
  // "B.N" o "b. n." se leen como "bn" y "bn".
  return t.replace(/\b([a-z])\.\s?([a-z])(?:\.\s?([a-z]))?\b\.?/g, (_m, a, b, c) => `${a}${b}${c ?? ''}`);
}

const tokensOf = (t: string) => t.split(/[^a-z0-9]+/).filter(Boolean);

function wordsOf(...names: (string | null | undefined)[]): Set<string> {
  const words = new Set<string>();
  const addAbbreviation = (abbr: string) => {
    if (abbr.length >= 2 && !COMMON_SHORT.has(abbr)) words.add(abbr);
  };
  for (const raw of names) {
    const tokens = tokensOf(normalize(raw)).filter((w) => !/^\d+$/.test(w));
    for (const w of tokens) {
      if (!GENERIC_WORDS.has(w) && w.length >= 2 && !COMMON_SHORT.has(w)) words.add(w);
    }
    // Iniciales del propio nombre: "Banco del Norte" => bdn y bn; "Mi Banco Uno" => mbu; "B.N-Corriente" => bn.
    const kept = tokens.filter((w) => !KIND_AND_TYPE_WORDS.has(w));
    if (kept.length >= 2) {
      addAbbreviation(kept.map((w) => w[0]).join(''));
      addAbbreviation(kept.filter((w) => !['de', 'del', 'la', 'el', 'y'].includes(w)).map((w) => w[0]).join(''));
    }
  }
  return words;
}

const lastDigits = (s: unknown): string | null => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
};

function accountKindOf(a: ReviewContext['accounts'][number]): Kind | null {
  const k = normalize(a.accountKind);
  if (k === 'savings' || k.startsWith('ahorro') || k === 'aho') return 'ahorros';
  if (k === 'checking' || k === 'corriente' || k === 'cte') return 'corriente';
  const kinds = new Set(tokensOf(normalize(a.name)).map((w) => KIND_ALIASES.get(w)));
  const saving = kinds.has('ahorros');
  const checking = kinds.has('corriente');
  if (saving === checking) return null;
  return saving ? 'ahorros' : 'corriente';
}

function cardKindOf(c: ReviewContext['cards'][number]): Kind | null {
  const k = normalize(c.type);
  if (k === 'credit' || k === 'credito') return 'credito';
  if (k === 'debit' || k === 'debito') return 'debito';
  return null;
}

/** Tarjetas de débito de la cuenta: mismo banco, y mismo titular si alguna lo cumple. */
function debitLast4ForAccount(a: ReviewContext['accounts'][number], cards: ReviewContext['cards']): string[] {
  const bank = normalize(a.bankName);
  if (!bank) return [];
  const sameBank = cards.filter((c) => cardKindOf(c) === 'debito' && normalize(c.bankName) === bank);
  const sameHolder = sameBank.filter((c) => normalize(c.name) === normalize(a.name));
  return (sameHolder.length ? sameHolder : sameBank).map((c) => lastDigits(c.last4)).filter((d): d is string => !!d);
}

const LAST4_MARKER = /(?:\b(?:termina\w*|terminacion|finaliza\w*)\s+(?:en\s+|con\s+)?|\b(?:la|el|mi|cuenta|cta|tarjeta)\s+|[*x•]\s*)$/;

/** Dígitos que apuntan a un instrumento, salvo los que son el propio monto sin indicación alguna. */
function hasLast4(text: string, last4: string[], amount: number | null): boolean {
  if (!last4.length) return false;
  for (const m of text.matchAll(/\d+/g)) {
    const run = m[0];
    if (run.length < 4 || !last4.includes(run.slice(-4))) continue;
    if (amount !== null && Number(run) === amount) {
      const start = m.index as number;
      if (!LAST4_MARKER.test(text.slice(Math.max(0, start - 30), start))) continue;
    }
    return true;
  }
  return false;
}

// ¿La palabra se dijo como medio de pago, o es casualidad ("pasaje a X", "Av. X", "el sueldo")?
const ARTICLES = new Set(['el', 'la', 'los', 'las']);
const INSTRUMENT_WORDS = new Set(['mi', 'mis', 'cuenta', 'cuentas', 'cta', 'banco', 'tarjeta', 'tarjetas', ...KIND_ALIASES.keys()]);
const CHAIN_WORDS = new Set([...ARTICLES, ...INSTRUMENT_WORDS, 'de', 'del']);
const PAYMENT_BEFORE = new Set(['con', 'desde', 'transferencia', 'deposito', 'mediante', 'usando']);
const STREET_WORDS = new Set(['calle', 'av', 'avenida']);
const PLACE_WORDS = new Set(['a', 'en', 'al', 'para', 'hacia', ...STREET_WORDS]);
const TRAVEL_WORDS = new Set(['pasaje', 'pasajes', 'vuelo', 'viaje', 'bus', 'taxi', 'uber', 'envio', 'encomienda']);
const PAY_WORDS = new Set(['pague', 'pago', 'abone', 'abono']);
const MAX_CHAIN = 6;

interface MentionRules {
  type: string | null;
  articleBlocks: boolean; // "el sueldo" no nombra una cuenta, pero "pagué la visa" sí nombra una tarjeta
}

interface Reading {
  text: string;
  tokens: string[];
  tokenSet: Set<string>;
  kinds: Kind[];
  rules: MentionRules | null; // null: no se exige indicio de pago (transferencias)
  firstPlace: number;
  deposit: boolean;
  transfer: boolean;
  travel: boolean;
}

function readingOf(text: string, family: Kind[], rules: MentionRules | null = null): Reading {
  const tokens = tokensOf(text);
  const tokenSet = new Set(tokens);
  const kinds = new Set<Kind>();
  for (const t of tokenSet) {
    const kind = KIND_ALIASES.get(t);
    if (kind && family.includes(kind)) kinds.add(kind);
  }
  return {
    text,
    tokens,
    tokenSet,
    kinds: [...kinds],
    rules,
    firstPlace: tokens.findIndex((t) => PLACE_WORDS.has(t)),
    deposit: tokens.some((t) => t.startsWith('deposit')),
    transfer: tokens.some((t) => t.startsWith('transferencia') || t.startsWith('transferi')),
    travel: tokens.some((t) => TRAVEL_WORDS.has(t))
  };
}

function mentionCounts(r: Reading, i: number): boolean {
  if (!r.rules) return true;
  let k = i - 1;
  let instrumentWord = false;
  let fromWord = false;
  while (k >= 0 && i - k <= MAX_CHAIN && CHAIN_WORDS.has(r.tokens[k])) {
    if (INSTRUMENT_WORDS.has(r.tokens[k])) instrumentWord = true;
    if (r.tokens[k] === 'de' || r.tokens[k] === 'del') fromWord = true;
    k--;
  }
  if (instrumentWord) return true;
  const before = k >= 0 ? r.tokens[k] : '';
  if (PAYMENT_BEFORE.has(before)) return true;
  if (STREET_WORDS.has(before)) return false;
  if (PLACE_WORDS.has(before)) {
    if (r.deposit) return true;
    // "pagué 20 a la visa": pagar la tarjeta sí la nombra.
    if (!r.rules.articleBlocks && (before === 'a' || before === 'al') && [r.tokens[k - 1], r.tokens[k - 2]].some((w) => PAY_WORDS.has(w))) return true;
    if (before !== 'en') return false;
    return r.transfer || r.rules.type === 'INCOME' || r.rules.type === 'WITHDRAWAL';
  }
  if (fromWord) return !r.travel;
  if (r.firstPlace >= 0 && r.firstPlace < i) return r.deposit;
  return !(r.rules.articleBlocks && ARTICLES.has(r.tokens[i - 1]));
}

function wordHits(inst: Instrument, r: Reading): number {
  const seen = new Set<string>();
  let previousCounted = false;
  r.tokens.forEach((token, i) => {
    let counted = false;
    if (inst.words.has(token) && (previousCounted || mentionCounts(r, i))) {
      seen.add(token);
      counted = true;
    }
    // "Banco Norte" también nombra a la cuenta abreviada "B.N-Corriente".
    if (token === 'banco') {
      const next = r.tokens[i + 1] === 'de' || r.tokens[i + 1] === 'del' ? r.tokens[i + 2] : r.tokens[i + 1];
      const abbr = next ? `b${next[0]}` : '';
      if (inst.words.has(abbr)) seen.add(abbr);
    }
    previousCounted = counted;
  });
  return seen.size;
}

interface Match { inst: Instrument; byDigits: boolean; hits: number }

function matchesIn(pool: Instrument[], r: Reading, amount: number | null): Match[] {
  const out: Match[] = [];
  for (const inst of pool) {
    const byDigits = hasLast4(r.text, inst.last4, amount);
    const hits = wordHits(inst, r);
    if (byDigits || hits > 0) out.push({ inst, byDigits, hits });
  }
  return out;
}

/** ¿El instrumento elegido es el único que queda tras aplicar los desempates? */
function uniqueAfterTieBreak(chosen: number, matches: Match[], kinds: Kind[]): boolean {
  let left = matches;
  if (left.some((m) => m.byDigits)) left = left.filter((m) => m.byDigits);
  if (kinds.length === 1) {
    const ofKind = left.filter((m) => m.inst.kind === kinds[0]);
    if (ofKind.length) left = ofKind;
  }
  if (left.length > 1) {
    const best = Math.max(...left.map((m) => m.hits));
    left = left.filter((m) => m.hits === best);
  }
  return left.length === 1 && left[0].inst.id === chosen;
}

interface InstrumentQuery {
  chosen: number;
  pool: Instrument[];   // instrumentos posibles para este dato
  reading: Reading;     // el trozo de texto que le corresponde
  whole?: Reading;      // en transferencias, el texto completo como segunda oportunidad
  mentioned: boolean;   // el trozo nombra el instrumento de forma genérica
  amount: number | null;
}

function hasBasis(q: InstrumentQuery): boolean {
  const matches = matchesIn(q.pool, q.reading, q.amount);
  if (matches.some((m) => m.inst.id === q.chosen)) return uniqueAfterTieBreak(q.chosen, matches, q.reading.kinds);
  if (matches.length) return false;

  // Sin nombre ni dígitos: el tipo o la mención genérica bastan si solo hay uno posible.
  if (q.reading.kinds.length === 1) {
    const kind = q.reading.kinds[0];
    const ofKind = q.pool.filter((i) => i.kind === kind);
    if (ofKind.length === 1 && ofKind[0].id === q.chosen) return true;
    if (q.whole) {
      const wide = matchesIn(q.pool, q.whole, q.amount).filter((m) => m.inst.kind === kind);
      if (wide.length === 1 && wide[0].inst.id === q.chosen) return true;
    }
  }
  return q.mentioned && q.pool.length === 1 && q.pool[0].id === q.chosen;
}

const FROM_WORD = /\b(?:de|del)\b/g;
const TO_WORD = /\b(?:a|al|hacia|para)\b/g;
const INSIDE_DESTINATION = /(?:^|\s)(?:cuenta|tarjeta|la|el|ahorros|ahorro|aho|corriente|cte|mi)\s*$/;

const indexes = (t: string, re: RegExp) => [...t.matchAll(re)].map((m) => m.index as number);

/** Separa el texto de una transferencia en origen y destino; null si no hay indicación. */
function splitTransfer(text: string): { from: string; to: string } | null {
  const t = text.replace(/\ba\s+las?\s+\d{1,2}\b/g, ' ');
  const tos = indexes(t, TO_WORD);
  const since = t.search(/\bdesde\b/);
  if (since >= 0) {
    const after = tos.find((i) => i > since);
    if (after !== undefined) return { from: t.slice(since, after), to: t.slice(after) };
    const before = tos[0];
    return { from: t.slice(since), to: before === undefined ? '' : t.slice(before, since) };
  }
  if (!tos.length) return null;

  const froms = indexes(t, FROM_WORD);
  if (froms.length) {
    const after = tos.find((i) => i > froms[0]);
    if (after !== undefined) return { from: t.slice(froms[0], after), to: t.slice(after) };
    // "a X de Y": el destino va primero; "a la cuenta de X" no es un origen.
    const origin = froms.find((i) => i > tos[0] && !INSIDE_DESTINATION.test(t.slice(Math.max(0, i - 12), i)));
    if (origin !== undefined) return { from: t.slice(origin), to: t.slice(tos[0], origin) };
  }
  return { from: t.slice(0, tos[0]), to: t.slice(tos[0]) };
}

const dropAccount = (p: ParsedMovement, out: ReviewResult) => { p.accountId = null; p.accountName = null; out.dropped.push('accountId'); };
const dropDestination = (p: ParsedMovement, out: ReviewResult) => { p.toAccountId = null; p.toAccountName = null; out.dropped.push('toAccountId'); };
const dropCard = (p: ParsedMovement, out: ReviewResult) => { p.cardId = null; p.cardName = null; out.dropped.push('cardId'); };

const ACCOUNT_MENTION = /\b(?:cuentas?|cta)\b/;
const PAYMENT_MENTION = /\b(?:bancos?|debito|transferencias?|transferi\w*|deposit\w*)\b/;
const CARD_MENTION = /\b(?:tarjetas?|tc|td)\b|\bde\s+(?:credito|debito)\b/;

function reviewInstruments(p: ParsedMovement, ctx: ReviewContext, normalizedText: string, out: ReviewResult): void {
  const amount = p.amount;
  const accounts: Instrument[] = ctx.accounts.map((a) => ({
    id: a.id,
    words: wordsOf(a.name, a.bankName),
    last4: [lastDigits(a.accountNumber), ...debitLast4ForAccount(a, ctx.cards)].filter((d): d is string => !!d),
    kind: accountKindOf(a)
  }));
  const cards: Instrument[] = ctx.cards.map((c) => ({
    id: c.id,
    words: wordsOf(c.name, c.bankName),
    last4: [lastDigits(c.last4)].filter((d): d is string => !!d),
    kind: cardKindOf(c)
  }));

  const text = cleanedText(normalizedText);
  const whole = readingOf(text, ACCOUNT_KINDS);
  const movementType = p.type;

  if (p.type === 'TRANSFER') {
    const origin = p.accountId;
    const destination = p.toAccountId;
    const split = splitTransfer(text);
    const check = (chosen: number, other: number | null, segment: string | null) => {
      const piece = segment ?? text;
      return hasBasis({
        chosen,
        pool: accounts.filter((a) => a.id !== other),
        reading: readingOf(piece, ACCOUNT_KINDS),
        whole: segment === null ? undefined : whole,
        mentioned: ACCOUNT_MENTION.test(piece) || /\botra\b/.test(piece),
        amount
      });
    };
    if (origin !== null && !check(origin, destination, split ? split.from : null)) dropAccount(p, out);
    if (destination !== null && !check(destination, origin, split ? split.to : null)) dropDestination(p, out);
  } else if (p.accountId !== null) {
    const debitByCard = p.paymentMethod === 'DEBIT_CARD' || /\btarjetas?\b/.test(text) && !/\bcredito\b/.test(text);
    const ok = hasBasis({
      chosen: p.accountId,
      pool: accounts,
      reading: readingOf(text, ACCOUNT_KINDS, { type: movementType, articleBlocks: true }),
      mentioned: ACCOUNT_MENTION.test(text) || PAYMENT_MENTION.test(text) || debitByCard,
      amount
    });
    if (!ok) dropAccount(p, out);
  }

  if (p.cardId !== null) {
    const reading = readingOf(text, CARD_KINDS, { type: movementType, articleBlocks: false });
    const chosenKind = cards.find((c) => c.id === p.cardId)?.kind ?? null;
    const sameType = chosenKind ? cards.filter((c) => c.kind === chosenKind || c.kind === null) : cards;
    // Las coincidencias se buscan entre todas las tarjetas; la mención genérica, entre las del mismo tipo.
    const matches = matchesIn(cards, reading, amount);
    const ok = matches.some((m) => m.inst.id === p.cardId)
      ? uniqueAfterTieBreak(p.cardId, matches, reading.kinds)
      : !matches.length && CARD_MENTION.test(text) && sameType.length === 1 && sameType[0].id === p.cardId;
    if (!ok) dropCard(p, out);
  }
}

// ---- Revisión ----

function reviewCatalog(p: ParsedMovement, ctx: ReviewContext, out: ReviewResult): void {
  const accountIds = new Set(ctx.accounts.map((a) => a.id));
  const cardIds = new Set(ctx.cards.map((c) => c.id));
  const categoryIds = new Set(ctx.categoryIds);

  if (p.accountId !== null && !accountIds.has(p.accountId)) dropAccount(p, out);
  if (p.toAccountId !== null && !accountIds.has(p.toAccountId)) dropDestination(p, out);
  if (p.cardId !== null && !cardIds.has(p.cardId)) dropCard(p, out);
  if (p.categoryId !== null && !categoryIds.has(p.categoryId)) {
    p.categoryId = null;
    p.categoryName = null;
    out.dropped.push('categoryId');
  }
  if (p.categoryCandidates !== null) {
    const current = Array.isArray(p.categoryCandidates) ? p.categoryCandidates : [];
    const valid = current.filter((id) => categoryIds.has(id));
    if (valid.length !== current.length || !Array.isArray(p.categoryCandidates)) out.dropped.push('categoryCandidates');
    p.categoryCandidates = valid;
  }
}

export function reviewParsed(parsed: ParsedMovement, rawCtx: ReviewContext): ReviewResult {
  if (!parsed || parsed.intent !== 'register') return { parsed, issues: [], dropped: [] };

  try {
    const ctx: ReviewContext = {
      text: String(rawCtx?.text ?? '').slice(0, MAX_TEXT),
      today: rawCtx?.today,
      accounts: Array.isArray(rawCtx?.accounts) ? rawCtx.accounts : [],
      cards: Array.isArray(rawCtx?.cards) ? rawCtx.cards : [],
      categoryIds: Array.isArray(rawCtx?.categoryIds) ? rawCtx.categoryIds : [],
      walletIds: rawCtx?.walletIds,
      amountStats: rawCtx?.amountStats ?? null
    };
    // La IA puede omitir claves: undefined se trata como null. Se trabaja sobre una copia.
    const p: ParsedMovement = {
      ...parsed,
      accountId: parsed.accountId ?? null,
      toAccountId: parsed.toAccountId ?? null,
      cardId: parsed.cardId ?? null,
      categoryId: parsed.categoryId ?? null,
      categoryCandidates: parsed.categoryCandidates ?? null,
      type: parsed.type ?? null,
      amount: parsed.amount ?? null,
      date: parsed.date ?? null
    };
    const out: ReviewResult = { parsed: p, issues: [], dropped: [] };
    const normalizedText = normalize(ctx.text);
    const last4s = new Set<string>([
      ...ctx.accounts.map((a) => lastDigits(a.accountNumber)),
      ...ctx.cards.map((c) => lastDigits(c.last4))
    ].filter((d): d is string => !!d));

    if (p.type !== null && !VALID_TYPES.has(p.type)) {
      p.type = null;
      out.dropped.push('type');
    }
    reviewCatalog(p, ctx, out);
    reviewAmount(p, ctx, normalizedText, last4s, out);
    reviewDate(p, ctx.today, out);
    if (p.type === 'TRANSFER' && p.accountId !== null && p.accountId === p.toAccountId) dropDestination(p, out);
    reviewInstruments(p, ctx, normalizedText, out);
    return out;
  } catch {
    return { parsed: { ...parsed }, issues: [], dropped: [] };
  }
}
