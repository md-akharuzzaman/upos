#!/usr/bin/env node
// Integration test: a full trading day for a new store, against a deployed environment.
// Exercises every layer: App Service -> Key Vault (signing key) -> Azure SQL (stores,
// users, products, sales, stock in one transaction) -> Blob Storage (receipts) -> clean-up.
//
//   node tests/integration.mjs --url https://<host> [--junit reports/integration-test.xml]
import { parseArgs, Suite, assert } from './lib.mjs';
import { client, runTag } from './pos-client.mjs';

const args = parseArgs();
const base = String(args.url || '').replace(/\/$/, '');
// --local allows http://127.0.0.1 for rehearsing the suites against `npm run dev`.
const local = Boolean(args.local) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base);
if (!base.startsWith('https://') && !local) {
  console.error('usage: integration.mjs --url https://<host>');
  process.exit(2);
}
const api = client(base);
const tag = runTag();
const suite = new Suite('Integration');
const today = new Date().toISOString().slice(0, 10);
let mgr = null;
let other = null;
let cashier = null;
const prod = {};
let cashSale = null;
console.log(`Integration testing ${base} with store ci-${tag}`);

try {
  await suite.check('create store + its Admin (SQL transaction, Key Vault signing key)', async () => {
    mgr = await api.createStore(`ci-${tag}`);
    // the store owner is Manager before v2.3 and Admin from v2.3 on
    assert(['admin', 'manager'].includes(mgr.user.role) && mgr.token, `no owner session (role ${mgr.user.role})`);
    return mgr.store.id;
  });

  await suite.check('manager adds products (SKU unique per store)', async () => {
    for (const [sku, name, priceCents, taxRateBp, stock] of [
      ['COF-001', 'Coffee, medium', 245, 1300, 10],
      ['BAK-002', 'Blueberry muffin', 295, 0, 2],
    ]) {
      const r = await api.call('POST', '/api/products', { token: mgr.token, body: { sku, name, priceCents, taxRateBp, stock } });
      assert(r.status === 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
      prod[sku] = r.body;
    }
    const dup = await api.call('POST', '/api/products', { token: mgr.token, body: { sku: 'COF-001', name: 'x', priceCents: 1 } });
    assert(dup.status === 409, `duplicate SKU: HTTP ${dup.status}`);
  });

  await suite.check('manager adds a cashier; cashier signs in', async () => {
    const u = await api.call('POST', '/api/users', {
      token: mgr.token,
      body: { name: 'Pipeline Cashier', email: `cashier@ci-${tag}.test`, password: 'Pipeline-Test-2026', role: 'cashier' },
    });
    assert(u.status === 201, `HTTP ${u.status}`);
    const l = await api.call('POST', '/api/auth/login', {
      body: { store: `ci-${tag}`, email: `cashier@ci-${tag}.test`, password: 'Pipeline-Test-2026' },
    });
    assert(l.status === 200, `login HTTP ${l.status}`);
    cashier = l.body;
  });

  await suite.check('roles enforced: cashier cannot manage products or see reports', async () => {
    const a = await api.call('POST', '/api/products', { token: cashier.token, body: { sku: 'X', name: 'X', priceCents: 1 } });
    const b = await api.call('GET', '/api/reports/daily', { token: cashier.token });
    assert(a.status === 403 && b.status === 403, `got ${a.status}/${b.status}`);
  });

  await suite.check('cash sale: server totals, change, stock decrement', async () => {
    const r = await api.call('POST', '/api/sales', {
      token: cashier.token,
      body: {
        items: [
          { productId: prod['COF-001'].id, qty: 2 },
          { productId: prod['BAK-002'].id, qty: 1 },
        ],
        payment: { method: 'cash', tenderedCents: 1000 },
      },
    });
    assert(r.status === 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    cashSale = r.body.sale;
    assert(cashSale.totalCents === 849, `total ${cashSale.totalCents} (expected 849)`);
    assert(cashSale.payment.changeCents === 151, `change ${cashSale.payment.changeCents}`);
    const p = (await api.call('GET', '/api/products', { token: cashier.token })).body;
    assert(p.find((x) => x.sku === 'COF-001').stock === 8, 'stock not decremented');
    return `receipt #${cashSale.receiptNo}`;
  });

  await suite.check('receipt stored in Blob Storage', async () => {
    const r = await api.call('GET', `/api/sales/${cashSale.id}/receipt`, { token: cashier.token });
    assert(r.status === 200 && r.body.source === 'blob', `HTTP ${r.status} source=${r.body?.source}`);
    assert(r.body.totalCents === 849, 'receipt total mismatch');
  });

  await suite.check('overselling is refused and nothing changes (409)', async () => {
    const r = await api.call('POST', '/api/sales', {
      token: cashier.token,
      body: {
        items: [
          { productId: prod['COF-001'].id, qty: 1 },
          { productId: prod['BAK-002'].id, qty: 5 },
        ],
        payment: { method: 'card', reference: 'AUTH-0001' },
      },
    });
    assert(r.status === 409, `HTTP ${r.status}`);
    const p = (await api.call('GET', '/api/products', { token: cashier.token })).body;
    assert(p.find((x) => x.sku === 'COF-001').stock === 8, 'partial sale was committed');
  });

  await suite.check('card sale records the terminal reference', async () => {
    const r = await api.call('POST', '/api/sales', {
      token: cashier.token,
      body: { items: [{ productId: prod['COF-001'].id, qty: 1 }], payment: { method: 'card', reference: 'AUTH-7731' } },
    });
    assert(r.status === 201 && r.body.sale.receiptNo === cashSale.receiptNo + 1, `HTTP ${r.status}`);
  });

  await suite.check('daily report (manager)', async () => {
    const r = await api.call('GET', `/api/reports/daily?date=${today}&tz=0`, { token: mgr.token });
    assert(r.status === 200, `HTTP ${r.status}`);
    assert(r.body.salesCount === 2 && r.body.grossCents === 849 + 277, `count ${r.body.salesCount} gross ${r.body.grossCents}`);
    return `gross ${r.body.grossCents} cents, ${r.body.salesCount} sales`;
  });

  await suite.check('item refund: one coffee back, stock and receipt updated (v2.1)', async () => {
    const r = await api.call('POST', `/api/sales/${cashSale.id}/refunds`, {
      token: mgr.token,
      body: { items: [{ lineNo: 1, qty: 1 }], reason: 'integration test' },
    });
    assert(r.status === 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.refund.refundNo === `R-${cashSale.receiptNo}-1`, `refund no ${r.body.refund.refundNo}`);
    assert(r.body.refund.totalCents === 277, `refund ${r.body.refund.totalCents} (expected 277)`);
    assert(r.body.sale.status === 'completed' && r.body.sale.refundState === 'partial', `state ${r.body.sale.refundState}`);
    const over = await api.call('POST', `/api/sales/${cashSale.id}/refunds`, { token: mgr.token, body: { items: [{ lineNo: 1, qty: 2 }] } });
    assert(over.status === 409, `over-refund HTTP ${over.status}`);
    const p = (await api.call('GET', '/api/products', { token: mgr.token })).body;
    assert(p.find((x) => x.sku === 'COF-001').stock === 8, 'coffee not restocked by exactly 1');
    const rc = await api.call('GET', `/api/sales/${cashSale.id}/receipt`, { token: mgr.token });
    assert(rc.body.refunds?.length === 1 && rc.body.refundedCents === 277, 'receipt does not show the refund');
    return `refund ${r.body.refund.refundNo}: 277 cents`;
  });

  await suite.check('refund restocks and cannot be repeated', async () => {
    const r = await api.call('POST', `/api/sales/${cashSale.id}/refund`, { token: mgr.token });
    assert(r.status === 200 && r.body.status === 'refunded', `HTTP ${r.status}`);
    const refunded = (r.body.refunds || []).reduce((t, x) => t + x.totalCents, 0);
    assert(refunded === cashSale.totalCents, `refunds add up to ${refunded}, sale was ${cashSale.totalCents}`);
    const again = await api.call('POST', `/api/sales/${cashSale.id}/refund`, { token: mgr.token });
    assert(again.status === 409, `second refund HTTP ${again.status}`);
    const p = (await api.call('GET', '/api/products', { token: mgr.token })).body;
    assert(p.find((x) => x.sku === 'BAK-002').stock === 2, 'not restocked');
  });

  await suite.check('stores are isolated from each other', async () => {
    other = await api.createStore(`ci-${tag}-b`);
    const list = await api.call('GET', '/api/products', { token: other.token });
    const sale = await api.call('GET', `/api/sales/${cashSale.id}`, { token: other.token });
    assert(list.body.length === 0 && sale.status === 404, `products ${list.body.length}, sale HTTP ${sale.status}`);
  });
  // ---- v2.2 store management ------------------------------------------------
  let v22 = {};
  await suite.check('Excel import: preview, then add products in one transaction (v2.2)', async () => {
    const rows = [
      { sku: 'SAN-100', name: 'Ham sandwich', category: 'Food', priceCents: 650, taxRateBp: 1300, stock: 5 },
      { sku: 'MUG-100', name: 'eURC mug', category: 'Merch', priceCents: 1200, taxRateBp: 1300, stock: 5 },
    ];
    const dry = await api.call('POST', '/api/products/import', { token: mgr.token, body: { rows, dryRun: true } });
    assert(dry.status === 200 && dry.body.created === 2, `dry run HTTP ${dry.status} ${JSON.stringify(dry.body)}`);
    const bad = await api.call('POST', '/api/products/import', { token: mgr.token, body: { rows: [...rows, { sku: 'X', name: '', priceCents: -1 }] } });
    assert(bad.status === 400 && bad.body.errors.length === 1, `bad file HTTP ${bad.status}`);
    const r = await api.call('POST', '/api/products/import', { token: mgr.token, body: { rows } });
    assert(r.status === 200 && r.body.created === 2, `import HTTP ${r.status}`);
    const list = (await api.call('GET', '/api/products', { token: mgr.token })).body;
    v22 = Object.fromEntries(list.map((x) => [x.sku, x]));
    assert(v22['SAN-100'].refundable === false && v22['MUG-100'].refundable === true, 'Food should default to final sale');
  });

  await suite.check('batch price change by category with preview (v2.2)', async () => {
    const pre = await api.call('POST', '/api/products/bulk-update', {
      token: mgr.token,
      body: { category: 'Merch', price: { mode: 'percent', value: 1000 }, dryRun: true },
    });
    assert(pre.status === 200 && pre.body.changes[0].after.priceCents === 1320, `preview ${JSON.stringify(pre.body)}`);
    const r = await api.call('POST', '/api/products/bulk-update', { token: mgr.token, body: { category: 'Merch', price: { mode: 'percent', value: 1000 } } });
    assert(r.status === 200, `HTTP ${r.status}`);
    const mug = (await api.call('GET', '/api/products', { token: mgr.token })).body.find((x) => x.sku === 'MUG-100');
    assert(mug.priceCents === 1320, `mug ${mug.priceCents}`);
  });

  let v22sale;
  await suite.check('promotion applied at checkout, tax on the discounted price (v2.2)', async () => {
    const p = await api.call('POST', '/api/promotions', {
      token: mgr.token,
      body: { name: 'CI mug 25%', kind: 'percent', value: 2500, target: 'skus', skus: ['MUG-100'] },
    });
    assert(p.status === 201, `HTTP ${p.status}`);
    const r = await api.call('POST', '/api/sales', {
      token: cashier.token,
      body: {
        items: [
          { productId: v22['MUG-100'].id, qty: 1 },
          { productId: v22['SAN-100'].id, qty: 1 },
        ],
        payment: { method: 'card', reference: 'AUTH-2200' },
      },
    });
    assert(r.status === 201, `sale HTTP ${r.status}`);
    v22sale = r.body.sale;
    // mug 13.20 - 25 % = 9.90 (+1.29 HST); sandwich 6.50 (+0.85)
    assert(v22sale.discountCents === 330 && v22sale.totalCents === 1854, `discount ${v22sale.discountCents} total ${v22sale.totalCents}`);
    await api.call('PATCH', `/api/promotions/${p.body.id}`, { token: mgr.token, body: { active: false } });
    return `saved 330 cents, total 1854`;
  });

  await suite.check('refund policy: final sale refused, manager override recorded (v2.2)', async () => {
    const no = await api.call('POST', `/api/sales/${v22sale.id}/refunds`, { token: mgr.token, body: { items: [{ lineNo: 2, qty: 1 }] } });
    assert(no.status === 409, `final-sale refund HTTP ${no.status}`);
    const yes = await api.call('POST', `/api/sales/${v22sale.id}/refunds`, {
      token: mgr.token,
      body: { items: [{ lineNo: 2, qty: 1 }], override: true, reason: 'integration test override' },
    });
    assert(yes.status === 201 && yes.body.refund.policyOverride === true, `override HTTP ${yes.status}`);
    const mug = await api.call('POST', `/api/sales/${v22sale.id}/refunds`, { token: mgr.token, body: { items: [{ lineNo: 1, qty: 1 }] } });
    assert(mug.status === 201 && mug.body.refund.totalCents === 1119, `mug refund ${mug.body?.refund?.totalCents} (expected the paid 9.90 + 1.29)`);
  });
  // ---- v2.3 foundations -----------------------------------------------------
  await suite.check('readiness endpoint and Admin role for the store owner (v2.3)', async () => {
    const r = await api.call('GET', '/health/ready');
    assert(r.status === 200 && r.body.status === 'Ready', `ready HTTP ${r.status}`);
    assert(mgr.user.role === 'admin', `owner role ${mgr.user.role}`);
  });

  await suite.check('business profile on the receipt; bank details masked (v2.3)', async () => {
    const p = await api.call('PUT', '/api/store/profile', {
      token: mgr.token,
      body: {
        legalName: 'CI Retail Inc.',
        storeType: 'supermarket',
        address: { line1: '1 Test St', city: 'Toronto', province: 'ON', postalCode: 'M5V 1A1' },
        gstHstNumber: '123456789RT0001',
        bank: { bankName: 'CI Bank', accountName: 'CI Retail Inc.', institutionNumber: '001', transitNumber: '12345', accountNumber: '7654321' },
      },
    });
    assert(p.status === 200, `HTTP ${p.status} ${JSON.stringify(p.body)}`);
    assert(p.body.profile.bank.account === '••••4321' && !JSON.stringify(p.body).includes('7654321'), 'bank number not masked');
  });

  let v23 = {};
  await suite.check('starter categories, barcode scan lookup, sub-category paging (v2.3)', async () => {
    const s = await api.call('POST', '/api/categories/suggested', { token: mgr.token, body: {} });
    assert(s.status === 200 && s.body.created > 10, `suggested HTTP ${s.status}`);
    const p = await api.call('POST', '/api/products', {
      token: mgr.token,
      body: { sku: 'MLK-230', name: 'CI Milk 2 L', category: 'Food', subcategory: 'Dairy', barcode: '4006381333931', priceCents: 499, taxRateBp: 0, stock: 5 },
    });
    assert(p.status === 201 && p.body.refundable === false, `create HTTP ${p.status} refundable=${p.body.refundable}`);
    const hit = await api.call('GET', '/api/products/lookup?code=4006381333931', { token: cashier.token });
    assert(hit.status === 200 && hit.body.sku === 'MLK-230', `lookup HTTP ${hit.status}`);
    const page = await api.call('GET', '/api/products?category=Food&subcategory=Dairy&limit=10&offset=0', { token: cashier.token });
    assert(page.body.total === 1 && page.body.items[0].sku === 'MLK-230', `page ${JSON.stringify(page.body).slice(0, 120)}`);
    v23 = p.body;
  });

  await suite.check('expired products cannot be sold (v2.3)', async () => {
    await api.call('PATCH', `/api/products/${v23.id}`, { token: mgr.token, body: { expiresOn: '2020-01-01' } });
    const r = await api.call('POST', '/api/sales', {
      token: cashier.token,
      body: { items: [{ productId: v23.id, qty: 1 }], payment: { method: 'card', reference: 'AUTH-2300' } },
    });
    assert(r.status === 409 && /expired/.test(r.body.error), `HTTP ${r.status} ${r.body.error}`);
    const exp = await api.call('GET', '/api/products?expiring=0&limit=10', { token: mgr.token });
    assert(
      exp.body.items.some((x) => x.sku === 'MLK-230'),
      'not listed as expired',
    );
  });

  await suite.check('roles: a cashier cannot change staff or the business profile (v2.3)', async () => {
    const a = await api.call('PUT', '/api/store/profile', { token: cashier.token, body: { legalName: 'x' } });
    const b = await api.call('POST', '/api/users', { token: cashier.token, body: { name: 'X', email: 'x@ci.test', password: 'Password1234', role: 'admin' } });
    assert(a.status === 403 && b.status === 403, `profile ${a.status}, users ${b.status}`);
  });

  await suite.check('payments: debit, e-Transfer, Stripe; GST/HST report adds up (v2.4)', async () => {
    const off = await api.call('POST', '/api/products', {
      token: mgr.token,
      body: { sku: 'GST-240', name: 'CI book', category: 'General', priceCents: 1000, taxRateBp: 500, stock: 5 },
    });
    assert(off.status === 201, `product HTTP ${off.status}`);
    const sell = (payment) => api.call('POST', '/api/sales', { token: cashier.token, body: { items: [{ productId: off.body.id, qty: 1 }], payment } });
    const refused = await sell({ method: 'etransfer', reference: 'CI24ETRANSFER' });
    assert(refused.status === 400 && /not accepted/.test(refused.body.error), `e-Transfer before enabling: HTTP ${refused.status}`);
    const p = await api.call('PUT', '/api/store/profile', {
      token: mgr.token,
      body: { paymentMethods: ['cash', 'debit', 'credit', 'etransfer', 'stripe'], etransferEmail: 'pay@ci.test' },
    });
    assert(p.status === 200, `profile HTTP ${p.status}`);
    const d = await sell({ method: 'debit', reference: 'DB-2400' });
    const e = await sell({ method: 'etransfer', reference: 'CI24ETRANSFER' });
    const st = await sell({ method: 'stripe', reference: 'pi_CI24stripe0001' });
    assert([d, e, st].every((x) => x.status === 201), `sales HTTP ${[d, e, st].map((x) => x.status)}`);
    assert(d.body.sale.payment.method === 'debit' && d.body.sale.payment.brand === 'interac', `debit read back as ${JSON.stringify(d.body.sale.payment)}`);
    const back = await api.call('GET', `/api/sales/${e.body.sale.id}/receipt`, { token: cashier.token });
    assert(back.body.payment?.method === 'etransfer', `receipt payment ${JSON.stringify(back.body.payment)}`);
    const rf = await api.call('POST', `/api/sales/${e.body.sale.id}/refunds`, { token: mgr.token, body: { items: [{ lineNo: 1, qty: 1 }] } });
    assert(rf.status === 201 && rf.body.refund.method === 'etransfer', `refund HTTP ${rf.status} method ${rf.body.refund?.method}`);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
    const t = await api.call('GET', `/api/reports/tax?from=${day}&to=${day}`, { token: mgr.token });
    assert(t.status === 200, `tax report HTTP ${t.status} ${JSON.stringify(t.body).slice(0, 200)}`);
    const gst = t.body.byRate.find((x) => x.rateBp === 500);
    assert(gst && gst.salesNetCents === 3000 && gst.salesTaxCents === 150 && gst.refundNetCents === 1000 && gst.taxCents === 100, `GST 5 % ${JSON.stringify(gst)}`);
    const money = t.body.sales.totalCents - t.body.refunds.totalCents;
    assert(money === t.body.totals.line101Cents + t.body.totals.line103Cents, `sales - refunds ${money} != line 101 + 103`);
    assert(['debit', 'etransfer', 'stripe'].every((m) => t.body.payments.some((x) => x.method === m)), 'payment methods missing');
    const sales = await api.call('GET', `/api/reports/tax?from=${day}&to=${day}`, { token: cashier.token });
    assert(sales.status === 403, `cashier tax report HTTP ${sales.status}`);
    return `line 103 ${t.body.totals.line103Cents} cents, ${t.body.sales.count} sales`;
  });
} finally {
  for (const s of [mgr, other]) {
    if (!s) continue;
    await suite.check(`clean-up: delete store ${s.store.slug} (rows + receipts)`, async () => {
      const status = await api.deleteStore(s);
      assert(status === 204, `HTTP ${status}`);
    });
  }
}

suite.finish({ junit: args.junit });
