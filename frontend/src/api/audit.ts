import { http } from './http';
import type { AuditEntry } from '../types';

export const auditApi = {
  async list(params?: { entity?: string; action?: string; limit?: number }): Promise<AuditEntry[]> {
    const { data } = await http.get<AuditEntry[]>('/audit', { params });
    return data;
  }
};
