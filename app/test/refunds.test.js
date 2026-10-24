'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { priceBasket } = require('../src/domain/pricing');
const { planRefund, withRefundTotals } = require('../src/domain/refunds');
const { startServer, newStore } = require('./helpers');

// A sale built with the real pricing rules: 3 x $1.05 (13 %) + 2 x $2.95 (0 %).
function saleOf(items, extra = {}) {
  const p = (id, priceCents, taxRateBp) => ({ id, sku: id.toUpperCase(), name: id, priceCents, taxRateBp });
  const priced = priceBasket(items.map(([id, price, tax, qty]) => ({ product: p(id, price, tax), qty })));
  return { receiptNo: 1001, status: 'completed', payment: { method: 'cash' }, refunds: [], ...priced, ...extra };
}
const apply = (sale, plan, seq = sale.refunds.length + 1) => ({
  ...sale,
  status: plan.completesSale ? 'refunded' : sale.status,
  refunds: [...sale.refunds, { id: `r${seq}`, seq, ...plan }],
});

describe('refund planning (domain)', () => {
  const sale = saleOf([
    ['tea', 105, 1300, 3],
    ['bun', 295, 0, 2],
  ]);

  test('one unit: priced per unit with tax rounded half-up', () => {
    const r = planRefund(sale, [{ lineNo: 1, qty: 1 }]);
    assert.deepEqual(
      r.lines.map((l) => [l.lineNo, l.qty, l.lineSubtotalCents, l.lineTaxCents]),
      [[1, 1, 105, 14]], // 13.65 -> 14
    );
    assert.equal(r.totalCents, 119);
    assert.equal(r.completesSale, false);
  });

  test('the last units of a line return exactly the tax still held, so refunds add up to the sale', () => {
    assert.equal(sale.lines[0].lineTaxCents, 41); // 315 * 13 % = 40.95 -> 41
    let s = sale;
    const totals = [];
    for (const qty of [1, 1, 1]) {
      const plan = planRefund(s, [{ lineNo: 1, qty }]);
      totals.push(plan.lines[0].lineTaxCents);
      s = apply(s, plan);
    }
    assert.deepEqual(totals, [14, 14, 13]); // 14 + 14 + 13 = 41
    const last = planRefund(s, [{ lineNo: 2, qty: 2 }]);
    assert.equal(last.completesSale, true);
    s = apply(s, last);
    assert.equal(withRefundTotals(s).refundedCents, sale.totalCents);
    assert.equal(withRefundTotals(s).refundState, 'full');
  });

  test('cannot refund more than was sold, lines that are not on the sale, or nothing at all', () => {
    assert.throws(() => planRefund(sale, [{ lineNo: 2, qty: 3 }]), { code: 'OVER_REFUND', status: 409 });
    assert.throws(() => planRefund(sale, [{ lineNo: 9, qty: 1 }]), { status: 400 });
    assert.throws(() => planRefund(sale, [{ lineNo: 1, qty: 0 }]), { status: 400 });
    assert.throws(() => planRefund(sale, []), { status: 400 });
    // duplicate lines are merged before the check
    assert.throws(() => planRefund(sale, [{ lineNo: 2, qty: 1 }, { lineNo: 2, qty: 2 }]), { code: 'OVER_REFUND' });
  });

  test('"refund everything" takes only what is left; a v2.0 whole-sale refund counts as everything', () => {
    const partly = apply(sale, planRefund(sale, [{ lineNo: 2, qty: 1 }]));
    const rest = planRefund(partly, undefined);
    assert.deepEqual(rest.lines.map((l) => [l.lineNo, l.qty]), [[1, 3], [2, 1]]);
    assert.equal(rest.completesSale, true);

    const legacy = { ...sale, status: 'refunded' };
    assert.equal(withRefundTotals(legacy).refundedCents, sale.totalCents);
    assert.deepEqual(withRefundTotals(legacy).lines.map((l) => l.refundedQty), [3, 2]);
    assert.throws(() => planRefund(legacy, undefined), { code: 'NOTHING_TO_REFUND' });
  });
});

describe('item refunds (API)', () => {
  let ctx;
  let mgr;
  let cashier;
  let coffee;
  let muffin;
  let sale;
  const today = () => new Date().toISOString().slice(0, 10);
  const stock = async (sku) => (await ctx.call('GET', '/api/products', { token: mgr.token })).body.find((p) => p.sku === sku).stock;

  before(async () => {
    ctx = await startServer();
    mgr = await newStore(ctx, 'refund-shop');
    const add = async (body) => (await ctx.call('POST', '/api/products', { token: mgr.token, body })).body;
    coffee = await add({ sku: 'COF-001', name: 'Coffee', priceCents: 245, taxRateBp: 1300, stock: 10 });
    muffin = await add({ sku: 'BAK-002', name: 'Muffin', priceCents: 295, taxRateBp: 0, stock: 5 });
    await ctx.call('POST', '/api/users', { token: mgr.token, body: { name: 'Cal', email: 'cal@refund-shop.test', password: 'Password123', role: 'cashier' } });
    cashier = (await ctx.call('POST', '/api/auth/login', { body: { store: 'refund-shop', email: 'cal@refund-shop.test', password: 'Password123' } })).body;
    const r = await ctx.call('POST', '/api/sales', {
      token: cashier.token,
      body: { items: [{ productId: coffee.id, qty: 2 }, { productId: muffin.id, qty: 1 }], payment: { method: 'cash', tenderedCents: 1000 } },
    });
    sale = r.body.sale;
    assert.equal(sale.totalCents, 849);
  });
  after(() => ctx.server.close());

  test('a cashier cannot refund; items are required', async () => {
    assert.equal((await ctx.call('POST', `/api/sales/${sale.id}/refunds`, { token: cashier.token, body: { items: [{ lineNo: 1, qty: 1 }] } })).status, 403);
    assert.equal((await ctx.call('POST', `/api/sales/${sale.id}/refunds`, { token: mgr.token, body: {} })).status, 400);
    assert.equal((await ctx.call('POST', '/api/sales/00000000-0000-0000-0000-000000000000/refunds', { token: mgr.token, body: { items: [{ lineNo: 1, qty: 1 }] } })).status, 404);
  });

  test('refund one coffee: money, stock, status, refund number and refund receipt', async () => {
    const r = await ctx.call('POST', `/api/sales/${sale.id}/refunds`, {
      token: mgr.token,
      body: { items: [{ lineNo: 1, qty: 1 }], reason: 'spilled' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.refund.refundNo, 'R-1001-1');
    assert.equal(r.body.refund.totalCents, 245 + 32); // 31.85 -> 32
    assert.equal(r.body.refund.method, 'cash');
    assert.equal(r.body.refund.reason, 'spilled');
    assert.equal(r.body.sale.status, 'completed');
    assert.equal(r.body.sale.refundState, 'partial');
    assert.deepEqual(r.body.sale.lines.map((l) => l.refundedQty), [1, 0]);
    assert.equal(await stock('COF-001'), 9);
    assert.ok(ctx.blobs.blobs.has(sale.receiptBlob.replace(/\.json$/, '-R1.json')));

    const rc = await ctx.call('GET', `/api/sales/${sale.id}/receipt`, { token: cashier.token });
    assert.equal(rc.body.source, 'blob');
    assert.equal(rc.body.refundedCents, 277);
    assert.equal(rc.body.refunds[0].refundNo, 'R-1001-1');
  });

  test('over-refunding is refused and changes nothing', async () => {
    const r = await ctx.call('POST', `/api/sales/${sale.id}/refunds`, { token: mgr.token, body: { items: [{ lineNo: 1, qty: 2 }] } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /only 1 × Coffee/);
    assert.equal(await stock('COF-001'), 9);
  });

  test('the report shows gross, refunds and net for the day', async () => {
    const rep = (await ctx.call('GET', `/api/reports/daily?date=${today()}&tz=0`, { token: mgr.token })).body;
    assert.equal(rep.salesCount, 1);
    assert.equal(rep.grossCents, 849);
    assert.equal(rep.refundsCount, 1);
    assert.equal(rep.refundedCents, 277);
    assert.equal(rep.netSalesCents, 572);
    assert.equal(rep.byPayment.cash.totalCents, 572);
    assert.deepEqual(rep.topProducts.map((p) => [p.sku, p.qty]), [['BAK-002', 1], ['COF-001', 1]]); // equal qty: higher revenue first
  });

  test('"Refund sale" then refunds only what is left, and the refunds add up to the sale', async () => {
    const r = await ctx.call('POST', `/api/sales/${sale.id}/refund`, { token: mgr.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'refunded');
    assert.equal(r.body.refunds.length, 2);
    assert.equal(r.body.refunds.reduce((t, x) => t + x.totalCents, 0), 849);
    assert.equal(await stock('COF-001'), 10);
    assert.equal(await stock('BAK-002'), 5);
    assert.equal((await ctx.call('POST', `/api/sales/${sale.id}/refund`, { token: mgr.token })).status, 409);
    const rep = (await ctx.call('GET', `/api/reports/daily?date=${today()}&tz=0`, { token: mgr.token })).body;
    assert.equal(rep.netSalesCents, 0);
    assert.equal(rep.taxCents, 0);
    assert.equal(rep.topProducts.length, 0);
  });
});
