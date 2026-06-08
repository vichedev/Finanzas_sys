// =====================================================
// Fábrica de servicios REST tipados sobre el cliente http.
// Evita repetir get/post/put/delete y endpoints en cada vista.
// =====================================================
import { http } from './http';

export interface RestResource<T, F> {
  list(params?: Record<string, unknown>): Promise<T[]>;
  get(id: number | string): Promise<T>;
  create(payload: F): Promise<T>;
  update(id: number | string, payload: F): Promise<T>;
  remove(id: number | string): Promise<void>;
}

export function createResource<T, F = Partial<T>>(base: string): RestResource<T, F> {
  return {
    async list(params) {
      const { data } = await http.get<T[]>(base, { params });
      return data;
    },
    async get(id) {
      const { data } = await http.get<T>(`${base}/${id}`);
      return data;
    },
    async create(payload) {
      const { data } = await http.post<T>(base, payload);
      return data;
    },
    async update(id, payload) {
      const { data } = await http.put<T>(`${base}/${id}`, payload);
      return data;
    },
    async remove(id) {
      await http.delete(`${base}/${id}`);
    }
  };
}
