import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

const COLORS = {
  income: 'FF10B981',
  expense: 'FFEF4444',
  balance: 'FF3B82F6',
  headerBg: 'FF1E3A8A',
  headerText: 'FFFFFFFF',
  totalBg: 'FF0F172A',
  zebra: 'FFF8FAFC',
  border: 'FFE2E8F0'
};

const MONEY_FMT = '"$"#,##0.00';
const PCT_FMT = '0.0%';

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: 'Efectivo',
  BANK_TRANSFER: 'Transferencia',
  DEPOSIT: 'Depósito',
  DEBIT_CARD: 'Tarjeta débito',
  CREDIT_CARD: 'Tarjeta crédito',
  WALLET: 'Billetera',
  OTHER: 'Otro'
};

const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  INCOME: 'Ingreso',
  EXPENSE: 'Gasto',
  TRANSFER: 'Transferencia',
  WITHDRAWAL: 'Retiro',
  PURCHASE: 'Compra'
};

function thinBorder() {
  return {
    top: { style: 'thin' as const, color: { argb: COLORS.border } },
    bottom: { style: 'thin' as const, color: { argb: COLORS.border } },
    left: { style: 'thin' as const, color: { argb: COLORS.border } },
    right: { style: 'thin' as const, color: { argb: COLORS.border } }
  };
}

function autoWidth(sheet: ExcelJS.Worksheet, minPadding = 2): void {
  sheet.columns.forEach((col) => {
    let max = 10;
    if (!col) return;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const text = cell.value == null ? '' : String(
        typeof cell.value === 'object' && cell.value !== null && 'richText' in (cell.value as object)
          ? (cell.value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('')
          : cell.value
      );
      const len = text.length;
      if (len > max) max = len;
    });
    col.width = max + minPadding;
  });
}

export async function buildMonthlyWorkbook(opts: {
  userId: number;
  year: number;
  month: number;
  prisma: PrismaClient;
}): Promise<Buffer> {
  const { userId, year, month, prisma } = opts;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const [user, totals, byCategory, categories, movements] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, currency: true }
    }),
    prisma.movement.groupBy({
      by: ['type'],
      where: { userId, movementDate: { gte: start, lt: end } },
      _sum: { amount: true }
    }),
    prisma.movement.groupBy({
      by: ['categoryId', 'type'],
      where: { userId, movementDate: { gte: start, lt: end } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } }
    }),
    prisma.category.findMany({ where: { userId } }),
    prisma.movement.findMany({
      where: { userId, movementDate: { gte: start, lt: end } },
      include: { category: true, account: true, card: true, fromBank: true, toBank: true },
      orderBy: { movementDate: 'desc' }
    })
  ]);

  const currency = user?.currency || 'USD';
  const income = Number((totals as any[]).find((t: any) => t.type === 'INCOME')?._sum.amount || 0);
  const expense = Number((totals as any[]).find((t: any) => t.type === 'EXPENSE')?._sum.amount || 0);
  const balance = income - expense;
  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;

  const categoryName = (id: number | null | undefined): string =>
    (categories as any[]).find((c: any) => c.id === id)?.name || 'Sin categoría';

  const incomeRows = (byCategory as any[])
    .filter((r: any) => r.type === 'INCOME')
    .map((r: any) => ({ name: categoryName(r.categoryId), amount: Number(r._sum.amount || 0) }));
  const expenseRows = (byCategory as any[])
    .filter((r: any) => r.type === 'EXPENSE')
    .map((r: any) => ({ name: categoryName(r.categoryId), amount: Number(r._sum.amount || 0) }));

  const wb = new ExcelJS.Workbook();
  wb.creator = user?.name || 'Finanzas Mensuales';
  wb.created = new Date();
  wb.title = `Reporte mensual ${monthLabel}`;

  // ----------------------- Hoja 1: Resumen -----------------------
  const summary = wb.addWorksheet('Resumen');
  summary.mergeCells('A1:D1');
  const title = summary.getCell('A1');
  title.value = `Reporte mensual ${monthLabel}`;
  title.font = { size: 16, bold: true, color: { argb: 'FF0F172A' } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  summary.getRow(1).height = 26;

  if (user) {
    summary.mergeCells('A2:D2');
    const sub = summary.getCell('A2');
    sub.value = `${user.name} · ${user.email}`;
    sub.font = { size: 10, color: { argb: 'FF64748B' } };
  }

  const headerRow = summary.getRow(4);
  headerRow.values = ['Concepto', 'Monto', '', ''];
  headerRow.font = { bold: true, color: { argb: COLORS.headerText } };
  headerRow.alignment = { vertical: 'middle' };
  ['A4', 'B4'].forEach((addr) => {
    const c = summary.getCell(addr);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    c.border = thinBorder();
  });

  const sumRows: Array<{ label: string; value: number; color: string }> = [
    { label: 'Ingresos', value: income, color: COLORS.income },
    { label: 'Gastos', value: expense, color: COLORS.expense },
    { label: 'Balance', value: balance, color: COLORS.balance }
  ];
  sumRows.forEach((r, i) => {
    const row = summary.getRow(5 + i);
    row.getCell(1).value = r.label;
    row.getCell(1).border = thinBorder();
    row.getCell(1).font = { bold: true };
    const amount = row.getCell(2);
    amount.value = r.value;
    amount.numFmt = MONEY_FMT;
    amount.font = { bold: true, color: { argb: r.color } };
    amount.border = thinBorder();
  });

  summary.getColumn(1).width = 18;
  summary.getColumn(2).width = 20;
  summary.getCell('A9').value = `Moneda: ${currency}`;
  summary.getCell('A9').font = { italic: true, color: { argb: 'FF94A3B8' }, size: 9 };

  // ----------------------- Hojas 2/3: por categoría -----------------------
  const buildCategorySheet = (
    name: string,
    rows: Array<{ name: string; amount: number }>,
    accentColor: string
  ) => {
    const sheet = wb.addWorksheet(name);
    const header = sheet.getRow(1);
    header.values = ['Categoría', 'Monto', '% del total'];
    header.font = { bold: true, color: { argb: COLORS.headerText } };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = thinBorder();
    });
    header.height = 20;

    const total = rows.reduce((s, r) => s + r.amount, 0);

    rows.forEach((r, idx) => {
      const row = sheet.getRow(2 + idx);
      row.getCell(1).value = r.name;
      row.getCell(2).value = r.amount;
      row.getCell(2).numFmt = MONEY_FMT;
      row.getCell(2).font = { color: { argb: accentColor }, bold: true };
      row.getCell(3).value = total > 0 ? r.amount / total : 0;
      row.getCell(3).numFmt = PCT_FMT;
      if (idx % 2 === 1) {
        for (let c = 1; c <= 3; c++) {
          row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
        }
      }
      for (let c = 1; c <= 3; c++) row.getCell(c).border = thinBorder();
    });

    const totalRow = sheet.getRow(2 + rows.length);
    totalRow.getCell(1).value = 'TOTAL';
    totalRow.getCell(2).value = total;
    totalRow.getCell(2).numFmt = MONEY_FMT;
    totalRow.getCell(3).value = rows.length > 0 ? 1 : 0;
    totalRow.getCell(3).numFmt = PCT_FMT;
    for (let c = 1; c <= 3; c++) {
      const cell = totalRow.getCell(c);
      cell.font = { bold: true, color: { argb: COLORS.headerText } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.totalBg } };
      cell.border = thinBorder();
    }

    autoWidth(sheet);
  };

  buildCategorySheet('Ingresos por categoría', incomeRows, COLORS.income);
  buildCategorySheet('Gastos por categoría', expenseRows, COLORS.expense);

  // ----------------------- Hoja 4: Movimientos -----------------------
  const mov = wb.addWorksheet('Movimientos del mes');
  const movHeaders = [
    'Fecha', 'Tipo', 'Concepto', 'Categoría', 'Método',
    'Cuenta', 'Tarjeta', 'Banco origen', 'Banco destino', 'Monto', 'Notas'
  ];
  const movHeader = mov.getRow(1);
  movHeader.values = movHeaders;
  movHeader.font = { bold: true, color: { argb: COLORS.headerText } };
  movHeader.height = 20;
  movHeader.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = thinBorder();
  });

  (movements as any[]).forEach((m: any, idx: number) => {
    const row = mov.getRow(2 + idx);
    const accentColor =
      m.type === 'INCOME' ? COLORS.income :
      m.type === 'EXPENSE' ? COLORS.expense :
      COLORS.balance;

    row.getCell(1).value = m.movementDate;
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(2).value = MOVEMENT_TYPE_LABEL[m.type] || m.type;
    row.getCell(2).font = { color: { argb: accentColor }, bold: true };
    row.getCell(3).value = m.description || '';
    row.getCell(4).value = m.category?.name || 'Sin categoría';
    row.getCell(5).value = PAYMENT_METHOD_LABEL[m.paymentMethod] || m.paymentMethod;
    row.getCell(6).value = m.account?.name || '';
    row.getCell(7).value = m.card?.name || '';
    row.getCell(8).value = m.fromBank?.name || '';
    row.getCell(9).value = m.toBank?.name || '';
    row.getCell(10).value = Number(m.amount);
    row.getCell(10).numFmt = MONEY_FMT;
    row.getCell(10).font = { color: { argb: accentColor }, bold: true };
    row.getCell(11).value = m.notes || '';

    if (idx % 2 === 1) {
      for (let c = 1; c <= movHeaders.length; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
      }
    }
    for (let c = 1; c <= movHeaders.length; c++) {
      row.getCell(c).border = thinBorder();
    }
  });

  if (movements.length === 0) {
    mov.mergeCells(2, 1, 2, movHeaders.length);
    const empty = mov.getCell('A2');
    empty.value = 'Sin movimientos en el periodo.';
    empty.alignment = { horizontal: 'center' };
    empty.font = { italic: true, color: { argb: 'FF94A3B8' } };
  }

  mov.views = [{ state: 'frozen', ySplit: 1 }];
  autoWidth(mov);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}
