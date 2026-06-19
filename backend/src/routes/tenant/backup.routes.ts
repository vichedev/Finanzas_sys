import { Router } from 'express';

// Respaldos: exporta TODOS los datos del usuario a JSON y los reimporta
// (remapeando IDs) para migrar entre empresas o restaurar. auth + tenantContext
// vienen del montaje (tenantScope) en index.ts.
export const backupRouter = Router();

type IdMap = Record<number, number>;
const remap = (m: IdMap, id: number | null | undefined): number | null =>
  id != null && m[id] != null ? m[id] : null;
const toDate = (v: unknown): Date | null => (v ? new Date(v as string) : null);

backupRouter.get('/export', async (req, res) => {
  const userId = req.tenantUserId!;
  const p = req.tenantPrisma!;

  const [banks, accounts, cards, wallets, categories, debts, recurrings, movements, invoices, attachments, budgets, branding, aiConfig, walletAccounts, notifications, auditLogs, entities] =
    await Promise.all([
      p.bank.findMany({ where: { userId } }),
      p.account.findMany({ where: { userId } }),
      p.card.findMany({ where: { userId } }),
      p.wallet.findMany({ where: { userId } }),
      p.category.findMany({ where: { userId } }),
      p.debt.findMany({ where: { userId } }),
      p.recurringRule.findMany({ where: { userId } }),
      p.movement.findMany({ where: { userId } }),
      p.invoice.findMany({ where: { userId } }),
      p.attachment.findMany({ where: { userId } }),
      p.budget.findMany({ where: { userId } }),
      p.branding.findUnique({ where: { id: 1 } }).catch(() => null),
      p.aiConfig.findUnique({ where: { id: 1 } }).catch(() => null),
      // Enlaces billetera–cuenta (solo de billeteras del usuario).
      p.walletAccount.findMany({ where: { wallet: { userId } }, select: { walletId: true, accountId: true } }),
      p.notification.findMany({ where: { userId } }),
      p.auditLog.findMany({}),
      p.entity.findMany({ where: { userId } })
    ]);

  const data = {
    format: 'finanzas-backup',
    version: 3,
    exportedAt: new Date().toISOString(),
    counts: {
      banks: banks.length, accounts: accounts.length, cards: cards.length, wallets: wallets.length,
      categories: categories.length, debts: debts.length, recurrings: recurrings.length,
      movements: movements.length, invoices: invoices.length, attachments: attachments.length,
      budgets: budgets.length, notifications: notifications.length, auditLogs: auditLogs.length
    },
    banks, accounts, cards, wallets, walletAccounts, entities, categories, debts, recurrings, movements, invoices, budgets,
    notifications, auditLogs,
    attachments: attachments.map((a) => ({ ...a, data: Buffer.from(a.data).toString('base64') })),
    // Identidad de la empresa (logo en base64) — singleton por empresa.
    branding: branding ? {
      systemTitle: branding.systemTitle, subtitle: branding.subtitle,
      primaryColor: branding.primaryColor, accentColor: branding.accentColor,
      logoMime: branding.logoMime,
      logoData: branding.logoData ? Buffer.from(branding.logoData).toString('base64') : null
    } : null,
    // Config de FinancIA (sin la clave de API: va cifrada y atada a este servidor).
    aiConfig: aiConfig ? { provider: aiConfig.provider, model: aiConfig.model, enabled: aiConfig.enabled } : null
  };

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="respaldo-finanzas-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(data));
});

backupRouter.post('/import', async (req, res) => {
  const data = req.body;
  if (!data || data.format !== 'finanzas-backup' || !Array.isArray(data.movements)) {
    return res.status(400).json({ message: 'Archivo de respaldo inválido.' });
  }
  const userId = req.tenantUserId!;
  const p = req.tenantPrisma!;

  try {
    const imported = await p.$transaction(async (tx) => {
      const mBank: IdMap = {}, mAccount: IdMap = {}, mCard: IdMap = {}, mWallet: IdMap = {};
      const mCategory: IdMap = {}, mDebt: IdMap = {}, mRecurring: IdMap = {};
      const mMovement: IdMap = {}, mInvoice: IdMap = {}, mEntity: IdMap = {};
      const counts: Record<string, number> = {};
      const bump = (k: string) => { counts[k] = (counts[k] || 0) + 1; };

      // Catálogos con nombre único: reutiliza si ya existe, si no, crea.
      for (const b of data.banks || []) {
        const ex = await tx.bank.findFirst({ where: { userId, name: b.name }, select: { id: true } });
        const id = ex?.id ?? (await tx.bank.create({ data: { userId, name: b.name, accountNumber: b.accountNumber ?? null, accountKind: b.accountKind ?? null, isActive: b.isActive ?? true, notes: b.notes ?? null } })).id;
        if (!ex) bump('banks');
        mBank[b.id] = id;
      }
      for (const w of data.wallets || []) {
        const ex = await tx.wallet.findFirst({ where: { userId, name: w.name }, select: { id: true } });
        const id = ex?.id ?? (await tx.wallet.create({ data: { userId, name: w.name, provider: w.provider ?? null, identifier: w.identifier ?? null, isActive: w.isActive ?? true, notes: w.notes ?? null } })).id;
        if (!ex) bump('wallets');
        mWallet[w.id] = id;
      }
      for (const c of data.categories || []) {
        const ex = await tx.category.findFirst({ where: { userId, name: c.name, type: c.type }, select: { id: true } });
        const id = ex?.id ?? (await tx.category.create({ data: { userId, name: c.name, type: c.type, color: c.color ?? null, icon: c.icon ?? null, isDefault: c.isDefault ?? false } })).id;
        if (!ex) bump('categories');
        mCategory[c.id] = id;
      }
      // Razones sociales (nombre único): reutiliza si existe.
      for (const e of data.entities || []) {
        const ex = await tx.entity.findFirst({ where: { userId, name: e.name }, select: { id: true } });
        const id = ex?.id ?? (await tx.entity.create({ data: { userId, name: e.name, kind: e.kind ?? 'PERSONAL', taxId: e.taxId ?? null, notes: e.notes ?? null } })).id;
        if (!ex) bump('entities');
        mEntity[e.id] = id;
      }

      // Cuentas
      for (const a of data.accounts || []) {
        const created = await tx.account.create({ data: {
          userId, name: a.name, type: a.type, holder: a.holder ?? null, accountKind: a.accountKind ?? null,
          entityId: remap(mEntity, a.entityId),
          bankId: remap(mBank, a.bankId), bankName: a.bankName ?? null,
          accountNumber: a.accountNumber ?? null, initialBalance: a.initialBalance ?? 0, currentBalance: a.currentBalance ?? 0, isActive: a.isActive ?? true
        } });
        mAccount[a.id] = created.id; bump('accounts');
      }
      // Enlaces billetera–cuenta (requieren billeteras y cuentas ya remapeadas).
      for (const link of data.walletAccounts || []) {
        const walletId = remap(mWallet, link.walletId);
        const accountId = remap(mAccount, link.accountId);
        if (walletId == null || accountId == null) continue;
        const ex = await tx.walletAccount.findFirst({ where: { walletId, accountId }, select: { id: true } });
        if (!ex) { await tx.walletAccount.create({ data: { walletId, accountId } }); bump('walletAccounts'); }
      }
      // Tarjetas
      for (const c of data.cards || []) {
        const created = await tx.card.create({ data: {
          userId, name: c.name, type: c.type, bankId: remap(mBank, c.bankId), bankName: c.bankName ?? null, last4: c.last4 ?? null,
          entityId: remap(mEntity, c.entityId),
          creditLimit: c.creditLimit ?? null, cutoffDay: c.cutoffDay ?? null, paymentDueDay: c.paymentDueDay ?? null,
          currentBalance: c.currentBalance ?? 0, isActive: c.isActive ?? true
        } });
        mCard[c.id] = created.id; bump('cards');
      }
      // Deudas
      for (const d of data.debts || []) {
        const created = await tx.debt.create({ data: {
          userId, kind: d.kind, status: d.status, name: d.name, counterparty: d.counterparty ?? null,
          principal: d.principal ?? 0, balance: d.balance ?? 0, interestRate: d.interestRate ?? null,
          dueDate: toDate(d.dueDate), accountId: remap(mAccount, d.accountId), notes: d.notes ?? null,
          cutoffDay: d.cutoffDay ?? null, paymentDay: d.paymentDay ?? null,
          installmentAmount: d.installmentAmount ?? null, installmentDueDay: d.installmentDueDay ?? null,
          termMonths: d.termMonths ?? null, totalToPay: d.totalToPay ?? null
        } });
        mDebt[d.id] = created.id; bump('debts');
      }
      // Recurrentes
      for (const r of data.recurrings || []) {
        const created = await tx.recurringRule.create({ data: {
          userId, name: r.name, type: r.type, amount: r.amount ?? 0, frequency: r.frequency, status: r.status,
          nextRunDate: toDate(r.nextRunDate) ?? new Date(), endDate: toDate(r.endDate), paymentMethod: r.paymentMethod,
          categoryId: remap(mCategory, r.categoryId), accountId: remap(mAccount, r.accountId), notes: r.notes ?? null
        } });
        mRecurring[r.id] = created.id; bump('recurrings');
      }
      // Movimientos (sin re-aplicar deltas: los saldos ya vienen en cuentas/tarjetas)
      for (const m of data.movements || []) {
        const created = await tx.movement.create({ data: {
          userId, type: m.type, expenseKind: m.expenseKind ?? null, amount: m.amount ?? 0,
          movementDate: toDate(m.movementDate) ?? new Date(), description: m.description, paymentMethod: m.paymentMethod,
          familyMember: m.familyMember ?? null, notes: m.notes ?? null,
          accountId: remap(mAccount, m.accountId), toAccountId: remap(mAccount, m.toAccountId), cardId: remap(mCard, m.cardId), walletId: remap(mWallet, m.walletId),
          categoryId: remap(mCategory, m.categoryId), debtId: remap(mDebt, m.debtId), recurringRuleId: remap(mRecurring, m.recurringRuleId),
          fromBankId: remap(mBank, m.fromBankId), toBankId: remap(mBank, m.toBankId),
          vendor: m.vendor ?? null, isCredit: m.isCredit ?? false, dueDate: toDate(m.dueDate), commission: m.commission ?? null,
          installmentNumber: m.installmentNumber ?? null, installmentTotal: m.installmentTotal ?? null,
          ...(m.attachmentMeta ? { attachmentMeta: m.attachmentMeta } : {})
        } });
        mMovement[m.id] = created.id; bump('movements');
      }
      // Facturas
      for (const inv of data.invoices || []) {
        const created = await tx.invoice.create({ data: {
          userId, kind: inv.kind, status: inv.status, number: inv.number ?? null, counterparty: inv.counterparty,
          counterpartyTaxId: inv.counterpartyTaxId ?? null, issueDate: toDate(inv.issueDate) ?? new Date(),
          netAmount: inv.netAmount ?? 0, vatRate: inv.vatRate ?? 0, vatAmount: inv.vatAmount ?? 0, total: inv.total ?? 0,
          accountId: remap(mAccount, inv.accountId), description: inv.description ?? null, notes: inv.notes ?? null
        } });
        mInvoice[inv.id] = created.id; bump('invoices');
      }
      // Comprobantes (remap del entityId según su tipo)
      for (const at of data.attachments || []) {
        let entityId: number | null = null;
        if (at.entityType === 'MOVEMENT') entityId = remap(mMovement, at.entityId);
        else if (at.entityType === 'INVOICE') entityId = remap(mInvoice, at.entityId);
        else if (at.entityType === 'DEBT') entityId = remap(mDebt, at.entityId);
        if (!entityId) { bump('comprobantesOmitidos'); continue; }
        await tx.attachment.create({ data: {
          userId, entityType: at.entityType, entityId, filename: at.filename, mimeType: at.mimeType,
          size: at.size ?? 0, data: Buffer.from(at.data || '', 'base64')
        } });
        bump('attachments');
      }

      // Presupuestos (remap de categoría; únicos por userId+categoría+periodo)
      for (const bud of data.budgets || []) {
        const categoryId = remap(mCategory, bud.categoryId);
        if (!categoryId) continue;
        const period = bud.period ?? 'MONTHLY';
        await tx.budget.upsert({
          where: { userId_categoryId_period: { userId, categoryId, period } },
          create: { userId, categoryId, amount: bud.amount ?? 0, period, isActive: bud.isActive ?? true },
          update: { amount: bud.amount ?? 0, isActive: bud.isActive ?? true }
        });
        bump('budgets');
      }

      // Notificaciones (solo remapeo de userId; conserva isRead/emailSent para no re-notificar).
      for (const n of data.notifications || []) {
        await tx.notification.create({ data: {
          userId, type: n.type, title: n.title, body: n.body, link: n.link ?? null,
          dedupeKey: n.dedupeKey ?? null, isRead: n.isRead ?? false, emailSent: n.emailSent ?? true,
          createdAt: toDate(n.createdAt) ?? new Date()
        } });
        bump('notifications');
      }
      // Historial de auditoría (sin FK; entityId queda como referencia histórica).
      for (const al of data.auditLogs || []) {
        await tx.auditLog.create({ data: {
          userId, userEmail: al.userEmail ?? null, action: al.action, entity: al.entity,
          entityId: al.entityId ?? null, summary: al.summary ?? null, createdAt: toDate(al.createdAt) ?? new Date()
        } });
        bump('auditLogs');
      }

      // Identidad / Branding (singleton id=1): restaura logo, colores y título.
      if (data.branding) {
        const br = data.branding;
        await tx.branding.upsert({
          where: { id: 1 },
          create: {
            id: 1, systemTitle: br.systemTitle ?? null, subtitle: br.subtitle ?? null,
            primaryColor: br.primaryColor ?? null, accentColor: br.accentColor ?? null,
            logoMime: br.logoMime ?? null, logoData: br.logoData ? Buffer.from(br.logoData, 'base64') : null
          },
          update: {
            systemTitle: br.systemTitle ?? null, subtitle: br.subtitle ?? null,
            primaryColor: br.primaryColor ?? null, accentColor: br.accentColor ?? null,
            logoMime: br.logoMime ?? null, logoData: br.logoData ? Buffer.from(br.logoData, 'base64') : null
          }
        });
        bump('branding');
      }

      // Config FinancIA (sin clave de API; se vuelve a ingresar tras restaurar).
      if (data.aiConfig) {
        const ai = data.aiConfig;
        await tx.aiConfig.upsert({
          where: { id: 1 },
          create: { id: 1, provider: ai.provider ?? 'groq', model: ai.model ?? 'llama-3.3-70b-versatile', enabled: false },
          update: { provider: ai.provider ?? 'groq', model: ai.model ?? 'llama-3.3-70b-versatile' }
        });
        bump('aiConfig');
      }

      return counts;
    }, { timeout: 120000, maxWait: 20000 });

    res.json({ ok: true, imported });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `No se pudo importar el respaldo: ${msg}` });
  }
});
