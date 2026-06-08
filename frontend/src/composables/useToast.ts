// =====================================================
// Notificaciones globales (toasts). Singleton a nivel módulo
// para que cualquier composable/vista comparta la misma cola.
// =====================================================
import { reactive } from 'vue';

export type ToastType = 'success' | 'error' | 'info';
export interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

const state = reactive<{ items: Toast[] }>({ items: [] });
let seq = 0;

function dismiss(id: number) {
  const i = state.items.findIndex((t) => t.id === id);
  if (i >= 0) state.items.splice(i, 1);
}

function push(type: ToastType, message: string, ms = 3200) {
  const id = ++seq;
  state.items.push({ id, type, message });
  if (ms > 0) setTimeout(() => dismiss(id), ms);
  return id;
}

export function useToast() {
  return {
    toasts: state.items,
    success: (message: string, ms?: number) => push('success', message, ms),
    error: (message: string, ms?: number) => push('error', message, ms),
    info: (message: string, ms?: number) => push('info', message, ms),
    dismiss
  };
}
