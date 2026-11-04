import { http } from './http';

export interface UpdateStatus {
  configured: boolean;
  agentAlive: boolean;
  version: string | null;
  state: string;            // idle | checking | updating | done | error | queued | unknown
  behind: number;
  commits: string[];
  checkedAt: string | null;
  updatedAt: string | null;
  error: string | null;
  pending: boolean;
  log: string;
}

export const systemApi = {
  async getUpdate(): Promise<UpdateStatus> {
    const { data } = await http.get<UpdateStatus>('/super-admin/system/update');
    return data;
  },
  async check(): Promise<void> { await http.post('/super-admin/system/update/check', {}); },
  async apply(): Promise<void> { await http.post('/super-admin/system/update/apply', {}); }
};
