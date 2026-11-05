// =====================================================
// Genera una IMAGEN de comprobante (PNG optimizado) a partir de los datos
// interpretados del correo. Usamos SVG → sharp (rasterizado nativo), sin navegador
// headless: liviano y fiable. Si sharp no está disponible, devuelve null y el
// movimiento simplemente se crea sin comprobante adjunto (nunca rompe la ingesta).
// =====================================================
import { logger } from './logger';

let sharpLib: any = null;
let sharpTried = false;
function getSharp(): any {
  if (sharpTried) return sharpLib;
  sharpTried = true;
  try { sharpLib = require('sharp'); }
  catch (e: any) { logger.error({ e: e?.message }, 'sharp no disponible: sin imagen de comprobante'); sharpLib = null; }
  return sharpLib;
}

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (s: unknown, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export interface ReceiptImageData {
  bank?: string | null;        // encabezado (banco/cooperativa)
  title?: string | null;       // título (ej. "Transferencia exitosa")
  typeLabel: string;           // Gasto | Ingreso | Transferencia
  amount: number;              // monto
  rows: { label: string; value: string }[];  // filas de detalle
  footer?: string;
}

/** Devuelve un PNG (Buffer) con el comprobante, o null si no se pudo generar. */
export async function buildReceiptImage(d: ReceiptImageData): Promise<Buffer | null> {
  const sharp = getSharp();
  if (!sharp) return null;
  try {
    const W = 760;
    const padX = 48;
    const headerH = 96;
    const amountH = 92;
    const rowH = 44;
    const rows = d.rows.filter((r) => r.value && r.value !== '—').slice(0, 9);
    const bodyTop = headerH + amountH;
    const H = bodyTop + rows.length * rowH + 72;
    const accent = '#0f766e';

    const rowSvg = rows.map((r, i) => {
      const y = bodyTop + 16 + i * rowH;
      return `
        <text x="${padX}" y="${y + 20}" font-size="15" fill="#64748b" font-family="Arial, sans-serif">${esc(clip(r.label, 28))}</text>
        <text x="${W - padX}" y="${y + 20}" font-size="16" fill="#0f172a" font-weight="600" text-anchor="end" font-family="Arial, sans-serif">${esc(clip(r.value, 40))}</text>
        <line x1="${padX}" y1="${y + 36}" x2="${W - padX}" y2="${y + 36}" stroke="#eef2f7" stroke-width="1"/>`;
    }).join('');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="#ffffff"/>
      <rect x="0" y="0" width="${W}" height="${headerH}" fill="${accent}"/>
      <text x="${padX}" y="42" font-size="22" fill="#ffffff" font-weight="700" font-family="Arial, sans-serif">${esc(clip(d.bank || 'Comprobante', 34))}</text>
      <text x="${padX}" y="70" font-size="14" fill="#d1fae5" font-family="Arial, sans-serif">${esc(clip(d.title || 'Notificación de transacción', 48))}</text>
      <text x="${W - padX}" y="56" font-size="13" fill="#99f6e4" text-anchor="end" font-family="Arial, sans-serif">${esc(d.typeLabel)}</text>
      <text x="${padX}" y="${headerH + 58}" font-size="40" fill="#0f172a" font-weight="800" font-family="Arial, sans-serif">$${d.amount.toFixed(2)}</text>
      ${rowSvg}
      <text x="${padX}" y="${H - 26}" font-size="12" fill="#94a3b8" font-family="Arial, sans-serif">${esc(d.footer || 'Comprobante generado automáticamente desde el correo · FinancIA')}</text>
    </svg>`;

    return await sharp(Buffer.from(svg)).png({ quality: 80, compressionLevel: 9 }).toBuffer();
  } catch (e: any) {
    logger.warn({ e: e?.message }, 'mail: no se pudo generar la imagen del comprobante');
    return null;
  }
}
