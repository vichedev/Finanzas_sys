// Puntuación de la interpretación contra lo esperado. Funciones puras: sin red ni base de datos.
import type { MovementCatalog, ParsedMovement } from '../src/whatsapp/parser';

export const EXPECT_FIELDS = ['intent', 'type', 'amount', 'paymentMethod', 'account', 'toAccount', 'card', 'category', 'date', 'isCredit'] as const;
export type ExpectField = (typeof EXPECT_FIELDS)[number];

/** Un campo ausente no se evalúa; null exige nulo. Las referencias van por nombre. */
export type EvalExpect = Partial<Record<ExpectField, string | number | boolean | null>>;

/** correcto; pregunta: el flujo se lo pide al usuario; erroneo: queda mal sin que nadie lo vea. */
export type FieldState = 'correcto' | 'pregunta' | 'erroneo';

export interface EvalCase {
  id: string;
  text: string;
  tags: string[];
  expect: EvalExpect;
}

export interface FieldScore {
  field: ExpectField;
  expected: string | number | boolean | null;
  got: string | number | boolean | null;
  ok: boolean;
  state: FieldState;
}

export interface CaseScore {
  ok: boolean;
  hits: number;
  total: number;
  asked: number;
  silentWrong: number;
  fields: FieldScore[];
}

const DATE_SPEC = /^(hoy|ayer|hoy-\d{1,3}|\d{4}-\d{2}-\d{2})$/;

/** Convierte "hoy", "ayer", "hoy-N" o una fecha fija en YYYY-MM-DD, a partir de `today`. */
export function resolveExpectedDate(spec: string, today: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  const back = spec === 'hoy' ? 0 : spec === 'ayer' ? 1 : Number(spec.replace('hoy-', ''));
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

const same = (a: unknown, b: unknown) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Campos sobre los que hay una duda pendiente, según el código de la revisión. */
export function fieldsInDoubt(issues: { code: string }[]): ExpectField[] {
  const fields = new Set<ExpectField>();
  for (const { code } of issues) {
    if (code.startsWith('AMOUNT_')) fields.add('amount');
    if (code.startsWith('DATE_')) fields.add('date');
  }
  return [...fields];
}

// Campos que el flujo pregunta si llegan vacíos. La fecha no (pone hoy), ni la intención ni isCredit.
const ASKED_WHEN_EMPTY: ExpectField[] = ['type', 'amount', 'paymentMethod', 'account', 'toAccount', 'card', 'category'];

/**
 * Compara lo interpretado con lo esperado, solo en los campos que el caso define.
 * `inDoubt` son los campos que el usuario todavía va a confirmar: ver fieldsInDoubt.
 */
export function scoreCase(expect: EvalExpect, parsed: ParsedMovement, catalog: MovementCatalog, today: string, inDoubt: ExpectField[] = []): CaseScore {
  const nameOf = (list: { id: number; name: string }[], id: number | null | undefined) => {
    if (id == null) return null;
    return list.find((x) => x.id === id)?.name ?? `id desconocido ${id}`;
  };
  const obtained: Record<ExpectField, string | number | boolean | null> = {
    intent: parsed.intent ?? null,
    type: parsed.type ?? null,
    amount: parsed.amount == null ? null : Number(parsed.amount),
    paymentMethod: parsed.paymentMethod ?? null,
    account: nameOf(catalog.accounts, parsed.accountId),
    toAccount: nameOf(catalog.accounts, parsed.toAccountId),
    card: nameOf(catalog.cards, parsed.cardId),
    category: nameOf(catalog.categories, parsed.categoryId),
    date: parsed.date ?? null,
    isCredit: parsed.isCredit === true
  };

  const fields: FieldScore[] = [];
  for (const field of EXPECT_FIELDS) {
    if (!(field in expect) || expect[field] === undefined) continue;
    const raw = expect[field] as string | number | boolean | null;
    const expected = field === 'date' && typeof raw === 'string' ? resolveExpectedDate(raw, today) : raw;
    const got = obtained[field];
    let ok: boolean;
    // Sin fecha, el flujo pone hoy: es correcto si se esperaba hoy.
    if (field === 'date' && got === null && expected === today) ok = true;
    else if (expected === null || got === null) ok = expected === got;
    else if (field === 'amount') ok = Math.abs(Number(got) - Number(expected)) < 0.005;
    else ok = same(got, expected);
    const asked = inDoubt.includes(field) || (got === null && ASKED_WHEN_EMPTY.includes(field));
    fields.push({ field, expected, got, ok, state: ok ? 'correcto' : asked ? 'pregunta' : 'erroneo' });
  }
  const hits = fields.filter((f) => f.ok).length;
  return {
    ok: hits === fields.length,
    hits,
    total: fields.length,
    asked: fields.filter((f) => f.state === 'pregunta').length,
    silentWrong: fields.filter((f) => f.state === 'erroneo').length,
    fields
  };
}

const ENUMS: Partial<Record<ExpectField, string[]>> = {
  intent: ['register', 'query'],
  type: ['INCOME', 'EXPENSE', 'PURCHASE', 'TRANSFER', 'WITHDRAWAL'],
  paymentMethod: ['CASH', 'BANK_TRANSFER', 'DEPOSIT', 'DEBIT_CARD', 'CREDIT_CARD', 'WALLET', 'OTHER']
};

/** Revisa que los casos estén bien formados y que sus referencias existan. Devuelve los problemas. */
export function validateCases(cases: unknown, catalog: MovementCatalog): string[] {
  if (!Array.isArray(cases)) return ['el archivo debe contener una lista de casos'];
  const problems: string[] = [];
  const seen = new Set<string>();
  const refs: Partial<Record<ExpectField, string[]>> = {
    account: catalog.accounts.map((a) => a.name),
    toAccount: catalog.accounts.map((a) => a.name),
    // Solo crédito: el débito se registra con su cuenta, nunca con cardId.
    card: catalog.cards.filter((c) => (c.type || '').toUpperCase() === 'CREDIT').map((c) => c.name),
    category: catalog.categories.map((c) => c.name)
  };

  cases.forEach((c: any, i) => {
    const label = c?.id ? `caso ${c.id}` : `caso #${i + 1}`;
    if (!c?.id || typeof c.id !== 'string') problems.push(`${label}: falta id`);
    else if (seen.has(c.id)) problems.push(`${label}: id repetido`);
    else seen.add(c.id);
    if (!c?.text || typeof c.text !== 'string') problems.push(`${label}: falta text`);
    if (!Array.isArray(c?.tags) || !c.tags.length) problems.push(`${label}: falta tags`);
    if (!c?.expect || typeof c.expect !== 'object') { problems.push(`${label}: falta expect`); return; }
    for (const [field, value] of Object.entries(c.expect) as [ExpectField, unknown][]) {
      if (!EXPECT_FIELDS.includes(field)) { problems.push(`${label}: campo desconocido "${field}"`); continue; }
      if (value === null) continue;
      if (ENUMS[field] && !ENUMS[field]!.includes(String(value))) problems.push(`${label}: ${field} inválido "${value}"`);
      if (refs[field] && !refs[field]!.includes(String(value))) problems.push(`${label}: ${field} "${value}" no está en el catálogo`);
      if (field === 'amount' && !(typeof value === 'number' && value > 0)) problems.push(`${label}: amount debe ser un número positivo o null`);
      if (field === 'date' && !DATE_SPEC.test(String(value))) problems.push(`${label}: date inválida "${value}"`);
      if (field === 'isCredit' && typeof value !== 'boolean') problems.push(`${label}: isCredit debe ser true o false`);
    }
  });
  return problems;
}
