'use strict';

// v2.4: payment methods (debit, credit, Interac e-Transfer, Stripe - recorded,
// never charged by the POS) and the GST/HST report.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { settlePayment, legacyMethod, accepts, refundInstruction } = require('../src/domain/payments');
const { periodWindow, zonedMidnight, rateLabel, buildTaxReport } = require('../src/domain/taxreport');
const { can } = require('../src/domain/permissions');
const { MIGRATIONS, validateMigrations } = require('../src/migrations');
const { storeToday } = require('../src/domain/business');
const { startServer, newStore } = require('./helpers');

describe('payments (domain)', () => {
  test('each method records what proves the payment, never card data', () => {
    assert.deepEqual(settlePayment({ method: 'debit', reference: 'A1B2C3' }, 500), {
      method: 'debit',
      tenderedCents: null,
      changeCents: null,
      reference: 'A1B2C3',
      cardReference: 'A1B2C3',
      brand: 'interac',
    });
    assert.equal(settlePayment({ method: 'credit', reference: 'AUTH-1', brand: 'VISA' }, 500).brand, 'visa');
    assert.equal(settlePayment({ method: 'credit', reference: 'AUTH-1' }, 500).brand, null);
    assert.throws(() => settlePayment({ method: 'credit', reference: 'AUTH-1', brand: 'diners-club' }, 500), /brand must be/);
    assert.throws(() => settlePayment({ method: 'credit', reference: '4111 1111 1111 1111' }, 500), /approval reference/);
    assert.equal(settlePayment({ method: 'etransfer', reference: 'CA1MRtX9cXyz' }, 500).reference, 'CA1MRtX9cXyz');
    assert.throws(() => settlePayment({ method: 'etransfer', reference: 'abc' }, 500), /e-Transfer reference/);
    assert.equal(settlePayment({ method: 'stripe', reference: 'pi_3Q0abcDEF123' }, 500).reference, 'pi_3Q0abcDEF123');
    assert.throws(() => settlePayment({ method: 'stripe', reference: 'cus_123456789' }, 500), /Stripe payment id/);
    assert.throws(() => settlePayment({ method: 'stripe', reference: `pi_${'x'.repeat(40)}` }, 500), /Stripe payment id/, 'fits the 40-char column');
    assert.throws(() => settlePayment({ method: 'paypal' }, 500), /payment.method must be one of/);
  });

  test('only the methods the store accepts (business profile)', () => {
    const enabled = ['cash', 'debit'];
    assert.ok(accepts(enabled, 'cash') && accepts(enabled, 'debit') && accepts(enabled, 'card'));
    assert.ok(!accepts(enabled, 'credit') && !accepts(enabled, 'etransfer') && !accepts(['cash'], 'card'));
    assert.ok(accepts(undefined, 'stripe'), 'no profile: anything');
    assert.throws(() => settlePayment({ method: 'etransfer', reference: 'CA1MRtX9cXyz' }, 500, enabled), /not accepted by this store/);
    assert.throws(() => settlePayment({ method: 'cash', tenderedCents: 500 }, 500, ['debit']), /Cash is not accepted/);
  });

  test('older versions see cash or card; refunds go back the way the sale was paid', () => {
    assert.deepEqual(['cash', 'debit', 'credit', 'card', 'etransfer', 'stripe'].map(legacyMethod), ['cash', 'card', 'card', 'card', 'card', 'card']);
    assert.match(refundInstruction({ method: 'cash' }), /drawer/);
    assert.match(refundInstruction({ method: 'debit', reference: 'A1' }), /card terminal.*A1/);
    assert.match(refundInstruction({ method: 'etransfer', reference: 'CA1' }), /e-Transfer.*CA1/);
    assert.match(refundInstruction({ method: 'stripe', reference: 'pi_1' }), /Stripe dashboard.*pi_1/);
  });

  test('migration 7 is expand-only and keeps payment_method compatible', () => {
    assert.ok(validateMigrations());
    const m7 = MIGRATIONS.find((m) => m.version === 7);
    assert.match(m7.sql, /ADD payment_type/);
    assert.doesNotMatch(m7.sql, /ck_sales_payment\b/, 'the old CHECK (cash, card) stays as it is');
  });
});

describe('GST/HST report (domain)', () => {
  test('periods are calendar days in the store time zone, across daylight saving', () => {
    assert.equal(new Date(zonedMidnight('2026-01-15', 'America/Toronto')).toISOString(), '2026-01-15T05:00:00.000Z'); // EST
    assert.equal(new Date(zonedMidnight('2026-07-15', 'America/Toronto')).toISOString(), '2026-07-15T04:00:00.000Z'); // EDT
    assert.equal(new Date(zonedMidnight('2026-03-08', 'America/Toronto')).toISOString(), '2026-03-08T05:00:00.000Z'); // DST starts at 02:00
    assert.equal(new Date(zonedMidnight('2026-03-09', 'America/Toronto')).toISOString(), '2026-03-09T04:00:00.000Z');
    assert.equal(new Date(zonedMidnight('2026-07-01', 'America/Vancouver')).toISOString(), '2026-07-01T07:00:00.000Z');
    const q = periodWindow('2026-07-01', '2026-09-30', 'America/Toronto');
    assert.deepEqual(q, { from: '2026-07-01T04:00:00.000Z', to: '2026-10-01T04:00:00.000Z', days: 92 });
    const winter = periodWindow('2026-10-01', '2026-12-31', 'America/Toronto');
    assert.equal(winter.to, '2027-01-01T05:00:00.000Z', 'quarter ends after DST');
    assert.throws(() => periodWindow('2026-02-30', '2026-03-01'), /dates/);
    assert.throws(() => periodWindow('2026-03-02', '2026-03-01'), /not be after/);
    assert.throws(() => periodWindow('2025-01-01', '2026-03-01'), /at most 366 days/);
    assert.equal(periodWindow('2028-01-01', '2028-12-31').days, 366, 'a leap year fits');
  });

  test('rates, refunds and payments add up to the return lines', () => {
    assert.equal(rateLabel(1300), 'HST 13 %');
    assert.equal(rateLabel(500), 'GST 5 %');
    assert.equal(rateLabel(0), 'Zero-rated / exempt (0 %)');
    assert.equal(rateLabel(1200), 'Tax 12 %'); // e.g. BC: GST 5 % + PST 7 % on one product
    const r = buildTaxReport(
      {
        salesByRate: [
          { rateBp: 1300, netCents: '100000', taxCents: '13000', discountCents: '500' }, // SQL BIGINT sums are strings
          { rateBp: 0, netCents: 20000, taxCents: 0, discountCents: 0 },
        ],
        refundsByRate: [{ rateBp: 1300, netCents: 10000, taxCents: 1300 }],
        payments: [
          { method: 'stripe', salesCount: 1, salesCents: 5000, refundsCount: 0, refundCents: 0 },
          { method: 'cash', salesCount: 3, salesCents: 128000, refundsCount: 1, refundCents: 11300 },
        ],
      },
      { from: '2026-07-01', to: '2026-09-30', timeZone: 'America/Toronto', store: { name: 'Shop', profile: { gstHstNumber: '123456789RT0001' } } },
    );
    assert.deepEqual(
      r.byRate.map((x) => [x.rateBp, x.netCents, x.taxCents]),
      [
        [0, 20000, 0],
        [1300, 90000, 11700],
      ],
    );
    assert.equal(r.totals.line101Cents, 110000);
    assert.equal(r.totals.line103Cents, 11700);
    assert.equal(r.totals.zeroRatedCents, 20000);
    assert.equal(r.totals.taxableCents, 90000);
    assert.equal(r.sales.discountCents, 500);
    assert.deepEqual(
      r.payments.map((p) => [p.method, p.netCents]),
      [
        ['cash', 116700],
        ['stripe', 5000],
      ],
    );
    assert.equal(r.business.gstHstNumber, '123456789RT0001');
    assert.equal(r.currency, 'CAD');
  });

  test('only Admins and Managers see the tax report', () => {
    assert.ok(can('admin', 'reports.tax') && can('manager', 'reports.tax'));
    assert.ok(!can('sales', 'reports.tax') && !can('cashier', 'reports.tax') && !can('support', 'reports.tax'));
  });
});

describe('GST/HST report (adapter sums)', () => {
  test('a v2.0 whole-sale refund (no refund rows) counts on its refund date', async () => {
    const { createMemoryDb } = require('../src/adapters/memory');
    const db = createMemoryDb();
    const store = { id: 's1', slug: 'old-shop', name: 'Old Shop' };
    await db.createStore({ store, manager: { id: 'u1', email: 'm@old.test', name: 'M', role: 'manager', passwordHash: 'x' } });
    await db.createProduct('s1', { id: 'p1', sku: 'A', name: 'A', category: 'General', priceCents: 1000, taxRateBp: 1300, stock: 10 });
    const line = { lineNo: 1, productId: 'p1', sku: 'A', name: 'A', qty: 1, unitPriceCents: 1000, taxRateBp: 1300, lineSubtotalCents: 1000, lineTaxCents: 130 };
    await db.recordSale('s1', { id: 'x1', cashierId: 'u1', cashierName: 'M', subtotalCents: 1000, taxCents: 130, totalCents: 1130, payment: { method: 'card' }, lines: [line], receiptBlob: 'r' });
    Object.assign(db.sales.get('x1'), { createdAt: '2026-06-30T15:00:00.000Z', status: 'refunded', refundedAt: '2026-07-02T15:00:00.000Z' });
    const raw = await db.taxReport('s1', { from: '2026-07-01T04:00:00.000Z', to: '2026-10-01T04:00:00.000Z' });
    const r = buildTaxReport(raw, { from: '2026-07-01', to: '2026-09-30', timeZone: 'America/Toronto', store });
    assert.equal(r.sales.count, 0, 'sold in June: not in Q3');
    assert.deepEqual([r.refunds.count, r.refunds.totalCents, r.totals.line101Cents, r.totals.line103Cents], [1, 1130, -1000, -130]);
    assert.equal(r.payments[0].method, 'card');
  });
});

describe('v2.4 API', () => {
  let ctx;
  let admin;
  let cashier;
  let products;
  const call = (method, path, body, token = admin.token) => ctx.call(method, path, { token, body });

  before(async () => {
    ctx = await startServer();
    admin = await newStore(ctx, 'pay-mart');
    await call('POST', '/api/users', { name: 'Cam Cashier', email: 'cam@pay-mart.test', password: 'Password123', role: 'cashier' });
    cashier = (await ctx.call('POST', '/api/auth/login', { body: { store: 'pay-mart', email: 'cam@pay-mart.test', password: 'Password123' } })).body;
    products = {};
    for (const [sku, priceCents, taxRateBp] of [
      ['HST-1', 1000, 1300],
      ['ZERO-1', 400, 0],
      ['GST-1', 2000, 500],
    ]) {
      products[sku] = (await call('POST', '/api/products', { sku, name: sku, priceCents, taxRateBp, stock: 100 })).body;
    }
  });
  after(() => ctx.server.close());

  const sell = (items, payment, token = cashier.token) =>
    call('POST', '/api/sales', { items: items.map(([sku, qty]) => ({ productId: products[sku].id, qty })), payment }, token);

  test('debit and credit by default; e-Transfer and Stripe once the Admin turns them on', async () => {
    const d = await sell([['HST-1', 1]], { method: 'debit', reference: 'DB-0001' });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.deepEqual(d.body.receipt.payment, {
      method: 'debit',
      tenderedCents: null,
      changeCents: null,
      reference: 'DB-0001',
      cardReference: 'DB-0001',
      brand: 'interac',
    });
    assert.equal((await sell([['HST-1', 1]], { method: 'credit', reference: 'CR-0001', brand: 'mastercard' })).body.sale.payment.brand, 'mastercard');
    const refused = await sell([['HST-1', 1]], { method: 'etransfer', reference: 'CA1MRtX9cXyz' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not accepted by this store/);
    const p = await call('PUT', '/api/store/profile', {
      paymentMethods: ['cash', 'debit', 'credit', 'etransfer', 'stripe'],
      etransferEmail: 'pay@pay-mart.test',
      gstHstNumber: '123456789RT0001',
    });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    // the cashier's session is older than the change: the server reads the store each time
    assert.equal((await sell([['GST-1', 1]], { method: 'etransfer', reference: 'CA1MRtX9cXyz' })).status, 201);
    assert.equal((await sell([['ZERO-1', 2]], { method: 'stripe', reference: 'pi_3Q0abcDEF123' })).status, 201);
    assert.equal((await sell([['HST-1', 1]], { method: 'stripe', reference: 'not-a-stripe-id' })).status, 400);
    assert.equal((await sell([['HST-1', 1]], { method: 'card', reference: 'AUTH-1' })).status, 201, 'v2.0-v2.3 clients still work');
  });

  test('daily report lists every method used; refunds keep the method', async () => {
    const s = await sell([['HST-1', 2]], { method: 'cash', tenderedCents: 5000 });
    const etr = (await call('GET', '/api/sales?limit=50')).body.find((x) => x.payment.method === 'etransfer');
    const r = await call('POST', `/api/sales/${etr.id}/refunds`, { items: [{ lineNo: 1, qty: 1 }], reason: 'changed mind' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.refund.method, 'etransfer');
    const rep = (await call('GET', `/api/reports/daily?date=${new Date().toISOString().slice(0, 10)}&tz=0`)).body;
    for (const m of ['cash', 'card', 'debit', 'credit', 'etransfer', 'stripe']) assert.ok(rep.byPayment[m], m);
    assert.equal(rep.byPayment.debit.count, 1);
    assert.equal(rep.byPayment.etransfer.totalCents, 0, 'refunded in full');
    assert.ok(s.body.sale.id);
  });

  test('GST/HST report: by rate, refunds deducted, payments, period and permissions', async () => {
    const today = storeToday({ profile: { timeZone: 'America/Toronto' } });
    const r = await call('GET', `/api/reports/tax?from=${today}&to=${today}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = r.body;
    // sold: HST-1 x(1 debit + 1 credit + 1 card + 2 cash) = 5000 net / 650 tax; GST-1 2000 / 100; ZERO-1 800 / 0
    // refunded: the e-Transfer GST-1 sale (2000 / 100)
    const rate = (bp) => t.byRate.find((x) => x.rateBp === bp);
    assert.deepEqual([rate(1300).salesNetCents, rate(1300).salesTaxCents], [5000, 650]);
    assert.deepEqual([rate(500).salesNetCents, rate(500).refundNetCents, rate(500).taxCents], [2000, 2000, 0]);
    assert.equal(rate(0).netCents, 800);
    assert.equal(t.totals.line101Cents, 5000 + 800);
    assert.equal(t.totals.line103Cents, 650);
    assert.equal(t.totals.taxRefundedCents, 100);
    assert.equal(t.business.gstHstNumber, '123456789RT0001');
    assert.equal(t.sales.count, 6);
    assert.equal(t.refunds.count, 1);
    assert.equal(t.payments.find((p) => p.method === 'etransfer').netCents, 0);
    assert.equal(t.sales.totalCents - t.refunds.totalCents, t.totals.line101Cents + t.totals.line103Cents, 'money in = sales + tax');
    // another period has nothing
    const empty = (await call('GET', '/api/reports/tax?from=2020-01-01&to=2020-03-31')).body;
    assert.deepEqual([empty.sales.count, empty.totals.line103Cents, empty.byRate.length], [0, 0, 0]);
    assert.equal((await call('GET', '/api/reports/tax?from=2026-13-01&to=2026-13-31')).status, 400);
    assert.equal((await call('GET', '/api/reports/tax')).status, 400);
    assert.equal((await call('GET', `/api/reports/tax?from=${today}&to=${today}`, undefined, cashier.token)).status, 403);
  });
});
