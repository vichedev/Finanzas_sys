// =====================================================
// Optimización de imágenes al subir (comprobantes). Redimensiona y recomprime
// para ahorrar espacio en la BASE DE DATOS (los comprobantes se guardan ahí) y,
// de paso, en los respaldos. Es defensiva: si no es una imagen soportada o algo
// falla, devuelve el archivo original sin tocar (nunca rompe la subida).
// =====================================================
import sharp from 'sharp';
import { logger } from './logger';

const MAX_DIM = 1800;       // lado máximo (px): legible para leer montos/detalles
const QUALITY = 72;         // calidad JPEG/WebP: buen equilibrio nitidez/tamaño

// Solo imágenes rasterizadas comunes. PDF, SVG y otros se dejan igual.
const OPTIMIZABLE = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

export interface OptimizedFile { buffer: Buffer; mimeType: string; optimized: boolean }

export async function optimizeImage(buffer: Buffer, mimeType: string): Promise<OptimizedFile> {
  const mime = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (!buffer?.length || !OPTIMIZABLE.includes(mime)) return { buffer, mimeType, optimized: false };
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
