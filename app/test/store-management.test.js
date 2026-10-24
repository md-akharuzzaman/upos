'use strict';

// v2.2 store management: promotions, refund policy, Excel import, batch price/tax.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { priceBasket } = require('../src/domain/pricing');
const { bestPromotion, isRunning, promotionInput } = require('../src/domain/promotions');
const { planRefund } = require('../src/domain/refunds');
const { startServer, newStore } = require('./helpers');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const product = (sku, priceCents, extra = {}) => ({ id: sku.toLowerCase(), sku, name: sku, category: 'General', priceCents, taxRateBp: 1300, ...extra });
const promo = (extra) => ({ name: 'Promo', kind: 'percent', value: 1000, target: 'all', startsAt: iso(Date.now() - DAY), endsAt: null, active: true, ...extra });

describe('promotions (domain)', () => {
  test('percent and amount discounts per unit; amount never exceeds the price', () => {
    const tea = product('TEA', 250);
    assert.equal(bestPromotion(tea, [promo({ value: 1000 })]).unitDiscountCents, 25);
    assert.equal(bestPromotion(tea, [promo({ value: 3333 })]).unitDiscountCents, 83); // 83.325 -> 83
    assert.equal(bestPromotion(tea, [promo({ kind: 'amount', value: 999 })]).unitDiscountCents, 250);
  });

  test('targets: all, category (any case), listed SKUs; the best single promotion wins', () => {
    const bun = product('BUN', 300, { category: 'Bakery' });
    const list = [
      promo({ name: 'Bakery 10%', target: 'category', category: 'bakery', value: 1000 }),
      promo({ name: 'BUN 50c', target: 'skus', skus: ['BUN'], kind: 'amount', value: 50 }),
      promo({ name: 'Tea only', target: 'skus', skus: ['TEA'], value: 5000 }),
    ];
    const best = bestPromotion(bun, list);
    assert.equal(best.promotion.name, 'BUN 50c');
    assert.equal(best.unitDiscountCents, 50);
    assert.equal(bestPromotion(product('COF', 300), list), null);
  });

  test('only running promotions count (start, end, active)', () => {
    const now = Date.now();
    assert.equal(isRunning(promo({ startsAt: iso(now + DAY) }), now), false);
    assert.equal(isRunning(promo({ endsAt: iso(now - 1) }), now), false);
    assert.equal(isRunning(promo({ active: false }), now), false);
    assert.equal(isRunning(promo({ endsAt: iso(now + DAY) }), now), true);
  });

  test('tax is charged on the discounted price', () => {
    const b = priceBasket([{ product: product('TEA', 250), qty: 3 }], [promo({ value: 2000 })]);
    // 3 x 2.50 = 7.50, less 20 % (0.50 each) = 6.00, HST 13 % = 0.78
    assert.equal(b.discountCents, 150);
    assert.equal(b.subtotalCents, 600);
    assert.equal(b.taxCents, 78);
    assert.equal(b.totalCents, 678);
    assert.equal(b.lines[0].promotionName, 'Promo');
  });

  test('input validation', () => {
    assert.throws(() => promotionInput({ name: 'x', kind: 'percent', value: 10, target: 'all' }), /name/);
    assert.throws(() => promotionInput({ name: 'Sale', kind: 'percent', value: 20000, target: 'all' }), /basis points/);
    assert.throws(() => promotionInput({ name: 'Sale', kind: 'amount', value: 50, target: 'category' }), /category is required/);
    assert.throws(() => promotionInput({ name: 'Sale', kind: 'amount', value: 50, target: 'skus', skus: [] }), /skus/);
    assert.throws(
      () => promotionInput({ name: 'Sale', kind: 'amount', value: 50, target: 'all', startsAt: '2026-11-02T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' }),
      /after/,
    );
    const ok = promotionInput({ name: ' Fall sale ', kind: 'amount', value: 50, target: 'skus', skus: ['cof-001', 'COF-001'] });
    assert.deepEqual([ok.name, ok.skus, ok.endsAt], ['Fall sale', ['COF-001'], null]);
  });
});

describe('refund policy (domain)', () => {
  const sold = (createdAt, lines) => {
    const priced = priceBasket(lines.map(([p, qty]) => ({ product: p, qty })), [promo({ value: 2000, target: 'skus', skus: ['TEA'] })]);
    return { receiptNo: 1001, status: 'completed', createdAt: iso(createdAt), payment: { method: 'cash' }, refunds: [], ...priced };
  };
  const now = Date.now();
  const sale = sold(now - 2 * DAY, [
    [product('TEA', 250), 3],
    [product('SANDWICH', 600, { category: 'Food', refundable: false }), 1],
  ]);

  test('a discounted item refunds what the customer paid, not the list price', () => {
    const r = planRefund(sale, [{ lineNo: 1, qty: 1 }], { windowDays: 30, now });
    assert.equal(r.lines[0].lineSubtotalCents, 200); // 2.50 - 20 %
    assert.equal(r.lines[0].lineTaxCents, 26);
  });

  test('final-sale items are refused; a manager override allows them', () => {
    assert.throws(() => planRefund(sale, [{ lineNo: 2, qty: 1 }], { windowDays: 30, now }), { code: 'POLICY', message: /final sale/ });
    assert.equal(planRefund(sale, [{ lineNo: 2, qty: 1 }], { windowDays: 30, now, override: true }).totalCents, 678);
  });

  test('"refund the rest" skips final-sale items', () => {
    const r = planRefund(sale, undefined, { windowDays: 30, now });
    assert.deepEqual(r.lines.map((l) => l.lineNo), [1]);
    assert.equal(r.completesSale, false);
  });

  test('the refund window: day 30 is allowed, day 31 is refused unless overridden', () => {
    const at = (days) => sold(now - days * DAY + 60000, [[product('TEA', 250), 1]]);
    assert.ok(planRefund(at(30), [{ lineNo: 1, qty: 1 }], { windowDays: 30, now }));
    assert.throws(() => planRefund(at(31), [{ lineNo: 1, qty: 1 }], { windowDays: 30, now }), { code: 'POLICY', message: /30-day refund window/ });
    assert.ok(planRefund(at(31), [{ lineNo: 1, qty: 1 }], { windowDays: 30, now, override: true }));
  });

  test('sales made before v2.2 (no refundable flag) stay refundable', () => {
    const legacy = { ...sale, lines: sale.lines.map((l) => ({ ...l, refundable: null })) };
    assert.equal(planRefund(legacy, [{ lineNo: 2, qty: 1 }], { windowDays: 30, now }).lines.length, 1);
  });
});

describe('store management (API)', () => {
  let ctx;
  let mgr;
  let cashier;
  const call = (method, path, body, token = mgr.token) => ctx.call(method, path, { token, body });
  const products = async () => (await call('GET', '/api/products?all=1')).body;
  const bySku = async (sku) => (await products()).find((p) => p.sku === sku);

  before(async () => {
    ctx = await startServer();
    mgr = await newStore(ctx, 'mgmt-shop');
    await call('POST', '/api/users', { name: 'Cal', email: 'cal@mgmt-shop.test', password: 'Password123', role: 'cashier' });
    cashier = (await ctx.call('POST', '/api/auth/login', { body: { store: 'mgmt-shop', email: 'cal@mgmt-shop.test', password: 'Password123' } })).body;
  });
  after(() => ctx.server.close());

  test('Excel import: preview, row errors stop everything, then create + update by SKU', async () => {
    const bad = await call('POST', '/api/products/import', {
      rows: [
        { sku: 'COF-001', name: 'Coffee', category: 'Drinks', priceCents: 350, taxRateBp: 1300, stock: 10 },
        { sku: 'cof-001', name: 'Coffee again', priceCents: 1 },
        { sku: 'BAD SKU', name: 'x', priceCents: -5 },
      ],
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.errors.map((e) => e.row), [3, 4]);
    assert.equal((await products()).length, 0, 'nothing imported when a row is invalid');

    const rows = [
      { sku: 'COF-001', name: 'Coffee', category: 'Drinks', priceCents: 350, taxRateBp: 1300, stock: 10 },
      { sku: 'SAN-001', name: 'Sandwich', category: 'Food', priceCents: 600, taxRateBp: 1300, stock: 5 },
      { sku: 'MUG-001', name: 'Mug', category: 'Merch', priceCents: 1200, taxRateBp: 1300, stock: 3 },
    ];
    const dry = await call('POST', '/api/products/import', { rows, dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.created, 3);
    assert.equal((await products()).length, 0, 'dry run saves nothing');

    const done = await call('POST', '/api/products/import', { rows });
    assert.equal(done.body.created, 3);
    assert.equal((await bySku('SAN-001')).refundable, false, 'Food defaults to final sale');
    assert.equal((await bySku('MUG-001')).refundable, true);

    const again = await call('POST', '/api/products/import', {
      rows: [
        { sku: 'COF-001', priceCents: 375 },
        { sku: 'MUG-001', name: 'Mug', priceCents: 1200 },
        { sku: 'TEA-001', name: 'Tea', priceCents: 250, active: false },
      ],
    });
    assert.deepEqual([again.body.created, again.body.updated, again.body.unchanged], [1, 1, 1]);
    assert.equal((await bySku('COF-001')).priceCents, 375);
    assert.equal((await bySku('COF-001')).stock, 10, 'columns not in the file are kept');
    assert.equal((await bySku('TEA-001')).active, false);
    assert.equal((await call('POST', '/api/products/import', { rows: [{ sku: 'A', name: 'A', priceCents: 1 }] }, cashier.token)).status, 403);
  });

  test('batch price and tax changes: preview, category, selection, set, and guard rails', async () => {
    const preview = await call('POST', '/api/products/bulk-update', { category: 'drinks', price: { mode: 'percent', value: 1000 }, dryRun: true });
    assert.equal(preview.body.changes[0].after.priceCents, 413); // 3.75 + 10 % = 4.125 -> 4.13
    assert.equal((await bySku('COF-001')).priceCents, 375, 'preview saves nothing');

    await call('POST', '/api/products/bulk-update', { category: 'Drinks', price: { mode: 'percent', value: 1000 } });
    assert.equal((await bySku('COF-001')).priceCents, 413);

    const mug = await bySku('MUG-001');
    const san = await bySku('SAN-001');
    await call('POST', '/api/products/bulk-update', { productIds: [mug.id, san.id], price: { mode: 'amount', value: -100 }, taxRateBp: 500 });
    assert.deepEqual([(await bySku('MUG-001')).priceCents, (await bySku('MUG-001')).taxRateBp], [1100, 500]);
    assert.equal((await bySku('SAN-001')).priceCents, 500);

    await call('POST', '/api/products/bulk-update', { all: true, taxRateBp: 1300 });
    assert.ok((await products()).every((p) => p.taxRateBp === 1300));

    await call('POST', '/api/products/bulk-update', { productIds: [mug.id], price: { mode: 'set', value: 1500 } });
    assert.equal((await bySku('MUG-001')).priceCents, 1500);

    const neg = await call('POST', '/api/products/bulk-update', { productIds: [san.id], price: { mode: 'amount', value: -10000 } });
    assert.equal(neg.status, 400);
    assert.match(neg.body.error, /SAN-001/);
    assert.equal((await call('POST', '/api/products/bulk-update', { price: { mode: 'set', value: 1 } })).status, 400);
    assert.equal((await call('POST', '/api/products/bulk-update', { all: true, taxRateBp: 1300 }, cashier.token)).status, 403);
    assert.equal((await call('PATCH', `/api/products/${mug.id}`, { priceCents: 1450, refundable: false })).body.refundable, false);
    await call('PATCH', `/api/products/${mug.id}`, { refundable: true });
  });

  let promoId;
  test('promotions apply at the till, show on the receipt and in the report, and can be ended', async () => {
    assert.equal((await call('POST', '/api/promotions', { name: 'Coffee week', kind: 'percent', value: 2000, target: 'skus', skus: ['COF-001'] }, cashier.token)).status, 403);
    const p = await call('POST', '/api/promotions', { name: 'Coffee week', kind: 'percent', value: 2000, target: 'skus', skus: ['cof-001'] });
    assert.equal(p.status, 201);
    promoId = p.body.id;
    await call('POST', '/api/promotions', { name: 'Next month', kind: 'amount', value: 100, target: 'all', startsAt: iso(Date.now() + 30 * DAY) });
    const seen = (await call('GET', '/api/promotions', undefined, cashier.token)).body;
    assert.deepEqual(seen.map((x) => x.name), ['Coffee week'], 'cashiers see only running promotions');
    const all = (await call('GET', '/api/promotions')).body;
    assert.deepEqual(all.map((x) => [x.name, x.state]).sort(), [['Coffee week', 'running'], ['Next month', 'scheduled']]);

    const cof = await bySku('COF-001');
    const sale = await call('POST', '/api/sales', { items: [{ productId: cof.id, qty: 2 }], payment: { method: 'cash', tenderedCents: 2000 } }, cashier.token);
    // 2 x 4.13 = 8.26, less 20 % (0.83 each) = 6.60, HST 0.86 -> 7.46
    assert.equal(sale.body.sale.discountCents, 166);
    assert.equal(sale.body.sale.totalCents, 746);
    assert.equal(sale.body.receipt.lines[0].promotionName, 'Coffee week');
    assert.match(sale.body.receipt.policy, /30 days/);

    const rep = (await call('GET', `/api/reports/daily?date=${new Date().toISOString().slice(0, 10)}&tz=0`)).body;
    assert.equal(rep.discountCents, 166);

    assert.equal((await call('PATCH', `/api/promotions/${promoId}`, { value: 1 })).status, 400);
    assert.equal((await call('PATCH', '/api/promotions/not-a-guid', { active: false })).status, 404);
    assert.equal((await call('GET', '/api/sales/not-a-guid')).status, 404);
    await call('PATCH', `/api/promotions/${promoId}`, { active: false });
    const later = await call('POST', '/api/sales', { items: [{ productId: cof.id, qty: 1 }], payment: { method: 'card', reference: 'AUTH-1' } }, cashier.token);
    assert.equal(later.body.sale.discountCents, 0);
  });

  test('refund policy over the API: final sale, override with reason, store window', async () => {
    const san = await bySku('SAN-001');
    const mug = await bySku('MUG-001');
    const sale = (
      await call('POST', '/api/sales', { items: [{ productId: san.id, qty: 1 }, { productId: mug.id, qty: 1 }], payment: { method: 'cash', tenderedCents: 5000 } }, cashier.token)
    ).body.sale;
    assert.equal(sale.lines[0].refundable, false);

    const refused = await call('POST', `/api/sales/${sale.id}/refunds`, { items: [{ lineNo: 1, qty: 1 }] });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /final sale/);
    assert.equal((await call('POST', `/api/sales/${sale.id}/refunds`, { items: [{ lineNo: 1, qty: 1 }], override: true })).status, 400, 'override needs a reason');
    const ok = await call('POST', `/api/sales/${sale.id}/refunds`, { items: [{ lineNo: 1, qty: 1 }], override: true, reason: 'spoiled on delivery' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.refund.policyOverride, true);

    assert.equal((await call('PATCH', '/api/store/settings', { refundWindowDays: 400 })).status, 400);
    assert.equal((await call('PATCH', '/api/store/settings', { refundWindowDays: 0 }, cashier.token)).status, 403);
    const s = await call('PATCH', '/api/store/settings', { refundWindowDays: 0 });
    assert.equal(s.body.refundWindowDays, 0);
    const late = await call('POST', `/api/sales/${sale.id}/refund`);
    assert.equal(late.status, 409);
    assert.match(late.body.error, /refund window/);
    await call('PATCH', '/api/store/settings', { refundWindowDays: 30 });
    assert.equal((await call('POST', `/api/sales/${sale.id}/refund`)).status, 200);

    const rep = (await call('GET', `/api/reports/daily?date=${new Date().toISOString().slice(0, 10)}&tz=0`)).body;
    assert.equal(rep.overridesCount, 1);
    const me = (await call('GET', '/api/me')).body;
    assert.equal(me.store.refundWindowDays, 30);
  });
});
