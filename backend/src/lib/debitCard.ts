// =====================================================
// Tarjetas de DÉBITO: su saldo NO se guarda, se deriva.
//
// Una tarjeta de débito es solo un acceso a las cuentas del banco; su saldo es
// la suma de las cuentas del MISMO banco y MISMO titular. Así, cualquier ingreso
// o gasto sobre esas cuentas se refleja al instante en la tarjeta, sin duplicar
// ni desincronizar saldos.
//
// El "titular" se compara por el NOMBRE (la cuenta y la tarjeta se nombran con su
// titular / razón social, p. ej. "MANUEL TANDAZO"), normalizado (sin espacios
// sobrantes, sin distinguir mayúsculas). NO se usa `holder` ni `entityId`: en los
// datos reales vienen inconsistentes (holder mal escrito, entidad cruzada) y
// mezclarían cuentas de titulares distintos del mismo banco.
// =====================================================

/** Nombre/titular normalizado para comparar (minúsculas, sin espacios sobrantes). */
export function normName(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export type DebitCardLike = { bankId: number | null; name: string };

/** ¿La cuenta pertenece a la tarjeta de débito? (mismo banco y mismo titular). */
export function accountBelongsToDebitCard(
  card: DebitCardLike,
  account: { bankId?: number | null; name?: string | null }
): boolean {
  if (card.bankId == null || (account.bankId ?? null) !== card.bankId) return false;
  const titular = normName(card.name);
  if (!titular) return false;
  return normName(account.name) === titular;
}
