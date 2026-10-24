// Display-side copy of the API's pricing rules (app/src/domain/pricing.js).
// The server always recalculates; this is only the live preview in the register.

export function lineTotals(unitPriceCents, qty, taxRateBp) {
  const subtotal = unitPriceCents * qty;
  const raw = (subtotal * taxRateBp) / 10000;
  const tax = Math.sign(raw) * Math.round(Math.abs(raw));
  return { subtotal, tax, total: subtotal + tax };
}

// ---- promotions: same rules as app/src/domain/promotions.js -----------------
export function isRunning(p, now = new Date()) {
  const t = new Date(now).getTime();
  return p.active !== false && new Date(p.startsAt).getTime() <= t && (!p.endsAt || t < new Date(p.endsAt).getTime());
}

function appliesTo(p, product) {
  if (p.target === 'all') return true;
  if (p.target === 'category') {
    // a promotion on a category also covers products whose sub-category has that name
    const c = String(p.category || '').toLowerCase();
    return c === String(product.category || '').toLowerCase() || c === String(product.subcategory || '').toLowerCase();
  }
  return (p.skus || []).includes(product.sku);
}

/** Best running promotion for a product: { promotion, unitDiscountCents } or null. */
export function bestPromotion(product, promotions = [], now = new Date()) {
  let best = null;
  for (const p of promotions) {
    if (!isRunning(p, now) || !appliesTo(p, product)) continue;
    const raw = p.kind === 'percent' ? Math.round((product.priceCents * p.value) / 10000) : p.value;
    const d = Math.max(0, Math.min(product.priceCents, raw));
    if (d > 0 && (!best || d > best.unitDiscountCents)) best = { promotion: p, unitDiscountCents: d };
  }
  return best;
}

/** One register line: list price, promotion discount, then tax on the discounted amount. */
export function priceLine(product, qty, promotions = [], now = new Date()) {
  const best = bestPromotion(product, promotions, now);
  const discount = best ? best.unitDiscountCents * qty : 0;
  const subtotal = product.priceCents * qty - discount;
  const raw = (subtotal * product.taxRateBp) / 10000;
  const tax = Math.sign(raw) * Math.round(Math.abs(raw));
  return { list: product.priceCents * qty, discount, subtotal, tax, total: subtotal + tax, promotion: best?.promotion ?? null };
}

export function cartTotals(lines, promotions = [], now = new Date()) {
  let subtotal = 0;
  let tax = 0;
  let discount = 0;
  for (const l of lines) {
    const t = priceLine(l.product, l.qty, promotions, now);
    subtotal += t.subtotal;
    tax += t.tax;
    discount += t.discount;
  }
  return { subtotal, tax, discount, total: subtotal + tax, items: lines.reduce((n, l) => n + l.qty, 0) };
}

export function formatMoney(cents, currency = 'CAD') {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format((cents || 0) / 100);
}

/** "12.5" -> 1250 ; returns null for invalid input */
export function parseMoney(text) {
  const s = String(text ?? '')
    .trim()
    .replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [d, c = ''] = s.split('.');
  return Number(d) * 100 + Number(c.padEnd(2, '0'));
}

/** Banknotes/coins a cashier is likely to be handed for a total (quick-tender buttons). */
export function quickTenders(totalCents) {
  const out = new Set([totalCents]);
  for (const step of [500, 1000, 2000, 5000, 10000]) out.add(Math.ceil(totalCents / step) * step);
  return [...out]
    .filter((v) => v >= totalCents)
    .sort((a, b) => a - b)
    .slice(0, 5);
}

/**
 * Preview of an item refund, using the server's rule (app/src/domain/refunds.js):
 * tax rounded half-up per line, and the last units of a line return exactly the
 * tax still held for it. qty = { [lineNo]: number }.
 */
export function refundPreview(lines, qty) {
  let subtotal = 0;
  let tax = 0;
  let items = 0;
  for (const l of lines) {
    const q = qty[l.lineNo] || 0;
    if (q <= 0) continue;
    const left = l.qty - (l.refundedQty || 0);
    if (q === left) {
      subtotal += l.lineSubtotalCents - (l.refundedSubtotalCents || 0);
      tax += l.lineTaxCents - (l.refundedTaxCents || 0);
    } else {
      const s = Math.round((l.lineSubtotalCents * q) / l.qty); // price actually paid per unit
      const raw = (s * l.taxRateBp) / 10000;
      subtotal += s;
      tax += Math.sign(raw) * Math.round(Math.abs(raw));
    }
    items += q;
  }
  return { subtotal, tax, total: subtotal + tax, items };
}
