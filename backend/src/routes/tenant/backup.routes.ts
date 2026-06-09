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

  const [banks, accounts, cards, wallets, categories, debts, recurrings, movements, invoices, attachments] =
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
      p.attachment.findMany({ where: { userId } })
    ]);

  const data = {
    format: 'finanzas-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: {
      banks: banks.length, accounts: accounts.length, cards: cards.length, wallets: wallets.length,
      categories: categories.length, debts: debts.length, recurrings: recurrings.length,
      movements: movements.length, invoices: invoices.length, attachments: attachments.length
    },
    banks, accounts, cards, wallets, categories, debts, recurrings, movements, invoices,
    attachments: attachments.map((a) => ({ ...a, data: Buffer.from(a.data).toString('base64') }))
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
      const mMovement: IdMap = {}, mInvoice: IdMap = {};
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

      // Cuentas
      for (const a of data.accounts || []) {
        const created = await tx.account.create({ data: {
          userId, name: a.name, type: a.type, bankId: remap(mBank, a.bankId), bankName: a.bankName ?? null,
          accountNumber: a.accountNumber ?? null, initialBalance: a.initialBalance ?? 0, currentBalance: a.currentBalance ?? 0, isActive: a.isActive ?? true
        } });
        mAccount[a.id] = created.id; bump('accounts');
      }
      // Tarjetas
      for (const c of data.cards || []) {
        const created = await tx.card.create({ data: {
          userId, name: c.name, type: c.type, bankName: c.bankName ?? null, last4: c.last4 ?? null,
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
          categoryId: remap(mCategory, r.categoryId), notes: r.notes ?? null
        } });
        mRecurring[r.id] = created.id; bump('recurrings');
      }
      // Movimientos (sin re-aplicar deltas: los saldos ya vienen en cuentas/tarjetas)
      for (const m of data.movements || []) {
        const created = await tx.movement.create({ data: {
          userId, type: m.type, expenseKind: m.expenseKind ?? null, amount: m.amount ?? 0,
          movementDate: toDate(m.movementDate) ?? new Date(), description: m.description, paymentMethod: m.paymentMethod,
          familyMember: m.familyMember ?? null, notes: m.notes ?? null,
          accountId: remap(mAccount, m.accountId), cardId: remap(mCard, m.cardId), walletId: remap(mWallet, m.walletId),
          categoryId: remap(mCategory, m.categoryId), debtId: remap(mDebt, m.debtId), recurringRuleId: remap(mRecurring, m.recurringRuleId),
          fromBankId: remap(mBank, m.fromBankId), toBankId: remap(mBank, m.toBankId),
          vendor: m.vendor ?? null, isCredit: m.isCredit ?? false, dueDate: toDate(m.dueDate), commission: m.commission ?? null,
          installmentNumber: m.installmentNumber ?? null, installmentTotal: m.installmentTotal ?? null
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
        if (!entityId) continue;
        await tx.attachment.create({ data: {
          userId, entityType: at.entityType, entityId, filename: at.filename, mimeType: at.mimeType,
          size: at.size ?? 0, data: Buffer.from(at.data || '', 'base64')
        } });
        bump('attachments');
      }

      return counts;
    }, { timeout: 120000, maxWait: 20000 });

    res.json({ ok: true, imported });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `No se pudo importar el respaldo: ${msg}` });
  }
});
