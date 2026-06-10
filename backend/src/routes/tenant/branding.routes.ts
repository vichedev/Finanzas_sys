import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// Identidad/branding de la empresa (logo, título, colores). La config es de
// solo lectura para todos los usuarios del tenant; editarla requiere ser admin.
export const brandingRouter = Router();

function requireTenantAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.kind === 'super') return next();
  if (req.auth?.kind === 'tenant' && req.auth.role === 'ADMIN_EMPRESA') return next();
  return res.status(403).json({ message: 'Solo los administradores pueden cambiar la identidad.' });
}

const HEX = /^#([0-9a-fA-F]{6})$/;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
const MAX_LOGO = 3 * 1024 * 1024; // 3 MB

const configSchema = z.object({
  systemTitle: z.string().trim().max(60).optional().nullable(),
  subtitle: z.string().trim().max(80).optional().nullable(),
  primaryColor: z.string().trim().regex(HEX, 'Color inválido (usa #RRGGBB)').optional().nullable(),
  accentColor: z.string().trim().regex(HEX, 'Color inválido (usa #RRGGBB)').optional().nullable()
}).strict();

async function getRow(prisma: NonNullable<Request['tenantPrisma']>) {
  return prisma.branding.findUnique({ where: { id: 1 } });
}

// Config pública del tenant (sin bytes del logo)
brandingRouter.get('/', async (req, res) => {
  const row = await getRow(req.tenantPrisma!);
  res.json({
    systemTitle: row?.systemTitle ?? null,
    subtitle: row?.subtitle ?? null,
    primaryColor: row?.primaryColor ?? null,
    accentColor: row?.accentColor ?? null,
    hasLogo: !!row?.logoData,
    updatedAt: row?.updatedAt ?? null
  });
});

// Logo (imagen)
brandingRouter.get('/logo', async (req, res) => {
  const row = await getRow(req.tenantPrisma!);
  if (!row?.logoData || !row.logoMime) return res.status(404).json({ message: 'Sin logo' });
  res.setHeader('Content-Type', row.logoMime);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(Buffer.from(row.logoData));
});

brandingRouter.put('/', requireTenantAdmin, async (req, res) => {
  const body = configSchema.parse(req.body);
  const data = {
    systemTitle: body.systemTitle?.trim() || null,
    subtitle: body.subtitle?.trim() || null,
    primaryColor: body.primaryColor || null,
    accentColor: body.accentColor || null
  };
  const row = await req.tenantPrisma!.branding.upsert({
    where: { id: 1 },
    create: { id: 1, ...data },
    update: data
  });
  res.json({ systemTitle: row.systemTitle, subtitle: row.subtitle, primaryColor: row.primaryColor, accentColor: row.accentColor, hasLogo: !!row.logoData });
});

brandingRouter.post('/logo', requireTenantAdmin, async (req, res) => {
  const body = z.object({ mimeType: z.string().trim().min(1), dataBase64: z.string().min(1) }).strict().parse(req.body);
  if (!LOGO_TYPES.includes(body.mimeType)) {
    return res.status(400).json({ message: 'Formato no permitido (PNG, JPG, WEBP o SVG).' });
  }
  const b64 = body.dataBase64.includes(',') ? body.dataBase64.split(',').pop() || '' : body.dataBase64;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return res.status(400).json({ message: 'Archivo vacío.' });
  if (buf.length > MAX_LOGO) return res.status(413).json({ message: 'Logo demasiado grande (máx. 3 MB).' });

  await req.tenantPrisma!.branding.upsert({
    where: { id: 1 },
    create: { id: 1, logoData: buf, logoMime: body.mimeType },
    update: { logoData: buf, logoMime: body.mimeType }
  });
  res.json({ ok: true });
});

brandingRouter.delete('/logo', requireTenantAdmin, async (req, res) => {
  await req.tenantPrisma!.branding.updateMany({ where: { id: 1 }, data: { logoData: null, logoMime: null } });
  res.json({ ok: true });
});
