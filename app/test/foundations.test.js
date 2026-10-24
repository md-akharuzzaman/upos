'use strict';

// v2.3 foundations: roles, business profile, categories, barcodes, expiry,
// big-catalogue search/paging/import and set-based price changes.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { can, permissionsOf, assignableRoles, ROLES } = require('../src/domain/permissions');
const { normaliseBarcode, isValidGtin } = require('../src/domain/barcode');
const { profileInput, bankInput, storeToday, suggestedCategories, STORE_TYPES } = require('../src/domain/business');
const { newPrice, changeInput } = require('../src/domain/reprice');
const { startServer, newStore } = require('./helpers');

describe('domain rules', () => {
  test('permission matrix', () => {
    assert.deepEqual(ROLES, ['admin', 'manager', 'cashier', 'sales', 'procurement', 'support']);
    assert.ok(can('admin', 'business.profile') && !can('manager', 'business.profile'));
    assert.ok(can('procurement', 'products.manage') && !can('procurement', 'sales.create'));
    assert.ok(can('support', 'refunds.create') && !can('support', 'refunds.override'));
    assert.ok(can('sales', 'promotions.manage') && can('sales', 'reports.view') && !can('sales', 'products.manage'));
    assert.ok(can('cashier', 'sales.create') && !can('cashier', 'reports.view'));
    assert.ok(permissionsOf('support').includes('sales.view'));
    assert.deepEqual(assignableRoles('manager'), ['manager', 'cashier', 'sales', 'procurement', 'support']);
    assert.deepEqual(assignableRoles('cashier'), []);
    assert.throws(() => can('admin', 'nope'), /unknown permission/);
  });

  test('barcodes: GTIN check digits, internal codes, empty', () => {
    assert.equal(normaliseBarcode('0 12345 67890 5'), '012345678905'); // UPC-A
    assert.equal(normaliseBarcode('4006381333931'), '4006381333931'); // EAN-13
    assert.equal(normaliseBarcode('96385074'), '96385074'); // EAN-8
    assert.throws(() => normaliseBarcode('4006381333932'), /check digit \(expected 1/);
    assert.equal(normaliseBarcode('int-0042'), 'INT-0042');
    assert.throws(() => normaliseBarcode('x'), /GTIN/);
    assert.equal(normaliseBarcode(''), null);
    assert.equal(normaliseBarcode(undefined), undefined);
    assert.equal(isValidGtin('12345'), false);
  });

  test('business profile: CRA numbers, address, payment methods, time zone, bank masking', () => {
    const p = profileInput({
      legalName: 'eURC Retail Inc.',
      storeType: 'supermarket',
      gstHstNumber: '123456789 rt 0001',
      qstNumber: '1234567890TQ0001',
      address: { line1: '1 Main St', city: 'Toronto', province: 'on', postalCode: 'm5v3l9' },
      paymentMethods: ['etransfer', 'cash'],
      etransferEmail: 'Pay@eURC.ca',
      stripeAccountId: 'acct_1A2b3C4d5E6f7G8h',
      timeZone: 'America/Vancouver',
    });
    assert.equal(p.gstHstNumber, '123456789RT0001');
    assert.equal(p.address.postalCode, 'M5V 3L9');
    assert.equal(p.address.province, 'ON');
    assert.deepEqual(p.paymentMethods, ['cash', 'etransfer']);
    assert.equal(p.etransferEmail, 'pay@eurc.ca');
    assert.throws(() => profileInput({ gstHstNumber: '12345' }), /RT0001/);
    assert.throws(() => profileInput({ address: { province: 'XX' } }), /province/);
    assert.throws(() => profileInput({ paymentMethods: ['bitcoin'] }), /paymentMethods/);
    assert.throws(() => profileInput({ paymentMethods: ['etransfer'] }), /e-transfer e-mail/);
    assert.throws(() => profileInput({ timeZone: 'Mars/Base' }), /timeZone/);
    assert.throws(() => profileInput({ storeType: 'castle' }), /storeType/);
    assert.equal(profileInput({ legalName: 'X Inc.' }, p).gstHstNumber, '123456789RT0001', 'fields left out are kept');
    const bank = bankInput({ bankName: 'RBC', accountName: 'eURC Retail', institutionNumber: '003', transitNumber: '12345', accountNumber: '1234567' });
    assert.deepEqual(bank.masked, { bankName: 'RBC', accountName: 'eURC Retail', institution: '003', transit: '•••45', account: '••••4567' });
    assert.throws(
      () => bankInput({ bankName: 'RBC', accountName: 'x', institutionNumber: '3', transitNumber: '12345', accountNumber: '1234567' }),
      /institution/,
    );
    // Toronto is still on the 23rd at 23:30 EDT while UTC is on the 24th
    assert.equal(storeToday({}, new Date('2026-10-24T03:30:00Z')), '2026-10-23');
    assert.ok(STORE_TYPES.length >= 8 && suggestedCategories('supermarket').some((c) => c.name === 'Food' && c.finalSale));
  });

  test('price arithmetic matches the SQL (half up, exact)', () => {
    assert.equal(newPrice(375, { mode: 'percent', value: 1000 }), 413); // 412.5 -> 413
    assert.equal(newPrice(999, { mode: 'percent', value: -10000 }), 0);
    assert.equal(newPrice(250, { mode: 'amount', value: -100 }), 150);
    assert.equal(newPrice(250, { mode: 'set', value: 199 }), 199);
    assert.throws(() => changeInput({}), /price change/);
    assert.throws(() => changeInput({ price: { mode: 'percent', value: -20000 } }), /basis points/);
  });
});

describe('v2.3 API', () => {
  let ctx;
  let admin;
  const tokens = {};
  const call = (method, path, body, token = admin.token) => ctx.call(method, path, { token, body });

  before(async () => {
    ctx = await startServer();
    admin = await newStore(ctx, 'big-mart');
    for (const role of ['manager', 'cashier', 'sales', 'procurement', 'support']) {
      const r = await call('POST', '/api/users', { name: `${role} person`, email: `${role}@big-mart.test`, password: 'Password123', role });
      assert.equal(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      tokens[role] = (
        await ctx.call('POST', '/api/auth/login', { body: { store: 'big-mart', email: `${role}@big-mart.test`, password: 'Password123' } })
      ).body.token;
    }
  });
  after(() => ctx.server.close());

  test('the store owner is Admin; sessions carry permissions; readiness endpoint', async () => {
    assert.equal(admin.user.role, 'admin');
    assert.ok(admin.user.permissions.includes('business.profile'));
    const r = await ctx.call('GET', '/health/ready');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'Ready');
  });

  test('each role reaches only its screens', async () => {
    const status = async (role, method, path, body) => (await call(method, path, body, tokens[role])).status;
    assert.equal(await status('procurement', 'POST', '/api/products', { sku: 'P-1', name: 'Rice', priceCents: 500 }), 201);
    assert.equal(await status('procurement', 'GET', '/api/reports/daily'), 403);
    assert.equal(await status('sales', 'POST', '/api/promotions', { name: 'Sale 5', kind: 'percent', value: 500, target: 'all' }), 201);
    assert.equal(await status('sales', 'POST', '/api/products', { sku: 'S-1', name: 'x', priceCents: 1 }), 403);
    assert.equal(await status('support', 'GET', '/api/sales'), 200);
    assert.equal(await status('support', 'POST', '/api/sales', { items: [], payment: {} }), 403);
    assert.equal(await status('cashier', 'GET', '/api/users'), 403);
    assert.equal(await status('manager', 'PUT', '/api/store/profile', { legalName: 'X' }), 403);
    assert.equal(await status('manager', 'DELETE', '/api/stores/current', { confirm: 'big-mart' }), 403);
    await call('PATCH', '/api/promotions/' + (await call('GET', '/api/promotions')).body[0].id, { active: false });
  });

  test('staff roles: managers cannot create or touch admins; the store keeps an admin', async () => {
    assert.equal(
      (await call('POST', '/api/users', { name: 'Second Admin', email: 'a2@big-mart.test', password: 'Password123', role: 'admin' }, tokens.manager)).status,
      403,
    );
    assert.equal((await call('POST', '/api/users', { name: 'Bad role', email: 'x@big-mart.test', password: 'Password123', role: 'owner' })).status, 400);
    const users = (await call('GET', '/api/users')).body;
    const id = (role) => users.find((u) => u.role === role).id;
    assert.equal((await call('PATCH', `/api/users/${id('admin')}`, { role: 'cashier' }, tokens.manager)).status, 403);
    assert.equal((await call('PATCH', `/api/users/${id('admin')}`, { active: false })).status, 400, 'cannot change yourself');
    const r = await call('PATCH', `/api/users/${id('support')}`, { role: 'cashier' }, tokens.manager);
    assert.equal(r.body.role, 'cashier');
    await call('PATCH', `/api/users/${id('support')}`, { role: 'support' });
    // a second admin can be demoted while one remains; the last one cannot
    const a2 = (await call('POST', '/api/users', { name: 'Second Admin', email: 'a2@big-mart.test', password: 'Password123', role: 'admin' })).body;
    const t2 = (await ctx.call('POST', '/api/auth/login', { body: { store: 'big-mart', email: 'a2@big-mart.test', password: 'Password123' } })).body.token;
    assert.equal((await call('PATCH', `/api/users/${id('admin')}`, { role: 'manager' }, t2)).status, 200);
    assert.equal((await call('PATCH', `/api/users/${a2.id}`, { active: false }, tokens.manager)).status, 403);
    assert.equal((await call('PATCH', `/api/users/${id('admin')}`, { role: 'admin' }, t2)).status, 200);
    assert.equal((await call('PATCH', `/api/users/${a2.id}`, { active: false })).status, 200);
  });

  test('business profile: Admin saves it, bank numbers stay in Key Vault, receipts show it', async () => {
    const r = await call('PUT', '/api/store/profile', {
      storeName: 'Big Mart',
      legalName: 'Big Mart Retail Inc.',
      storeType: 'supermarket',
      address: { line1: '100 Queen St W', city: 'Toronto', province: 'ON', postalCode: 'M5H 2N2' },
      gstHstNumber: '123456789RT0001',
      paymentMethods: ['cash', 'debit', 'credit', 'etransfer'],
      etransferEmail: 'pay@bigmart.test',
      bank: { bankName: 'RBC', accountName: 'Big Mart Retail Inc.', institutionNumber: '003', transitNumber: '12345', accountNumber: '9876543210' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'Big Mart');
    assert.equal(r.body.profile.bank.account, '••••3210');
    assert.ok(!JSON.stringify(r.body).includes('9876543210'), 'full account number never leaves Key Vault');
    assert.equal(JSON.parse(ctx.secrets.secrets.get(`bank-${admin.store.id}`)).account, '9876543210');
    assert.equal((await call('PUT', '/api/store/profile', { gstHstNumber: 'nope' })).status, 400);
    const me = (await call('GET', '/api/store/profile', undefined, tokens.cashier)).body;
    assert.equal(me.profile.gstHstNumber, '123456789RT0001');
    assert.ok(me.storeTypes.length >= 8);
  });

  test('store type suggests categories; sub-categories; final-sale defaults follow the category', async () => {
    const s = await call('POST', '/api/categories/suggested', {}, tokens.procurement);
    assert.equal(s.status, 200);
    assert.ok(s.body.created > 10);
    assert.equal((await call('POST', '/api/categories/suggested', {}, tokens.procurement)).body.created, 0, 'idempotent');
    const cats = s.body.categories;
    const food = cats.find((c) => c.name === 'Food' && !c.parentId);
    assert.ok(food.finalSale);
    assert.ok(cats.some((c) => c.parentId === food.id && c.name === 'Dairy'));
    assert.equal((await call('POST', '/api/categories', { name: 'Dairy', parentId: food.id })).status, 409);
    const dairy = cats.find((c) => c.name === 'Dairy');
    assert.equal((await call('POST', '/api/categories', { name: 'Milk', parentId: dairy.id })).status, 400, 'two levels only');
    const hh = cats.find((c) => c.name === 'Household');
    const p = await call('POST', '/api/products', { sku: 'MLK-1', name: 'Milk 2 L', category: 'Food', subcategory: 'Dairy', priceCents: 499, taxRateBp: 0 });
    assert.equal(p.body.refundable, false);
    assert.equal(p.body.subcategory, 'Dairy');
    assert.equal((await call('POST', '/api/products', { sku: 'SPG-1', name: 'Sponge', category: 'Household', priceCents: 199 })).body.refundable, true);
    await call('PATCH', `/api/categories/${hh.id}`, { finalSale: true });
    assert.equal((await call('POST', '/api/products', { sku: 'SPG-2', name: 'Sponge 2', category: 'Household', priceCents: 199 })).body.refundable, false);
    assert.equal((await call('POST', '/api/categories', { name: 'X' }, tokens.cashier)).status, 403);
  });

  test('barcodes: unique per store, scanner lookup by barcode or SKU', async () => {
    const r = await call('POST', '/api/products', { sku: 'COF-1', name: 'Coffee', category: 'Food', priceCents: 899, barcode: '4006381333931' });
    assert.equal(r.status, 201);
    assert.equal((await call('POST', '/api/products', { sku: 'COF-2', name: 'Coffee 2', priceCents: 899, barcode: '4006381333931' })).status, 409);
    assert.equal((await call('POST', '/api/products', { sku: 'COF-3', name: 'Coffee 3', priceCents: 899, barcode: '4006381333932' })).status, 400);
    assert.equal((await call('GET', '/api/products/lookup?code=4006381333931', undefined, tokens.cashier)).body.sku, 'COF-1');
    assert.equal((await call('GET', '/api/products/lookup?code=cof-1', undefined, tokens.cashier)).body.barcode, '4006381333931');
    assert.equal((await call('GET', '/api/products/lookup?code=0000', undefined, tokens.cashier)).status, 404);
    const dup = await call('PATCH', `/api/products/${(await call('GET', '/api/products/lookup?code=MLK-1')).body.id}`, { barcode: '4006381333931' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /barcode/);
  });

  test('expiry: expired items cannot be sold; near-expiry filter', async () => {
    const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const old = (await call('POST', '/api/products', { sku: 'YOG-OLD', name: 'Old yogurt', category: 'Food', priceCents: 199, stock: 5, expiresOn: yesterday }))
      .body;
    await call('POST', '/api/products', { sku: 'YOG-NEW', name: 'Fresh yogurt', category: 'Food', priceCents: 199, stock: 5, expiresOn: soon });
    const sale = await call('POST', '/api/sales', { items: [{ productId: old.id, qty: 1 }], payment: { method: 'cash', tenderedCents: 500 } }, tokens.cashier);
    assert.equal(sale.status, 409);
    assert.match(sale.body.error, /expired/);
    const week = (await call('GET', '/api/products?expiring=7&limit=50')).body;
    assert.deepEqual(
      week.items.map((p) => p.sku),
      ['YOG-OLD', 'YOG-NEW'],
    );
    assert.deepEqual(
      (await call('GET', '/api/products?expiring=0&limit=50')).body.items.map((p) => p.sku),
      ['YOG-OLD'],
    );
    assert.equal((await call('POST', '/api/products', { sku: 'BAD-D', name: 'x', priceCents: 1, expiresOn: '2026-13-40' })).status, 400);
  });

  test('big catalogues: batched import with new columns, paging and search', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      sku: `GRO-${String(i + 1).padStart(6, '0')}`,
      name: `Grocery item ${i + 1}`,
      category: 'Food',
      subcategory: i % 2 ? 'Pantry' : 'Frozen',
      priceCents: 100 + i,
      taxRateBp: 0,
      stock: 10,
      barcode: null,
      expiresOn: '2027-06-30',
    }));
    const first = await call('POST', '/api/products/import', { rows, startRow: 2 });
    assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
    assert.equal(first.body.created, 1000);
    const bad = await call('POST', '/api/products/import', {
      startRow: 1002,
      rows: [
        { sku: 'GRO-X1', name: 'x', priceCents: 1, barcode: '4006381333931' },
        { sku: 'GRO-X2', name: 'y', priceCents: 1, barcode: '96385074' },
        { sku: 'GRO-X3', name: 'z', priceCents: 1, barcode: '96385074' },
      ],
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(
      bad.body.errors.map((e) => [e.row, e.error.slice(0, 30)]),
      [
        [1002, 'barcode 4006381333931 already '],
        [1004, 'barcode 96385074 is also on ro'],
      ],
    );
    assert.equal((await call('POST', '/api/products/import', { rows: Array.from({ length: 1001 }, () => ({})) })).status, 400);

    const page = (await call('GET', '/api/products?category=Food&subcategory=Pantry&limit=50&offset=100', undefined, tokens.cashier)).body;
    assert.equal(page.total, 500);
    assert.equal(page.items.length, 50);
    assert.equal(page.limit, 50);
    const found = (await call('GET', '/api/products?q=item 77&limit=20', undefined, tokens.cashier)).body;
    assert.ok(found.items.some((p) => p.name === 'Grocery item 77'));
    assert.ok(Array.isArray((await call('GET', '/api/products', undefined, tokens.cashier)).body), 'unpaged form still returns an array');
  });

  test('set-based price change by sub-category: preview capped at 50, all-or-nothing', async () => {
    const pre = await call(
      'POST',
      '/api/products/bulk-update',
      { category: 'pantry', price: { mode: 'percent', value: 1000 }, dryRun: true },
      tokens.procurement,
    );
    assert.equal(pre.body.count, 500);
    assert.equal(pre.body.changes.length, 50);
    assert.equal(pre.body.more, 450);
    await call('POST', '/api/products/bulk-update', { category: 'Pantry', price: { mode: 'percent', value: 1000 } }, tokens.procurement);
    const p = (await call('GET', '/api/products/lookup?code=GRO-000002')).body;
    assert.equal(p.priceCents, 111); // 101 + 10 % = 111.1 -> 111
    const neg = await call('POST', '/api/products/bulk-update', { category: 'Frozen', price: { mode: 'amount', value: -150 } });
    assert.equal(neg.status, 400);
    assert.equal((await call('GET', '/api/products/lookup?code=GRO-000001')).body.priceCents, 100, 'nothing changed');
    const ids = [p.id, '00000000-0000-0000-0000-000000000000'];
    assert.equal((await call('POST', '/api/products/bulk-update', { productIds: ids, taxRateBp: 500 })).status, 404);
    assert.equal((await call('GET', '/api/products/lookup?code=GRO-000002')).body.taxRateBp, 0, 'nothing changed');
  });

  test('promotions on a sub-category; the admin deletes the store and its bank secret', async () => {
    await call('POST', '/api/promotions', { name: 'Pantry week', kind: 'percent', value: 5000, target: 'category', category: 'Pantry' }, tokens.sales);
    const item = (await call('GET', '/api/products/lookup?code=GRO-000002')).body;
    const sale = await call(
      'POST',
      '/api/sales',
      { items: [{ productId: item.id, qty: 1 }], payment: { method: 'card', reference: 'AUTH-1' } },
      tokens.cashier,
    );
    assert.equal(sale.body.sale.discountCents, 56); // 50 % of 1.11 = 0.555 -> 0.56
    assert.equal(sale.body.receipt.store.legalName, 'Big Mart Retail Inc.');
    assert.deepEqual(sale.body.receipt.store.taxNumbers, ['GST/HST 123456789RT0001']);
    assert.match(sale.body.receipt.store.address, /Toronto ON M5H 2N2/);
    assert.equal((await call('DELETE', '/api/stores/current', { confirm: 'big-mart' })).status, 204);
    assert.equal(ctx.secrets.secrets.has(`bank-${admin.store.id}`), false);
    assert.ok(storeTodayIsString());
  });
});

function storeTodayIsString() {
  return /^\d{4}-\d{2}-\d{2}$/.test(storeToday({}));
}
