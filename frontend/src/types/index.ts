// =====================================================
// Tipos de dominio compartidos por toda la app.
// (Se irán ampliando a medida que se migren más vistas.)
// =====================================================

export type AccountType = 'CASH' | 'BANK' | 'WALLET' | 'DEBIT' | 'RECEIVABLE';
export type BankAccountKind = 'SAVINGS' | 'CHECKING';

export interface Bank {
  id: number;
  name: string;
  accountNumber?: string | null;
  accountKind?: BankAccountKind | null;
  isActive?: boolean;
}

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  holder?: string | null;
  accountKind?: BankAccountKind | null;
  bankId: number | null;
  bankName: string | null;
  accountNumber: string | null;
  initialBalance: number | string;
  currentBalance: number | string;
  isActive: boolean;
  bank?: Bank | null;
}

export interface AccountPayload {
  name: string;
  type: AccountType;
  holder?: string | null;
  accountKind?: BankAccountKind | null;
  accountNumber?: string | null;
  bankId: number | null;
  initialBalance: number;
}

export interface BankPayload {
  name: string;
  accountNumber?: string | null;
  accountKind?: BankAccountKind | null;
}

export interface Wallet {
  id: number;
  name: string;
  provider?: string | null;
  identifier?: string | null;
  isActive: boolean;
  notes?: string | null;
}

export interface WalletPayload {
  name: string;
  provider?: string | null;
  identifier?: string | null;
  isActive?: boolean;
  notes?: string | null;
}

export interface Category {
  id: number;
  name: string;
  icon?: string | null;
  kind?: string | null;
}

export type InvoiceKind = 'SALE' | 'PURCHASE';
export type InvoiceStatus = 'ISSUED' | 'PAID' | 'VOID';

export interface Invoice {
  id: number;
  kind: InvoiceKind;
  status: InvoiceStatus;
  number?: string | null;
  counterparty: string;
  counterpartyTaxId?: string | null;
  issueDate: string;
  netAmount: number | string;
  vatRate: number | string;
  vatAmount: number | string;
  total: number | string;
  accountId?: number | null;
  account?: { id: number; name: string } | null;
  description?: string | null;
  notes?: string | null;
}

export interface InvoicePayload {
  kind: InvoiceKind;
  status?: InvoiceStatus;
  number?: string | null;
  counterparty: string;
  counterpartyTaxId?: string | null;
  issueDate: string;
  netAmount: number;
  vatRate: number;
  description?: string | null;
  accountId?: number | null;
  notes?: string | null;
}

export interface VatSummary {
  period: { year: number; month: number; label: string };
  paymentPeriod: { year: number; month: number; label: string };
  sales: { net: number; vat: number; total: number; count: number };
  purchases: { net: number; vat: number; total: number; count: number };
  vatToPay: number;
  vatCredit: number;
  netVat: number;
}

/** Mínimo común para tablas/CRUD genéricos. */
export interface Identifiable {
  id: number;
}
