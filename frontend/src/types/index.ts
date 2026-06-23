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

export type EntityKind = 'PERSONAL' | 'BUSINESS';

export interface Entity {
  id: number;
  name: string;
  kind: EntityKind;
  taxId?: string | null;
  notes?: string | null;
  _count?: { accounts: number; cards: number };
}

export interface EntityPayload {
  name: string;
  kind: EntityKind;
  taxId?: string | null;
  notes?: string | null;
}

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  holder?: string | null;
  entityId?: number | null;
  entity?: { id: number; name: string; kind: EntityKind } | null;
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
  entityId?: number | null;
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
  accountIds?: number[];          // cuentas de banco que respaldan la billetera
}

export interface WalletPayload {
  name: string;
  provider?: string | null;
  identifier?: string | null;
  isActive?: boolean;
  notes?: string | null;
  accountIds?: number[];
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
  entityId?: number | null;
  entity?: { id: number; name: string; kind: EntityKind } | null;
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
  entityId?: number | null;
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
  byEntity?: Array<{ entityId: number | null; name: string; kind: string | null; salesVat: number; purchasesVat: number; vatToPay: number; vatCredit: number; netVat: number }>;
}

export interface Budget {
  id: number;
  categoryId: number;
  categoryName: string;
  categoryColor?: string | null;
  amount: number;
  period: 'MONTHLY';
  spent: number;
  remaining: number;
  pct: number;
}

export interface BudgetsResponse {
  year: number;
  month: number;
  budgets: Budget[];
}

export interface BudgetPayload {
  categoryId: number;
  amount: number;
  period?: 'MONTHLY';
}

export interface AuditEntry {
  id: number;
  userId?: number | null;
  userEmail?: string | null;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  entity: string;
  entityId?: number | null;
  summary?: string | null;
  createdAt: string;
}

/** Mínimo común para tablas/CRUD genéricos. */
export interface Identifiable {
  id: number;
}
