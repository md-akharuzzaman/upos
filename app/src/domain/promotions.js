'use strict';

// Promotions (v2.2). A promotion takes a percentage or a fixed amount off the
// unit price of the products it targets (all products, one category, or a
// list of SKUs) between two dates. At the till the BEST single promotion for
// each line applies automatically; promotions never stack. Sales tax is then
// charged on the discounted price, as for any store discount in Ontario.
// The same rules run in the browser for the live preview (web/src/lib/money.js).

const KINDS = new Set(['percent', 'amount']);
const TARGETS = new Set(['all', 'category', 'skus']);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID' });
}

/** True when promotion p is running at `now` (ISO string or Date). */
function isRunning(p, now = new Date()) {
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

/** Discount per unit in cents (never more than the price). */
function unitDiscount(p, priceCents) {
  const raw = p.kind === 'percent' ? Math.round((priceCents * p.value) / 10000) : p.value;
  return Math.max(0, Math.min(priceCents, raw));
}

/** Best running promotion for a product: { promotion, unitDiscountCents } or null. */
function bestPromotion(product, promotions = [], now = new Date()) {
  let best = null;
  for (const p of promotions) {
    if (!isRunning(p, now) || !appliesTo(p, product)) continue;
    const d = unitDiscount(p, product.priceCents);
    if (d > 0 && (!best || d > best.unitDiscountCents)) best = { promotion: p, unitDiscountCents: d };
  }
  return best;
}

/** Validates a promotion request body and returns the stored shape. */
function promotionInput(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== 'string' || b.name.trim().length < 2 || b.name.trim().length > 120) throw invalid('name must be 2-120 characters');
    out.name = b.name.trim();
  }
  if (!partial || b.kind !== undefined) {
    if (!KINDS.has(b.kind)) throw invalid("kind must be 'percent' or 'amount'");
    out.kind = b.kind;
  }
  if (!partial || b.value !== undefined) {
    const kind = out.kind ?? b.kind;
    const max = kind === 'percent' ? 10000 : 1_000_000;
    if (!Number.isInteger(b.value) || b.value < 1 || b.value > max) {
      throw invalid(kind === 'percent' ? 'value must be basis points from 1 to 10000 (1000 = 10 %)' : 'value must be cents from 1 to 1000000');
    }
    out.value = b.value;
  }
  if (!partial || b.target !== undefined) {
    if (!TARGETS.has(b.target)) throw invalid("target must be 'all', 'category' or 'skus'");
    out.target = b.target;
    if (b.target === 'category') {
      if (typeof b.category !== 'string' || !b.category.trim()) throw invalid('category is required for a category promotion');
      out.category = b.category.trim().slice(0, 60);
    } else out.category = null;
    if (b.target === 'skus') {
      if (!Array.isArray(b.skus) || b.skus.length === 0 || b.skus.length > 100) throw invalid('skus must list 1-100 product SKUs');
      out.skus = [...new Set(b.skus.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    } else out.skus = [];
  }
  const date = (v, name) => {
    const d = new Date(v);
    if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw invalid(`${name} must be an ISO date-time`);
    return d.toISOString();
  };
  if (!partial || b.startsAt !== undefined) out.startsAt = b.startsAt === undefined ? new Date().toISOString() : date(b.startsAt, 'startsAt');
  if (b.endsAt !== undefined) out.endsAt = b.endsAt === null ? null : date(b.endsAt, 'endsAt');
  else if (!partial) out.endsAt = null;
  if (out.startsAt && out.endsAt && out.endsAt <= out.startsAt) throw invalid('endsAt must be after startsAt');
  if (partial && b.active !== undefined) {
    if (typeof b.active !== 'boolean') throw invalid('active must be true or false');
    out.active = b.active;
  }
  return out;
}

module.exports = { isRunning, appliesTo, unitDiscount, bestPromotion, promotionInput };
