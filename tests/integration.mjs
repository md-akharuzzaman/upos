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
  await suite.check('create store + manager (SQL transaction, Key Vault signing key)', async () => {
    mgr = await api.createStore(`ci-${tag}`);
    assert(mgr.user.role === 'manager' && mgr.token, 'no manager session');
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
