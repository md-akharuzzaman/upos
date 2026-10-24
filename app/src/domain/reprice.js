'use strict';

// Batch price / tax changes (v2.2, set-based in v2.3). The same arithmetic
// runs in JavaScript (memory adapter, previews) and in T-SQL (Azure adapter):
//   set      new = value
//   amount   new = old + value            (value in cents, may be negative)
//   percent  new = round(old * (10000 + value) / 10000)   (value in basis points)
// Prices are positive, so JavaScript's Math.round and T-SQL ROUND(x, 0) agree
// (both round .5 up), and old * (10000 + value) / 10000 is exact in both.

const MAX_PRICE = 10_000_000;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID' });
}

/** Validates { price?: { mode, value }, taxRateBp? } and returns the normalised change. */
function changeInput(b) {
  const out = {};
  if (b.price !== undefined) {
    const { mode, value } = b.price || {};
    if (!['set', 'percent', 'amount'].includes(mode)) throw invalid("price.mode must be 'set', 'percent' or 'amount'");
    if (!Number.isInteger(value)) throw invalid('price.value must be a whole number (cents, or basis points for percent)');
    if (mode === 'set' && (value < 0 || value > MAX_PRICE)) throw invalid(`price.value must be 0-${MAX_PRICE} cents`);
    if (mode === 'percent' && (value < -10000 || value > 100000)) throw invalid('price.value must be -10000..100000 basis points');
    if (mode === 'amount' && Math.abs(value) > MAX_PRICE) throw invalid('price.value is too large');
    out.price = { mode, value };
  }
  if (b.taxRateBp !== undefined) {
    if (!Number.isInteger(b.taxRateBp) || b.taxRateBp < 0 || b.taxRateBp > 5000) throw invalid('taxRateBp must be a whole number from 0 to 5000');
    out.taxRateBp = b.taxRateBp;
  }
  if (!out.price && out.taxRateBp === undefined) throw invalid('give a price change and/or taxRateBp');
  return out;
}

function newPrice(cents, price) {
  if (!price) return cents;
  if (price.mode === 'set') return price.value;
  if (price.mode === 'amount') return cents + price.value;
  return Math.round((cents * (10000 + price.value)) / 10000);
}

/** One product's before/after. */
function applyChange(p, change) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    before: { priceCents: p.priceCents, taxRateBp: p.taxRateBp },
    after: { priceCents: newPrice(p.priceCents, change.price), taxRateBp: change.taxRateBp ?? p.taxRateBp },
  };
}

const outOfRange = (c) => c.after.priceCents < 0 || c.after.priceCents > MAX_PRICE;

/** Does product p match { ids } | { category } | { all } ? category matches the category or sub-category, any case. */
function matches(p, where) {
  if (where.ids) return where.ids.includes(p.id);
  if (where.category) {
    const c = where.category.toLowerCase();
    return String(p.category || '').toLowerCase() === c || String(p.subcategory || '').toLowerCase() === c;
  }
  return where.all === true;
}

module.exports = { changeInput, newPrice, applyChange, outOfRange, matches, MAX_PRICE };
