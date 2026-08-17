// Credenciales de Groq del tenant, reutilizando la config de IA (Ajustes → IA).
// El bot usa la MISMA clave para Whisper (transcripción) y para el parsing.
import { decryptString } from '../lib/tenantCrypto';

export interface GroqCreds { apiKey: string; model: string; }

/** Devuelve la clave Groq descifrada + modelo, o null si no hay clave configurada. */
export async function getGroqCreds(prisma: any): Promise<GroqCreds | null> {
  const cfg = await prisma.aiConfig.findUnique({ where: { id: 1 } });
  if (!cfg?.apiKeyEnc) return null;
  try {
    return { apiKey: decryptString(cfg.apiKeyEnc), model: cfg.model || 'llama-3.3-70b-versatile' };
  } catch {
    return null;
  }
}
