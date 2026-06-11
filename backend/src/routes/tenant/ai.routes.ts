import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { encryptString, decryptString } from '../../lib/tenantCrypto';
import { buildFinancialSnapshot, callFinancIA } from '../../lib/financia';
import { auditFromReq } from '../../lib/tenantAudit';

export const aiRouter = Router();
aiRouter.use(requireAuth, (req, res, next) => requirePermission('reports', req.method === 'GET' ? 'read' : 'write')(req, res, next));

async function getConfig(prisma: any) {
  return prisma.aiConfig.findUnique({ where: { id: 1 } });
}

// Estado/configuración (nunca devuelve la clave)
aiRouter.get('/config', async (req, res) => {
  const cfg = await getConfig(req.tenantPrisma!);
  res.json({
    provider: cfg?.provider || 'groq',
    model: cfg?.model || 'llama-3.3-70b-versatile',
    enabled: cfg?.enabled ?? false,
    hasKey: !!cfg?.apiKeyEnc
  });
});

const configSchema = z.object({
  apiKey: z.string().trim().min(10).max(300).optional(),
  model: z.string().trim().min(2).max(80).optional(),
  enabled: z.boolean().optional()
}).strict();

aiRouter.put('/config', async (req, res) => {
  const body = configSchema.parse(req.body);
  const data: Record<string, unknown> = {};
  if (body.model !== undefined) data.model = body.model;
  if (body.enabled !== undefined) data.enabled = body.enabled;
  if (body.apiKey) data.apiKeyEnc = encryptString(body.apiKey);

  const cfg = await req.tenantPrisma!.aiConfig.upsert({
    where: { id: 1 },
    create: { id: 1, provider: 'groq', model: (data.model as string) || 'llama-3.3-70b-versatile', enabled: (data.enabled as boolean) ?? false, apiKeyEnc: (data.apiKeyEnc as string) ?? null },
    update: data
  });
  void auditFromReq(req, 'UPDATE', 'ai', 1, 'Configuración de FinancIA actualizada');
  res.json({ provider: cfg.provider, model: cfg.model, enabled: cfg.enabled, hasKey: !!cfg.apiKeyEnc });
});

aiRouter.delete('/config', async (req, res) => {
  await req.tenantPrisma!.aiConfig.upsert({
    where: { id: 1 },
    create: { id: 1, enabled: false },
    update: { apiKeyEnc: null, enabled: false }
  });
  void auditFromReq(req, 'DELETE', 'ai', 1, 'Clave de FinancIA eliminada');
  res.status(204).send();
});

// Ejecuta el análisis con FinancIA
const analyzeSchema = z.object({ question: z.string().trim().max(500).optional() }).strict();

aiRouter.post('/analyze', async (req, res) => {
  const body = analyzeSchema.parse(req.body);
  const userId = req.tenantUserId!;
  const cfg = await getConfig(req.tenantPrisma!);
  if (!cfg || !cfg.enabled) return res.status(400).json({ message: 'FinancIA no está activada. Configúrala en Configuración → FinancIA.' });
  if (!cfg.apiKeyEnc) return res.status(400).json({ message: 'Falta la clave de API de Groq.' });

  let apiKey: string;
  try { apiKey = decryptString(cfg.apiKeyEnc); }
  catch { return res.status(500).json({ message: 'No se pudo leer la clave de API.' }); }

  const { readable, snapshot } = await buildFinancialSnapshot(req.tenantPrisma!, userId);
  const analysis = await callFinancIA(apiKey, cfg.model, readable, body.question);
  res.json({ analysis, snapshot, generatedAt: new Date().toISOString() });
});
