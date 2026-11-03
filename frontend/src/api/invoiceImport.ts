import { http } from './http';

export interface ImportFile {
  filename: string;
  contentBase64: string; // bytes originales del XML
}

export interface ImportVatLine {
  rate: number;
  rateCode: string;
  base: number;
  vat: number;
}

export interface ImportDraft {
  kind: 'SALE' | 'PURCHASE' | null; // null: no coincide con ninguna razón social
  entityId: number | null;
  accessKey: string;
  number: string;
  counterparty: string;
  counterpartyTaxId: string;
  issuerTaxId: string;
  issuerName: string;
  buyerTaxId: string;
  buyerName: string;
  issueDate: string; // YYYY-MM-DD
  netAmount: number;
  discount: number;
  vatRate: number;
  vatAmount: number;
  vatLines: ImportVatLine[];
  otherCharges: number;
  total: number;
  warnings: string[];
}

export type ImportItemStatus = 'READY' | 'NEEDS_KIND' | 'DUPLICATE' | 'ERROR';

export interface ImportPreviewItem {
  filename: string;
  status: ImportItemStatus;
  error?: { code: string; message: string };
  draft?: ImportDraft;
  duplicateOf?: { id: number; number: string | null; source: 'ACCESS_KEY' | 'NUMBER_AND_TAX_ID' };
}

export interface ImportConfirmItem extends ImportFile {
  kind: 'SALE' | 'PURCHASE';
  entityId?: number | null;
  accountId?: number | null;
  status?: 'ISSUED' | 'PAID';
  description?: string | null;
  allowPossibleDuplicate?: boolean; // solo para duplicados por número y RUC, nunca por clave
}

export interface ImportConfirmResult {
  created: { filename: string; id: number; number: string | null }[];
  skipped: { filename: string; reason: string; code: string }[];
}

// Un lote grande por una conexión lenta supera el tiempo por defecto de http.ts.
const IMPORT_REQUEST = { timeout: 120_000 };

export const invoiceImportApi = {
  async preview(files: ImportFile[]): Promise<ImportPreviewItem[]> {
    const { data } = await http.post<{ items: ImportPreviewItem[] }>('/invoices/import/preview', { files }, IMPORT_REQUEST);
    return data.items;
  },
  async confirm(items: ImportConfirmItem[]): Promise<ImportConfirmResult> {
    const { data } = await http.post<ImportConfirmResult>('/invoices/import/confirm', { items }, IMPORT_REQUEST);
    return data;
  }
};
