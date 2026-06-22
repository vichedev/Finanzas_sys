// =====================================================
// Confirmación/aviso con modal propio (reemplaza window.confirm / alert).
// Uso:  const { confirm, alert } = useConfirm();
//       if (!(await confirm('¿Eliminar?'))) return;
//       await alert('No se pudo guardar.');
// Estado global consumido por <ConfirmHost /> montado en App.vue.
// =====================================================
import { reactive } from 'vue';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;   // botón de confirmar en rojo (acciones destructivas)
  alert?: boolean;    // solo botón de aceptar (informativo)
}

interface ConfirmState extends Required<Omit<ConfirmOptions, 'title'>> {
  open: boolean;
  title: string;
  resolve: ((v: boolean) => void) | null;
}

export const confirmState = reactive<ConfirmState>({
  open: false,
  title: 'Confirmar',
  message: '',
  confirmText: 'Aceptar',
  cancelText: 'Cancelar',
  danger: false,
  alert: false,
  resolve: null
});

export function useConfirm() {
  function confirm(opts: ConfirmOptions | string): Promise<boolean> {
    const o: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts;
    return new Promise<boolean>((resolve) => {
      confirmState.title = o.title ?? (o.alert ? 'Aviso' : 'Confirmar');
      confirmState.message = o.message;
      confirmState.confirmText = o.confirmText ?? 'Aceptar';
      confirmState.cancelText = o.cancelText ?? 'Cancelar';
      confirmState.danger = o.danger ?? false;
      confirmState.alert = o.alert ?? false;
      confirmState.resolve = resolve;
      confirmState.open = true;
    });
  }
  function alert(message: string, title = 'Aviso'): Promise<boolean> {
    return confirm({ message, title, alert: true });
  }
  return { confirm, alert };
}

// Lo usa <ConfirmHost /> al pulsar Aceptar/Cancelar o cerrar.
export function resolveConfirm(value: boolean) {
  if (!confirmState.open) return;
  confirmState.open = false;
  const r = confirmState.resolve;
  confirmState.resolve = null;
  r?.(value);
}
