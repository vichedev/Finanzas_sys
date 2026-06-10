import { http } from './http';

export interface BrandingConfig {
  systemTitle: string | null;
  subtitle: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  hasLogo: boolean;
  updatedAt?: string | null;
}

export interface BrandingPayload {
  systemTitle?: string | null;
  subtitle?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
}

export const brandingApi = {
  async get(): Promise<BrandingConfig> {
    const { data } = await http.get<BrandingConfig>('/branding');
    return data;
  },
  async save(payload: BrandingPayload): Promise<BrandingConfig> {
    const { data } = await http.put<BrandingConfig>('/branding', payload);
    return data;
  },
  async uploadLogo(mimeType: string, dataBase64: string): Promise<void> {
    await http.post('/branding/logo', { mimeType, dataBase64 });
  },
  async removeLogo(): Promise<void> {
    await http.delete('/branding/logo');
  },
  async logoBlob(): Promise<Blob> {
    const { data } = await http.get('/branding/logo', { responseType: 'blob' });
    return data as Blob;
  }
};
