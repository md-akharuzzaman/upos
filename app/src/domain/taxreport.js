'use strict';

// GST/HST report (v2.4): the figures a store needs for its GST/HST return
// (CRA form GST34) for any period - sales and tax by tax rate, refunds issued
// in the period, and payments by method. Dates are calendar days in the
// store's time zone. Sales count in the period they were made; refunds count
// in the period they were given (as a credit note would).

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID' });
}

/** Minutes the time zone is ahead of UTC at instant `ms`. */
function offsetMinutes(ms, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The UTC instant (ms) of local midnight starting `date` in `timeZone`. */
function zonedMidnight(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMinutes(guess, timeZone) * 60000;
  t = guess - offsetMinutes(t, timeZone) * 60000; // second pass: right side of a DST change
  return t;
}

const validDate = (s) => {
  if (!DAY.test(s || '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

const nextDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** UTC window [from, to) for the local calendar days from..to (inclusive). */
function periodWindow(from, to, timeZone = 'America/Toronto') {
  if (!validDate(from) || !validDate(to)) throw invalid('from and to must be dates (YYYY-MM-DD)');
  if (from > to) throw invalid('from must not be after to');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > MAX_DAYS) throw invalid(`a report covers at most ${MAX_DAYS} days`);
  return { from: new Date(zonedMidnight(from, timeZone)).toISOString(), to: new Date(zonedMidnight(nextDay(to), timeZone)).toISOString(), days };
}

function rateLabel(bp) {
  if (bp === 0) return 'Zero-rated / exempt (0 %)';
  const pct = `${(bp / 100).toLocaleString('en-CA', { maximumFractionDigits: 3 })} %`;
  if (bp === 500) return `GST ${pct}`;
  if ([1300, 1400, 1500].includes(bp)) return `HST ${pct}`;
  return `Tax ${pct}`;
}

const n = (v) => Number(v ?? 0); // SQL BIGINT sums arrive as strings

/**
 * Shapes the adapter's raw sums into the report.
 * raw = { salesByRate: [{rateBp, netCents, taxCents, discountCents}], refundsByRate: [{rateBp, netCents, taxCents}],
 *         payments: [{method, salesCount, salesCents, refundsCount, refundCents}] }
 */
function buildTaxReport(raw, { from, to, timeZone, store }) {
  const rates = new Map();
  const at = (bp) => {
    const k = n(bp);
    if (!rates.has(k)) rates.set(k, { rateBp: k, label: rateLabel(k), salesNetCents: 0, salesTaxCents: 0, refundNetCents: 0, refundTaxCents: 0 });
    return rates.get(k);
  };
  let discountCents = 0;
  for (const r of raw.salesByRate || []) {
    const x = at(r.rateBp);
    x.salesNetCents += n(r.netCents);
    x.salesTaxCents += n(r.taxCents);
    discountCents += n(r.discountCents);
  }
  for (const r of raw.refundsByRate || []) {
    const x = at(r.rateBp);
    x.refundNetCents += n(r.netCents);
    x.refundTaxCents += n(r.taxCents);
  }
  const byRate = [...rates.values()]
    .sort((a, b) => a.rateBp - b.rateBp)
    .map((x) => ({ ...x, netCents: x.salesNetCents - x.refundNetCents, taxCents: x.salesTaxCents - x.refundTaxCents }));

  const methods = new Map();
  for (const p of raw.payments || []) {
    const m = methods.get(p.method) || { method: p.method, salesCount: 0, salesCents: 0, refundsCount: 0, refundCents: 0 };
    m.salesCount += n(p.salesCount);
    m.salesCents += n(p.salesCents);
    m.refundsCount += n(p.refundsCount);
    m.refundCents += n(p.refundCents);
    methods.set(p.method, m);
  }
  const ORDER = ['cash', 'debit', 'credit', 'card', 'etransfer', 'stripe'];
  const payments = [...methods.values()]
    .sort((a, b) => ORDER.indexOf(a.method) - ORDER.indexOf(b.method))
    .map((m) => ({ ...m, netCents: m.salesCents - m.refundCents }));

  const sum = (list, k) => list.reduce((t, x) => t + x[k], 0);
  const salesNetCents = sum(byRate, 'salesNetCents');
  const taxCollectedCents = sum(byRate, 'salesTaxCents');
  const refundNetCents = sum(byRate, 'refundNetCents');
  const taxRefundedCents = sum(byRate, 'refundTaxCents');
  const p = store?.profile || {};
  return {
    from,
    to,
    timeZone,
    currency: store?.currency || 'CAD',
    business: {
      name: store?.name ?? null,
      legalName: p.legalName ?? null,
      gstHstNumber: p.gstHstNumber ?? null,
      qstNumber: p.qstNumber ?? null,
      pstNumber: p.pstNumber ?? null,
      province: p.address?.province ?? null,
    },
    sales: { count: sum(payments, 'salesCount'), totalCents: sum(payments, 'salesCents'), discountCents },
    refunds: { count: sum(payments, 'refundsCount'), totalCents: sum(payments, 'refundCents') },
    byRate,
    payments,
    totals: {
      salesNetCents,
      refundNetCents,
      taxCollectedCents,
      taxRefundedCents,
      // GST34: line 101 = sales and other revenue (before tax, all rates incl. zero-rated);
      // line 103 = GST/HST collected or collectible. Refunds given in the period are deducted.
      line101Cents: salesNetCents - refundNetCents,
      line103Cents: taxCollectedCents - taxRefundedCents,
      zeroRatedCents: byRate.filter((r) => r.rateBp === 0).reduce((t, r) => t + r.netCents, 0),
      taxableCents: byRate.filter((r) => r.rateBp > 0).reduce((t, r) => t + r.netCents, 0),
    },
  };
}

module.exports = { periodWindow, zonedMidnight, offsetMinutes, rateLabel, buildTaxReport, MAX_DAYS };
