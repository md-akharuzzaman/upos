'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { MIGRATIONS } = require('./migrations');
const { priceBasket, normaliseBasket, settlePayment } = require('./domain/pricing');
const { withRefundTotals, planRefund, refundDeadline } = require('./domain/refunds');
const { promotionInput, isRunning } = require('./domain/promotions');
const { hashPassword, verifyPassword, validatePassword, signToken, verifyToken } = require('./domain/auth');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const SKU_RE = /^[A-Za-z0-9._-]{1,40}$/;
const ROLES = new Set(['manager', 'cashier']);
const SIGNING_SECRET = 'pos-token-signing-key';
const MAX_IMPORT_ROWS = 500;
// Products in these categories are sold as final sale by default (store policy;
// the manager can still switch any product's "Refundable" setting).
const FINAL_SALE_CATEGORIES = new Set(['food']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

function rateLimiter({ limit, windowMs, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    const h = hits.get(k);
    if (!h || now - h.start > windowMs) {
      hits.set(k, { start: now, n: 1 });
      if (hits.size > 10000) hits.clear();
      return next();
    }
    if (++h.n > limit) return res.status(429).json({ error: 'too many requests, try again in a minute' });
    return next();
  };
}

// Express 5 forwards rejected promises to the error handler; this keeps the
// route bodies short.
const str = (v, { min = 1, max = 120, name }) => {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) throw bad(`${name} must be ${min}-${max} characters`);
  return v.trim();
};
const int = (v, { min = 0, max = 10_000_000, name }) => {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
  return v;
};

const publicUser = ({ id, email, name, role, active }) => ({ id, email, name, role, active });
const publicProduct = ({ id, sku, name, category, priceCents, taxRateBp, stock, active, refundable }) => ({
  id,
  sku,
  name,
  category,
  priceCents,
  taxRateBp,
  stock,
  active,
  refundable: refundable !== false,
});
const publicStore = ({ id, slug, name, currency, refundWindowDays }) => ({ id, slug, name, currency, refundWindowDays: refundWindowDays ?? 30 });

/** The policy line printed on every receipt. */
function policyText(store, lines) {
  const days = store.refundWindowDays ?? 30;
  const finalSale = lines.some((l) => l.refundable === false);
  return `Refunds within ${days} days with this receipt.${finalSale ? ' Items marked * are final sale.' : ''}`;
}

/** Day window in UTC for a local calendar date; tz = minutes east of UTC (Toronto summer = -240). */
function dayWindow(date, tz) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw bad('date must be YYYY-MM-DD');
  const offset = Number.isInteger(Number(tz)) ? Number(tz) : 0;
  if (Math.abs(offset) > 14 * 60) throw bad('tz must be minutes east of UTC (-840..840)');
  const [y, m, d] = date.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) - offset * 60000;
  return { from: new Date(start).toISOString(), to: new Date(start + 86400000).toISOString() };
}

function buildReceipt(store, rawSale) {
  const sale = withRefundTotals(rawSale);
  return {
    store: { name: store.name, slug: store.slug, currency: store.currency },
    policy: policyText(store, sale.lines),
    refundBy: refundDeadline(sale, store.refundWindowDays ?? 30),
    receiptNo: sale.receiptNo,
    saleId: sale.id,
    createdAt: sale.createdAt,
    cashier: sale.cashierName,
    lines: sale.lines.map(({ lineNo, sku, name, qty, unitPriceCents, taxRateBp, discountCents, promotionName, refundable, lineSubtotalCents, lineTaxCents, refundedQty, refundedSubtotalCents, refundedTaxCents }) => ({
      lineNo,
      discountCents: discountCents ?? 0,
      promotionName: promotionName ?? null,
      refundable: refundable !== false,
      sku,
      name,
      qty,
      unitPriceCents,
      taxRateBp,
      lineSubtotalCents,
      lineTaxCents,
      refundedQty,
      refundedSubtotalCents,
      refundedTaxCents,
    })),
    subtotalCents: sale.subtotalCents,
    discountCents: sale.discountCents ?? 0,
    taxCents: sale.taxCents,
    totalCents: sale.totalCents,
    payment: sale.payment,
    status: sale.status,
    refundedAt: sale.refundedAt,
    refundState: sale.refundState,
    refundedCents: sale.refundedCents,
    refunds: sale.refunds.map(publicRefund),
  };
}

const publicRefund = ({ id, refundNo, seq, createdAt, cashierName, method, reason, policyOverride, lines, subtotalCents, taxCents, totalCents }) => ({
  id,
  refundNo,
  seq,
  createdAt,
  cashierName,
  method,
  reason,
  policyOverride: Boolean(policyOverride),
  lines: lines.map(({ lineNo, sku, name, qty, lineSubtotalCents, lineTaxCents }) => ({ lineNo, sku, name, qty, lineSubtotalCents, lineTaxCents })),
  subtotalCents,
  taxCents,
  totalCents,
});

/**
 * Daily report over the sales made on a day. Refunds are counted against the
 * day of the original sale, so "net sales" for a day is what that day's sales
 * are finally worth after any returns.
 */
function summarise(rawSales) {
  const sales = rawSales.map(withRefundTotals);
  const byPayment = { cash: { count: 0, totalCents: 0 }, card: { count: 0, totalCents: 0 } };
  const products = new Map();
  let refundsCount = 0;
  let refundedTax = 0;
  let refundedSub = 0;
  for (const s of sales) {
    byPayment[s.payment.method].count += 1;
    byPayment[s.payment.method].totalCents += s.totalCents - s.refundedCents;
    refundsCount += s.refundState !== 'none' && s.refunds.length === 0 ? 1 : s.refunds.length; // v2.0 whole-sale refunds have no rows
    for (const l of s.lines) {
      refundedTax += l.refundedTaxCents;
      refundedSub += l.refundedSubtotalCents;
      const p = products.get(l.sku) || { sku: l.sku, name: l.name, qty: 0, revenueCents: 0 };
      p.qty += l.qty - l.refundedQty;
      p.revenueCents += l.lineSubtotalCents - l.refundedSubtotalCents;
      products.set(l.sku, p);
    }
  }
  const sum = (k) => sales.reduce((t, s) => t + s[k], 0);
  const grossCents = sum('totalCents');
  const refundedCents = sum('refundedCents');
  return {
    salesCount: sales.length,
    refundsCount,
    overridesCount: sales.reduce((n, s) => n + s.refunds.filter((r) => r.policyOverride).length, 0),
    discountCents: sales.reduce((t, s) => t + (s.discountCents ?? 0), 0),
    grossCents,
    refundedCents,
    netSalesCents: grossCents - refundedCents,
    taxCents: sum('taxCents') - refundedTax,
    netCents: sum('subtotalCents') - refundedSub,
    averageSaleCents: sales.length ? Math.round(grossCents / sales.length) : 0,
    byPayment,
    topProducts: [...products.values()]
      .filter((p) => p.qty > 0)
      .sort((a, b) => b.qty - a.qty || b.revenueCents - a.revenueCents)
      .slice(0, 5),
  };
}

/**
 * Build the Express app. Adapters are injected so the same code runs against
 * Azure (SQL / Blob / Key Vault) or fully in memory for unit tests.
 */
function createApp({ config, db, blobs, secrets, state = { ready: true, schemaVersion: MIGRATIONS.at(-1).version }, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '128kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      'X-EURC-Version': config.build.version,
      'X-EURC-Environment': config.environment,
    });
    next();
  });

  // ---- token signing key (Key Vault) ---------------------------------------
  const keyState = { value: null, refreshedAt: 0 };
  async function signingKey({ refresh = false } = {}) {
    if (keyState.value && !refresh) return keyState.value;
    if (refresh && Date.now() - keyState.refreshedAt < 60000) return keyState.value;
    let v = await secrets.get(SIGNING_SECRET);
    if (!v) {
      await secrets.set(SIGNING_SECRET, crypto.randomBytes(48).toString('base64url'));
      v = await secrets.get(SIGNING_SECRET); // read back: if two instances raced, both use the last write
    }
    keyState.value = v;
    keyState.refreshedAt = Date.now();
    return v;
  }

  const info = () => ({
    app: 'eURC POS',
    version: config.build.version,
    commit: config.build.commit,
    buildTime: config.build.buildTime,
    pipelineRun: config.build.runId,
    environment: config.environment,
    slot: config.slot,
    region: config.region,
    node: process.version,
    store: db.kind,
  });

  // ---- health ------------------------------------------------------------
  app.get('/health/live', (req, res) => res.json({ status: 'Alive' }));

  app.get('/health', async (req, res) => {
    const base = { ...info(), schemaVersion: state.schemaVersion, expectedSchemaVersion: MIGRATIONS.at(-1).version };
    if (!state.ready) {
      return res.status(503).json({ status: state.error ? 'Unhealthy' : 'Starting', error: state.error, ...base, checks: {} });
    }
    const probe = async (name, fn) => {
      const t0 = Date.now();
      try {
        await withTimeout(fn(), 5000, name);
        return [name, { status: 'Healthy', ms: Date.now() - t0 }];
      } catch (err) {
        return [name, { status: 'Unhealthy', ms: Date.now() - t0, error: err.message }];
      }
    };
    const checks = Object.fromEntries(
      await Promise.all([probe('sql', () => db.ping()), probe('blob', () => blobs.ping()), probe('keyVault', () => secrets.ping())]),
    );
    const schemaOk = state.schemaVersion >= MIGRATIONS.at(-1).version;
    const healthy = schemaOk && Object.values(checks).every((c) => c.status === 'Healthy');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'Healthy' : 'Unhealthy', ...base, checks });
  });

  app.get('/api/info', (req, res) => res.json(info()));

  // ---- auth --------------------------------------------------------------
  async function issue(store, user) {
    const token = signToken({ sid: store.id, uid: user.id, role: user.role }, await signingKey());
    return { token, user: publicUser(user), store: publicStore(store) };
  }

  async function auth(req, res, next) {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'sign in required' });
    let claims = verifyToken(m[1], await signingKey());
    if (!claims) claims = verifyToken(m[1], await signingKey({ refresh: true })); // key rotated in Key Vault
    if (!claims) return res.status(401).json({ error: 'session expired, please sign in again' });
    const [user, store] = await Promise.all([db.getUser(claims.sid, claims.uid), db.getStore(claims.sid)]);
    if (!user || !user.active || !store) return res.status(401).json({ error: 'account disabled' });
    req.user = user;
    req.store = store;
    return next();
  }
  // Every :id in a URL is a GUID. Anything else cannot exist: answer 404 here
  // instead of letting the database driver reject it as a 500.
  app.param('id', (req, res, next, id) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? next() : res.status(404).json({ error: 'not found' })));
  const managerOnly = (req, res, next) => (req.user.role === 'manager' ? next() : res.status(403).json({ error: 'manager role required' }));

  app.post('/api/stores', rateLimiter({ limit: 10, windowMs: 60000 }), async (req, res) => {
    const b = req.body || {};
    const slug = String(b.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) throw bad('store code must be 3-40 characters: lowercase letters, digits, hyphens');
    const storeName = str(b.storeName, { min: 2, name: 'store name' });
    const managerName = str(b.managerName, { min: 2, name: 'manager name' });
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad('a valid e-mail is required');
    const pwErr = validatePassword(b.password);
    if (pwErr) throw bad(pwErr);
    const store = { id: crypto.randomUUID(), slug, name: storeName };
    const manager = { id: crypto.randomUUID(), email, name: managerName, role: 'manager', passwordHash: hashPassword(b.password) };
    try {
      const saved = await db.createStore({ store, manager });
      res.status(201).json(await issue(saved, manager));
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, 'that store code is taken');
      throw err;
    }
  });

  app.post(
    '/api/auth/login',
    rateLimiter({ limit: 10, windowMs: 60000, key: (req) => `${req.ip}|${String(req.body?.store || '')}` }),
    async (req, res) => {
      const { store: slug, email, password } = req.body || {};
      const fail = () => res.status(401).json({ error: 'store code, e-mail or password is incorrect' });
      if (typeof slug !== 'string' || typeof email !== 'string' || typeof password !== 'string') return fail();
      const store = await db.getStoreBySlug(slug.toLowerCase());
      const user = store && (await db.findUserByEmail(store.id, email.trim().toLowerCase()));
      if (!user || !user.active || !verifyPassword(password, user.passwordHash)) return fail();
      return res.json(await issue(store, user));
    },
  );

  app.get('/api/me', auth, (req, res) =>
    res.json({ user: publicUser(req.user), store: publicStore(req.store) }),
  );

  // ---- store settings (refund policy) ----------------------------------------
  app.patch('/api/store/settings', auth, managerOnly, async (req, res) => {
    const b = req.body || {};
    if (b.refundWindowDays === undefined) throw bad('nothing to update');
    const days = int(b.refundWindowDays, { min: 0, max: 365, name: 'refundWindowDays' });
    res.json(publicStore(await db.updateStoreSettings(req.store.id, { refundWindowDays: days })));
  });

  // ---- users -------------------------------------------------------------
  app.get('/api/users', auth, managerOnly, async (req, res) => {
    res.json((await db.listUsers(req.store.id)).map(publicUser));
  });

  app.post('/api/users', auth, managerOnly, async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { min: 2, name: 'name' });
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad('a valid e-mail is required');
    const role = b.role || 'cashier';
    if (!ROLES.has(role)) throw bad('role must be manager or cashier');
    const pwErr = validatePassword(b.password);
    if (pwErr) throw bad(pwErr);
    try {
      const u = await db.createUser(req.store.id, { id: crypto.randomUUID(), email, name, role, passwordHash: hashPassword(b.password) });
      res.status(201).json(publicUser(u));
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, 'a user with that e-mail already exists');
      throw err;
    }
  });

  app.patch('/api/users/:id', auth, managerOnly, async (req, res) => {
    if (typeof req.body?.active !== 'boolean') throw bad('active (true/false) is required');
    if (req.params.id === req.user.id) throw bad('you cannot deactivate yourself');
    const u = await db.setUserActive(req.store.id, req.params.id, req.body.active);
    if (!u) throw new HttpError(404, 'user not found');
    res.json(publicUser(u));
  });

  // ---- products ----------------------------------------------------------
  app.get('/api/products', auth, async (req, res) => {
    const includeInactive = req.query.all === '1' && req.user.role === 'manager';
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : '';
    res.json((await db.listProducts(req.store.id, { q, includeInactive })).map(publicProduct));
  });

  function productInput(b, partial) {
    const out = {};
    if (!partial || b.sku !== undefined) {
      if (typeof b.sku !== 'string' || !SKU_RE.test(b.sku.trim())) throw bad('sku must be 1-40 letters, digits, . _ -');
      out.sku = b.sku.trim().toUpperCase();
    }
    if (!partial || b.name !== undefined) out.name = str(b.name, { min: 1, name: 'name' });
    if (b.category !== undefined) out.category = str(b.category, { min: 1, max: 60, name: 'category' });
    if (!partial || b.priceCents !== undefined) out.priceCents = int(b.priceCents, { max: 10_000_000, name: 'priceCents' });
    if (b.taxRateBp !== undefined) out.taxRateBp = int(b.taxRateBp, { max: 5000, name: 'taxRateBp' });
    if (b.stock !== undefined) out.stock = int(b.stock, { max: 1_000_000, name: 'stock' });
    if (b.refundable !== undefined) {
      if (typeof b.refundable !== 'boolean') throw bad('refundable must be true or false');
      out.refundable = b.refundable;
    } else if (!partial) {
      out.refundable = !FINAL_SALE_CATEGORIES.has(String(out.category || 'General').toLowerCase());
    }
    if (partial && b.active !== undefined) {
      if (typeof b.active !== 'boolean') throw bad('active must be true or false');
      out.active = b.active;
    }
    return out;
  }

  app.post('/api/products', auth, managerOnly, async (req, res) => {
    try {
      const p = await db.createProduct(req.store.id, { id: crypto.randomUUID(), ...productInput(req.body || {}, false) });
      res.status(201).json(publicProduct(p));
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, 'that SKU already exists');
      throw err;
    }
  });

  app.patch('/api/products/:id', auth, managerOnly, async (req, res) => {
    const patch = productInput(req.body || {}, true);
    if (Object.keys(patch).length === 0) throw bad('nothing to update');
    try {
      const p = await db.updateProduct(req.store.id, req.params.id, patch);
      if (!p) throw new HttpError(404, 'product not found');
      res.json(publicProduct(p));
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, 'that SKU already exists');
      throw err;
    }
  });

  // Excel / CSV import: rows already parsed by the browser. All rows are
  // validated first; nothing is saved unless every row is valid. Existing SKUs
  // are updated (only the columns given), new SKUs are added.
  app.post('/api/products/import', auth, managerOnly, async (req, res) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw bad('rows must be a non-empty array');
    if (rows.length > MAX_IMPORT_ROWS) throw bad(`at most ${MAX_IMPORT_ROWS} rows per import`);
    const existing = new Map((await db.listProducts(req.store.id, { includeInactive: true })).map((p) => [p.sku, p]));
    const seen = new Set();
    const errors = [];
    const plan = [];
    rows.forEach((raw, i) => {
      const row = i + 2; // spreadsheet row number (row 1 = headings)
      try {
        const sku = typeof raw?.sku === 'string' ? raw.sku.trim().toUpperCase() : raw?.sku;
        if (seen.has(sku)) throw bad(`SKU ${sku} appears twice in the file`);
        seen.add(sku);
        const found = existing.get(sku);
        if (found) {
          const patch = productInput({ ...raw, sku }, true);
          delete patch.sku;
          const changed = Object.keys(patch).filter((k) => patch[k] !== found[k]);
          plan.push({ row, action: changed.length ? 'update' : 'unchanged', sku, name: patch.name ?? found.name, changed, item: { id: found.id, ...patch } });
        } else {
          const p = productInput({ ...raw, sku }, false);
          if (raw.active !== undefined) {
            if (typeof raw.active !== 'boolean') throw bad('active must be true or false');
            p.active = raw.active;
          }
          plan.push({ row, action: 'create', sku, name: p.name, changed: [], item: { create: true, id: crypto.randomUUID(), ...p } });
        }
      } catch (err) {
        errors.push({ row, sku: raw?.sku ?? null, error: err.message });
      }
    });
    const summary = {
      created: plan.filter((p) => p.action === 'create').length,
      updated: plan.filter((p) => p.action === 'update').length,
      unchanged: plan.filter((p) => p.action === 'unchanged').length,
      errors,
      rows: plan.map(({ row, action, sku, name, changed }) => ({ row, action, sku, name, changed })),
    };
    if (errors.length) return res.status(400).json({ error: `${errors.length} row(s) need fixing; nothing was imported`, ...summary });
    if (req.body.dryRun) return res.json({ dryRun: true, ...summary });
    const items = plan.filter((p) => p.action !== 'unchanged').map((p) => p.item);
    try {
      if (items.length) await db.saveProducts(req.store.id, items);
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, 'a SKU in the file clashes with another product');
      throw err;
    }
    res.json({ dryRun: false, ...summary });
  });

  // Batch price / tax change for selected products, one category, or all.
  // price: { mode: 'set' | 'percent' | 'amount', value } - percent in basis
  // points (+500 = +5 %), amount in cents (may be negative). Preview with dryRun.
  app.post('/api/products/bulk-update', auth, managerOnly, async (req, res) => {
    const b = req.body || {};
    const all = await db.listProducts(req.store.id, { includeInactive: true });
    let targets;
    if (Array.isArray(b.productIds)) {
      if (b.productIds.length === 0 || b.productIds.length > MAX_IMPORT_ROWS) throw bad(`productIds must list 1-${MAX_IMPORT_ROWS} products`);
      const ids = new Set(b.productIds);
      targets = all.filter((p) => ids.has(p.id));
      if (targets.length !== ids.size) throw new HttpError(404, 'some products were not found in this store');
    } else if (typeof b.category === 'string' && b.category.trim()) {
      targets = all.filter((p) => p.category.toLowerCase() === b.category.trim().toLowerCase());
    } else if (b.all === true) targets = all;
    else throw bad('choose productIds, a category, or all: true');
    if (targets.length === 0) throw bad('no products match');
    if (b.price === undefined && b.taxRateBp === undefined) throw bad('give a price change and/or taxRateBp');
    const tax = b.taxRateBp === undefined ? undefined : int(b.taxRateBp, { max: 5000, name: 'taxRateBp' });
    let price = null;
    if (b.price !== undefined) {
      const { mode, value } = b.price || {};
      if (!['set', 'percent', 'amount'].includes(mode)) throw bad("price.mode must be 'set', 'percent' or 'amount'");
      if (!Number.isInteger(value)) throw bad('price.value must be a whole number (cents, or basis points for percent)');
      if (mode === 'set') int(value, { max: 10_000_000, name: 'price.value' });
      if (mode === 'percent' && (value < -10000 || value > 100000)) throw bad('price.value must be -10000..100000 basis points');
      price = (cents) => {
        if (mode === 'set') return value;
        if (mode === 'amount') return cents + value;
        const raw = (cents * (10000 + value)) / 10000;
        return Math.sign(raw) * Math.round(Math.abs(raw));
      };
    }
    const changes = targets.map((p) => {
      const after = { priceCents: price ? price(p.priceCents) : p.priceCents, taxRateBp: tax ?? p.taxRateBp };
      return { id: p.id, sku: p.sku, name: p.name, before: { priceCents: p.priceCents, taxRateBp: p.taxRateBp }, after };
    });
    const negative = changes.find((c) => c.after.priceCents < 0 || c.after.priceCents > 10_000_000);
    if (negative) throw bad(`${negative.sku} would end up at an invalid price (${negative.after.priceCents} cents)`);
    if (!b.dryRun) {
      const items = changes
        .filter((c) => c.after.priceCents !== c.before.priceCents || c.after.taxRateBp !== c.before.taxRateBp)
        .map((c) => ({ id: c.id, priceCents: c.after.priceCents, taxRateBp: c.after.taxRateBp }));
      if (items.length) await db.saveProducts(req.store.id, items);
    }
    res.json({ dryRun: Boolean(b.dryRun), count: changes.length, changes });
  });

  // ---- promotions ---------------------------------------------------------
  app.get('/api/promotions', auth, async (req, res) => {
    const list = await db.listPromotions(req.store.id);
    const now = new Date();
    const state = (p) => (isRunning(p, now) ? 'running' : p.active && new Date(p.startsAt) > now ? 'scheduled' : 'ended');
    const out = list.map((p) => ({ ...p, running: isRunning(p, now), state: state(p) }));
    // cashiers only need what is running now (for the register preview)
    res.json(req.user.role === 'manager' && req.query.running !== '1' ? out : out.filter((p) => p.running));
  });

  app.post('/api/promotions', auth, managerOnly, async (req, res) => {
    const p = promotionInput(req.body || {});
    res.status(201).json(await db.createPromotion(req.store.id, { id: crypto.randomUUID(), ...p }));
  });

  app.patch('/api/promotions/:id', auth, managerOnly, async (req, res) => {
    const patch = promotionInput(req.body || {}, { partial: true });
    for (const k of ['kind', 'value', 'target', 'category', 'skus']) {
      if (patch[k] !== undefined) throw bad('kind, value and target cannot change: end this promotion and create a new one');
    }
    if (Object.keys(patch).length === 0) throw bad('nothing to update');
    const p = await db.updatePromotion(req.store.id, req.params.id, patch);
    if (!p) throw new HttpError(404, 'promotion not found');
    res.json(p);
  });

  // ---- sales -------------------------------------------------------------
  app.post('/api/sales', auth, async (req, res) => {
    const basket = normaliseBasket(req.body?.items);
    const found = await db.getProductsByIds(req.store.id, basket.map((i) => i.productId));
    const byId = new Map(found.map((p) => [p.id, p]));
    const items = basket.map(({ productId, qty }) => {
      const product = byId.get(productId);
      if (!product || !product.active) throw bad(`product ${productId} is not for sale in this store`);
      return { product, qty };
    });
    const now = new Date();
    const running = (await db.listPromotions(req.store.id)).filter((p) => isRunning(p, now));
    const priced = priceBasket(items, running, now);
    const payment = settlePayment(req.body?.payment, priced.totalCents);
    const id = crypto.randomUUID();
    let sale;
    try {
      sale = await db.recordSale(req.store.id, {
        id,
        cashierId: req.user.id,
        cashierName: req.user.name,
        subtotalCents: priced.subtotalCents,
        taxCents: priced.taxCents,
        discountCents: priced.discountCents,
        totalCents: priced.totalCents,
        payment,
        lines: priced.lines,
        receiptBlob: `receipts/${req.store.id}/${id}.json`,
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_STOCK') throw new HttpError(409, `not enough stock for ${err.sku}`);
      throw err;
    }
    const receipt = buildReceipt(req.store, sale);
    try {
      await blobs.putJson(sale.receiptBlob, receipt);
    } catch (err) {
      // The sale is committed; the receipt can always be rebuilt from SQL.
      log.error?.(`[receipt] blob write failed for ${sale.id}: ${err.message}`);
    }
    res.status(201).json({ sale, receipt });
  });

  app.get('/api/sales', auth, async (req, res) => {
    const opts = { limit: Math.min(Number(req.query.limit) || 50, 200) };
    if (req.query.date) Object.assign(opts, dayWindow(req.query.date, req.query.tz));
    res.json((await db.listSales(req.store.id, opts)).map(withRefundTotals));
  });

  app.get('/api/sales/:id', auth, async (req, res) => {
    const s = await db.getSale(req.store.id, req.params.id);
    if (!s) throw new HttpError(404, 'sale not found');
    res.json(withRefundTotals(s));
  });

  app.get('/api/sales/:id/receipt', auth, async (req, res) => {
    const s = await db.getSale(req.store.id, req.params.id);
    if (!s) throw new HttpError(404, 'sale not found');
    const stored = await blobs.getJson(s.receiptBlob);
    // SQL is the source of truth for refunds; the stored receipt keeps the
    // original as printed (receipts written by v2.0 have no line numbers).
    const live = buildReceipt(req.store, s);
    const receipt = stored
      ? { ...stored, lines: live.lines, status: live.status, refundedAt: live.refundedAt, refundState: live.refundState, refundedCents: live.refundedCents, refunds: live.refunds, policy: stored.policy ?? live.policy, refundBy: live.refundBy, discountCents: live.discountCents }
      : live;
    res.json({ ...receipt, source: stored ? 'blob' : 'rebuilt' });
  });

  async function refund(req, requested) {
    const b = req.body || {};
    const reason = b.reason === undefined || b.reason === '' ? null : str(b.reason, { min: 1, max: 200, name: 'reason' });
    if (b.override !== undefined && typeof b.override !== 'boolean') throw bad('override must be true or false');
    const override = b.override === true;
    if (override && (!reason || reason.length < 5)) throw bad('a policy override needs a reason (at least 5 characters)');
    const meta = { id: crypto.randomUUID(), cashierId: req.user.id, cashierName: req.user.name, reason, policyOverride: override };
    const policy = { windowDays: req.store.refundWindowDays ?? 30, now: new Date(), override };
    let out;
    try {
      out = await db.recordRefund(req.store.id, req.params.id, meta, (sale) => planRefund(sale, requested, policy));
    } catch (err) {
      if (['NOTHING_TO_REFUND', 'OVER_REFUND', 'POLICY'].includes(err.code)) throw new HttpError(409, err.message);
      throw err;
    }
    if (!out) throw new HttpError(404, 'sale not found');
    const sale = withRefundTotals(out.sale);
    const r = sale.refunds.find((x) => x.id === out.refund.id);
    const receipt = buildReceipt(req.store, out.sale);
    try {
      await blobs.putJson(sale.receiptBlob.replace(/\.json$/, `-R${r.seq}.json`), { store: receipt.store, receiptNo: sale.receiptNo, saleId: sale.id, ...publicRefund(r) });
      await blobs.putJson(sale.receiptBlob, receipt);
    } catch (err) {
      // The refund is committed; its receipt can always be rebuilt from SQL.
      log.error?.(`[refund] blob write failed for ${sale.id}: ${err.message}`);
    }
    return { sale, refund: publicRefund(r), receipt };
  }

  // Refund chosen lines: { items: [{ lineNo, qty }], reason? }
  app.post('/api/sales/:id/refunds', auth, managerOnly, async (req, res) => {
    if (req.body?.items === undefined) throw bad('items is required: [{ lineNo, qty }]');
    res.status(201).json(await refund(req, req.body.items));
  });

  // Refund everything not yet refunded (the v2.0 API, kept for compatibility).
  app.post('/api/sales/:id/refund', auth, managerOnly, async (req, res) => {
    res.json((await refund(req, undefined)).sale);
  });

  // ---- reports -----------------------------------------------------------
  app.get('/api/reports/daily', auth, managerOnly, async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const w = dayWindow(date, req.query.tz);
    const sales = await db.listSales(req.store.id, { ...w, limit: 500 });
    res.json({ date, tz: Number(req.query.tz) || 0, currency: req.store.currency, ...summarise(sales) });
  });

  // ---- store lifecycle (used by the test suites to clean up) -------------
  app.delete('/api/stores/current', auth, managerOnly, async (req, res) => {
    if (req.body?.confirm !== req.store.slug) throw bad('confirm must equal the store code');
    await blobs.deletePrefix(`receipts/${req.store.id}/`);
    await db.deleteStore(req.store.id);
    res.status(204).end();
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // ---- React single-page app ----------------------------------------------
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { maxAge: '1h', index: false }));
  const indexFile = path.join(publicDir, 'index.html');
  app.get(/^\/(?!api\/|health).*/, (req, res, next) => {
    if (!fs.existsSync(indexFile)) return next();
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(indexFile);
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    log.error?.('[error]', req.method, req.path, err.message);
    return res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp, dayWindow, summarise, SLUG_RE };
