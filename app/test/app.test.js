'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, newStore } = require('./helpers');
const { createMemorySecrets } = require('../src/adapters/memory');

describe('health and info', () => {
  let ctx;
  before(async () => (ctx = await startServer()));
  after(() => ctx.server.close());

  test('GET /health returns Healthy with sql, blob and keyVault checks', async () => {
    const r = await ctx.call('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'Healthy');
    assert.equal(r.body.version, '1.2.3');
    assert.deepEqual(Object.keys(r.body.checks).sort(), ['blob', 'keyVault', 'sql']);
  });

  test('GET /api/info reports app, build, environment and slot', async () => {
    const r = await ctx.call('GET', '/api/info');
    assert.equal(r.body.app, 'eURC POS');
    assert.equal(r.body.commit, 'abc1234');
    assert.equal(r.body.environment, 'test');
    assert.equal(r.body.slot, 'production');
  });

  test('security headers are set and x-powered-by is hidden', async () => {
    const r = await ctx.call('GET', '/api/info');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-eurc-version'), '1.2.3');
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  test('unknown API route returns 404 JSON; bad JSON returns 400', async () => {
    assert.equal((await ctx.call('GET', '/api/nope')).status, 404);
    const r = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(r.status, 400);
  });
});

describe('health failure modes', () => {
  test('503 Starting until migrations have run; liveness still 200', async () => {
    const ctx = await startServer({ state: { ready: false, schemaVersion: 0 } });
    const r = await ctx.call('GET', '/health');
    assert.equal(r.status, 503);
    assert.equal(r.body.status, 'Starting');
    assert.equal((await ctx.call('GET', '/health/live')).status, 200);
    ctx.server.close();
  });

  test('503 Unhealthy when Key Vault is unreachable', async () => {
    const secrets = createMemorySecrets();
    secrets.ping = async () => {
      throw new Error('vault unreachable');
    };
    const ctx = await startServer({ secrets });
    const r = await ctx.call('GET', '/health');
    assert.equal(r.status, 503);
    assert.equal(r.body.checks.keyVault.status, 'Unhealthy');
    assert.equal(r.body.checks.sql.status, 'Healthy');
    ctx.server.close();
  });
});

describe('stores, sign-in and roles', () => {
  let ctx;
  let mgr;
  before(async () => {
    ctx = await startServer();
    mgr = await newStore(ctx);
  });
  after(() => ctx.server.close());

  test('store sign-up validates input and rejects a taken code', async () => {
    const body = { slug: 'Bad Code', storeName: 'X', managerName: 'Y', email: 'x', password: 'short' };
    assert.equal((await ctx.call('POST', '/api/stores', { body })).status, 400);
    const weak = { slug: 'shop-two', storeName: 'Shop', managerName: 'Sam', email: 'sam@x.test', password: 'alllettersnodigits' };
    assert.match((await ctx.call('POST', '/api/stores', { body: weak })).body.error, /digits/);
    const taken = { ...weak, slug: 'corner-shop', password: 'Password123' };
    assert.equal((await ctx.call('POST', '/api/stores', { body: taken })).status, 409);
  });

  test('sign-up returns a manager session; the signing key is kept in Key Vault', async () => {
    assert.equal(mgr.user.role, 'manager');
    assert.equal(mgr.user.passwordHash, undefined);
    assert.ok(ctx.secrets.secrets.get('pos-token-signing-key').length >= 40);
    const me = await ctx.call('GET', '/api/me', { token: mgr.token });
    assert.equal(me.body.store.slug, 'corner-shop');
  });

  test('login: wrong password and unknown store give the same 401', async () => {
    const a = await ctx.call('POST', '/api/auth/login', { body: { store: 'corner-shop', email: 'maya@corner-shop.test', password: 'Wrong12345' } });
    const b = await ctx.call('POST', '/api/auth/login', { body: { store: 'nope', email: 'maya@corner-shop.test', password: 'Password123' } });
    assert.equal(a.status, 401);
    assert.deepEqual(a.body, b.body);
    const ok = await ctx.call('POST', '/api/auth/login', { body: { store: 'CORNER-SHOP', email: 'MAYA@corner-shop.test', password: 'Password123' } });
    assert.equal(ok.status, 200);
  });

  test('requests without or with a forged token are rejected', async () => {
    assert.equal((await ctx.call('GET', '/api/products')).status, 401);
    assert.equal((await ctx.call('GET', '/api/products', { token: `${mgr.token}x` })).status, 401);
  });

  test('manager creates a cashier; cashier cannot use manager endpoints', async () => {
    const c = await ctx.call('POST', '/api/users', {
      token: mgr.token,
      body: { name: 'Cal Cashier', email: 'cal@corner-shop.test', password: 'Password123', role: 'cashier' },
    });
    assert.equal(c.status, 201);
    const dupe = await ctx.call('POST', '/api/users', {
      token: mgr.token,
      body: { name: 'Again', email: 'cal@corner-shop.test', password: 'Password123' },
    });
    assert.equal(dupe.status, 409);
    const login = await ctx.call('POST', '/api/auth/login', { body: { store: 'corner-shop', email: 'cal@corner-shop.test', password: 'Password123' } });
    const cashier = login.body.token;
    assert.equal((await ctx.call('GET', '/api/users', { token: cashier })).status, 403);
    assert.equal((await ctx.call('POST', '/api/products', { token: cashier, body: { sku: 'X', name: 'X', priceCents: 1 } })).status, 403);
    assert.equal((await ctx.call('GET', '/api/reports/daily', { token: cashier })).status, 403);

    // deactivation takes effect immediately, even for an existing session
    assert.equal((await ctx.call('PATCH', `/api/users/${c.body.id}`, { token: mgr.token, body: { active: false } })).status, 200);
    assert.equal((await ctx.call('GET', '/api/me', { token: cashier })).status, 401);
    assert.equal((await ctx.call('PATCH', `/api/users/${mgr.user.id}`, { token: mgr.token, body: { active: false } })).status, 400);
  });
});

describe('products, checkout, receipts, refunds and reports', () => {
  let ctx;
  let mgr;
  let coffee;
  let muffin;
  before(async () => {
    ctx = await startServer();
    mgr = await newStore(ctx);
    const add = async (body) => (await ctx.call('POST', '/api/products', { token: mgr.token, body })).body;
    coffee = await add({ sku: 'cof-001', name: 'Coffee, medium', category: 'Drinks', priceCents: 245, taxRateBp: 1300, stock: 10 });
    muffin = await add({ sku: 'BAK-002', name: 'Blueberry muffin', priceCents: 295, taxRateBp: 0, stock: 2 });
  });
  after(() => ctx.server.close());

  test('product SKUs are normalised, unique and validated', async () => {
    assert.equal(coffee.sku, 'COF-001');
    assert.equal((await ctx.call('POST', '/api/products', { token: mgr.token, body: { sku: 'COF-001', name: 'x', priceCents: 1 } })).status, 409);
    assert.equal((await ctx.call('POST', '/api/products', { token: mgr.token, body: { sku: 'A', name: 'x', priceCents: -1 } })).status, 400);
    const list = await ctx.call('GET', '/api/products?q=muff', { token: mgr.token });
    assert.deepEqual(list.body.map((p) => p.sku), ['BAK-002']);
  });

  let sale;
  test('cash sale: server prices the basket, decrements stock, stores the receipt in Blob', async () => {
    const r = await ctx.call('POST', '/api/sales', {
      token: mgr.token,
      body: {
        items: [
          { productId: coffee.id, qty: 2, priceCents: 1 }, // client price is ignored
          { productId: muffin.id, qty: 1 },
        ],
        payment: { method: 'cash', tenderedCents: 1000 },
      },
    });
    assert.equal(r.status, 201);
    sale = r.body.sale;
    assert.equal(sale.receiptNo, 1001);
    assert.equal(sale.totalCents, 849);
    assert.equal(sale.payment.changeCents, 151);
    assert.ok(ctx.blobs.blobs.has(sale.receiptBlob));
    const stock = await ctx.call('GET', '/api/products', { token: mgr.token });
    assert.equal(stock.body.find((p) => p.sku === 'COF-001').stock, 8);
    const rc = await ctx.call('GET', `/api/sales/${sale.id}/receipt`, { token: mgr.token });
    assert.equal(rc.body.source, 'blob');
    assert.equal(rc.body.store.name, 'Corner Shop');
  });

  test('not enough stock -> 409 and nothing changes (all-or-nothing)', async () => {
    const r = await ctx.call('POST', '/api/sales', {
      token: mgr.token,
      body: { items: [{ productId: coffee.id, qty: 1 }, { productId: muffin.id, qty: 5 }], payment: { method: 'card', reference: 'AUTH-1' } },
    });
    assert.equal(r.status, 409);
    const p = (await ctx.call('GET', '/api/products', { token: mgr.token })).body;
    assert.equal(p.find((x) => x.sku === 'COF-001').stock, 8);
  });

  test('underpaid cash and unknown products are rejected', async () => {
    const under = await ctx.call('POST', '/api/sales', {
      token: mgr.token,
      body: { items: [{ productId: coffee.id, qty: 1 }], payment: { method: 'cash', tenderedCents: 100 } },
    });
    assert.equal(under.status, 400);
    const unknown = await ctx.call('POST', '/api/sales', {
      token: mgr.token,
      body: { items: [{ productId: 'nope', qty: 1 }], payment: { method: 'card', reference: 'AUTH-1' } },
    });
    assert.equal(unknown.status, 400);
  });

  test('card sale records only the terminal reference; receipt numbers increase', async () => {
    const r = await ctx.call('POST', '/api/sales', {
      token: mgr.token,
      body: { items: [{ productId: coffee.id, qty: 1 }], payment: { method: 'card', reference: 'AUTH-7731' } },
    });
    assert.equal(r.body.sale.receiptNo, 1002);
    assert.equal(r.body.sale.payment.cardReference, 'AUTH-7731');
  });

  test('daily report totals by payment method and top products', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await ctx.call('GET', `/api/reports/daily?date=${today}&tz=0`, { token: mgr.token });
    assert.equal(r.body.salesCount, 2);
    assert.equal(r.body.grossCents, 849 + 277);
    assert.equal(r.body.byPayment.cash.totalCents, 849);
    assert.equal(r.body.byPayment.card.count, 1);
    assert.equal(r.body.topProducts[0].sku, 'COF-001');
  });

  test('refund restocks, is manager-only and cannot be repeated', async () => {
    const r = await ctx.call('POST', `/api/sales/${sale.id}/refund`, { token: mgr.token });
    assert.equal(r.body.status, 'refunded');
    assert.equal((await ctx.call('POST', `/api/sales/${sale.id}/refund`, { token: mgr.token })).status, 409);
    const p = (await ctx.call('GET', '/api/products', { token: mgr.token })).body;
    assert.equal(p.find((x) => x.sku === 'COF-001').stock, 9);
    assert.equal(p.find((x) => x.sku === 'BAK-002').stock, 2);
    const today = new Date().toISOString().slice(0, 10);
    const rep = await ctx.call('GET', `/api/reports/daily?date=${today}&tz=0`, { token: mgr.token });
    assert.equal(rep.body.refundsCount, 1);
  });

  test('stores are isolated from each other', async () => {
    const other = await newStore(ctx, 'other-shop');
    assert.equal((await ctx.call('GET', '/api/products', { token: other.token })).body.length, 0);
    assert.equal((await ctx.call('GET', `/api/sales/${sale.id}`, { token: other.token })).status, 404);
    const steal = await ctx.call('POST', '/api/sales', {
      token: other.token,
      body: { items: [{ productId: coffee.id, qty: 1 }], payment: { method: 'card', reference: 'AUTH-1' } },
    });
    assert.equal(steal.status, 400);
    assert.equal((await ctx.call('PATCH', `/api/products/${coffee.id}`, { token: other.token, body: { stock: 0 } })).status, 404);
  });

  test('deleting a store removes its data and receipts', async () => {
    assert.equal((await ctx.call('DELETE', '/api/stores/current', { token: mgr.token, body: { confirm: 'wrong' } })).status, 400);
    const r = await ctx.call('DELETE', '/api/stores/current', { token: mgr.token, body: { confirm: 'corner-shop' } });
    assert.equal(r.status, 204);
    assert.equal([...ctx.blobs.blobs.keys()].filter((k) => k.includes(mgr.store.id)).length, 0);
    assert.equal((await ctx.call('GET', '/api/me', { token: mgr.token })).status, 401);
  });
});
