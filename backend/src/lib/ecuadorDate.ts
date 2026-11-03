// Fecha de hoy en Ecuador, sin depender de la zona horaria del servidor.
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Guayaquil',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** Devuelve YYYY-MM-DD en America/Guayaquil. */
export function todayEcuador(now: Date = new Date()): string {
  const parts = formatter.formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
