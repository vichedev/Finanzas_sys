// =====================================================
// Período (mes/año) unificado para todas las vistas.
// El sistema empezó a registrar en MAYO 2026: no se permiten meses anteriores.
// A medida que avanza el calendario, el mes nuevo aparece automáticamente.
// =====================================================
export const START_YEAR = 2026;
export const START_MONTH = 5; // Mayo

export const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

export interface PeriodOption { value: string; label: string; year: number; month: number }

// Opciones desde mayo 2026 hasta el mes actual (más reciente primero).
export function periodOptions(now: Date = new Date()): PeriodOption[] {
  const opts: PeriodOption[] = [];
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  // Si por reloj estuviéramos antes del inicio, al menos mostrar el mes de inicio.
  if (y < START_YEAR || (y === START_YEAR && m < START_MONTH)) { y = START_YEAR; m = START_MONTH; }
  while (y > START_YEAR || (y === START_YEAR && m >= START_MONTH)) {
    opts.push({ value: `${y}-${m}`, label: `${MONTH_NAMES[m - 1]} ${y}`, year: y, month: m });
    m--; if (m < 1) { m = 12; y--; }
  }
  return opts;
}

// Años seleccionables (desde el de inicio hasta el próximo).
export function yearOptions(now: Date = new Date()): number[] {
  const max = Math.max(now.getFullYear() + 1, START_YEAR);
  const years: number[] = [];
  for (let y = START_YEAR; y <= max; y++) years.push(y);
  return years;
}

// Meses válidos para un año dado (en el año de inicio, solo desde mayo).
export function monthsForYear(year: number): { value: number; label: string }[] {
  return MONTH_NAMES
    .map((label, i) => ({ value: i + 1, label }))
    .filter((m) => year > START_YEAR || m.value >= START_MONTH);
}

// ¿Es el período el más antiguo permitido? (para deshabilitar "mes anterior")
export function isStartPeriod(year: number, month: number): boolean {
  return year <= START_YEAR && month <= START_MONTH;
}
