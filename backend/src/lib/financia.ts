import { PrismaClient, Prisma } from '.prisma/tenant';
import { logger } from './logger';
import { accountBelongsToDebitCard } from './debitCard';

type TenantPrisma = PrismaClient;

function monthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { start, end };
}

const fmt = (v: unknown) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(v || 0));

/**
 * Reúne una foto financiera compacta del usuario para que FinancIA la analice.
 * Devuelve un objeto estructurado (no texto) y un resumen legible.
 */
export async function buildFinancialSnapshot(prisma: TenantPrisma, userId: number) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const { start, end } = monthRange(year, month);

  const [totalsRaw, byCatRaw, accounts, cards, debts, budgets, recentCount, categories] = await Promise.all([
    prisma.$queryRaw<Array<{ income: number; expense: number }>>(Prisma.sql`
      SELECT
        SUM(CASE WHEN "type" = 'INCOME' THEN "amount" ELSE 0 END)::float8 AS income,
        (SUM(CASE WHEN "type" IN ('EXPENSE','WITHDRAWAL') THEN "amount"
                  WHEN "type" = 'PURCHASE' AND "isCredit" = false THEN "amount" ELSE 0 END)
         + COALESCE(SUM("commission"), 0))::float8 AS expense
      FROM "Movement"
      WHERE "userId" = ${userId} AND "movementDate" >= ${start} AND "movementDate" < ${end}
    `),
    prisma.$queryRaw<Array<{ categoryId: number | null; amount: number }>>(Prisma.sql`
      SELECT "categoryId", SUM("amount")::float8 AS amount
      FROM "Movement"
      WHERE "userId" = ${userId} AND "movementDate" >= ${start} AND "movementDate" < ${end}
        AND ("type" = 'EXPENSE' OR ("type" = 'PURCHASE' AND "isCredit" = false))
      GROUP BY "categoryId" ORDER BY amount DESC LIMIT 8
    `),
    prisma.account.findMany({ where: { userId, isActive: true }, select: { name: true, type: true, currentBalance: true, bankId: true } }),
    prisma.card.findMany({ where: { userId, isActive: true }, select: { name: true, type: true, bankId: true, creditLimit: true, currentBalance: true, paymentDueDay: true } }),
    prisma.debt.findMany({ where: { userId, status: { in: ['OPEN', 'PARTIAL'] } }, select: { name: true, kind: true, balance: true, dueDate: true } }),
    prisma.budget.findMany({ where: { userId, isActive: true }, include: { category: true } }),
    prisma.movement.count({ where: { userId, movementDate: { gte: start, lt: end } } }),
    prisma.category.findMany({ where: { userId }, select: { id: true, name: true } })
  ]);

  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const income = Number(totalsRaw[0]?.income || 0);
  const expense = Number(totalsRaw[0]?.expense || 0);

  // Gasto del mes por categoría para comparar con presupuestos
  const spentByCat = new Map<number, number>();
  for (const r of byCatRaw) if (r.categoryId != null) spentByCat.set(r.categoryId, Number(r.amount || 0));

  const snapshot = {
    period: `${month}/${year}`,
    income,
    expense,
    balance: income - expense,
    movementsThisMonth: recentCount,
    accounts: accounts.map((a) => ({ name: a.name, type: a.type, balance: Number(a.currentBalance) })),
    cards: cards.map((c) => {
      // Débito: no hay "usado"; el saldo es la suma de sus cuentas (mismo banco y titular).
      const debitBalance = c.type === 'DEBIT'
        ? accounts
            .filter((a) => accountBelongsToDebitCard(c, a))
            .reduce((sum, a) => sum + Number(a.currentBalance ?? 0), 0)
        : null;
      return {
        name: c.name, type: c.type,
        limit: c.creditLimit ? Number(c.creditLimit) : null,
        used: c.type === 'DEBIT' ? null : Number(c.currentBalance),
        balance: debitBalance,
        available: c.creditLimit ? Number(c.creditLimit) - Number(c.currentBalance) : null,
        paymentDueDay: c.paymentDueDay
      };
    }),
    debts: debts.map((d) => ({ name: d.name, kind: d.kind, balance: Number(d.balance), dueDate: d.dueDate })),
    topExpenseCategories: byCatRaw.map((r) => ({ category: r.categoryId ? (catName.get(r.categoryId) || 'Sin categoría') : 'Sin categoría', amount: Number(r.amount || 0) })),
    budgets: budgets.map((b) => {
      const limit = Number(b.amount);
      const spent = spentByCat.get(b.categoryId) || 0;
      return { category: b.category?.name || 'Sin categoría', limit, spent, pct: limit > 0 ? Math.round((spent / limit) * 100) : 0 };
    })
  };

  // Resumen legible para incrustar en el prompt
  const lines: string[] = [];
  lines.push(`Periodo: ${snapshot.period}`);
  lines.push(`Ingresos del mes: ${fmt(income)} | Gastos: ${fmt(expense)} | Balance: ${fmt(snapshot.balance)} | Movimientos: ${recentCount}`);
  if (snapshot.accounts.length) lines.push(`Cuentas: ${snapshot.accounts.map((a) => `${a.name} (${a.type}) ${fmt(a.balance)}`).join('; ')}`);
  if (snapshot.cards.length) lines.push(`Tarjetas: ${snapshot.cards.map((c) => c.type === 'DEBIT'
    ? `${c.name} (débito) saldo ${fmt(c.balance ?? 0)}`
    : `${c.name} usado ${fmt(c.used ?? 0)}${c.limit ? ` de ${fmt(c.limit)} (disp. ${fmt(c.available)})` : ''}`).join('; ')}`);
  if (snapshot.debts.length) lines.push(`Deudas/cobros activos: ${snapshot.debts.map((d) => `${d.name} [${d.kind}] ${fmt(d.balance)}`).join('; ')}`);
  if (snapshot.topExpenseCategories.length) lines.push(`Gasto por categoría: ${snapshot.topExpenseCategories.map((c) => `${c.category} ${fmt(c.amount)}`).join('; ')}`);
  if (snapshot.budgets.length) lines.push(`Presupuestos: ${snapshot.budgets.map((b) => `${b.category} ${fmt(b.spent)}/${fmt(b.limit)} (${b.pct}%)`).join('; ')}`);

  return { snapshot, readable: lines.join('\n') };
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `Eres "FinancIA", una asesora financiera experta integrada en un sistema de finanzas para empresas y personas en Ecuador (moneda USD, IVA 15%).
Analizas los datos financieros reales que te entregan y respondes SIEMPRE en español, de forma clara, concreta y accionable.
Tu objetivo: detectar lo importante (riesgos, oportunidades, fugas de dinero, presupuestos excedidos, deudas próximas a vencer, uso de tarjetas, liquidez) y dar recomendaciones priorizadas.
Formato de respuesta en Markdown:
1. **Resumen** (2-3 líneas con el estado general).
2. **Hallazgos clave** (viñetas: lo más relevante, con cifras).
3. **Recomendaciones** (viñetas accionables, priorizadas).
4. **Alertas** (solo si hay riesgos: deudas por vencer, saldos negativos, presupuestos excedidos, sobreuso de tarjeta).
No inventes datos que no estén en la información provista. Si faltan datos, dilo brevemente. Sé conciso.`;

/** Llama a Groq (API compatible con OpenAI) y devuelve el texto del análisis. */
export async function callFinancIA(
  apiKey: string,
  model: string,
  readable: string,
  question?: string
): Promise<string> {
  const userContent = question?.trim()
    ? `Datos financieros actuales:\n${readable}\n\nPregunta específica del usuario: ${question.trim()}`
    : `Analiza estos datos financieros y entrega tu informe:\n${readable}`;

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ status: res.status, text: text.slice(0, 500) }, 'Groq API error');
    if (res.status === 401) throw Object.assign(new Error('Clave de API de Groq inválida o expirada.'), { status: 400 });
    if (res.status === 429) throw Object.assign(new Error('Groq: límite de uso alcanzado. Intenta más tarde.'), { status: 429 });
    throw Object.assign(new Error('No se pudo obtener el análisis de FinancIA.'), { status: 502 });
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw Object.assign(new Error('FinancIA no devolvió respuesta.'), { status: 502 });
  return content;
}
