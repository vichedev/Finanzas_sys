import { http } from './http';

export type EntityType = 'MOVEMENT' | 'INVOICE' | 'DEBT';

export interface AttachmentMeta {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  entityType: EntityType;
  entityId: number;
}

export interface UploadPayload {
  entityType: EntityType;
  entityId: number;
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface DocAttachment extends AttachmentMeta {
  entityLabel: string;
  contextLabel: string;
  contextDate: string;
  link: string;
}

export const attachmentsApi = {
  async listAll(): Promise<DocAttachment[]> {
    const { data } = await http.get<DocAttachment[]>('/attachments/all');
    return data;
  },
  async list(entityType: EntityType, entityId: number): Promise<AttachmentMeta[]> {
    const { data } = await http.get<AttachmentMeta[]>('/attachments', { params: { entityType, entityId } });
    return data;
  },
  async upload(payload: UploadPayload): Promise<AttachmentMeta> {
    const { data } = await http.post<AttachmentMeta>('/attachments', payload);
    return data;
  },
  async remove(id: number): Promise<void> {
    await http.delete(`/attachments/${id}`);
  },
  async rename(id: number, filename: string): Promise<AttachmentMeta> {
    const { data } = await http.patch<AttachmentMeta>(`/attachments/${id}`, { filename });
    return data;
  },
  /** Descarga el archivo (con auth) y lo abre en una pestaña nueva. */
  async openFile(id: number): Promise<void> {
    const { data } = await http.get(`/attachments/${id}/file`, { responseType: 'blob' });
    const url = URL.createObjectURL(data as Blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
};
