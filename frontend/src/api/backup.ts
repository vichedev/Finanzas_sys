import { http } from './http';

export const backupApi = {
  async exportData(): Promise<Blob> {
    const { data } = await http.get('/backup/export', { responseType: 'blob' });
    return data as Blob;
  },
  async importData(json: unknown): Promise<{ ok: boolean; imported: Record<string, number> }> {
    const { data } = await http.post('/backup/import', json);
    return data;
  }
};
