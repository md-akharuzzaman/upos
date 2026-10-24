'use strict';

// Authoritative POS money maths. All amounts are integer cents; tax rates are
// basis points (1300 = 13 % HST). Tax is rounded half-up per line, which is
// what the React register shows as a preview (web/src/lib/money.js).

const { bestPromotion } = require('./promotions');

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
 * @param {Array<{product: {id, sku, name, category, priceCents, taxRateBp, refundable}, qty: number}>} items
 * @param {Array} promotions running promotions of the store (best one per line applies)
 * @param {Date|string} now
 */
function priceBasket(items, promotions = [], now = new Date()) {
  const lines = items.map(({ product, qty }, i) => {
    const best = bestPromotion(product, promotions, now);
    const discount = best ? best.unitDiscountCents * qty : 0;
    const subtotal = product.priceCents * qty - discount;
    const tax = roundHalfUp((subtotal * product.taxRateBp) / 10000);
    return {
      lineNo: i + 1,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      qty,
      unitPriceCents: product.priceCents,
      taxRateBp: product.taxRateBp,
      discountCents: discount,
      promotionName: best ? best.promotion.name : null,
      refundable: product.refundable !== false,
      lineSubtotalCents: subtotal,
      lineTaxCents: tax,
    };
  });
  const subtotalCents = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  const taxCents = lines.reduce((s, l) => s + l.lineTaxCents, 0);
  const discountCents = lines.reduce((s, l) => s + l.discountCents, 0);
  return { lines, subtotalCents, taxCents, discountCents, totalCents: subtotalCents + taxCents };
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

// Payments moved to ./payments (v2.4: debit, credit, e-Transfer, Stripe).
const { settlePayment } = require('./payments');

function validation(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function formatCents(cents, currency = 'CAD') {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
}

module.exports = { lineTotals, priceBasket, normaliseBasket, settlePayment, formatCents, roundHalfUp, MAX_QTY_PER_LINE };
