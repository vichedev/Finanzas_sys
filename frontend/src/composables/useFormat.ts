// =====================================================
// Formateo de dinero y fechas, con la moneda del usuario.
// Reemplaza las copias de formatMoney/formatDate en cada vista.
// =====================================================
import { useAuthStore } from '../stores/auth';

const moneyCache = new Map<string, Intl.NumberFormat>();
function moneyFmt(currency: string): Intl.NumberFormat {
  let fmt = moneyCache.get(currency);
  if (!fmt) {
    fmt = new Intl.NumberFormat('es-EC', { style: 'currency', currency });
    moneyCache.set(currency, fmt);
  }
  return fmt;
}

// Las fechas "date-only" se guardan como medianoche UTC. Se formatean con componentes
// UTC para no retroceder un día en zonas horarias negativas (ej. America/Guayaquil −05).
function utcDmy(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export function useFormat() {
  const auth = useAuthStore();
  const currency = () => auth.user?.currency || 'USD';

  function formatMoney(v: number | string | null | undefined): string {
    return moneyFmt(currency()).format(Number(v ?? 0));
  }

  function formatDate(v: string | number | Date | null | undefined): string {
    if (!v) return '—';
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : utcDmy(d);
  }

  return { formatMoney, formatDate, currency };
}
