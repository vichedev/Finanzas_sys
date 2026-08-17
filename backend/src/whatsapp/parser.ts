// =====================================================
// Intérprete (NLU): convierte una instrucción hablada/escrita en un movimiento
// financiero estructurado, usando Groq (LLM) con salida JSON. Se le pasan los
// catálogos reales del usuario (cuentas, tarjetas, categorías) para que devuelva
// directamente los IDs correctos, evitando matching frágil de strings.
// =====================================================
import { logger } from '../lib/logger';
import { getGroqCreds } from './groq';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export type MovType = 'INCOME' | 'EXPENSE' | 'PURCHASE' | 'TRANSFER' | 'WITHDRAWAL';

export interface ParsedMovement {
  understood: boolean;
  intent: 'register' | 'query';
  type: MovType | null;
  amount: number | null;
  description: string | null;
  accountId: number | null;
  toAccountId: number | null;
  cardId: number | null;
  categoryId: number | null;
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'DEPOSIT' | 'DEBIT_CARD' | 'CREDIT_CARD' | 'WALLET' | 'OTHER' | null;
  date: string | null;
  isCredit: boolean;
  vendor: string | null;
  clarification: string | null;
  // Nombres resueltos (para el resumen legible)
  accountName?: string | null;
  toAccountName?: string | null;
  cardName?: string | null;
  categoryName?: string | null;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Extrae un objeto JSON de la respuesta de la IA, tolerando ```json, texto extra, etc. */
function extractJson(raw: string): ParsedMovement | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned) as ParsedMovement; } catch { /* intenta extraer */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]) as ParsedMovement; } catch { /* nada */ } }
  return null;
}

export async function parseMovement(prisma: any, userId: number, text: string): Promise<ParsedMovement | { error: string }> {
  const creds = await getGroqCreds(prisma);
  if (!creds) return { error: 'Falta la clave de IA. Configúrala en Ajustes → FinancIA.' };

  const [accounts, cards, categories] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, type: true } }),
    prisma.card.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, last4: true, type: true } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true } })
  ]);

  // Para pagos con débito o cuenta usamos la CUENTA; las tarjetas de crédito sí van como cardId.
  const creditCards = cards.filter((c: any) => (c.type || '').toUpperCase() === 'CREDIT');

  const catalogo = {
    cuentas: accounts.map((a: any) => ({ id: a.id, nombre: a.name, banco: a.bankName })),
    tarjetasCredito: creditCards.map((c: any) => ({ id: c.id, nombre: c.name, banco: c.bankName, ultimos4: c.last4 })),
    categorias: categories.map((c: any) => ({ id: c.id, nombre: c.name }))
  };

  const system = `Eres un asistente que convierte una instrucción (en español, Ecuador, moneda USD) en UN movimiento financiero en JSON.
Hoy es ${todayYmd()}.
Devuelve SOLO un objeto JSON válido con EXACTAMENTE estas claves:
{"understood":bool,"intent":"register|query","type":"INCOME|EXPENSE|PURCHASE|TRANSFER|WITHDRAWAL|null","amount":number|null,"description":string,"accountId":number|null,"toAccountId":number|null,"cardId":number|null,"categoryId":number|null,"paymentMethod":"CASH|BANK_TRANSFER|DEPOSIT|DEBIT_CARD|CREDIT_CARD|WALLET|OTHER|null","date":"YYYY-MM-DD|null","isCredit":bool,"vendor":string|null,"clarification":string|null}

Primero decide la intención:
- intent="register": el usuario quiere REGISTRAR un movimiento (ej. "gasté 20 en el súper", "ingreso de 800").
- intent="query": el usuario PREGUNTA, consulta o pide análisis/consejo sobre sus finanzas (ej. "¿cuánto he gastado?", "¿en qué gasto más?", "dame consejos", "¿cómo voy este mes?", "¿cuánto tengo en Pichincha?"). En este caso pon understood=false y deja los demás campos en null; NO inventes un movimiento.

Reglas (solo si intent="register"):
- type: INCOME=entra dinero (sueldo, cobro); EXPENSE=gasto/pago que sale (servicios, comida, salud); PURCHASE=compra de un bien/producto; TRANSFER=mover dinero entre DOS cuentas propias; WITHDRAWAL=retirar efectivo de una cuenta.
- amount: solo el número en USD (ej. "veinte dólares" -> 20).
- accountId, toAccountId, cardId, categoryId: ELIGE únicamente por "id" de los catálogos dados. Si no se menciona o no calza con seguridad, usa null. NO inventes ids.
- Pago con TARJETA DE CRÉDITO -> cardId = id de la tarjeta de crédito, paymentMethod="CREDIT_CARD", accountId=null.
- Pago con CUENTA o TARJETA DE DÉBITO -> accountId = id de la cuenta correspondiente, paymentMethod="DEBIT_CARD" (si dijo "débito") o "BANK_TRANSFER" (si dijo transferencia/cuenta). cardId=null.
- Efectivo -> paymentMethod="CASH", sin cuenta ni tarjeta.
- TRANSFER: accountId=cuenta origen, toAccountId=cuenta destino (ambas de "cuentas", distintas).
- WITHDRAWAL: accountId=cuenta de la que sale el efectivo.
- date: fecha del movimiento en formato YYYY-MM-DD; resuelve "hoy", "ayer", "el 5", "el lunes". Si no se menciona, usa hoy.
- description: breve y clara en español (ej. "Gasolina", "Sueldo", "Supermercado").
- categoryId: elige la categoría más adecuada del catálogo si aplica (para EXPENSE/INCOME/PURCHASE); si ninguna calza, null.
- isCredit: true SOLO si es una compra "fiada"/"a crédito" que no se paga ahora.
- understood: true si pudiste extraer al menos "type" y "amount". Si falta lo esencial o es ambiguo, understood=false y explica breve en "clarification" qué necesitas.

Catálogos del usuario:
${JSON.stringify(catalogo)}`;

  // Llama a Groq de forma tolerante: prueba el modelo configurado; si falla (p. ej.
  // modelo desactualizado o sin soporte de JSON), reintenta con un modelo conocido
  // y sin "response_format". Extrae el JSON aunque venga con texto/fences alrededor.
  const FALLBACK_MODEL = 'llama-3.3-70b-versatile';
  const messages = [{ role: 'system', content: system }, { role: 'user', content: text }];

  async function callGroq(model: string, useJsonMode: boolean): Promise<{ status: number; content: string | null; err?: string }> {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds!.apiKey}` },
      body: JSON.stringify({ model, temperature: 0.1, max_tokens: 500, ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}), messages })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logger.error({ status: res.status, model, useJsonMode, t: t.slice(0, 300) }, 'wa: parser Groq error');
      return { status: res.status, content: null, err: t.slice(0, 200) };
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { status: 200, content: data.choices?.[0]?.message?.content ?? null };
  }

  // Intento 1: modelo del usuario con modo JSON. Fallbacks ante error.
  let r = await callGroq(creds.model, true);
  if (r.status === 401) return { error: 'Clave de IA inválida. Revísala en Ajustes → FinancIA.' };
  if (r.status === 429) return { error: 'Groq: límite de uso alcanzado, intenta en un momento.' };
  if (!r.content) r = await callGroq(creds.model, false);                 // sin modo JSON
  if (!r.content && creds.model !== FALLBACK_MODEL) r = await callGroq(FALLBACK_MODEL, true); // modelo conocido
  if (!r.content) return { error: 'No pude interpretar el mensaje (falló la IA). Revisa el modelo en Ajustes → FinancIA.' };

  // Extrae el objeto JSON aunque venga con ```json, texto extra, etc.
  const p = extractJson(r.content);
  if (!p) { logger.error({ raw: r.content.slice(0, 300) }, 'wa: JSON inválido del parser'); return { error: 'No entendí bien; intenta de nuevo con el tipo y el monto.' }; }

  p.intent = p.intent === 'query' ? 'query' : 'register';

  // Descarta ids que la IA haya inventado y resuelve nombres para el resumen.
  const findAcc = (id: number | null) => (id ? accounts.find((a: any) => a.id === id) : undefined);
  if (p.accountId && !findAcc(p.accountId)) p.accountId = null;
  if (p.toAccountId && !findAcc(p.toAccountId)) p.toAccountId = null;
  p.accountName = findAcc(p.accountId)?.name ?? null;
  p.toAccountName = findAcc(p.toAccountId)?.name ?? null;

  const card = p.cardId ? creditCards.find((c: any) => c.id === p.cardId) : undefined;
  if (p.cardId && !card) p.cardId = null;
  p.cardName = card?.name ?? null;

  const cat = p.categoryId ? categories.find((c: any) => c.id === p.categoryId) : undefined;
  if (p.categoryId && !cat) p.categoryId = null;
  p.categoryName = cat?.name ?? null;

  return p;
}
