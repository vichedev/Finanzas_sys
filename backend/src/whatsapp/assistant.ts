// =====================================================
// Asistente conversacional del bot: responde preguntas sobre las finanzas del
// usuario (con TODO el contexto real) y genera avisos proactivos de gasto.
// Reutiliza buildFinancialSnapshot (el mismo contexto que alimenta a FinancIA).
// =====================================================
import { logger } from '../lib/logger';
import { buildFinancialSnapshot } from '../lib/financia';
import { getGroqCreds } from './groq';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Formato pensado para WhatsApp: *negrita* con UN asterisco, viñetas con "• ".
const CHAT_SYSTEM = `Eres el asistente financiero personal del usuario, dentro de WhatsApp (Ecuador, moneda USD, IVA 15%).
Tienes los datos REALES de sus finanzas (ingresos, gastos, cuentas, tarjetas, deudas, presupuestos, recurrentes).
Responde en español, BREVE y directo (es WhatsApp, no un informe largo).
Formato WhatsApp: *negrita* con UN solo asterisco, viñetas con "• ", sin títulos markdown, sin tablas, sin #.
Cuando el usuario pregunte o pida consejo:
1) Da primero la cifra o el dato concreto que pide.
2) Señala lo relevante (categoría donde más gasta, gastos altos, deudas por vencer, saldos bajos, presupuestos excedidos), con números.
3) Cierra SIEMPRE con "*Te recomiendo:*" y una lista corta (2-4 viñetas) de acciones concretas a hacer o revisar.
No inventes datos que no estén en la información dada. Máximo ~9 líneas.`;

const COACH_SYSTEM = `Eres el coach financiero del usuario por WhatsApp (Ecuador, USD). Tienes sus datos reales del mes.
Escribe UN mensaje proactivo, breve y amable, para ayudarle a controlar sus gastos.
Empieza con "Oye 👋". Formato WhatsApp: *negrita* con UN asterisco, viñetas con "• ".
Incluye: cuánto lleva gastado este mes, la categoría donde MÁS gasta (con la cifra) y una recomendación clara para limitarlo. Si hay una deuda por vencer o un saldo negativo, menciónalo.
Máximo 6 líneas. Si NO hay nada realmente relevante que avisar (poco gasto, todo en orden), responde EXACTAMENTE la palabra: NADA`;

async function callGroq(apiKey: string, model: string, system: string, user: string, maxTokens = 500): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, temperature: 0.5, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    logger.error({ status: res.status, t: t.slice(0, 300) }, 'wa: assistant Groq error');
    if (res.status === 401) throw Object.assign(new Error('Clave de IA inválida.'), { status: 400 });
    if (res.status === 429) throw Object.assign(new Error('Groq: límite de uso alcanzado, intenta en un momento.'), { status: 429 });
    throw Object.assign(new Error('No pude generar la respuesta.'), { status: 502 });
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content || '').trim();
}

/** Responde una consulta del usuario usando todo su contexto financiero. */
export async function answerQuestion(prisma: any, userId: number, question: string): Promise<string> {
  const creds = await getGroqCreds(prisma);
  if (!creds) return '⚠️ Falta la clave de IA. Configúrala en *Ajustes → FinancIA*.';
  const { readable } = await buildFinancialSnapshot(prisma, userId);
  try {
    const answer = await callGroq(creds.apiKey, creds.model, CHAT_SYSTEM, `Datos financieros actuales:\n${readable}\n\nMensaje del usuario: ${question}`);
    return answer || 'No tengo suficiente información para responder eso.';
  } catch (e: any) {
    return `❌ ${e?.message || 'No pude responder ahora.'}`;
  }
}

/** Genera un aviso proactivo de gastos, o null si no hay nada relevante que decir. */
export async function proactiveCoach(prisma: any, userId: number): Promise<string | null> {
  const creds = await getGroqCreds(prisma);
  if (!creds) return null;
  const { readable } = await buildFinancialSnapshot(prisma, userId);
  try {
    const msg = await callGroq(creds.apiKey, creds.model, COACH_SYSTEM, `Datos financieros del usuario:\n${readable}`, 400);
    if (!msg || msg.trim().toUpperCase() === 'NADA') return null;
    return msg;
  } catch (e: any) {
    logger.error({ e: e?.message }, 'wa: coach falló');
    return null;
  }
}
