// Mide cuánto acierta la IA al interpretar movimientos, con un catálogo inventado y sin base
// de datos. Consume cuota de Groq: una llamada por caso, repetición y modelo.
// Uso: npm run eval:ai -- [--model x,y] [--repeat 3] [--limit N] [--tag t] [--delay 1] [--out archivo.json] [--cases archivo]
import './quiet';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { todayEcuador } from '../src/lib/ecuadorDate';
import { DEFAULT_GROQ_MODEL } from '../src/whatsapp/groq';
import { PROVIDERS, type BrainCreds } from '../src/whatsapp/llm';
import { interpretMovement, type MovementCatalog, type ParsedMovement } from '../src/whatsapp/parser';
import { reviewParsed } from '../src/whatsapp/reviewParsed';
import { EVAL_CATALOG } from './catalog';
import { EXPECT_FIELDS, fieldsInDoubt, scoreCase, validateCases, type CaseScore, type EvalCase, type FieldScore } from './score';

const LOCAL_CASES = path.join(__dirname, 'cases.local.json');
const DEFAULT_CASES = path.join(__dirname, 'cases.json');
const RATE_LIMIT_PAUSE_MS = 30_000;
const MAX_CONSECUTIVE_ERRORS = 5;

export interface EvalOptions {
  apiKey: string;
  models: string[];
  repeat: number;
  delayMs: number;
  cases: EvalCase[];
  catalog: MovementCatalog;
  today: string;
  log?: (line: string) => void;
  onModelDone?: (report: EvalReport) => void;
}

interface Tally { hits: number; total: number; rate: number }
interface StageSummary {
  silentWrong: Tally; // campos con un valor equivocado que nadie pregunta: la cifra principal
  asked: Tally;       // campos sin acertar que el flujo le pide al usuario
  cases: Tally;
  fields: Tally;
  byField: Record<string, Tally>;
  byTag: Record<string, Tally>;
}
interface Failure {
  id: string;
  text: string;
  run: number;
  stage: 'ia' | 'con validacion';
  fields: FieldScore[];
}
interface ModelReport {
  model: string;
  calls: number;
  completed: number;
  errors: { count: number; items: { id: string; run: number; message: string }[] };
  stoppedEarly: boolean;
  ia: StageSummary;
  withReview: StageSummary & { issuesByCode: Record<string, number>; droppedByField: Record<string, number> };
  consistency: { rate: number | null; comparedCases: number; inconsistentCases: string[] };
  latencyMs: { mean: number | null; p50: number | null; p95: number | null };
  failures: Failure[];
}
export interface EvalReport {
  generatedAt: string;
  today: string;
  config: { models: string[]; repeat: number; delaySeconds: number; caseCount: number };
  models: ModelReport[];
  comparison: { model: string; silentWrongIa: number; silentWrongWithReview: number; casesIa: number; fieldsIa: number; casesWithReview: number; fieldsWithReview: number; consistency: number | null; latencyP50Ms: number | null; errors: number }[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rate = (hits: number, total: number) => (total ? Math.round((hits / total) * 1000) / 1000 : 0);

class StageCounter {
  private cases = { hits: 0, total: 0 };
  private fields = { hits: 0, total: 0 };
  private silentWrong = 0;
  private asked = 0;
  private byField = new Map<string, { hits: number; total: number }>();
  private byTag = new Map<string, { hits: number; total: number }>();

  add(tags: string[], score: CaseScore): void {
    this.cases.total++;
    if (score.ok) this.cases.hits++;
    this.fields.total += score.total;
    this.fields.hits += score.hits;
    this.silentWrong += score.silentWrong;
    this.asked += score.asked;
    for (const f of score.fields) bump(this.byField, f.field, f.ok);
    for (const tag of tags) bump(this.byTag, tag, score.ok);
  }

  summary(): StageSummary {
    return {
      silentWrong: { hits: this.silentWrong, total: this.fields.total, rate: rate(this.silentWrong, this.fields.total) },
      asked: { hits: this.asked, total: this.fields.total, rate: rate(this.asked, this.fields.total) },
      cases: { ...this.cases, rate: rate(this.cases.hits, this.cases.total) },
      fields: { ...this.fields, rate: rate(this.fields.hits, this.fields.total) },
      byField: toTallies(this.byField),
      byTag: toTallies(this.byTag)
    };
  }
}

function bump(map: Map<string, { hits: number; total: number }>, key: string, ok: boolean): void {
  const entry = map.get(key) ?? { hits: 0, total: 0 };
  entry.total++;
  if (ok) entry.hits++;
  map.set(key, entry);
}

function toTallies(map: Map<string, { hits: number; total: number }>): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const key of [...map.keys()].sort()) {
    const { hits, total } = map.get(key)!;
    out[key] = { hits, total, rate: rate(hits, total) };
  }
  return out;
}

function percentile(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
}

/** Lo que debe repetirse igual entre corridas para decir que el modelo es consistente. */
function signature(p: ParsedMovement): string {
  return JSON.stringify([p.intent, p.type, p.amount == null ? null : Number(p.amount), p.paymentMethod ?? null, p.accountId ?? null, p.toAccountId ?? null, p.cardId ?? null, p.categoryId ?? null, p.date ?? null]);
}

function consistencyOf(byCase: Map<string, string[]>): ModelReport['consistency'] {
  let sum = 0;
  let compared = 0;
  const inconsistentCases: string[] = [];
  for (const [id, signatures] of byCase) {
    if (signatures.length < 2) continue;
    const counts = new Map<string, number>();
    for (const s of signatures) counts.set(s, (counts.get(s) ?? 0) + 1);
    const top = Math.max(...counts.values());
    sum += top / signatures.length;
    compared++;
    if (counts.size > 1) inconsistentCases.push(id);
  }
  return { rate: compared ? rate(sum, compared) : null, comparedCases: compared, inconsistentCases };
}

function reviewFor(evalCase: EvalCase, parsed: ParsedMovement, catalog: MovementCatalog, today: string) {
  if (parsed.intent === 'query') return { parsed, issues: [], dropped: [] as string[] };
  return reviewParsed(structuredClone(parsed), {
    text: evalCase.text,
    today,
    accounts: catalog.accounts,
    cards: catalog.cards,
    categoryIds: catalog.categories.map((c) => c.id),
    amountStats: null
  });
}

async function evaluateModel(model: string, options: EvalOptions): Promise<ModelReport> {
  const { apiKey, cases, catalog, today, repeat, delayMs, log } = options;
  const creds: BrainCreds = { apiKey, model, baseUrl: PROVIDERS.groq.baseUrl, provider: 'groq', groqKey: apiKey };
  const ia = new StageCounter();
  const withReview = new StageCounter();
  const issuesByCode: Record<string, number> = {};
  const droppedByField: Record<string, number> = {};
  const failures: Failure[] = [];
  const errorItems: ModelReport['errors']['items'] = [];
  const signatures = new Map<string, string[]>();
  const latencies: number[] = [];
  const hideKey = (message: string) => message.split(apiKey).join('[clave oculta]');
  let calls = 0;
  let consecutiveErrors = 0;
  let stoppedEarly = false;

  outer: for (let run = 1; run <= repeat; run++) {
    for (const evalCase of cases) {
      if (calls > 0 && delayMs > 0) await sleep(delayMs);
      calls++;
      const started = Date.now();
      const result = await interpretMovement(creds, catalog, [], evalCase.text, today);
      if ('error' in result) {
        errorItems.push({ id: evalCase.id, run, message: hideKey(result.error) });
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          stoppedEarly = true;
          log?.(`  ${model}: ${MAX_CONSECUTIVE_ERRORS} errores seguidos, se detiene este modelo. Último: ${hideKey(result.error)}`);
          break outer;
        }
        if (result.status === 429) {
          log?.(`  ${model}: límite de la API, pausa de ${RATE_LIMIT_PAUSE_MS / 1000} s`);
          await sleep(RATE_LIMIT_PAUSE_MS);
        }
        continue;
      }
      consecutiveErrors = 0;
      latencies.push(Date.now() - started);
      signatures.set(evalCase.id, [...(signatures.get(evalCase.id) ?? []), signature(result)]);

      const score = scoreCase(evalCase.expect, result, catalog, today);
      ia.add(evalCase.tags, score);
      if (!score.ok) failures.push({ id: evalCase.id, text: evalCase.text, run, stage: 'ia', fields: score.fields.filter((f) => !f.ok) });

      const review = reviewFor(evalCase, result, catalog, today);
      for (const issue of review.issues) issuesByCode[issue.code] = (issuesByCode[issue.code] ?? 0) + 1;
      for (const field of review.dropped) droppedByField[field] = (droppedByField[field] ?? 0) + 1;
      const reviewedScore = scoreCase(evalCase.expect, review.parsed, catalog, today, fieldsInDoubt(review.issues));
      withReview.add(evalCase.tags, reviewedScore);
      if (!reviewedScore.ok) failures.push({ id: evalCase.id, text: evalCase.text, run, stage: 'con validacion', fields: reviewedScore.fields.filter((f) => !f.ok) });

      if (log && calls % 20 === 0) log(`  ${model}: ${calls} de ${cases.length * repeat}`);
    }
  }

  latencies.sort((a, b) => a - b);
  return {
    model,
    calls,
    completed: latencies.length,
    errors: { count: errorItems.length, items: errorItems },
    stoppedEarly,
    ia: ia.summary(),
    withReview: { ...withReview.summary(), issuesByCode, droppedByField },
    consistency: consistencyOf(signatures),
    latencyMs: {
      mean: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95)
    },
    failures
  };
}

/** Corre la medición completa. No lee variables de entorno ni escribe archivos. */
export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    today: options.today,
    config: { models: options.models, repeat: options.repeat, delaySeconds: options.delayMs / 1000, caseCount: options.cases.length },
    models: [],
    comparison: []
  };
  for (const model of options.models) {
    options.log?.(`Midiendo ${model} (${options.cases.length} casos x ${options.repeat})…`);
    const result = await evaluateModel(model, options);
    report.models.push(result);
    report.comparison.push({
      model,
      silentWrongIa: result.ia.silentWrong.rate,
      silentWrongWithReview: result.withReview.silentWrong.rate,
      casesIa: result.ia.cases.rate,
      fieldsIa: result.ia.fields.rate,
      casesWithReview: result.withReview.cases.rate,
      fieldsWithReview: result.withReview.fields.rate,
      consistency: result.consistency.rate,
      latencyP50Ms: result.latencyMs.p50,
      errors: result.errors.count
    });
    options.onModelDone?.(report);
  }
  return report;
}

const pct = (n: number | null) => (n == null ? 'n/d' : `${(n * 100).toFixed(1)} %`);
const line = (t: Tally) => `${t.hits}/${t.total} (${pct(t.rate)})`;

/** Resumen legible para la consola; el detalle completo queda en el archivo de resultados. */
export function formatReport(report: EvalReport): string {
  const out: string[] = [];
  for (const m of report.models) {
    out.push('', `=== ${m.model} ===`);
    out.push(`Llamadas: ${m.calls}; completas: ${m.completed}; errores de la API o de formato: ${m.errors.count}${m.stoppedEarly ? ' (detenido antes de terminar)' : ''}`);
    out.push(`ERRÓNEOS SILENCIOSOS: IA ${line(m.ia.silentWrong)} | con validación ${line(m.withReview.silentWrong)}`);
    out.push(`Se le preguntan:   IA ${line(m.ia.asked)} | con validación ${line(m.withReview.asked)}`);
    out.push(`Casos correctos:   IA ${line(m.ia.cases)} | con validación ${line(m.withReview.cases)}`);
    out.push(`Campos correctos:  IA ${line(m.ia.fields)} | con validación ${line(m.withReview.fields)}`);
    out.push(`Consistencia: ${pct(m.consistency.rate)} en ${m.consistency.comparedCases} casos; varían: ${m.consistency.inconsistentCases.join(', ') || 'ninguno'}`);
    out.push(`Latencia: media ${m.latencyMs.mean ?? 'n/d'} ms, p50 ${m.latencyMs.p50 ?? 'n/d'} ms, p95 ${m.latencyMs.p95 ?? 'n/d'} ms`);
    out.push(`Validación: preguntas ${JSON.stringify(m.withReview.issuesByCode)}; datos quitados ${JSON.stringify(m.withReview.droppedByField)}`);
    out.push('Por campo (IA | con validación):');
    for (const field of EXPECT_FIELDS) {
      if (m.ia.byField[field]) out.push(`  ${field.padEnd(14)} ${line(m.ia.byField[field])} | ${line(m.withReview.byField[field])}`);
    }
    out.push('Por etiqueta, casos (IA | con validación):');
    for (const [tag, tally] of Object.entries(m.ia.byTag)) out.push(`  ${tag.padEnd(22)} ${line(tally)} | ${line(m.withReview.byTag[tag])}`);
    const iaFailures = m.failures.filter((f) => f.stage === 'ia');
    out.push(`Fallos de la IA (${iaFailures.length}):`);
    for (const f of iaFailures) {
      const detail = f.fields.map((x) => `${x.field} [${x.state}]: esperado ${JSON.stringify(x.expected)}, obtenido ${JSON.stringify(x.got)}`).join('; ');
      out.push(`  [${f.id} #${f.run}] "${f.text}" -> ${detail}`);
    }
    if (m.errors.count) {
      out.push('Errores:');
      for (const e of m.errors.items) out.push(`  [${e.id} #${e.run}] ${e.message}`);
    }
  }
  if (report.comparison.length > 1) {
    out.push('', '=== Comparación ===', 'modelo | erróneos silenciosos IA | erróneos silenciosos validación | casos IA | campos IA | casos validación | campos validación | consistencia | p50 ms | errores');
    for (const c of report.comparison) {
      out.push(`${c.model} | ${pct(c.silentWrongIa)} | ${pct(c.silentWrongWithReview)} | ${pct(c.casesIa)} | ${pct(c.fieldsIa)} | ${pct(c.casesWithReview)} | ${pct(c.fieldsWithReview)} | ${pct(c.consistency)} | ${c.latencyP50Ms ?? 'n/d'} | ${c.errors}`);
    }
  }
  return out.join('\n');
}

/** ¿El archivo queda en evals/results o en algo que git ignora? Si no, puede acabar en el repositorio. */
export function isProtectedPath(file: string): boolean {
  const results = path.join(__dirname, 'results') + path.sep;
  if (path.resolve(file).startsWith(results)) return true;
  return spawnSync('git', ['check-ignore', '-q', path.resolve(file)], { cwd: __dirname }).status === 0;
}

function exitWith(message: string): never {
  console.error(message);
  process.exit(2);
}

function readCases(file: string): EvalCase[] {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as EvalCase[];
  } catch (e: any) {
    return exitWith(`No pude leer los casos de ${file}: ${e?.message}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    exitWith('Falta la clave de Groq. Defínela solo para este comando, por ejemplo en PowerShell:\n  $env:GROQ_API_KEY = "tu-clave"; npm run eval:ai\nLa medición consume cuota de esa clave. No se llamó a la API ni se escribió nada.');
  }

  let values;
  try {
    ({ values } = parseArgs({
      options: {
        model: { type: 'string' },
        repeat: { type: 'string', default: '3' },
        limit: { type: 'string' },
        tag: { type: 'string' },
        out: { type: 'string' },
        cases: { type: 'string' },
        delay: { type: 'string', default: '1' }
      }
    }));
  } catch (e: any) {
    return exitWith(`Opciones inválidas: ${e?.message}`);
  }
  const repeat = Number(values.repeat);
  const delay = Number(values.delay);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (!Number.isInteger(repeat) || repeat < 1) exitWith('--repeat debe ser un entero de 1 en adelante.');
  if (!Number.isFinite(delay) || delay < 0) exitWith('--delay debe ser un número de segundos, 0 o más.');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) exitWith('--limit debe ser un entero de 1 en adelante.');
  const models = (values.model ?? DEFAULT_GROQ_MODEL).split(',').map((m) => m.trim()).filter(Boolean);
  if (!models.length) exitWith('--model no indica ningún modelo.');

  for (const [option, file] of [['--out', values.out], ['--cases', values.cases]] as const) {
    if (file && !isProtectedPath(file)) console.warn(`Aviso: ${option} ${file} queda fuera de evals/results y de lo que git ignora. No dejes ahí casos reales.`);
  }

  let cases = readCases(values.cases ? path.resolve(values.cases) : DEFAULT_CASES);
  if (existsSync(LOCAL_CASES)) {
    const local = readCases(LOCAL_CASES);
    cases = [...cases, ...(Array.isArray(local) ? local.map((c) => ({ ...c, tags: [...(c.tags ?? []), 'local'] })) : [])];
  }
  const problems = validateCases(cases, EVAL_CATALOG);
  if (problems.length) exitWith(`Casos inválidos:\n  ${problems.join('\n  ')}`);
  if (values.tag) cases = cases.filter((c) => c.tags.includes(values.tag!));
  if (limit !== undefined) cases = cases.slice(0, limit);
  if (!cases.length) exitWith('Ningún caso coincide con el filtro.');

  const outFile = values.out
    ? path.resolve(values.out)
    : path.join(__dirname, 'results', `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  const save = (report: EvalReport) => writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');

  const report = await runEval({
    apiKey: apiKey!,
    models,
    repeat,
    delayMs: delay * 1000,
    cases,
    catalog: EVAL_CATALOG,
    today: todayEcuador(),
    log: (message) => console.log(message),
    onModelDone: save
  });
  console.log(formatReport(report));
  console.log(`\nResultado completo: ${outFile}`);
  if (report.models.some((m) => m.errors.count)) console.log('Hubo errores: no cuentan como fallos de interpretación.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`La medición falló: ${e?.message}`);
    process.exit(1);
  });
}
