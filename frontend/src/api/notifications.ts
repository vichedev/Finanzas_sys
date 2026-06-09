import { http } from './http';

export interface Notification {
  id: number;
  type: 'MOVEMENT_CREATED' | 'PAYMENT_DUE' | 'VAT_DUE' | 'LOW_BALANCE' | string;
  title: string;
  body: string;
  link?: string | null;
  isRead: boolean;
  emailSent: boolean;
  createdAt: string;
}

export const notificationsApi = {
  async list(): Promise<Notification[]> {
    const { data } = await http.get<Notification[]>('/notifications');
    return data;
  },
  async unreadCount(): Promise<number> {
    const { data } = await http.get<{ count: number }>('/notifications/unread-count');
    return data.count;
  },
  async markRead(id: number): Promise<void> {
    await http.post(`/notifications/${id}/read`);
  },
  async markAllRead(): Promise<void> {
    await http.post('/notifications/read-all');
  },
  async remove(id: number): Promise<void> {
    await http.delete(`/notifications/${id}`);
  },
  async getEmailPref(): Promise<boolean> {
    const { data } = await http.get<{ emailNotifications: boolean }>('/notifications/prefs');
    return data.emailNotifications;
  },
  async setEmailPref(emailNotifications: boolean): Promise<void> {
    await http.put('/notifications/prefs', { emailNotifications });
  }
};
