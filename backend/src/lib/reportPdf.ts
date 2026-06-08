import PDFDocument from 'pdfkit';
import { Writable } from 'stream';

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

export type CategoryRow = { type: 'INCOME' | 'EXPENSE'; categoryName: string; amount: number };

export type MonthlyReportData = {
  year: number;
  month: number;
  income: number;
  expense: number;
  balance: number;
  byCategory: CategoryRow[];
  user: { name: string; email: string; currency?: string };
};

const COLORS = {
  primary: '#0f172a',
  secondary: '#475569',
  muted: '#94a3b8',
  income: '#047857',
  expense: '#b91c1c',
  balance: '#1e40af',
  border: '#e2e8f0',
  rowAlt: '#f8fafc',
  headerBg: '#1e3a8a',
  headerText: '#ffffff'
};

function fmtMoney(value: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('es-EC', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2
    }).format(Number(value || 0));
  } catch {
    return `${currency} ${(value || 0).toFixed(2)}`;
  }
}

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('es-EC', { day: '2-digit', month: 'long', year: 'numeric' }).format(d);
}

export function buildMonthlyReportPdf(data: MonthlyReportData, output: Writable): void {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
    info: {
      Title: `Reporte mensual ${MONTH_NAMES[data.month - 1]} ${data.year}`,
      Author: data.user.name,
      Creator: 'Finanzas Mensuales',
      Subject: 'Reporte mensual'
    }
  });

  doc.pipe(output);

  const currency = data.user.currency || 'USD';
  const periodLabel = `${MONTH_NAMES[data.month - 1]} ${data.year}`;
  const incomeRows = data.byCategory.filter((r) => r.type === 'INCOME');
  const expenseRows = data.byCategory.filter((r) => r.type === 'EXPENSE');
  const incomeTotal = incomeRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const expenseTotal = expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0);

  // Header band
  const pageW = doc.page.width;
  doc.rect(0, 0, pageW, 90).fill(COLORS.headerBg);
  doc.fillColor(COLORS.headerText)
    .fontSize(10)
    .text('REPORTE MENSUAL · FINANZAS MENSUALES', 50, 30, { characterSpacing: 1.2 });
  doc.fontSize(22).font('Helvetica-Bold').text(periodLabel, 50, 46);
  doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.85)' as unknown as string)
    .text(`${data.user.name} · ${data.user.email}`, 50, 72, { lineBreak: false });

  doc.fillColor(COLORS.primary);
  doc.y = 110;

  // KPI cards (3 columnas)
  const cardW = (pageW - 100 - 20) / 3;
  const cardH = 70;
  const startY = doc.y;
  const cards = [
    { label: 'INGRESOS', value: data.income, color: COLORS.income },
    { label: 'GASTOS', value: data.expense, color: COLORS.expense },
    { label: 'BALANCE', value: data.balance, color: data.balance >= 0 ? COLORS.income : COLORS.expense }
  ];
  cards.forEach((c, i) => {
    const x = 50 + i * (cardW + 10);
    doc.roundedRect(x, startY, cardW, cardH, 8).lineWidth(1).strokeColor(COLORS.border).stroke();
    doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica-Bold')
      .text(c.label, x + 14, startY + 12, { characterSpacing: 0.6 });
    doc.fillColor(c.color).fontSize(20).font('Helvetica-Bold')
      .text(fmtMoney(c.value, currency), x + 14, startY + 30, { width: cardW - 28, lineBreak: false });
  });

  doc.y = startY + cardH + 24;
  doc.fillColor(COLORS.primary);

  // Sección Ingresos
  drawSectionTable(doc, {
    title: 'Ingresos por categoría',
    color: COLORS.income,
    rows: incomeRows,
    total: incomeTotal,
    currency
  });

  doc.moveDown(1);

  // Sección Gastos
  drawSectionTable(doc, {
    title: 'Gastos por categoría',
    color: COLORS.expense,
    rows: expenseRows,
    total: expenseTotal,
    currency
  });

  // Footer en cada página
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - 40;
    doc.fontSize(8).fillColor(COLORS.muted)
      .text(`Generado el ${fmtDate(new Date())}`, 50, fy, { width: pageW - 100, align: 'left' });
    doc.text(`Página ${i - range.start + 1} de ${range.count}`, 50, fy, { width: pageW - 100, align: 'right' });
  }

  doc.end();
}

type Section = {
  title: string;
  color: string;
  rows: CategoryRow[];
  total: number;
  currency: string;
};

function drawSectionTable(doc: PDFKit.PDFDocument, s: Section): void {
  const pageW = doc.page.width;
  const tableX = 50;
  const tableW = pageW - 100;

  ensureSpace(doc, 60);

  // Título sección
  doc.fontSize(13).font('Helvetica-Bold').fillColor(COLORS.primary)
    .text(s.title, tableX, doc.y);
  doc.moveDown(0.4);

  // Header table
  const headerY = doc.y;
  doc.rect(tableX, headerY, tableW, 24).fill('#f1f5f9');
  doc.fillColor(COLORS.secondary).fontSize(9).font('Helvetica-Bold')
    .text('CATEGORÍA', tableX + 14, headerY + 8, { width: tableW * 0.55 - 14, characterSpacing: 0.6 });
  doc.text('% TOTAL', tableX + tableW * 0.55, headerY + 8, { width: tableW * 0.2, align: 'right' });
  doc.text('MONTO', tableX + tableW * 0.55 + tableW * 0.2, headerY + 8, { width: tableW * 0.25 - 14, align: 'right' });

  doc.y = headerY + 24;

  if (s.rows.length === 0) {
    doc.fillColor(COLORS.muted).fontSize(10).font('Helvetica-Oblique')
      .text('Sin movimientos en el periodo.', tableX, doc.y + 8, { width: tableW, align: 'center' });
    doc.y += 30;
    return;
  }

  s.rows.forEach((r, idx) => {
    ensureSpace(doc, 24);
    const y = doc.y;
    if (idx % 2 === 1) {
      doc.rect(tableX, y, tableW, 22).fill(COLORS.rowAlt);
    }
    const pct = s.total > 0 ? (r.amount / s.total) * 100 : 0;
    doc.fillColor(COLORS.primary).fontSize(10).font('Helvetica')
      .text(r.categoryName, tableX + 14, y + 6, { width: tableW * 0.55 - 14, lineBreak: false, ellipsis: true });
    doc.fillColor(COLORS.muted)
      .text(`${pct.toFixed(1)}%`, tableX + tableW * 0.55, y + 6, { width: tableW * 0.2, align: 'right' });
    doc.fillColor(s.color).font('Helvetica-Bold')
      .text(fmtMoney(r.amount, s.currency), tableX + tableW * 0.55 + tableW * 0.2, y + 6, { width: tableW * 0.25 - 14, align: 'right' });
    doc.y = y + 22;
  });

  // Total
  ensureSpace(doc, 28);
  const totalY = doc.y;
  doc.rect(tableX, totalY, tableW, 26).fill('#0f172a');
  doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
    .text('TOTAL', tableX + 14, totalY + 8, { width: tableW * 0.6, characterSpacing: 0.6 });
  doc.text(fmtMoney(s.total, s.currency), tableX + tableW * 0.6, totalY + 8, { width: tableW * 0.4 - 14, align: 'right' });
  doc.y = totalY + 26;
  doc.fillColor(COLORS.primary);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottomLimit) {
    doc.addPage();
  }
}
