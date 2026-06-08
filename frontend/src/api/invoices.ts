import { http } from './http';
import { createResource } from './resource';
import type { Invoice, InvoicePayload, VatSummary } from '../types';

export const invoicesApi = {
  ...createResource<Invoice, InvoicePayload>('/invoices'),
  async vatSummary(year: number, month: number): Promise<VatSummary> {
    const { data } = await http.get<VatSummary>('/invoices/vat-summary', { params: { year, month } });
    return data;
  }
};
