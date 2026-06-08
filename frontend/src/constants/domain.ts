// =====================================================
// Etiquetas, iconos y opciones de dominio.
// Centraliza lo que antes se duplicaba en cada vista.
// =====================================================
import type { AccountType, BankAccountKind } from '../types';

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  CASH: 'Efectivo',
  BANK: 'Banco',
  WALLET: 'Billetera digital',
  DEBIT: 'Tarjeta de débito',
  RECEIVABLE: 'Por cobrar'
};

export const ACCOUNT_TYPE_ICON: Record<AccountType, string> = {
  CASH: '💵',
  BANK: '🏦',
  WALLET: '👛',
  DEBIT: '💳',
  RECEIVABLE: '🧾'
};

export const ACCOUNT_TYPE_OPTIONS: { value: AccountType; label: string }[] =
  (Object.keys(ACCOUNT_TYPE_LABEL) as AccountType[]).map((value) => ({
    value,
    label: ACCOUNT_TYPE_LABEL[value]
  }));

export const BANK_KIND_LABEL: Record<BankAccountKind, string> = {
  SAVINGS: 'Ahorros',
  CHECKING: 'Corriente'
};

/** Etiqueta legible de un banco: "Pichincha · Ahorros · ****1234". */
export function bankFullLabel(b: {
  name: string;
  accountKind?: BankAccountKind | null;
  accountNumber?: string | null;
}): string {
  const parts: string[] = [b.name];
  if (b.accountKind) parts.push(BANK_KIND_LABEL[b.accountKind]);
  if (b.accountNumber) parts.push(`****${b.accountNumber.slice(-4)}`);
  return parts.join(' · ');
}
