// Display-side copy of the API's pricing rules (app/src/domain/pricing.js).
// The server always recalculates; this is only the live preview in the register.

export function lineTotals(unitPriceCents, qty, taxRateBp) {
  const subtotal = unitPriceCents * qty;
  const raw = (subtotal * taxRateBp) / 10000;
  const tax = Math.sign(raw) * Math.round(Math.abs(raw));
  return { subtotal, tax, total: subtotal + tax };
}

export function cartTotals(lines) {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const t = lineTotals(l.product.priceCents, l.qty, l.product.taxRateBp);
    subtotal += t.subtotal;
    tax += t.tax;
  }
  return { subtotal, tax, total: subtotal + tax, items: lines.reduce((n, l) => n + l.qty, 0) };
}

export function formatMoney(cents, currency = 'CAD') {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format((cents || 0) / 100);
}

/** "12.5" -> 1250 ; returns null for invalid input */
export function parseMoney(text) {
  const s = String(text ?? '').trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [d, c = ''] = s.split('.');
  return Number(d) * 100 + Number(c.padEnd(2, '0'));
}

/** Banknotes/coins a cashier is likely to be handed for a total (quick-tender buttons). */
export function quickTenders(totalCents) {
  const out = new Set([totalCents]);
  for (const step of [500, 1000, 2000, 5000, 10000]) out.add(Math.ceil(totalCents / step) * step);
  return [...out].filter((v) => v >= totalCents).sort((a, b) => a - b).slice(0, 5);
}
