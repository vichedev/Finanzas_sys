import 'dotenv/config';
import './lib/env';
import 'express-async-errors';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { globalAuthRouter } from './routes/global/auth.routes';
import { superAdminRouter } from './routes/global/superAdmin.routes';
// Tenant routes (multitenant) — apuntan a req.tenantPrisma
import { accountsRouter } from './routes/tenant/accounts.routes';
import { cardsRouter } from './routes/tenant/cards.routes';
import { categoriesRouter } from './routes/tenant/categories.routes';
import { banksRouter } from './routes/tenant/banks.routes';
import { movementsRouter } from './routes/tenant/movements.routes';
import { debtsRouter } from './routes/tenant/debts.routes';
import { recurringsRouter } from './routes/tenant/recurrings.routes';
import { invoicesRouter } from './routes/tenant/invoices.routes';
import { dashboardRouter } from './routes/tenant/dashboard.routes';
import { adminRouter as tenantAdminRouter } from './routes/tenant/admin.routes';
import { reportsRouter } from './routes/tenant/reports.routes';
import { requireAuth } from './middleware/auth';
import { tenantContext } from './middleware/tenantContext';

const app = express();
const port = Number(process.env.PORT || 4000);
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((item) => item.trim()).filter(Boolean);

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false, // el frontend nginx ya emite CSP completa
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: false },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  frameguard: { action: 'deny' },
  noSniff: true,
}));
app.use(compression());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true
}));
app.use(express.json({ limit: '256kb' }));
app.use(pinoHttp({
  logger,
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req(req) { return { method: req.method, url: req.url, id: req.id }; },
    res(res) { return { statusCode: res.statusCode }; }
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limit cuando el response es 2xx (logins exitosos no cuentan)
  skipSuccessfulRequests: true,
  message: { message: 'Demasiados intentos, espera unos minutos.' }
});

const adminWriteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiadas operaciones, espera unos minutos.' }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'finanzas-backend' });
});

app.use('/api/auth', authLimiter, globalAuthRouter);
app.use('/api/super-admin', superAdminRouter);

// Todas las rutas /api/* (excepto auth y super-admin) requieren auth + tenant context
const tenantScope = [requireAuth, tenantContext];
app.use('/api/accounts',   tenantScope, accountsRouter);
app.use('/api/cards',      tenantScope, cardsRouter);
app.use('/api/categories', tenantScope, categoriesRouter);
app.use('/api/banks',      tenantScope, banksRouter);
app.use('/api/movements',  tenantScope, movementsRouter);
app.use('/api/debts',      tenantScope, debtsRouter);
app.use('/api/recurrings', tenantScope, recurringsRouter);
app.use('/api/invoices',   tenantScope, invoicesRouter);
app.use('/api/dashboard',  tenantScope, dashboardRouter);
app.use('/api/admin',      tenantScope, adminWriteLimiter, tenantAdminRouter);
app.use('/api/reports',    tenantScope, reportsRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ message: 'Datos inválidos', errors: err.flatten() });
  }
  const e = err as { type?: string; code?: string; message?: string };
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ message: 'JSON inválido' });
  if (e?.type === 'entity.too.large') return res.status(413).json({ message: 'Carga demasiado grande' });
  if (e?.code === 'P2025') return res.status(404).json({ message: 'Recurso no encontrado' });
  if (e?.code === 'P2002') return res.status(409).json({ message: 'Registro duplicado' });
  if (e?.code === 'P2003') return res.status(409).json({ message: 'No se puede eliminar: hay registros que dependen de este.' });
  logger.error({ err }, 'unhandled error');
  return res.status(500).json({ message: 'Error interno' });
});

process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));

app.listen(port, () => logger.info({ port }, 'API Finanzas escuchando'));
