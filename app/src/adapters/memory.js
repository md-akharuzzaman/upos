'use strict';

// In-memory adapters with exactly the same contract as the Azure ones.
// Used for local development (npm run dev) and unit tests in CI.

const { MIGRATIONS } = require('../migrations');
const { applyChange, outOfRange, matches } = require('../domain/reprice');

const dup = (what) => Object.assign(new Error(`${what} already exists`), { code: 'DUPLICATE', field: what });
const clone = (x) => (x == null ? x : structuredClone(x));
const noStore = (row) => {
  const out = clone(row);
  delete out.storeId;
  return out;
};

function createMemoryDb() {
  const stores = new Map();
  const users = new Map();
  const products = new Map();
  const sales = new Map();
  const promotions = new Map();
  const categories = new Map();

  const storeUsers = (storeId) => [...users.values()].filter((u) => u.storeId === storeId);
  const storeProducts = (storeId) => [...products.values()].filter((p) => p.storeId === storeId);

  return {
    kind: 'memory',
    sales, // tests only: lets a test shape data older versions wrote
    async init() {
      return { schemaVersion: MIGRATIONS.at(-1).version };
    },
    async ping() {
      return true;
    },
    async close() {},

    // ---- stores ------------------------------------------------------------
    async createStore({ store, manager }) {
      if ([...stores.values()].some((s) => s.slug === store.slug)) throw dup('store');
      const s = { currency: 'CAD', refundWindowDays: 30, ...store, createdAt: new Date().toISOString() };
      stores.set(s.id, s);
      users.set(manager.id, { ...manager, storeId: s.id, active: true, createdAt: s.createdAt });
      return clone(s);
    },
    async getStoreBySlug(slug) {
      return clone([...stores.values()].find((s) => s.slug === slug) || null);
    },
    async getStore(id) {
      return clone(stores.get(id) || null);
    },
    async updateStoreSettings(id, patch) {
      const s = stores.get(id);
      if (!s) return null;
      Object.assign(s, patch);
      return clone(s);
    },
    async countStores() {
      return stores.size;
    },
    async deleteStore(id) {
      for (const m of [users, products, sales, promotions, categories]) for (const [k, v] of m) if (v.storeId === id) m.delete(k);
      stores.delete(id);
    },

    // ---- users -------------------------------------------------------------
    async findUserByEmail(storeId, email) {
      return clone(storeUsers(storeId).find((u) => u.email === email) || null);
    },
    async getUser(storeId, id) {
      const u = users.get(id);
      return clone(u && u.storeId === storeId ? u : null);
    },
    async listUsers(storeId) {
      return storeUsers(storeId)
        .sort((a, b) => a.email.localeCompare(b.email))
        .map(clone);
    },
    async createUser(storeId, u) {
      if (storeUsers(storeId).some((x) => x.email === u.email)) throw dup('user');
      const row = { ...u, storeId, active: true, createdAt: new Date().toISOString() };
      users.set(u.id, row);
      return clone(row);
    },
    async updateUser(storeId, id, patch) {
      const u = users.get(id);
      if (!u || u.storeId !== storeId) return null;
      Object.assign(u, patch);
      return clone(u);
    },
    async setUserActive(storeId, id, active) {
      const u = users.get(id);
      if (!u || u.storeId !== storeId) return null;
      u.active = active;
      return clone(u);
    },

    // ---- products ----------------------------------------------------------
    async searchProducts(storeId, { q = '', includeInactive = false, category, subcategory, expiresBefore, limit = 50, offset = 0 } = {}) {
      const needle = q.toLowerCase();
      const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
      const all = storeProducts(storeId)
        .filter((p) => includeInactive || p.active)
        .filter(
          (p) => !needle || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle) || (p.barcode || '').toLowerCase().includes(needle),
        )
        .filter((p) => !category || eq(p.category, category))
        .filter((p) => !subcategory || eq(p.subcategory, subcategory))
        .filter((p) => !expiresBefore || (p.expiresOn && p.expiresOn <= expiresBefore))
        .sort((a, b) => (expiresBefore ? a.expiresOn.localeCompare(b.expiresOn) : 0) || a.name.localeCompare(b.name));
      return { items: all.slice(offset, offset + limit).map(clone), total: all.length };
    },
    async listProducts(storeId, opts = {}) {
      return (await this.searchProducts(storeId, { ...opts, limit: 100000 })).items;
    },
    async findProductByCode(storeId, code) {
      return clone(storeProducts(storeId).find((p) => p.barcode === code) || storeProducts(storeId).find((p) => p.sku === code) || null);
    },
    async findProductsByCodes(storeId, { skus = [], barcodes = [] }) {
      const s = new Set(skus);
      const b = new Set(barcodes);
      return storeProducts(storeId)
        .filter((p) => s.has(p.sku) || (p.barcode && b.has(p.barcode)))
        .map(clone);
    },
    /** One "statement": validates everything first, then changes all or nothing. */
    async repriceProducts(storeId, where, change, { dryRun = false, previewLimit = 50 } = {}) {
      const targets = storeProducts(storeId)
        .filter((p) => matches(p, where))
        .sort((a, b) => a.name.localeCompare(b.name));
      const changes = targets.map((p) => applyChange(p, change));
      const bad = changes.find(outOfRange);
      const result = {
        count: targets.length,
        preview: changes.slice(0, previewLimit),
        invalid: bad ? { sku: bad.sku, priceCents: bad.after.priceCents } : null,
      };
      if (dryRun || bad || (where.ids && targets.length !== where.ids.length)) return result;
      const now = new Date().toISOString();
      for (const c of changes) Object.assign(products.get(c.id), c.after, { updatedAt: now });
      return result;
    },
    async getProductsByIds(storeId, ids) {
      return ids
        .map((id) => products.get(id))
        .filter((p) => p && p.storeId === storeId)
        .map(clone);
    },
    async createProduct(storeId, p) {
      if (storeProducts(storeId).some((x) => x.sku === p.sku)) throw dup('sku');
      if (p.barcode && storeProducts(storeId).some((x) => x.barcode === p.barcode)) throw dup('barcode');
      const row = { category: 'General', taxRateBp: 1300, stock: 0, refundable: true, ...p, storeId, active: true, updatedAt: new Date().toISOString() };
      products.set(p.id, row);
      return clone(row);
    },
    async updateProduct(storeId, id, patch) {
      const p = products.get(id);
      if (!p || p.storeId !== storeId) return null;
      if (patch.sku && patch.sku !== p.sku && storeProducts(storeId).some((x) => x.sku === patch.sku)) throw dup('sku');
      if (patch.barcode && storeProducts(storeId).some((x) => x.id !== id && x.barcode === patch.barcode)) throw dup('barcode');
      Object.assign(p, patch, { updatedAt: new Date().toISOString() });
      return clone(p);
    },

    /**
     * All-or-nothing bulk write (Excel import, price/tax changes). Each item is
     * { id, ...fields } to update an existing product or { create: true, ... }
     * to add one. Fails with DUPLICATE before changing anything if a SKU clashes.
     */
    async saveProducts(storeId, items) {
      const mine = storeProducts(storeId);
      const skus = new Map(mine.map((p) => [p.sku, p.id]));
      const codes = new Map(mine.filter((p) => p.barcode).map((p) => [p.barcode, p.id]));
      for (const it of items) {
        if (!it.create && !products.has(it.id)) throw Object.assign(new Error(`product ${it.id} not found`), { status: 404 });
        if (it.sku !== undefined && skus.has(it.sku) && skus.get(it.sku) !== it.id) throw dup('sku');
        if (it.sku !== undefined) skus.set(it.sku, it.id);
        if (it.barcode && codes.has(it.barcode) && codes.get(it.barcode) !== it.id) throw dup('barcode');
        if (it.barcode) codes.set(it.barcode, it.id);
      }
      const now = new Date().toISOString();
      const out = [];
      for (const { create, ...it } of items) {
        if (create) {
          const row = { category: 'General', taxRateBp: 1300, stock: 0, refundable: true, active: true, ...it, storeId, updatedAt: now };
          products.set(it.id, row);
          out.push(clone(row));
        } else {
          const p = products.get(it.id);
          Object.assign(p, it, { updatedAt: now });
          out.push(clone(p));
        }
      }
      return out;
    },

    // ---- categories --------------------------------------------------------
    async listCategories(storeId) {
      return [...categories.values()]
        .filter((c) => c.storeId === storeId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(noStore);
    },
    async createCategory(storeId, c) {
      const clash = [...categories.values()].some(
        (x) => x.storeId === storeId && (x.parentId || null) === (c.parentId || null) && x.name.toLowerCase() === c.name.toLowerCase(),
      );
      if (clash) throw dup('category');
      const row = { finalSale: false, ...c, parentId: c.parentId || null, storeId, createdAt: new Date().toISOString() };
      categories.set(c.id, row);
      return noStore(row);
    },
    async updateCategory(storeId, id, patch) {
      const c = categories.get(id);
      if (!c || c.storeId !== storeId) return null;
      if (
        patch.name &&
        [...categories.values()].some(
          (x) => x.id !== id && x.storeId === storeId && x.parentId === c.parentId && x.name.toLowerCase() === patch.name.toLowerCase(),
        )
      ) {
        throw dup('category');
      }
      Object.assign(c, patch);
      return noStore(c);
    },

    // ---- promotions --------------------------------------------------------
    async listPromotions(storeId) {
      return [...promotions.values()]
        .filter((p) => p.storeId === storeId)
        .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
        .map(clone);
    },
    async createPromotion(storeId, p) {
      const row = { active: true, ...p, storeId, createdAt: new Date().toISOString() };
      promotions.set(p.id, row);
      return clone(row);
    },
    async updatePromotion(storeId, id, patch) {
      const p = promotions.get(id);
      if (!p || p.storeId !== storeId) return null;
      Object.assign(p, patch);
      return clone(p);
    },

    // ---- sales -------------------------------------------------------------
    async recordSale(storeId, sale) {
      // check everything first, then apply: all-or-nothing like the SQL transaction
      for (const l of sale.lines) {
        const p = products.get(l.productId);
        if (!p || p.storeId !== storeId || !p.active || p.stock < l.qty) {
          throw Object.assign(new Error(`insufficient stock for ${l.sku}`), { code: 'INSUFFICIENT_STOCK', sku: l.sku });
        }
      }
      for (const l of sale.lines) products.get(l.productId).stock -= l.qty;
      const receiptNo = [...sales.values()].filter((s) => s.storeId === storeId).reduce((m, s) => Math.max(m, s.receiptNo), 1000) + 1;
      const row = { ...sale, storeId, receiptNo, status: 'completed', createdAt: new Date().toISOString(), refundedAt: null, refunds: [] };
      sales.set(sale.id, row);
      return clone(row);
    },
    async getSale(storeId, id) {
      const s = sales.get(id);
      return clone(s && s.storeId === storeId ? s : null);
    },
    async listSales(storeId, { from, to, limit = 50 } = {}) {
      return [...sales.values()]
        .filter((s) => s.storeId === storeId && (!from || s.createdAt >= from) && (!to || s.createdAt < to))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(clone);
    },
    /** Same sums as the SQL adapter's taxReport (see adapters/azure.js). */
    async taxReport(storeId, { from, to }) {
      const inWindow = (t) => t && t >= from && t < to;
      const mine = [...sales.values()].filter((s) => s.storeId === storeId);
      const salesByRate = new Map();
      const refundsByRate = new Map();
      const payments = new Map();
      const add = (map, key, init, fn) => {
        if (!map.has(key)) map.set(key, { ...init });
        fn(map.get(key));
      };
      const pay = (method, fn) => add(payments, method, { method, salesCount: 0, salesCents: 0, refundsCount: 0, refundCents: 0 }, fn);
      for (const s of mine) {
        if (inWindow(s.createdAt)) {
          for (const l of s.lines)
            add(salesByRate, l.taxRateBp, { rateBp: l.taxRateBp, netCents: 0, taxCents: 0, discountCents: 0 }, (x) => {
              x.netCents += l.lineSubtotalCents;
              x.taxCents += l.lineTaxCents;
              x.discountCents += l.discountCents ?? 0;
            });
          pay(s.payment.method, (x) => {
            x.salesCount += 1;
            x.salesCents += s.totalCents;
          });
        }
        const rate = new Map(s.lines.map((l) => [l.lineNo, l.taxRateBp]));
        // v2.0 whole-sale refund: no refund rows, the sale's own lines at refundedAt
        const legacy =
          s.status === 'refunded' && s.refunds.length === 0 && inWindow(s.refundedAt)
            ? [{ lines: s.lines, totalCents: s.totalCents, createdAt: s.refundedAt }]
            : [];
        for (const f of [...s.refunds, ...legacy]) {
          if (!inWindow(f.createdAt)) continue;
          for (const l of f.lines)
            add(refundsByRate, rate.get(l.lineNo), { rateBp: rate.get(l.lineNo), netCents: 0, taxCents: 0 }, (x) => {
              x.netCents += l.lineSubtotalCents;
              x.taxCents += l.lineTaxCents;
            });
          pay(s.payment.method, (x) => {
            x.refundsCount += 1;
            x.refundCents += f.totalCents;
          });
        }
      }
      return { salesByRate: [...salesByRate.values()], refundsByRate: [...refundsByRate.values()], payments: [...payments.values()] };
    },
    /**
     * Records a refund atomically. plan(sale) validates and prices it (and
     * throws to refuse); the adapter then stores it, restocks and, when the
     * sale is now fully refunded, marks the sale 'refunded'.
     */
    async recordRefund(storeId, saleId, meta, plan) {
      const s = sales.get(saleId);
      if (!s || s.storeId !== storeId) return null;
      const draft = plan(clone(s));
      const refund = {
        ...meta,
        saleId,
        seq: s.refunds.length + 1,
        method: s.payment.method,
        lines: draft.lines,
        subtotalCents: draft.subtotalCents,
        taxCents: draft.taxCents,
        totalCents: draft.totalCents,
        createdAt: new Date().toISOString(),
      };
      for (const l of draft.lines) {
        const p = products.get(l.productId);
        if (p) p.stock += l.qty;
      }
      s.refunds.push(refund);
      if (draft.completesSale) {
        s.status = 'refunded';
        s.refundedAt = refund.createdAt;
      }
      return { sale: clone(s), refund: clone(refund) };
    },
  };
}

function createMemoryBlobs() {
  const blobs = new Map();
  return {
    kind: 'memory',
    blobs,
    async ping() {
      return true;
    },
    async putJson(name, obj) {
      blobs.set(name, JSON.stringify(obj));
    },
    async getJson(name) {
      return blobs.has(name) ? JSON.parse(blobs.get(name)) : null;
    },
    async deletePrefix(prefix) {
      for (const k of blobs.keys()) if (k.startsWith(prefix)) blobs.delete(k);
    },
  };
}

function createMemorySecrets() {
  const secrets = new Map();
  return {
    kind: 'memory',
    secrets,
    async ping() {
      return true;
    },
    async get(name) {
      return secrets.has(name) ? secrets.get(name) : null;
    },
    async set(name, value) {
      secrets.set(name, value);
    },
    async remove(name) {
      secrets.delete(name);
    },
  };
}

module.exports = { createMemoryDb, createMemoryBlobs, createMemorySecrets };
