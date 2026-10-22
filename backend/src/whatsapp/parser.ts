// =====================================================
// Intérprete (NLU): convierte una instrucción hablada/escrita en un movimiento
// financiero estructurado, usando Groq (LLM) con salida JSON. Se le pasan los
// catálogos reales del usuario (cuentas, tarjetas, categorías) para que devuelva
// directamente los IDs correctos, evitando matching frágil de strings.
// =====================================================
import { logger } from '../lib/logger';
import { getBrainCreds, chatComplete } from './llm';
import { accountBelongsToDebitCard } from '../lib/debitCard';

export type MovType = 'INCOME' | 'EXPENSE' | 'PURCHASE' | 'TRANSFER' | 'WITHDRAWAL';

export interface ParsedMovement {
  understood: boolean;
  intent: 'register' | 'query';
  type: MovType | null;
  amount: number | null;
  description: string | null;
  bankHint: string | null; // banco mencionado (ej. "Pichincha") para acotar las cuentas
  accountId: number | null;
  toAccountId: number | null;
  cardId: number | null;
  categoryId: number | null;
  categoryCandidates: number[] | null; // ids de categorías probables según el detalle (para acotar la lista)
  paymentMethod: 'CASH' | 'BANK_TRANSFER' | 'DEPOSIT' | 'DEBIT_CARD' | 'CREDIT_CARD' | 'WALLET' | 'OTHER' | null;
  date: string | null;
  isCredit: boolean;
  vendor: string | null;
  familyMember: string | null; // "quién paga" / persona involucrada
  notes: string | null;        // notas adicionales
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
  const creds = await getBrainCreds(prisma);
  if (!creds) return { error: 'Falta la clave de IA. Configúrala en Ajustes → FinancIA.' };

  const [accounts, cards, categories] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, bankId: true, accountKind: true, accountNumber: true, type: true } }),
    prisma.card.findMany({ where: { userId, isActive: true }, select: { id: true, name: true, bankName: true, bankId: true, last4: true, type: true } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true } })
  ]);

  // Para pagos con débito o cuenta usamos la CUENTA; las tarjetas de crédito sí van como cardId.
  const creditCards = cards.filter((c: any) => (c.type || '').toUpperCase() === 'CREDIT');
  const debitCards = cards.filter((c: any) => (c.type || '').toUpperCase() === 'DEBIT');
  const last4 = (s: unknown) => { const d = String(s ?? '').replace(/\D/g, ''); return d ? d.slice(-4) : null; };

  const catalogo = {
    // Datos ricos para emparejar la cuenta por nombre, banco, tipo o ultimos4.
    cuentas: accounts.map((a: any) => ({ id: a.id, nombre: a.name, banco: a.bankName, tipo: a.accountKind === 'SAVINGS' ? 'ahorros' : a.accountKind === 'CHECKING' ? 'corriente' : null, ultimos4: last4(a.accountNumber) })),
    tarjetasCredito: creditCards.map((c: any) => ({ id: c.id, nombre: c.name, banco: c.bankName, ultimos4: c.last4 })),
    // Tarjetas de DÉBITO -> se pagan con su CUENTA asociada (cuentaId si es única).
    tarjetasDebito: debitCards.map((c: any) => {
      const matched = accounts.filter((a: any) => accountBelongsToDebitCard(c, a));
      return { ultimos4: last4(c.last4), banco: c.bankName, cuentaId: matched.length === 1 ? matched[0].id : null };
    }),
    categorias: categories.map((c: any) => ({ id: c.id, nombre: c.name }))
  };

  const system = `Eres un asistente que convierte una instrucción (en español, Ecuador, moneda USD) en UN movimiento financiero en JSON.
Hoy es ${todayYmd()}.
Devuelve SOLO un objeto JSON válido con EXACTAMENTE estas claves:
{"understood":bool,"intent":"register|query","type":"INCOME|EXPENSE|PURCHASE|TRANSFER|WITHDRAWAL|null","amount":number|null,"description":string,"bankHint":string|null,"accountId":number|null,"toAccountId":number|null,"cardId":number|null,"categoryId":number|null,"categoryCandidates":number[],"paymentMethod":"CASH|BANK_TRANSFER|DEPOSIT|DEBIT_CARD|CREDIT_CARD|WALLET|OTHER|null","date":"YYYY-MM-DD|null","isCredit":bool,"vendor":string|null,"familyMember":string|null,"notes":string|null,"clarification":string|null}

Primero decide la intención:
- intent="register": el usuario quiere REGISTRAR un movimiento (ej. "gasté 20 en el súper", "ingreso de 800").
- intent="query": el usuario PREGUNTA, consulta o pide análisis/consejo sobre sus finanzas (ej. "¿cuánto he gastado?", "¿en qué gasto más?", "dame consejos", "¿cómo voy este mes?", "¿cuánto tengo en Pichincha?"). En este caso pon understood=false y deja los demás campos en null; NO inventes un movimiento.

Reglas (solo si intent="register"):
- type: INCOME=entra dinero (sueldo, cobro); EXPENSE=gasto/pago que sale (servicios, comida, salud); PURCHASE=compra de un bien/producto; TRANSFER=mover dinero entre DOS cuentas propias; WITHDRAWAL=retirar efectivo de una cuenta.
- amount: solo el número en USD. Interpreta cantidades habladas/escritas con MILES: "tres mil noventa y ocho" -> 3098, "mil quinientos" -> 1500, "3 mil" -> 3000, "3.098" o "3,098" -> 3098. El punto/coma seguido de 3 dígitos es separador de miles, NO decimal.
- bankHint: si el usuario menciona un banco o cuenta (ej. "Pichincha", "Guayaquil", "la cuenta de ahorros"), pon ese texto corto; si no menciona, null. NO inventes.
- accountId, toAccountId, cardId, categoryId: ELIGE únicamente por "id" de los catálogos dados. Si no se menciona o no calza con seguridad, usa null. NO inventes ids.
- paymentMethod: SOLO si el usuario menciona explícitamente CÓMO pagó/recibió (efectivo, transferencia, depósito, tarjeta de débito, tarjeta de crédito, billetera). Si NO lo menciona, null (el sistema lo preguntará).
- EMPAREJAR por últimos dígitos: si el usuario dice "la que termina en 4567", "la 4567", "****4567" o similar, busca ese número en los "ultimos4" de cuentas, tarjetasCredito y tarjetasDebito y usa el id correspondiente. Prioriza el match exacto por ultimos4 sobre el nombre.
- ELEGIR CUENTA de forma FLEXIBLE e INTELIGENTE: empareja la cuenta por CUALQUIERA de estos datos: nombre, banco, tipo (corriente/ahorros) o ultimos4. El nombre puede ser una abreviatura (ej. "B.P-Corriente" = Banco Pichincha, corriente; "B.G-MAAT" = Banco Guayaquil). Ejemplos: "la corriente de Pichincha" -> cuenta con banco Pichincha y tipo corriente; "Produbanco" -> cuenta de banco Produbanco; "Pacífico" -> cuenta de banco Pacífico; "mi ahorros de Guayaquil" -> banco Guayaquil tipo ahorros; "la del JEP" -> Cooperativa JEP. Reconoce el banco aunque el nombre esté abreviado. Pon siempre bankHint con el banco/cuenta mencionado. Si VARIAS cuentas calzan por igual (ej. solo dice "Pichincha" y hay varias), deja accountId=null para que el sistema pregunte cuál.
- Pago con TARJETA DE CRÉDITO -> paymentMethod="CREDIT_CARD", accountId=null SIEMPRE. cardId = id de la tarjeta de crédito (empareja por ultimos4 o nombre); si mencionan "tarjeta de crédito" pero no sabes cuál, igual paymentMethod="CREDIT_CARD", cardId=null y accountId=null. NUNCA uses una cuenta para un pago con tarjeta de crédito.
- Pago con TARJETA DE DÉBITO -> busca en "tarjetasDebito" por ultimos4; usa su "cuentaId" como accountId y paymentMethod="DEBIT_CARD". Si no hay cuentaId, intenta emparejar una cuenta por ultimos4. cardId=null.
- Pago con CUENTA / transferencia / depósito -> accountId = id de la cuenta (empareja por ultimos4 o nombre), paymentMethod="BANK_TRANSFER" (o "DEPOSIT" si dijo depósito). cardId=null. "débito" y "crédito" son DISTINTOS: no los confundas.
- Efectivo -> paymentMethod="CASH", sin cuenta ni tarjeta.
- familyMember: nombre de la persona si el usuario dice "quién paga" o menciona una persona involucrada; si no, null.
- notes: cualquier nota o número de factura extra que mencione; si no, null.
- TRANSFER: accountId=cuenta origen, toAccountId=cuenta destino (ambas de "cuentas", distintas).
- WITHDRAWAL: accountId=cuenta de la que sale el efectivo.
- date: fecha del movimiento en formato YYYY-MM-DD; resuelve "hoy", "ayer", "el 5", "el lunes". Si no se menciona, usa hoy.
- description: breve y clara en español (ej. "Gasolina", "Sueldo", "Supermercado").
- categoryId: ASIGNA con confianza la categoría del catálogo cuando el detalle se relacione claramente con ella (relaciona el concepto de forma inteligente: "víveres/súper/comida/mercado"->Alimentación; "gasolina/taxi/bus/uber"->Transporte; "medicina/doctor/farmacia"->Salud; "arriendo/luz/agua/internet"->Servicios/Hogar; etc.). Usa null SOLO si de verdad no hay ninguna categoría relacionada en el catálogo. Elige por el id real del catálogo.
- categoryCandidates: 2 a 4 ids de categorías probables según el detalle, ordenadas de más a menos probable (por si el usuario quiere cambiar la asignada). Si ninguna aplica, [].
- isCredit: true SOLO si es una compra "fiada"/"a crédito" que no se paga ahora.
- understood: true si pudiste extraer al menos "type" y "amount". Si falta lo esencial o es ambiguo, understood=false y explica breve en "clarification" qué necesitas.

Catálogos del usuario:
${JSON.stringify(catalogo)}`;

  // Llama al proveedor (Groq/OpenRouter) de forma tolerante: modo JSON → sin JSON →
  // fallback a Groq. Extrae el JSON aunque venga con ```json o texto alrededor.
  let raw: string;
  try {
    raw = await chatComplete(creds, { system, user: text, jsonMode: true, temperature: 0.1, maxTokens: 2000 });
  } catch (e: any) {
    return { error: e?.message || 'No pude interpretar el mensaje (falló la IA). Revisa el modelo en Ajustes → FinancIA.' };
  }

  // Extrae el objeto JSON aunque venga con ```json, texto extra, etc.
  const p = extractJson(raw);
  if (!p) { logger.error({ raw: raw.slice(0, 300) }, 'wa: JSON inválido del parser'); return { error: 'No entendí bien; intenta de nuevo con el tipo y el monto.' }; }

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

  // Filtra las candidatas a ids reales del usuario (máx 4). Incluye la principal si existe.
  const validIds = new Set(categories.map((c: any) => c.id));
  let cands = Array.isArray(p.categoryCandidates) ? p.categoryCandidates.filter((id) => validIds.has(id)) : [];
  if (p.categoryId && !cands.includes(p.categoryId)) cands = [p.categoryId, ...cands];
  p.categoryCandidates = Array.from(new Set(cands)).slice(0, 4);

  return p;
}
