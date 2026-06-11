import { http } from './http';
import type { BudgetsResponse, BudgetPayload } from '../types';

export const budgetsApi = {
  async list(params?: { year?: number; month?: number }): Promise<BudgetsResponse> {
    const { data } = await http.get<BudgetsResponse>('/budgets', { params });
    return data;
  },
  async save(payload: BudgetPayload) {
    const { data } = await http.post('/budgets', payload);
    return data;
  },
  async remove(id: number) {
    await http.delete(`/budgets/${id}`);
  }
};
