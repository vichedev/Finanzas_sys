import { http } from './http';

// Los respaldos mueven mucho dato (comprobantes) y tardan más que un request
// normal: se les da un timeout amplio para que el navegador no aborte antes de
// que el servidor termine (el timeout global es de solo 15s).
const BACKUP_TIMEOUT = 5 * 60 * 1000; // 5 min

// Debe coincidir con RESTORE_LIMIT del backend y client_max_body_size de nginx.
export const MAX_RESTORE_BYTES = 32 * 1024 * 1024;

export const backupApi = {
  async exportData(): Promise<Blob> {
    const { data } = await http.get('/backup/export', { responseType: 'blob', timeout: BACKUP_TIMEOUT });
    return data as Blob;
  },
  async importData(json: unknown): Promise<{ ok: boolean; imported: Record<string, number> }> {
    const { data } = await http.post('/backup/import', json, { timeout: BACKUP_TIMEOUT });
    return data;
  }
};
