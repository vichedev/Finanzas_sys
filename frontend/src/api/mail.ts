import { http } from './http';

export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  email: string | null;
  folder: string;
  autoCreate: boolean;
  hasPassword: boolean;
  lastCheckAt: string | null;
}

export interface MailConfigPayload {
  enabled?: boolean;
  host?: string;
  port?: number;
  email?: string;
  password?: string;
  folder?: string;
  autoCreate?: boolean;
}

export interface MailTestResult { ok: true; total: number; recent: string[] }

export interface MailReceiptDetail {
  medio: string | null;
  ultimos4: string | null;
  banco: string | null;
  categoria: string | null;
  tipo: string | null;
  paymentMethod: string | null;
  accountId: number | null;
  cardId: number | null;
  categoryId: number | null;
}

export interface MailReceipt {
  id: number;
  subject: string | null;
  from: string | null;
  vendor: string | null;
  amount: number | null;
  docDate: string | null;
  kind: string;
  status: 'PENDING' | 'APPROVED' | 'DISCARDED' | 'FAILED';
  movementId: number | null;
  receivedAt: string | null;
  createdAt: string;
  reason: string | null;
  resolved: boolean;
  detail: MailReceiptDetail;
}

export interface MailCheckSummary { checked: number; added: number; pending: number; discarded: number; failed: number }

export interface MailOptions {
  accounts: { id: number; name: string; bankName: string | null }[];
  creditCards: { id: number; name: string; bankName: string | null; last4: string | null }[];
  categories: { id: number; name: string }[];
}

export interface ApprovePayload { accountId?: number | null; cardId?: number | null; categoryId?: number | null; paymentMethod?: string }

export const mailApi = {
  async getConfig(): Promise<MailConfig> {
    const { data } = await http.get<MailConfig>('/mail/config');
    return data;
  },
  async saveConfig(payload: MailConfigPayload): Promise<MailConfig> {
    const { data } = await http.put<MailConfig>('/mail/config', payload);
    return data;
  },
  async test(): Promise<MailTestResult> {
    const { data } = await http.post<MailTestResult>('/mail/test', {});
    return data;
  },
  async receipts(limit = 40): Promise<MailReceipt[]> {
    const { data } = await http.get<MailReceipt[]>('/mail/receipts', { params: { limit } });
    return data;
  },
  async check(): Promise<MailCheckSummary> {
    const { data } = await http.post<MailCheckSummary>('/mail/check', {});
    return data;
  },
  async options(): Promise<MailOptions> {
    const { data } = await http.get<MailOptions>('/mail/options');
    return data;
  },
  async approve(id: number, payload: ApprovePayload = {}): Promise<{ ok: true; movementId: number }> {
    const { data } = await http.post<{ ok: true; movementId: number }>(`/mail/receipts/${id}/approve`, payload);
    return data;
  },
  async discard(id: number): Promise<{ ok: true }> {
    const { data } = await http.post<{ ok: true }>(`/mail/receipts/${id}/discard`, {});
    return data;
  }
};
