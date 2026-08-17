import { http } from './http';

export type WaState = 'idle' | 'connecting' | 'qr' | 'connected' | 'logged_out';

export interface WhatsappStatus {
  state: WaState;
  qr: string | null;          // data URL PNG del QR (solo cuando state='qr')
  linkedNumber: string | null;
  enabled: boolean;
  coachEnabled: boolean;      // avisos proactivos de gasto
  userId: number | null;
  hasAiKey: boolean;
}

export const whatsappApi = {
  async status(): Promise<WhatsappStatus> {
    const { data } = await http.get<WhatsappStatus>('/whatsapp/status');
    return data;
  },
  async connect(): Promise<WhatsappStatus> {
    const { data } = await http.post<WhatsappStatus>('/whatsapp/connect', {});
    return data;
  },
  async disconnect(logout: boolean): Promise<WhatsappStatus> {
    const { data } = await http.post<WhatsappStatus>('/whatsapp/disconnect', { logout });
    return data;
  },
  async setCoach(coachEnabled: boolean): Promise<WhatsappStatus> {
    const { data } = await http.put<WhatsappStatus>('/whatsapp/config', { coachEnabled });
    return data;
  }
};
