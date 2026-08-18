// =====================================================
// Cliente LLM multi-proveedor (API compatible con OpenAI).
//
// El "cerebro" (análisis, recomendaciones y entender los mensajes) puede ser
// Groq u OpenRouter (que da acceso gratis a DeepSeek/Llama/Qwen/Gemini y más).
// La TRANSCRIPCIÓN de audio se queda SIEMPRE en Groq (Whisper), por eso se
// mantiene una clave de Groq aparte (transcribeApiKeyEnc) cuando el cerebro no
// es Groq.
//
// Robustez: si el proveedor configurado falla (modelo dado de baja, límite,
// etc.) se hace fallback automático a Groq, para que el bot nunca se caiga por
// un id de modelo desactualizado.
// =====================================================
import { decryptString } from '../lib/tenantCrypto';
import { logger } from '../lib/logger';
import { resolveModel, DEFAULT_GROQ_MODEL } from './groq';

export interface BrainCreds {
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
  groqKey: string | null; // clave de Groq para el fallback / transcripción
}

// Proveedores soportados (todos compatibles con la API de OpenAI). TODOS gratis.
export const PROVIDERS: Record<string, { baseUrl: string; defaultModel: string }> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: DEFAULT_GROQ_MODEL },
  // "openrouter/free" es un router que elige entre los modelos gratuitos vigentes
  // filtrando por capacidad (JSON/tools); así sobrevive a bajas de modelos sueltos.
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/free' },
  // Google Gemini vía su capa compatible con OpenAI. Capa gratuita generosa (AI Studio).
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash' }
};

export function resolveProvider(p: string | null | undefined): string {
  return p && PROVIDERS[p] ? p : 'groq';
}

/** Modelo efectivo según el proveedor (Groq sustituye modelos dados de baja). */
export function resolveBrainModel(provider: string, model: string | null | undefined): string {
  const prov = resolveProvider(provider);
  if (prov === 'groq') return resolveModel(model);
  return (model && model.trim()) || PROVIDERS[prov].defaultModel;
}

/** Credenciales del "cerebro" (proveedor configurado) o null si falta la clave. */
export async function getBrainCreds(prisma: any): Promise<BrainCreds | null> {
  const cfg = await prisma.aiConfig.findUnique({ where: { id: 1 } });
  if (!cfg) return null;
  const provider = resolveProvider(cfg.provider);
  const reg = PROVIDERS[provider];
  const baseUrl = (cfg.baseUrl && String(cfg.baseUrl).trim()) || reg.baseUrl;

  let apiKey: string | null = null;
  try { if (cfg.apiKeyEnc) apiKey = decryptString(cfg.apiKeyEnc); } catch { /* clave corrupta */ }
  if (!apiKey) return null;

  let groqKey: string | null = null;
  try { if (cfg.transcribeApiKeyEnc) groqKey = decryptString(cfg.transcribeApiKeyEnc); } catch { /* */ }
  if (provider === 'groq' && !groqKey) groqKey = apiKey; // con Groq, la misma clave sirve

  return { apiKey, model: resolveBrainModel(provider, cfg.model), baseUrl, provider, groqKey };
}

/** Clave de Groq para transcribir audio (Whisper). null si no hay ninguna. */
export async function getTranscribeCreds(prisma: any): Promise<{ apiKey: string } | null> {
  const cfg = await prisma.aiConfig.findUnique({ where: { id: 1 } });
  if (!cfg) return null;
  const provider = resolveProvider(cfg.provider);
  try {
    if (cfg.transcribeApiKeyEnc) return { apiKey: decryptString(cfg.transcribeApiKeyEnc) };
    if (provider === 'groq' && cfg.apiKeyEnc) return { apiKey: decryptString(cfg.apiKeyEnc) };
  } catch { /* clave corrupta */ }
  return null;
}

interface ChatOpts { system: string; user: string; jsonMode?: boolean; temperature?: number; maxTokens?: number }

async function callOnce(baseUrl: string, apiKey: string, model: string, useJson: boolean, opts: ChatOpts): Promise<{ status: number; content: string | null; err?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  // OpenRouter recomienda estas cabeceras (identifican la app); son inofensivas en otros.
  if (baseUrl.includes('openrouter')) { headers['HTTP-Referer'] = 'https://maat.ec'; headers['X-Title'] = 'MAAT Finanzas'; }
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 800,
      ...(useJson ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }]
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    logger.error({ status: res.status, model, useJson, baseUrl, t: t.slice(0, 300) }, 'llm: error del proveedor');
    return { status: res.status, content: null, err: t.slice(0, 200) };
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return { status: 200, content: data.choices?.[0]?.message?.content ?? null };
}

/**
 * Completa un chat con el proveedor configurado, con reintentos tolerantes:
 * 1) modelo configurado con modo JSON (si se pide); 2) sin modo JSON;
 * 3) fallback a Groq (si el cerebro no es Groq y hay clave). Devuelve el texto.
 */
export async function chatComplete(creds: BrainCreds, opts: ChatOpts): Promise<string> {
  const groq = PROVIDERS.groq;
  let r = await callOnce(creds.baseUrl, creds.apiKey, creds.model, !!opts.jsonMode, opts);
  if (r.status === 401 && creds.provider === 'groq') throw Object.assign(new Error('Clave de IA inválida. Revísala en Ajustes → FinancIA.'), { status: 400 });
  if (!r.content && opts.jsonMode) r = await callOnce(creds.baseUrl, creds.apiKey, creds.model, false, opts);
  // Fallback a Groq si el proveedor no es Groq y tenemos su clave.
  if (!r.content && creds.provider !== 'groq' && creds.groqKey) {
    logger.warn({ status: r.status, err: r.err }, 'llm: proveedor falló, usando Groq de respaldo');
    r = await callOnce(groq.baseUrl, creds.groqKey, groq.defaultModel, !!opts.jsonMode, opts);
    if (!r.content && opts.jsonMode) r = await callOnce(groq.baseUrl, creds.groqKey, groq.defaultModel, false, opts);
  }
  if (r.status === 401) throw Object.assign(new Error('Clave de IA inválida.'), { status: 400 });
  if (r.status === 429) throw Object.assign(new Error('Límite de uso de la IA alcanzado, intenta en un momento.'), { status: 429 });
  if (!r.content) throw Object.assign(new Error('La IA no devolvió respuesta. Revisa el modelo en Ajustes → FinancIA.'), { status: 502 });
  return r.content.trim();
}
