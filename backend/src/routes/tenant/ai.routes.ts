import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permissions';
import { encryptString } from '../../lib/tenantCrypto';
import { buildFinancialSnapshot, callFinancIA, getBrainCreds } from '../../lib/financia';
import { resolveProvider, resolveBrainModel, PROVIDERS } from '../../whatsapp/llm';
import { DEFAULT_GROQ_MODEL } from '../../whatsapp/groq';
import { auditFromReq } from '../../lib/tenantAudit';

export const aiRouter = Router();
aiRouter.use(requireAuth, (req, res, next) => requirePermission('reports', req.method === 'GET' ? 'read' : 'write')(req, res, next));

async function getConfig(prisma: any) {
  return prisma.aiConfig.findUnique({ where: { id: 1 } });
}

// Estado/configuración (nunca devuelve las claves)
function publicConfig(cfg: any) {
  const provider = resolveProvider(cfg?.provider);
  return {
    provider,                                   // groq | openrouter
    model: resolveBrainModel(provider, cfg?.model),
    baseUrl: cfg?.baseUrl || PROVIDERS[provider].baseUrl,
    enabled: cfg?.enabled ?? false,
    hasKey: !!cfg?.apiKeyEnc,                    // clave del "cerebro"
    hasTranscribeKey: !!cfg?.transcribeApiKeyEnc // clave de Groq para audio (Whisper)
  };
}

aiRouter.get('/config', async (req, res) => {
  res.json(publicConfig(await getConfig(req.tenantPrisma!)));
});

const configSchema = z.object({
  provider: z.enum(['groq', 'openrouter', 'gemini']).optional(),
  apiKey: z.string().trim().min(10).max(300).optional(),           // clave del cerebro
  transcribeApiKey: z.string().trim().min(10).max(300).optional(), // clave de Groq para audio
  baseUrl: z.string().trim().url().max(200).optional(),
  model: z.string().trim().min(2).max(80).optional(),
  enabled: z.boolean().optional()
}).strict();

aiRouter.put('/config', async (req, res) => {
  const body = configSchema.parse(req.body);
  const prev = await getConfig(req.tenantPrisma!);
  const data: Record<string, unknown> = {};
  if (body.provider !== undefined) data.provider = body.provider;
  if (body.model !== undefined) data.model = body.model;
  if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
  if (body.enabled !== undefined) data.enabled = body.enabled;
  if (body.apiKey) data.apiKeyEnc = encryptString(body.apiKey);
  if (body.transcribeApiKey) data.transcribeApiKeyEnc = encryptString(body.transcribeApiKey);

  // Migración suave: si el usuario cambia de Groq a otro proveedor y no había clave
  // de transcripción, conserva la clave de Groq actual para que el audio siga
  // funcionando (antes de que la nueva clave del cerebro sobrescriba apiKeyEnc).
  if (body.provider && body.provider !== 'groq' && resolveProvider(prev?.provider) === 'groq'
      && prev?.apiKeyEnc && !prev?.transcribeApiKeyEnc && !body.transcribeApiKey) {
    data.transcribeApiKeyEnc = prev.apiKeyEnc;
  }

  const cfg = await req.tenantPrisma!.aiConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      provider: (data.provider as string) || 'groq',
      model: (data.model as string) || DEFAULT_GROQ_MODEL,
      baseUrl: (data.baseUrl as string) ?? null,
      enabled: (data.enabled as boolean) ?? false,
      apiKeyEnc: (data.apiKeyEnc as string) ?? null,
      transcribeApiKeyEnc: (data.transcribeApiKeyEnc as string) ?? null
    },
    update: data
  });
  void auditFromReq(req, 'UPDATE', 'ai', 1, 'Configuración de FinancIA actualizada');
  res.json(publicConfig(cfg));
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

  const creds = await getBrainCreds(req.tenantPrisma!);
  if (!creds) return res.status(400).json({ message: 'Falta la clave de API de la IA.' });

  const { readable, snapshot } = await buildFinancialSnapshot(req.tenantPrisma!, userId);
  const analysis = await callFinancIA(creds, readable, body.question);
  res.json({ analysis, snapshot, generatedAt: new Date().toISOString() });
});
