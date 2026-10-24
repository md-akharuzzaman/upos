// GST/HST report helpers (v2.4): filing-period presets and the Excel export.
import { LONG_LABELS } from './payments.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

/** Monthly, quarterly and annual filing periods around `today` (YYYY-MM-DD). */
export function periodPresets(today) {
  const [y, m] = today.split('-').map(Number);
  const month = (yy, mm) => ({ from: ymd(yy, mm, 1), to: ymd(yy, mm, lastDay(yy, mm)) });
  const prevM = m === 1 ? [y - 1, 12] : [y, m - 1];
  const q = Math.floor((m - 1) / 3); // 0..3
  const quarter = (yy, qq) => ({ from: ymd(yy, qq * 3 + 1, 1), to: ymd(yy, qq * 3 + 3, lastDay(yy, qq * 3 + 3)) });
  const prevQ = q === 0 ? [y - 1, 3] : [y, q - 1];
  const name = (yy, mm) => new Date(Date.UTC(yy, mm - 1, 1)).toLocaleString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return [
    { id: 'this-month', label: `This month (${name(y, m)})`, ...month(y, m) },
    { id: 'last-month', label: `Last month (${name(...prevM)})`, ...month(...prevM) },
    { id: 'this-quarter', label: `This quarter (Q${q + 1} ${y})`, ...quarter(y, q) },
    { id: 'last-quarter', label: `Last quarter (Q${prevQ[1] + 1} ${prevQ[0]})`, ...quarter(...prevQ) },
    { id: 'this-year', label: `This year (${y})`, from: ymd(y, 1, 1), to: ymd(y, 12, 31) },
    { id: 'last-year', label: `Last year (${y - 1})`, from: ymd(y - 1, 1, 1), to: ymd(y - 1, 12, 31) },
  ];
}

const money = (cents) => ({ value: cents / 100, type: Number, format: '#,##0.00' });
const bold = (value) => ({ value, fontWeight: 'bold' });

/** The workbook: Summary, By tax rate, Payments. */
export function taxReportSheets(r) {
  const t = r.totals;
  const summary = [
    [bold('GST/HST report'), { value: r.business.legalName || r.business.name || '' }],
    [{ value: 'GST/HST number' }, { value: r.business.gstHstNumber || 'not set (Business tab)' }],
    [{ value: 'Period' }, { value: `${r.from} to ${r.to} (${r.timeZone})` }],
    [],
    [bold('Line'), bold('Amount')],
    [{ value: 'Sales before tax' }, money(t.salesNetCents)],
    [{ value: 'Less refunds before tax' }, money(-t.refundNetCents)],
    [bold('Line 101 - sales and other revenue'), money(t.line101Cents)],
    [{ value: '  of which zero-rated / exempt' }, money(t.zeroRatedCents)],
    [{ value: 'GST/HST collected on sales' }, money(t.taxCollectedCents)],
    [{ value: 'Less GST/HST refunded' }, money(-t.taxRefundedCents)],
    [bold('Line 103 - GST/HST collected (net of refunds)'), money(t.line103Cents)],
    [],
    [{ value: 'Sales' }, { value: r.sales.count, type: Number }],
    [{ value: 'Refunds' }, { value: r.refunds.count, type: Number }],
    [{ value: 'Promotion discounts (already deducted)' }, money(r.sales.discountCents)],
    [],
    [{ value: 'Input tax credits (line 106) come from purchase invoices and are not in this report.' }],
  ];
  const byRate = [
    ['Tax rate', 'Sales before tax', 'Tax on sales', 'Refunds before tax', 'Tax refunded', 'Net sales', 'Net tax'].map(bold),
    ...r.byRate.map((x) => [
      { value: x.label },
      money(x.salesNetCents),
      money(x.salesTaxCents),
      money(x.refundNetCents),
      money(x.refundTaxCents),
      money(x.netCents),
      money(x.taxCents),
    ]),
  ];
  const payments = [
    ['Payment method', 'Sales', 'Amount', 'Refunds', 'Refunded', 'Net'].map(bold),
    ...r.payments.map((p) => [
      { value: LONG_LABELS[p.method] || p.method },
      { value: p.salesCount, type: Number },
      money(p.salesCents),
      { value: p.refundsCount, type: Number },
      money(p.refundCents),
      money(p.netCents),
    ]),
  ];
  return [
    { data: summary, sheet: 'Summary', columns: [{ width: 48 }, { width: 40 }] },
    { data: byRate, sheet: 'By tax rate', columns: [{ width: 26 }, ...Array(6).fill({ width: 16 })], stickyRowsCount: 1 },
    { data: payments, sheet: 'Payments', columns: [{ width: 22 }, ...Array(5).fill({ width: 14 })], stickyRowsCount: 1 },
  ];
}

export async function downloadTaxReport(report) {
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  const blob = await writeExcelFile(taxReportSheets(report)).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gst-hst-${report.from}-to-${report.to}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
