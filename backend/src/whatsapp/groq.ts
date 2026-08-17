// Credenciales de Groq del tenant, reutilizando la config de IA (Ajustes → IA).
// El bot usa la MISMA clave para Whisper (transcripción) y para el parsing.
import { decryptString } from '../lib/tenantCrypto';

export interface GroqCreds { apiKey: string; model: string; }

// Modelo vigente por defecto en Groq.
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
// Modelos dados de baja por Groq (2026): se sustituyen por el vigente para que
// el bot siga funcionando aunque la config del usuario esté desactualizada.
const DECOMMISSIONED = new Set([
  'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama-3.1-70b-versatile',
  'qwen/qwen3-32b', 'llama3-70b-8192', 'llama3-groq-70b-8192-tool-use-preview',
  'mixtral-8x7b-32768', 'gemma-7b-it', 'gemma2-9b-it'
]);

/** Normaliza el modelo: si fue dado de baja o falta, usa el vigente. */
export function resolveModel(model: string | null | undefined): string {
  return model && !DECOMMISSIONED.has(model) ? model : DEFAULT_GROQ_MODEL;
}

/** Devuelve la clave Groq descifrada + modelo vigente, o null si no hay clave. */
export async function getGroqCreds(prisma: any): Promise<GroqCreds | null> {
  const cfg = await prisma.aiConfig.findUnique({ where: { id: 1 } });
  if (!cfg?.apiKeyEnc) return null;
  try {
    return { apiKey: decryptString(cfg.apiKeyEnc), model: resolveModel(cfg.model) };
  } catch {
    return null;
  }
}
