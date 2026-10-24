'use strict';

// Item-level refunds (v2.1). A sale can be refunded in several steps; each
// refund names sale lines and quantities. Rules:
//   - a line can never be refunded beyond the quantity sold;
//   - tax is rounded half-up per refund line, and the refund that returns the
//     LAST units of a line returns exactly the tax still held for that line,
//     so all refunds of a sale always add up to its original total;
//   - money goes back the way it came (cash -> cash, card -> card reversal);
//   - when every unit is refunded the sale's status becomes 'refunded'.
// Sales refunded as a whole by v2.0 have status 'refunded' and no refund rows;
// they are treated as fully refunded.

const { roundHalfUp, MAX_QTY_PER_LINE } = require('./pricing');

function err(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

/** Adds refundedQty / refundedSubtotalCents / refundedTaxCents per line, refundNo per refund, and sale totals. */
function withRefundTotals(sale) {
  const refunds = (sale.refunds || [])
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({ ...r, refundNo: `R-${sale.receiptNo}-${r.seq}` }));
  const legacy = sale.status === 'refunded' && refunds.length === 0;
  const per = new Map();
  for (const r of refunds) {
    for (const l of r.lines) {
      const x = per.get(l.lineNo) || { qty: 0, sub: 0, tax: 0 };
      x.qty += l.qty;
      x.sub += l.lineSubtotalCents;
      x.tax += l.lineTaxCents;
      per.set(l.lineNo, x);
    }
  }
  const lines = sale.lines.map((l) => {
    const x = legacy ? { qty: l.qty, sub: l.lineSubtotalCents, tax: l.lineTaxCents } : per.get(l.lineNo) || { qty: 0, sub: 0, tax: 0 };
    return { ...l, refundedQty: x.qty, refundedSubtotalCents: x.sub, refundedTaxCents: x.tax };
  });
  const refundedCents = legacy ? sale.totalCents : refunds.reduce((t, r) => t + r.totalCents, 0);
  const refundState = refundedCents === 0 && !legacy ? 'none' : sale.status === 'refunded' ? 'full' : 'partial';
  return { ...sale, lines, refunds, refundedCents, refundState };
}

/** Validates [{lineNo, qty}] and merges repeated lines. */
function normaliseRefundItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw err('items must be a non-empty array of { lineNo, qty }', 'INVALID', 400);
  const merged = new Map();
  for (const it of raw) {
    if (!it || !Number.isInteger(it.lineNo) || it.lineNo < 1) throw err('each item needs a lineNo from the receipt', 'INVALID', 400);
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY_PER_LINE) throw err(`qty must be an integer from 1 to ${MAX_QTY_PER_LINE}`, 'INVALID', 400);
    merged.set(it.lineNo, (merged.get(it.lineNo) || 0) + it.qty);
  }
  return [...merged].map(([lineNo, qty]) => ({ lineNo, qty }));
}

/**
 * Plans a refund against a sale (raw or already decorated).
 * @param sale the sale with its lines and earlier refunds
 * @param requested [{lineNo, qty}] or undefined for "everything not yet refunded"
 * @returns {{lines, subtotalCents, taxCents, totalCents, completesSale}}
 */
function planRefund(sale, requested) {
  const s = sale.refundState ? sale : withRefundTotals(sale);
  const remaining = new Map(
    s.lines.map((l) => [
      l.lineNo,
      { line: l, qty: l.qty - l.refundedQty, sub: l.lineSubtotalCents - l.refundedSubtotalCents, tax: l.lineTaxCents - l.refundedTaxCents },
    ]),
  );
  const wanted =
    requested === undefined
      ? [...remaining.values()].filter((r) => r.qty > 0).map((r) => ({ lineNo: r.line.lineNo, qty: r.qty }))
      : normaliseRefundItems(requested);
  if (wanted.length === 0) throw err('sale is already refunded', 'NOTHING_TO_REFUND', 409);

  const lines = wanted.map(({ lineNo, qty }) => {
    const r = remaining.get(lineNo);
    if (!r) throw err(`line ${lineNo} is not on this sale`, 'INVALID', 400);
    if (r.qty === 0) throw err(`${r.line.name} is already fully refunded`, 'OVER_REFUND', 409);
    if (qty > r.qty) throw err(`only ${r.qty} × ${r.line.name} can still be refunded`, 'OVER_REFUND', 409);
    const last = qty === r.qty;
    const subtotal = last ? r.sub : r.line.unitPriceCents * qty;
    const tax = last ? r.tax : roundHalfUp((subtotal * r.line.taxRateBp) / 10000);
    return {
      lineNo,
      productId: r.line.productId,
      sku: r.line.sku,
      name: r.line.name,
      qty,
      lineSubtotalCents: subtotal,
      lineTaxCents: tax,
    };
  });
  const byLine = new Map(lines.map((l) => [l.lineNo, l.qty]));
  const completesSale = [...remaining.values()].every((r) => r.qty === (byLine.get(r.line.lineNo) || 0));
  const subtotalCents = lines.reduce((t, l) => t + l.lineSubtotalCents, 0);
  const taxCents = lines.reduce((t, l) => t + l.lineTaxCents, 0);
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, completesSale };
}

module.exports = { withRefundTotals, planRefund, normaliseRefundItems };
