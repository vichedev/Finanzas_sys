import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { globalPrisma } from '../../lib/globalPrisma';
import { requireAuth } from '../../middleware/auth';
// requireTenantAdmin legacy reemplazado por check inline de role
function requireTenantAdmin(req: any, res: any, next: any) {
  if (req.auth?.kind === 'super') return next();
  if (req.auth?.kind === 'tenant' && req.auth.role === 'ADMIN_EMPRESA') return next();
  return res.status(403).json({ message: 'Solo admin de empresa' });
}
const invalidateAuthCache = (_id: string | number) => {}; // no-op (auth ya consulta DB)
import { sendMail, isMailerConfigured, welcomeEmailHtml, getPublicUrl } from '../../lib/mailer';

// =====================================================================
// TENANT ADMIN — gestión de usuarios DENTRO de un tenant.
// NO confundir con SuperAdmin global (creación de tenants, planes, etc.)
//
// Endpoints conservados:
//   - GET    /users          → lista usuarios locales del tenant
//   - POST   /users          → crea User local + TenantMembership global
//   - PUT    /users/:id      → actualiza User local (+ membership si aplica)
//   - DELETE /users/:id      → desactiva User local + membership
//
// Endpoints eliminados (ya viven en SuperAdmin global):
//   - Gestión de tenants
//   - Creación de SuperAdmins
//   - Plantillas de Roles (el modelo Role no existe en schema tenant)
//   - Configuración SMTP (es GlobalSetting, va en SuperAdmin global)
// =====================================================================

export const adminRouter = Router();
// TODO: `requireTenantAdmin` revisa req.user.role contra 'ADMIN'/'SUPERADMIN' (roles legacy).
// Para tenant deberíamos chequear req.auth.role === 'ADMIN_EMPRESA' (o agregar un
// requireTenantAdmin en middleware/admin.ts). Por ahora se mantiene para no tocar
// archivos fuera de scope.
adminRouter.use(requireAuth, requireTenantAdmin);

const passwordSchema = z.string()
  .min(10, 'Mínimo 10 caracteres')
  .max(200, 'Máximo 200 caracteres')
  .refine((v) => /[A-Z]/.test(v), 'Debe incluir mayúscula')
  .refine((v) => /[a-z]/.test(v), 'Debe incluir minúscula')
  .refine((v) => /\d/.test(v), 'Debe incluir número')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Debe incluir símbolo o espacio')
  .refine((v) => !/(.)\1{3,}/.test(v), 'Evita más de 3 caracteres repetidos seguidos');

const createUserSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email().max(120),
  password: passwordSchema,
  role: z.enum(['ADMIN_EMPRESA', 'USUARIO_EMPRESA']).optional().default('USUARIO_EMPRESA'),
  sendEmail: z.boolean().optional().default(true)
}).strict();

const updateUserSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  email: z.string().email().max(120).optional(),
  role: z.enum(['ADMIN_EMPRESA', 'USUARIO_EMPRESA']).optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional()
}).strict();

const defaultCategories = [
  { name: 'Sueldo', type: 'INCOME' as const, color: '#16a34a', icon: 'wallet' },
  { name: 'Ventas', type: 'INCOME' as const, color: '#22c55e', icon: 'trending-up' },
  { name: 'Combustible', type: 'EXPENSE' as const, color: '#f97316', icon: 'fuel' },
  { name: 'Comida', type: 'EXPENSE' as const, color: '#ef4444', icon: 'utensils' },
  { name: 'Familia', type: 'EXPENSE' as const, color: '#8b5cf6', icon: 'users' },
  { name: 'Salud', type: 'EXPENSE' as const, color: '#06b6d4', icon: 'heart' },
  { name: 'Ropa', type: 'EXPENSE' as const, color: '#ec4899', icon: 'shirt' },
  { name: 'Servicios básicos', type: 'EXPENSE' as const, color: '#64748b', icon: 'receipt' }
];

adminRouter.get('/users', async (req, res) => {
  const users = await req.tenantPrisma!.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, name: true, email: true,
      role: true, isActive: true, currency: true,
      createdAt: true, updatedAt: true,
      _count: { select: { accounts: true, movements: true, debts: true } }
    }
  });
  res.json({ users, mailerConfigured: await isMailerConfigured() });
});

adminRouter.post('/users', async (req, res) => {
  const body = createUserSchema.parse(req.body);
  const tenantId = req.tenantId!;

  // Conflictos: User local (por email) y TenantMembership (por email+tenantId).
  const [existsLocal, existsMembership] = await Promise.all([
    req.tenantPrisma!.user.findUnique({ where: { email: body.email } }),
    globalPrisma.tenantMembership.findUnique({
      where: { email_tenantId: { email: body.email, tenantId } }
    })
  ]);
  if (existsLocal || existsMembership) {
    return res.status(409).json({ message: 'Ya existe un usuario con ese correo en este tenant' });
  }

  const passwordHash = await bcrypt.hash(body.password, 12);

  // 1) Crea User local en el tenant DB con categorías y cuenta por defecto.
  const user = await req.tenantPrisma!.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: body.name,
        email: body.email,
        role: body.role
      }
    });
    await tx.category.createMany({
      data: defaultCategories.map((c) => ({ ...c, userId: created.id, isDefault: true }))
    });
    await tx.account.create({
      data: {
        userId: created.id, name: 'Efectivo principal', type: 'CASH',
        initialBalance: 0, currentBalance: 0
      }
    });
    return created;
  });

  // 2) Crea TenantMembership en global DB con la passwordHash y rol.
  await globalPrisma.tenantMembership.create({
    data: {
      email: body.email,
      passwordHash,
      name: body.name,
      tenantId,
      role: body.role,
      isActive: true
    }
  });

  // 3) Envío opcional de email de bienvenida.
  let mailResult: { ok: boolean; error?: string } = { ok: false, error: 'no enviado' };
  const mailerOn = await isMailerConfigured();
  if (body.sendEmail && mailerOn) {
    const loginUrl = await getPublicUrl();
    mailResult = await sendMail({
      to: body.email,
      subject: 'Tu cuenta en Finanzas Mensuales',
      html: welcomeEmailHtml({ name: body.name, email: body.email, password: body.password, loginUrl })
    });
  }

  return res.status(201).json({
    user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, isActive: user.isActive, createdAt: user.createdAt
    },
    mail: { sent: mailResult.ok, error: mailResult.error || null, configured: mailerOn },
    initialPassword: mailResult.ok ? null : body.password
  });
});

adminRouter.put('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = updateUserSchema.parse(req.body);
  const tenantId = req.tenantId!;

  const target = await req.tenantPrisma!.user.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ message: 'Usuario no encontrado' });

  if (id === req.tenantUserId! && body.role && body.role !== target.role) {
    return res.status(400).json({ message: 'No puedes cambiar tu propio rol' });
  }
  if (id === req.tenantUserId! && body.isActive === false) {
    return res.status(400).json({ message: 'No puedes desactivar tu propia cuenta' });
  }

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.email !== undefined) data.email = body.email;
  if (body.role !== undefined) data.role = body.role;
  if (body.isActive !== undefined) data.isActive = body.isActive;

  const user = await req.tenantPrisma!.user.update({
    where: { id }, data,
    select: { id: true, name: true, email: true, role: true, isActive: true }
  });

  // Sincroniza membership global (email/name/role/isActive/password).
  const membership = await globalPrisma.tenantMembership.findUnique({
    where: { email_tenantId: { email: target.email, tenantId } }
  });
  if (membership) {
    const membershipData: Record<string, unknown> = {};
    if (body.name !== undefined) membershipData.name = body.name;
    if (body.email !== undefined) membershipData.email = body.email;
    if (body.role !== undefined) membershipData.role = body.role;
    if (body.isActive !== undefined) membershipData.isActive = body.isActive;
    if (body.password) membershipData.passwordHash = await bcrypt.hash(body.password, 12);
    if (Object.keys(membershipData).length > 0) {
      await globalPrisma.tenantMembership.update({
        where: { id: membership.id },
        data: membershipData
      });
    }
  }

  invalidateAuthCache(id);
  res.json(user);
});

adminRouter.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.tenantUserId!) {
    return res.status(400).json({ message: 'No puedes eliminar tu propia cuenta' });
  }
  const target = await req.tenantPrisma!.user.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ message: 'Usuario no encontrado' });

  // Borrado en cascada elimina cuentas/movs/etc. (FK ON DELETE CASCADE).
  await req.tenantPrisma!.user.delete({ where: { id } });

  // Desactiva la membership global (no la borramos para preservar el audit log).
  await globalPrisma.tenantMembership.updateMany({
    where: { email: target.email, tenantId: req.tenantId! },
    data: { isActive: false }
  });

  invalidateAuthCache(id);
  res.json({ ok: true });
});

// Stub vacio: no hay plantillas de roles en multitenant; el frontend espera
// el endpoint para listar opciones, devolvemos array vacio.
adminRouter.get('/roles', (_req, res) => {
  res.json({ roles: [] });
});

// =====================================================================
// TODO (movidos a SuperAdmin global):
//   - POST/PUT/DELETE /roles → modelo Role no existe en tenant schema;
//     si quieres plantillas de permisos por tenant, agrega `Role` al
//     schema tenant o expónlo desde el SuperAdmin global.
//   - GET/PUT/DELETE /settings/smtp + /settings/smtp/test → GlobalSetting
//     es global; debe vivir bajo SuperAdmin global (o exponerse read-only
//     a admins de tenant si se requiere).
// =====================================================================
