'use strict';

// Authoritative POS money maths. All amounts are integer cents; tax rates are
// basis points (1300 = 13 % HST). Tax is rounded half-up per line, which is
// what the React register shows as a preview (web/src/lib/money.js).

const MAX_QTY_PER_LINE = 999;
const MAX_LINES = 100;

function roundHalfUp(n) {
  return Math.sign(n) * Math.round(Math.abs(n));
}

function lineTotals(unitPriceCents, qty, taxRateBp) {
  const subtotal = unitPriceCents * qty;
  const tax = roundHalfUp((subtotal * taxRateBp) / 10000);
  return { subtotal, tax, total: subtotal + tax };
}

/**
 * Price a basket.
 * @param {Array<{product: {id, sku, name, priceCents, taxRateBp}, qty: number}>} items
 */
function priceBasket(items) {
  const lines = items.map(({ product, qty }, i) => {
    const t = lineTotals(product.priceCents, qty, product.taxRateBp);
    return {
      lineNo: i + 1,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      qty,
      unitPriceCents: product.priceCents,
      taxRateBp: product.taxRateBp,
      lineSubtotalCents: t.subtotal,
      lineTaxCents: t.tax,
    };
  });
  const subtotalCents = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  const taxCents = lines.reduce((s, l) => s + l.lineTaxCents, 0);
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** Validates the raw request basket shape; merges duplicate product ids. */
function normaliseBasket(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw validation('items must be a non-empty array');
  const merged = new Map();
  for (const it of raw) {
    if (!it || typeof it.productId !== 'string') throw validation('each item needs a productId');
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY_PER_LINE) {
      throw validation(`qty must be an integer from 1 to ${MAX_QTY_PER_LINE}`);
    }
    merged.set(it.productId, (merged.get(it.productId) || 0) + it.qty);
  }
  if (merged.size > MAX_LINES) throw validation(`at most ${MAX_LINES} different products per sale`);
  for (const q of merged.values()) if (q > MAX_QTY_PER_LINE) throw validation(`qty must be at most ${MAX_QTY_PER_LINE}`);
  return [...merged].map(([productId, qty]) => ({ productId, qty }));
}

/** Validates payment against the total and returns the stored payment fields. */
function settlePayment(payment, totalCents) {
  if (!payment || !['cash', 'card'].includes(payment.method)) throw validation("payment.method must be 'cash' or 'card'");
  if (payment.method === 'cash') {
    const t = payment.tenderedCents;
    if (!Number.isInteger(t) || t < totalCents) throw validation('cash tendered must be an integer number of cents >= total');
    return { method: 'cash', tenderedCents: t, changeCents: t - totalCents, cardReference: null };
  }
  // Card is taken on an external terminal; the POS only records its approval
  // reference. No card number ever reaches eURC (keeps the app out of PCI scope).
  const ref = String(payment.reference || '').trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(ref)) throw validation('card payments need the terminal approval reference (4-40 letters/digits)');
  return { method: 'card', tenderedCents: null, changeCents: null, cardReference: ref };
}

function validation(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function formatCents(cents, currency = 'CAD') {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
}

module.exports = { lineTotals, priceBasket, normaliseBasket, settlePayment, formatCents, roundHalfUp, MAX_QTY_PER_LINE };
