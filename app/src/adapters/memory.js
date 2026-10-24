'use strict';

// In-memory adapters with exactly the same contract as the Azure ones.
// Used for local development (npm run dev) and unit tests in CI.

const { MIGRATIONS } = require('../migrations');

const dup = (what) => Object.assign(new Error(`${what} already exists`), { code: 'DUPLICATE' });
const clone = (x) => (x == null ? x : structuredClone(x));

function createMemoryDb() {
  const stores = new Map();
  const users = new Map();
  const products = new Map();
  const sales = new Map();
  const promotions = new Map();

  const storeUsers = (storeId) => [...users.values()].filter((u) => u.storeId === storeId);
  const storeProducts = (storeId) => [...products.values()].filter((p) => p.storeId === storeId);

  return {
    kind: 'memory',
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
      for (const m of [users, products, sales, promotions]) for (const [k, v] of m) if (v.storeId === id) m.delete(k);
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
    async setUserActive(storeId, id, active) {
      const u = users.get(id);
      if (!u || u.storeId !== storeId) return null;
      u.active = active;
      return clone(u);
    },

    // ---- products ----------------------------------------------------------
    async listProducts(storeId, { q = '', includeInactive = false } = {}) {
      const needle = q.toLowerCase();
      return storeProducts(storeId)
        .filter((p) => includeInactive || p.active)
        .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(clone);
    },
    async getProductsByIds(storeId, ids) {
      return ids.map((id) => products.get(id)).filter((p) => p && p.storeId === storeId).map(clone);
    },
    async createProduct(storeId, p) {
      if (storeProducts(storeId).some((x) => x.sku === p.sku)) throw dup('sku');
      const row = { category: 'General', taxRateBp: 1300, stock: 0, refundable: true, ...p, storeId, active: true, updatedAt: new Date().toISOString() };
      products.set(p.id, row);
      return clone(row);
    },
    async updateProduct(storeId, id, patch) {
      const p = products.get(id);
      if (!p || p.storeId !== storeId) return null;
      if (patch.sku && patch.sku !== p.sku && storeProducts(storeId).some((x) => x.sku === patch.sku)) throw dup('sku');
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
      for (const it of items) {
        if (!it.create && !products.has(it.id)) throw Object.assign(new Error(`product ${it.id} not found`), { status: 404 });
        if (it.sku !== undefined && skus.has(it.sku) && skus.get(it.sku) !== it.id) throw dup('sku');
        if (it.sku !== undefined) skus.set(it.sku, it.id);
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
  };
}

module.exports = { createMemoryDb, createMemoryBlobs, createMemorySecrets };
