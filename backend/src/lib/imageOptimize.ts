// =====================================================
// Optimización de imágenes al subir (comprobantes). Redimensiona y recomprime
// para ahorrar espacio en la BASE DE DATOS (los comprobantes se guardan ahí) y,
// de paso, en los respaldos. Es defensiva: si no es una imagen soportada o algo
// falla, devuelve el archivo original sin tocar (nunca rompe la subida).
// =====================================================
import { logger } from './logger';

const MAX_DIM = 1800;       // lado máximo (px): legible para leer montos/detalles
const QUALITY = 72;         // calidad JPEG/WebP: buen equilibrio nitidez/tamaño

// Solo imágenes rasterizadas comunes. PDF, SVG y otros se dejan igual.
const OPTIMIZABLE = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

export interface OptimizedFile { buffer: Buffer; mimeType: string; optimized: boolean }

// Carga sharp de forma perezosa y DEFENSIVA: si su binario nativo no está
// disponible (p. ej. arquitectura sin prebuild), NO se cae el backend — solo se
// omite la optimización y se guarda el original.
let sharpLib: any = null;
let sharpTried = false;
function getSharp(): any {
  if (sharpTried) return sharpLib;
  sharpTried = true;
  try { sharpLib = require('sharp'); }
  catch (e: any) { logger.error({ e: e?.message }, 'sharp no disponible: se omitirá la optimización de imágenes'); sharpLib = null; }
  return sharpLib;
}

export async function optimizeImage(buffer: Buffer, mimeType: string): Promise<OptimizedFile> {
  const mime = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (!buffer?.length || !OPTIMIZABLE.includes(mime)) return { buffer, mimeType, optimized: false };
  const sharp = getSharp();
  if (!sharp) return { buffer, mimeType, optimized: false };
  try {
    const hasAlpha = mime === 'image/png' || mime === 'image/webp';
    const pipe = sharp(buffer, { failOn: 'none' })
      .rotate() // aplica la orientación EXIF (fotos de celular) y quita metadatos
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true });

    // PNG/WebP (pueden tener transparencia) -> WebP; el resto -> JPEG (mozjpeg).
    const out = hasAlpha
      ? { buffer: await pipe.webp({ quality: QUALITY }).toBuffer(), mimeType: 'image/webp' }
      : { buffer: await pipe.jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer(), mimeType: 'image/jpeg' };

    // Si por lo que sea quedó más grande que el original, conserva el original.
    if (out.buffer.length >= buffer.length) return { buffer, mimeType, optimized: false };
    return { ...out, optimized: true };
  } catch (e: any) {
    logger.warn({ e: e?.message, mime }, 'optimizeImage: no se pudo optimizar, se guarda el original');
    return { buffer, mimeType, optimized: false };
  }
}
