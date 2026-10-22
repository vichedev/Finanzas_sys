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
  }
};
