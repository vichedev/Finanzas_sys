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

const PREVIEW_MIME: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
  'application/pdf': 'application/pdf'
};

/**
 * Tipo con el que un adjunto puede abrirse en el navegador, o null si solo se descarga.
 * Un blob se abre en el origen de la app: un XML con XHTML o un SVG ejecutarían sus scripts ahí.
 */
export function previewMime(mimeType?: string | null): string | null {
  const clean = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  return Object.hasOwn(PREVIEW_MIME, clean) ? PREVIEW_MIME[clean] : null;
}

/** Guarda los bytes como descarga, con un tipo que el navegador nunca interpreta. */
export function downloadAsFile(data: Blob, filename: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
  /** Descarga el archivo (con auth): imagen ráster o PDF se abren en una pestaña nueva; lo demás solo se descarga. */
  async openFile(attachment: Pick<AttachmentMeta, 'id' | 'filename' | 'mimeType'>): Promise<void> {
    const { data } = await http.get(`/attachments/${attachment.id}/file`, { responseType: 'blob' });
    const mime = previewMime(attachment.mimeType);
    if (!mime) {
      downloadAsFile(data as Blob, attachment.filename);
      return;
    }
    const url = URL.createObjectURL(new Blob([data as Blob], { type: mime }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
};
