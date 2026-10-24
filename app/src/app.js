'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { MIGRATIONS } = require('./migrations');
const { priceBasket, normaliseBasket } = require('./domain/pricing');
const { settlePayment } = require('./domain/payments');
const { periodWindow, buildTaxReport } = require('./domain/taxreport');
const { withRefundTotals, planRefund, refundDeadline } = require('./domain/refunds');
const { promotionInput, isRunning } = require('./domain/promotions');
const { ROLES, can, permissionsOf, assignableRoles } = require('./domain/permissions');
const { profileInput, publicProfile, bankInput, storeToday, STORE_TYPES, suggestedCategories } = require('./domain/business');
const { normaliseBarcode } = require('./domain/barcode');
const { changeInput } = require('./domain/reprice');
const { hashPassword, verifyPassword, validatePassword, signToken, verifyToken } = require('./domain/auth');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const SKU_RE = /^[A-Za-z0-9._-]{1,40}$/;
const SIGNING_SECRET = 'pos-token-signing-key';
const MAX_IMPORT_ROWS = 1000; // per request; the browser and the CLI send big files in batches
const MAX_LIST = 2000; // GET /api/products without paging (small stores, older clients)
// Without a category record saying otherwise, these categories are final sale by default.
const FINAL_SALE_CATEGORIES = new Set(['food']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

const publicUser = ({ id, email, name, role, active }) => ({ id, email, name, role, active, permissions: permissionsOf(role) });
const publicProduct = ({ id, sku, name, category, subcategory, barcode, expiresOn, priceCents, taxRateBp, stock, active, refundable }) => ({
  id,
  sku,
  name,
  category,
  subcategory: subcategory ?? null,
  barcode: barcode ?? null,
  expiresOn: expiresOn ?? null,
  priceCents,
  taxRateBp,
  stock,
  active,
  refundable: refundable !== false,
});
const publicStore = ({ id, slug, name, currency, refundWindowDays, profile }) => ({
  id,
  slug,
  name,
  currency,
  refundWindowDays: refundWindowDays ?? 30,
  profile: publicProfile(profile),
});

/** Business details a Canadian receipt should carry (legal name, address, GST/HST registration). */
function receiptHeader(store) {
  const p = store.profile || {};
  const a = p.address || {};
  const address = [a.line1, a.line2, [a.city, a.province, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {
    legalName: p.legalName || null,
    address: address || null,
    phone: p.phone || null,
    taxNumbers: [p.gstHstNumber && `GST/HST ${p.gstHstNumber}`, p.pstNumber && `PST ${p.pstNumber}`, p.qstNumber && `QST ${p.qstNumber}`].filter(Boolean),
  };
}

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
    store: { name: store.name, slug: store.slug, currency: store.currency, ...receiptHeader(store) },
    policy: policyText(store, sale.lines),
    refundBy: refundDeadline(sale, store.refundWindowDays ?? 30),
    receiptNo: sale.receiptNo,
    saleId: sale.id,
    createdAt: sale.createdAt,
    cashier: sale.cashierName,
    lines: sale.lines.map(
      ({
        lineNo,
        sku,
        name,
        qty,
        unitPriceCents,
        taxRateBp,
        discountCents,
        promotionName,
        refundable,
        lineSubtotalCents,
        lineTaxCents,
        refundedQty,
        refundedSubtotalCents,
        refundedTaxCents,
      }) => ({
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
      }),
    ),
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
  // cash and card always listed (v2.0-v2.3 clients read them); v2.4 adds debit, credit, etransfer, stripe as they occur
  const byPayment = { cash: { count: 0, totalCents: 0 }, card: { count: 0, totalCents: 0 } };
  const products = new Map();
  let refundsCount = 0;
  let refundedTax = 0;
  let refundedSub = 0;
  for (const s of sales) {
    byPayment[s.payment.method] ??= { count: 0, totalCents: 0 };
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
  // imports send up to 1000 rows per request; everything else stays small
  app.use('/api/products/import', express.json({ limit: '2mb' }));
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

  // Readiness: started and the database schema is current. Used by the slot
  // swap warm-up, so a slow first connection to a dependency cannot cancel a
  // release; /health (below) still checks every dependency for monitoring.
  app.get('/health/ready', (req, res) => {
    const ok = state.ready && state.schemaVersion >= MIGRATIONS.at(-1).version;
    res.status(ok ? 200 : 503).json({ status: ok ? 'Ready' : 'Starting', version: config.build.version, schemaVersion: state.schemaVersion });
  });

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
  app.param('id', (req, res, next, id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? next() : res.status(404).json({ error: 'not found' }),
  );
  /** Route guard: the signed-in user's role must have this permission (domain/permissions.js). */
  const need = (permission) => (req, res, next) =>
    can(req.user.role, permission) ? next() : res.status(403).json({ error: `your role (${req.user.role}) cannot do this (${permission})` });

  app.post('/api/stores', rateLimiter({ limit: 10, windowMs: 60000 }), async (req, res) => {
    const b = req.body || {};
    const slug = String(b.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) throw bad('store code must be 3-40 characters: lowercase letters, digits, hyphens');
    const storeName = str(b.storeName, { min: 2, name: 'store name' });
    const managerName = str(b.managerName, { min: 2, name: 'manager name' });
    const email = String(b.email || '')
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad('a valid e-mail is required');
    const pwErr = validatePassword(b.password);
    if (pwErr) throw bad(pwErr);
    const store = { id: crypto.randomUUID(), slug, name: storeName };
    // the person who opens the store is its first Admin
    const manager = { id: crypto.randomUUID(), email, name: managerName, role: 'admin', passwordHash: hashPassword(b.password) };
    try {
      const saved = await db.createStore({ store, manager });
      res.status(201).json(await issue(saved, manager));
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, 'that store code is taken');
      throw err;
    }
  });

  app.post('/api/auth/login', rateLimiter({ limit: 10, windowMs: 60000, key: (req) => `${req.ip}|${String(req.body?.store || '')}` }), async (req, res) => {
    const { store: slug, email, password } = req.body || {};
    const fail = () => res.status(401).json({ error: 'store code, e-mail or password is incorrect' });
    if (typeof slug !== 'string' || typeof email !== 'string' || typeof password !== 'string') return fail();
    const store = await db.getStoreBySlug(slug.toLowerCase());
    const user = store && (await db.findUserByEmail(store.id, email.trim().toLowerCase()));
    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) return fail();
    return res.json(await issue(store, user));
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user), store: publicStore(req.store) }));

  // ---- store settings (refund policy) ----------------------------------------
  app.patch('/api/store/settings', auth, need('store.settings'), async (req, res) => {
    const b = req.body || {};
    if (b.refundWindowDays === undefined) throw bad('nothing to update');
    const days = int(b.refundWindowDays, { min: 0, max: 365, name: 'refundWindowDays' });
    res.json(publicStore(await db.updateStoreSettings(req.store.id, { refundWindowDays: days })));
  });

  // ---- users -------------------------------------------------------------
  app.get('/api/users', auth, need('staff.manage'), async (req, res) => {
    res.json((await db.listUsers(req.store.id)).map(publicUser));
  });

  app.post('/api/users', auth, need('staff.manage'), async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { min: 2, name: 'name' });
    const email = String(b.email || '')
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad('a valid e-mail is required');
    const role = b.role || 'cashier';
    if (!ROLES.includes(role)) throw bad(`role must be one of: ${ROLES.join(', ')}`);
    if (!assignableRoles(req.user.role).includes(role)) throw new HttpError(403, `a ${req.user.role} cannot add a ${role}`);
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

  // Change a staff member's role and/or deactivate them. Managers cannot touch
  // admins; nobody can lock themselves out; the store always keeps an admin.
  app.patch('/api/users/:id', auth, need('staff.manage'), async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.active !== undefined) {
      if (typeof b.active !== 'boolean') throw bad('active must be true or false');
      patch.active = b.active;
    }
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) throw bad(`role must be one of: ${ROLES.join(', ')}`);
      patch.role = b.role;
    }
    if (Object.keys(patch).length === 0) throw bad('give active and/or role');
    if (req.params.id === req.user.id) throw bad('you cannot change your own role or deactivate yourself');
    const staff = await db.listUsers(req.store.id);
    const target = staff.find((u) => u.id === req.params.id);
    if (!target) throw new HttpError(404, 'user not found');
    const allowed = assignableRoles(req.user.role);
    if (!allowed.includes(target.role) || (patch.role && !allowed.includes(patch.role))) {
      throw new HttpError(403, `a ${req.user.role} cannot change a ${target.role}${patch.role ? ` into a ${patch.role}` : ''}`);
    }
    const losesAdmin = target.role === 'admin' && target.active && (patch.active === false || (patch.role && patch.role !== 'admin'));
    if (losesAdmin && staff.filter((u) => u.role === 'admin' && u.active).length === 1) throw bad('the store must keep at least one active admin');
    const u = await db.updateUser(req.store.id, req.params.id, patch);
    res.json(publicUser(u));
  });

  // ---- business profile (Admin) ---------------------------------------------
  app.get('/api/store/profile', auth, async (req, res) => {
    res.json({ ...publicStore(req.store), storeTypes: STORE_TYPES });
  });

  app.put('/api/store/profile', auth, need('business.profile'), async (req, res) => {
    const b = req.body || {};
    const profile = profileInput(b, req.store.profile || {});
    if (b.bank !== undefined) {
      if (b.bank === null) {
        await secrets.remove?.(`bank-${req.store.id}`);
        profile.bank = null;
      } else {
        const bank = bankInput(b.bank);
        // the full numbers live only in Key Vault; the database keeps a masked copy
        await secrets.set(`bank-${req.store.id}`, JSON.stringify(bank.secret));
        profile.bank = bank.masked;
      }
    }
    const patch = { profile };
    if (b.storeName !== undefined) patch.name = str(b.storeName, { min: 2, name: 'store name' });
    const saved = await db.updateStoreSettings(req.store.id, patch);
    res.json({ ...publicStore(saved), storeTypes: STORE_TYPES });
  });

  // ---- categories and sub-categories -------------------------------------
  app.get('/api/categories', auth, async (req, res) => {
    res.json(await db.listCategories(req.store.id));
  });

  app.post('/api/categories', auth, need('categories.manage'), async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { min: 1, max: 60, name: 'name' });
    let parentId = null;
    if (b.parentId) {
      const parent = (await db.listCategories(req.store.id)).find((c) => c.id === b.parentId);
      if (!parent) throw bad('parent category not found');
      if (parent.parentId) throw bad('sub-categories cannot have sub-categories (two levels)');
      parentId = parent.id;
    }
    if (b.finalSale !== undefined && typeof b.finalSale !== 'boolean') throw bad('finalSale must be true or false');
    try {
      res.status(201).json(await db.createCategory(req.store.id, { id: crypto.randomUUID(), name, parentId, finalSale: b.finalSale === true }));
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, `category "${name}" already exists here`);
      throw err;
    }
  });

  app.patch('/api/categories/:id', auth, need('categories.manage'), async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = str(b.name, { min: 1, max: 60, name: 'name' });
    if (b.finalSale !== undefined) {
      if (typeof b.finalSale !== 'boolean') throw bad('finalSale must be true or false');
      patch.finalSale = b.finalSale;
    }
    if (Object.keys(patch).length === 0) throw bad('nothing to update');
    try {
      const c = await db.updateCategory(req.store.id, req.params.id, patch);
      if (!c) throw new HttpError(404, 'category not found');
      res.json(c);
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, 'a category with that name already exists here');
      throw err;
    }
  });

  // Store type -> a starter set of categories (skips any that already exist).
  app.post('/api/categories/suggested', auth, need('categories.manage'), async (req, res) => {
    const type = req.body?.storeType || req.store.profile?.storeType;
    const tree = suggestedCategories(type);
    if (!tree) throw bad(`storeType must be one of: ${STORE_TYPES.map((t) => t.id).join(', ')}`);
    const existing = await db.listCategories(req.store.id);
    const key = (name, parentId) => `${parentId || ''}|${name.toLowerCase()}`;
    const have = new Map(existing.map((c) => [key(c.name, c.parentId), c]));
    let created = 0;
    for (const top of tree) {
      let parent = have.get(key(top.name, null));
      if (!parent) {
        parent = await db.createCategory(req.store.id, { id: crypto.randomUUID(), name: top.name, parentId: null, finalSale: Boolean(top.finalSale) });
        created += 1;
      }
      for (const sub of top.subcategories || []) {
        if (have.has(key(sub, parent.id))) continue;
        await db.createCategory(req.store.id, { id: crypto.randomUUID(), name: sub, parentId: parent.id, finalSale: Boolean(top.finalSale) });
        created += 1;
      }
    }
    res.json({ created, categories: await db.listCategories(req.store.id) });
  });

  // ---- products ----------------------------------------------------------
  function searchOptions(req) {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    const o = { q, includeInactive: req.query.all === '1' && can(req.user.role, 'products.manage') };
    if (typeof req.query.category === 'string' && req.query.category) o.category = req.query.category.slice(0, 60);
    if (typeof req.query.subcategory === 'string' && req.query.subcategory) o.subcategory = req.query.subcategory.slice(0, 60);
    if (req.query.expiring !== undefined) {
      // expiring=N: expires within N days (store time zone); expiring=0: already expired
      const days = Number(req.query.expiring);
      if (!Number.isInteger(days) || days < 0 || days > 365) throw bad('expiring must be 0-365 days');
      const d = new Date(`${storeToday(req.store)}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      o.expiresBefore = d.toISOString().slice(0, 10);
    }
    return o;
  }

  // Without ?limit: a plain array (up to 2000) as in earlier versions.
  // With ?limit=&offset=: { items, total, limit, offset } - for big catalogues.
  app.get('/api/products', auth, async (req, res) => {
    const o = searchOptions(req);
    if (req.query.limit === undefined) {
      const r = await db.searchProducts(req.store.id, { ...o, limit: MAX_LIST, offset: 0 });
      return res.json(r.items.map(publicProduct));
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const r = await db.searchProducts(req.store.id, { ...o, limit, offset });
    return res.json({ items: r.items.map(publicProduct), total: r.total, limit, offset });
  });

  // Barcode scanner / SKU entry at the till: one exact match.
  app.get('/api/products/lookup', auth, async (req, res) => {
    const code = String(req.query.code || '')
      .trim()
      .toUpperCase();
    if (!code || code.length > 40) throw bad('code is required');
    const p = await db.findProductByCode(req.store.id, code);
    if (!p || (!p.active && !can(req.user.role, 'products.manage'))) throw new HttpError(404, `no product with barcode or SKU ${code}`);
    res.json(publicProduct(p));
  });

  /** Names of categories / sub-categories the store marked as final sale. */
  async function finalSaleNames(storeId) {
    const cats = await db.listCategories(storeId);
    const set = new Set(cats.filter((c) => c.finalSale).map((c) => c.name.toLowerCase()));
    const known = new Set(cats.map((c) => c.name.toLowerCase()));
    return { set, known };
  }

  function productInput(b, partial, finalSale = { set: new Set(), known: new Set() }) {
    const out = {};
    if (!partial || b.sku !== undefined) {
      if (typeof b.sku !== 'string' || !SKU_RE.test(b.sku.trim())) throw bad('sku must be 1-40 letters, digits, . _ -');
      out.sku = b.sku.trim().toUpperCase();
    }
    if (!partial || b.name !== undefined) out.name = str(b.name, { min: 1, name: 'name' });
    if (b.category !== undefined) out.category = str(b.category, { min: 1, max: 60, name: 'category' });
    if (b.subcategory !== undefined)
      out.subcategory = b.subcategory === null || b.subcategory === '' ? null : str(b.subcategory, { min: 1, max: 60, name: 'subcategory' });
    if (b.barcode !== undefined) out.barcode = normaliseBarcode(b.barcode);
    if (b.expiresOn !== undefined) {
      if (b.expiresOn === null || b.expiresOn === '') out.expiresOn = null;
      else if (typeof b.expiresOn !== 'string' || !DATE_RE.test(b.expiresOn) || Number.isNaN(Date.parse(`${b.expiresOn}T00:00:00Z`)))
        throw bad('expiresOn must be a date YYYY-MM-DD');
      else out.expiresOn = b.expiresOn;
    }
    if (!partial || b.priceCents !== undefined) out.priceCents = int(b.priceCents, { max: 10_000_000, name: 'priceCents' });
    if (b.taxRateBp !== undefined) out.taxRateBp = int(b.taxRateBp, { max: 5000, name: 'taxRateBp' });
    if (b.stock !== undefined) out.stock = int(b.stock, { max: 1_000_000, name: 'stock' });
    if (b.refundable !== undefined) {
      if (typeof b.refundable !== 'boolean') throw bad('refundable must be true or false');
      out.refundable = b.refundable;
    } else if (!partial) {
      const names = [out.category || 'General', out.subcategory].filter(Boolean).map((n) => n.toLowerCase());
      const flagged = names.some((n) => finalSale.set.has(n));
      const fallback = !names.some((n) => finalSale.known.has(n)) && names.some((n) => FINAL_SALE_CATEGORIES.has(n));
      out.refundable = !(flagged || fallback);
    }
    if (partial && b.active !== undefined) {
      if (typeof b.active !== 'boolean') throw bad('active must be true or false');
      out.active = b.active;
    }
    return out;
  }
  const dupMessage = (err) => (err.field === 'barcode' ? 'that barcode is already used by another product' : 'that SKU already exists');

  app.post('/api/products', auth, need('products.manage'), async (req, res) => {
    try {
      const p = await db.createProduct(req.store.id, { id: crypto.randomUUID(), ...productInput(req.body || {}, false, await finalSaleNames(req.store.id)) });
      res.status(201).json(publicProduct(p));
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, dupMessage(err));
      throw err;
    }
  });

  app.patch('/api/products/:id', auth, need('products.manage'), async (req, res) => {
    const patch = productInput(req.body || {}, true);
    if (Object.keys(patch).length === 0) throw bad('nothing to update');
    try {
      const p = await db.updateProduct(req.store.id, req.params.id, patch);
      if (!p) throw new HttpError(404, 'product not found');
      res.json(publicProduct(p));
    } catch (err) {
      if (err.code === 'DUPLICATE') throw new HttpError(409, dupMessage(err));
      throw err;
    }
  });

  // Excel / CSV import: rows already parsed by the browser. All rows are
  // validated first; nothing is saved unless every row is valid. Existing SKUs
  // are updated (only the columns given), new SKUs are added.
  app.post('/api/products/import', auth, need('products.manage'), async (req, res) => {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw bad('rows must be a non-empty array');
    if (rows.length > MAX_IMPORT_ROWS) throw bad(`at most ${MAX_IMPORT_ROWS} rows per request (send big files in batches)`);
    // batches of a big file say where they start, so errors name the spreadsheet row
    const firstRow = Number.isInteger(req.body.startRow) && req.body.startRow >= 2 ? req.body.startRow : 2;
    const upper = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v);
    const skus = rows.map((r) => upper(r?.sku)).filter((v) => typeof v === 'string');
    const codes = rows.map((r) => (r?.barcode ? String(r.barcode).replace(/\s+/g, '').toUpperCase() : null)).filter(Boolean);
    const found0 = await db.findProductsByCodes(req.store.id, { skus, barcodes: codes });
    const existing = new Map(found0.map((p) => [p.sku, p]));
    const barcodeOwner = new Map(found0.filter((p) => p.barcode).map((p) => [p.barcode, p.sku]));
    const finalSale = await finalSaleNames(req.store.id);
    const seen = new Set();
    const seenCodes = new Map();
    const errors = [];
    const plan = [];
    rows.forEach((raw, i) => {
      const row = firstRow + i; // spreadsheet row number (row 1 = headings)
      try {
        const sku = upper(raw?.sku);
        if (seen.has(sku)) throw bad(`SKU ${sku} appears twice in the file`);
        seen.add(sku);
        const found = existing.get(sku);
        const checkBarcode = (code) => {
          if (!code) return;
          if (seenCodes.has(code)) throw bad(`barcode ${code} is also on row ${seenCodes.get(code)}`);
          seenCodes.set(code, row);
          const owner = barcodeOwner.get(code);
          if (owner && owner !== sku) throw bad(`barcode ${code} already belongs to ${owner}`);
        };
        if (found) {
          const patch = productInput({ ...raw, sku }, true);
          checkBarcode(patch.barcode);
          delete patch.sku;
          const changed = Object.keys(patch).filter((k) => patch[k] !== found[k]);
          plan.push({ row, action: changed.length ? 'update' : 'unchanged', sku, name: patch.name ?? found.name, changed, item: { id: found.id, ...patch } });
        } else {
          const p = productInput({ ...raw, sku }, false, finalSale);
          checkBarcode(p.barcode);
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
      if (err.code === 'DUPLICATE') throw new HttpError(409, `a ${err.field === 'barcode' ? 'barcode' : 'SKU'} in the file clashes with another product`);
      throw err;
    }
    res.json({ dryRun: false, ...summary });
  });

  // Batch price / tax change for selected products, one category, or all.
  // price: { mode: 'set' | 'percent' | 'amount', value } - percent in basis
  // points (+500 = +5 %), amount in cents (may be negative). Preview with dryRun.
  app.post('/api/products/bulk-update', auth, need('products.manage'), async (req, res) => {
    const b = req.body || {};
    let where;
    if (Array.isArray(b.productIds)) {
      if (b.productIds.length === 0 || b.productIds.length > MAX_IMPORT_ROWS) throw bad(`productIds must list 1-${MAX_IMPORT_ROWS} products`);
      where = { ids: [...new Set(b.productIds)] };
    } else if (typeof b.category === 'string' && b.category.trim()) where = { category: str(b.category, { max: 60, name: 'category' }) };
    else if (b.all === true) where = { all: true };
    else throw bad('choose productIds, a category, or all: true');
    const change = changeInput(b);
    // one statement / one transaction, however many products match
    const r = await db.repriceProducts(req.store.id, where, change, { dryRun: Boolean(b.dryRun), previewLimit: 50 });
    if (where.ids && r.count !== where.ids.length) throw new HttpError(404, 'some products were not found in this store');
    if (r.count === 0) throw bad('no products match');
    if (r.invalid) throw bad(`${r.invalid.sku} would end up at an invalid price (${r.invalid.priceCents} cents)`);
    res.json({ dryRun: Boolean(b.dryRun), count: r.count, changes: r.preview, more: Math.max(0, r.count - r.preview.length) });
  });

  // ---- promotions ---------------------------------------------------------
  app.get('/api/promotions', auth, async (req, res) => {
    const list = await db.listPromotions(req.store.id);
    const now = new Date();
    const state = (p) => (isRunning(p, now) ? 'running' : p.active && new Date(p.startsAt) > now ? 'scheduled' : 'ended');
    const out = list.map((p) => ({ ...p, running: isRunning(p, now), state: state(p) }));
    // cashiers only need what is running now (for the register preview)
    res.json(can(req.user.role, 'promotions.manage') && req.query.running !== '1' ? out : out.filter((p) => p.running));
  });

  app.post('/api/promotions', auth, need('promotions.manage'), async (req, res) => {
    const p = promotionInput(req.body || {});
    res.status(201).json(await db.createPromotion(req.store.id, { id: crypto.randomUUID(), ...p }));
  });

  app.patch('/api/promotions/:id', auth, need('promotions.manage'), async (req, res) => {
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
  app.post('/api/sales', auth, need('sales.create'), async (req, res) => {
    const basket = normaliseBasket(req.body?.items);
    const found = await db.getProductsByIds(
      req.store.id,
      basket.map((i) => i.productId),
    );
    const byId = new Map(found.map((p) => [p.id, p]));
    const items = basket.map(({ productId, qty }) => {
      const product = byId.get(productId);
      if (!product || !product.active) throw bad(`product ${productId} is not for sale in this store`);
      return { product, qty };
    });
    const today = storeToday(req.store);
    const expired = items.find(({ product }) => product.expiresOn && product.expiresOn < today);
    if (expired) throw new HttpError(409, `${expired.product.name} expired on ${expired.product.expiresOn} and cannot be sold`);
    const now = new Date();
    const running = (await db.listPromotions(req.store.id)).filter((p) => isRunning(p, now));
    const priced = priceBasket(items, running, now);
    const payment = settlePayment(req.body?.payment, priced.totalCents, publicProfile(req.store.profile).paymentMethods);
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
      ? {
          ...stored,
          lines: live.lines,
          status: live.status,
          refundedAt: live.refundedAt,
          refundState: live.refundState,
          refundedCents: live.refundedCents,
          refunds: live.refunds,
          policy: stored.policy ?? live.policy,
          refundBy: live.refundBy,
          discountCents: live.discountCents,
        }
      : live;
    res.json({ ...receipt, source: stored ? 'blob' : 'rebuilt' });
  });

  async function refund(req, requested) {
    const b = req.body || {};
    const reason = b.reason === undefined || b.reason === '' ? null : str(b.reason, { min: 1, max: 200, name: 'reason' });
    if (b.override !== undefined && typeof b.override !== 'boolean') throw bad('override must be true or false');
    const override = b.override === true;
    if (override && !can(req.user.role, 'refunds.override')) throw new HttpError(403, `your role (${req.user.role}) cannot override the refund policy`);
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
      await blobs.putJson(sale.receiptBlob.replace(/\.json$/, `-R${r.seq}.json`), {
        store: receipt.store,
        receiptNo: sale.receiptNo,
        saleId: sale.id,
        ...publicRefund(r),
      });
      await blobs.putJson(sale.receiptBlob, receipt);
    } catch (err) {
      // The refund is committed; its receipt can always be rebuilt from SQL.
      log.error?.(`[refund] blob write failed for ${sale.id}: ${err.message}`);
    }
    return { sale, refund: publicRefund(r), receipt };
  }

  // Refund chosen lines: { items: [{ lineNo, qty }], reason? }
  app.post('/api/sales/:id/refunds', auth, need('refunds.create'), async (req, res) => {
    if (req.body?.items === undefined) throw bad('items is required: [{ lineNo, qty }]');
    res.status(201).json(await refund(req, req.body.items));
  });

  // Refund everything not yet refunded (the v2.0 API, kept for compatibility).
  app.post('/api/sales/:id/refund', auth, need('refunds.create'), async (req, res) => {
    res.json((await refund(req, undefined)).sale);
  });

  // ---- reports -----------------------------------------------------------
  // GST/HST report for a period of calendar days in the store's time zone (v2.4).
  app.get('/api/reports/tax', auth, need('reports.tax'), async (req, res) => {
    const timeZone = publicProfile(req.store.profile).timeZone;
    const { from, to } = req.query;
    const w = periodWindow(from, to, timeZone);
    const raw = await db.taxReport(req.store.id, w);
    res.json(buildTaxReport(raw, { from, to, timeZone, store: req.store }));
  });

  app.get('/api/reports/daily', auth, need('reports.view'), async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const w = dayWindow(date, req.query.tz);
    const sales = await db.listSales(req.store.id, { ...w, limit: 500 });
    res.json({ date, tz: Number(req.query.tz) || 0, currency: req.store.currency, ...summarise(sales) });
  });

  // ---- store lifecycle (used by the test suites to clean up) -------------
  app.delete('/api/stores/current', auth, need('store.delete'), async (req, res) => {
    if (req.body?.confirm !== req.store.slug) throw bad('confirm must equal the store code');
    await blobs.deletePrefix(`receipts/${req.store.id}/`);
    if (req.store.profile?.bank) await secrets.remove?.(`bank-${req.store.id}`);
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
