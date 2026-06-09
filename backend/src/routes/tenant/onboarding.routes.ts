import { Router } from 'express';

// Estado de configuración inicial del tenant (para la guía de primeros pasos).
// No requiere permisos de módulo: cualquier usuario del tenant ve su progreso.
// El auth + tenantContext los aplica el montaje (tenantScope) en index.ts.
export const onboardingRouter = Router();

onboardingRouter.get('/', async (req, res) => {
  const userId = req.tenantUserId!;
  const prisma = req.tenantPrisma!;

  const [accounts, banks, categories, cards, wallets, movements] = await Promise.all([
    prisma.account.count({ where: { userId } }),
    prisma.bank.count({ where: { userId } }),
    prisma.category.count({ where: { userId } }),
    prisma.card.count({ where: { userId } }),
    prisma.wallet.count({ where: { userId } }),
    prisma.movement.count({ where: { userId } })
  ]);

  res.json({ accounts, banks, categories, cards, wallets, movements });
});
