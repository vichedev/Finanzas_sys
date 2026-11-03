// El IVA se liquida por contribuyente: el crédito de una razón social no compensa
// lo que debe otra con distinto RUC. Las facturas sin razón social se tratan como una sola.
type VatGroup = {
  entityId: number | null;
  kind: 'SALE' | 'PURCHASE';
  _sum: { vatAmount: unknown };
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function settleVatByEntity(groups: VatGroup[]): { vatToPay: number; vatCredit: number } {
  const balances = new Map<number | null, number>();
  for (const g of groups) {
    const amount = Number(g._sum.vatAmount || 0);
    balances.set(g.entityId, (balances.get(g.entityId) ?? 0) + (g.kind === 'SALE' ? amount : -amount));
  }
  let vatToPay = 0;
  let vatCredit = 0;
  for (const balance of balances.values()) {
    const net = round2(balance);
    if (net > 0) vatToPay += net; else vatCredit -= net;
  }
  return { vatToPay: round2(vatToPay), vatCredit: round2(vatCredit) };
}
