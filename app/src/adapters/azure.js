'use strict';

// Azure adapters: Azure SQL, Blob Storage and Key Vault, all authenticated with
// the environment's user-assigned managed identity (no keys, no passwords).

const sql = require('mssql');
const { ManagedIdentityCredential, DefaultAzureCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');
const { SecretClient } = require('@azure/keyvault-secrets');
const { MIGRATIONS, BOOTSTRAP_SQL, ENSURE_ADMIN_SQL, pendingMigrations } = require('../migrations');
const { applyChange, MAX_PRICE } = require('../domain/reprice');

function createCredential(cfg) {
  if (cfg.runningInAzure) return new ManagedIdentityCredential({ clientId: cfg.managedIdentityClientId });
  return new DefaultAzureCredential({ managedIdentityClientId: cfg.managedIdentityClientId });
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
const lower = (g) => (g ? String(g).toLowerCase() : g);
const dup = (what) => Object.assign(new Error(`${what} already exists`), { code: 'DUPLICATE', field: what });
// a unique-index violation names the index: tell SKU and barcode clashes apart
const dupProduct = (err) => dup(/ux_products_store_barcode/i.test(err.message || '') ? 'barcode' : 'sku');
const byProduct = (lines) => [...lines].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
const isDup = (err) => err && (err.number === 2627 || err.number === 2601);

const parseJson = (v) => {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};
const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const toDate = (v) => (v ? new Date(`${v}T00:00:00Z`) : null);
const mapStore = (r) =>
  r && {
    id: lower(r.id),
    slug: r.slug,
    name: r.name,
    currency: r.currency,
    refundWindowDays: r.refund_window_days ?? 30,
    profile: parseJson(r.profile_json),
    createdAt: iso(r.created_at),
  };
const mapUser = (r) =>
  r && {
    id: lower(r.id),
    storeId: lower(r.store_id),
    email: r.email,
    name: r.name,
    role: r.role,
    passwordHash: r.password_hash,
    active: Boolean(r.active),
    createdAt: iso(r.created_at),
  };
const mapProduct = (r) =>
  r && {
    id: lower(r.id),
    storeId: lower(r.store_id),
    sku: r.sku,
    name: r.name,
    category: r.category,
    priceCents: r.price_cents,
    taxRateBp: r.tax_rate_bp,
    stock: r.stock,
    active: Boolean(r.active),
    refundable: r.refundable == null ? true : Boolean(r.refundable),
    subcategory: r.subcategory ?? null,
    barcode: r.barcode ?? null,
    expiresOn: dateOnly(r.expires_on),
    updatedAt: iso(r.updated_at),
  };
const mapCategory = (r) => ({
  id: lower(r.id),
  parentId: r.parent_id ? lower(r.parent_id) : null,
  name: r.name,
  finalSale: Boolean(r.final_sale),
  createdAt: iso(r.created_at),
});
const mapSale = (r, lines = [], refunds = []) =>
  r && {
    id: lower(r.id),
    storeId: lower(r.store_id),
    receiptNo: r.receipt_no,
    cashierId: lower(r.cashier_id),
    cashierName: r.cashier_name,
    subtotalCents: r.subtotal_cents,
    taxCents: r.tax_cents,
    discountCents: r.discount_cents ?? 0,
    totalCents: r.total_cents,
    payment: {
      method: r.payment_method,
      tenderedCents: r.tendered_cents,
      changeCents: r.change_cents,
      cardReference: r.card_reference,
    },
    status: r.status,
    receiptBlob: r.receipt_blob,
    createdAt: iso(r.created_at),
    refundedAt: iso(r.refunded_at),
    lines,
    refunds,
  };
const mapRefund = (r, lines = []) => ({
  id: lower(r.id),
  saleId: lower(r.sale_id),
  seq: r.seq,
  cashierId: lower(r.cashier_id),
  cashierName: r.cashier_name,
  method: r.method,
  reason: r.reason,
  policyOverride: Boolean(r.policy_override),
  subtotalCents: r.subtotal_cents,
  taxCents: r.tax_cents,
  totalCents: r.total_cents,
  createdAt: iso(r.created_at),
  lines,
});
const mapRefundLine = (r) => ({
  lineNo: r.line_no,
  productId: lower(r.product_id),
  sku: r.sku,
  name: r.name,
  qty: r.qty,
  lineSubtotalCents: r.line_subtotal_cents,
  lineTaxCents: r.line_tax_cents,
});
const mapLine = (r) => ({
  lineNo: r.line_no,
  productId: lower(r.product_id),
  sku: r.sku,
  name: r.name,
  qty: r.qty,
  unitPriceCents: r.unit_price_cents,
  taxRateBp: r.tax_rate_bp,
  discountCents: r.discount_cents ?? 0,
  promotionName: r.promotion_name ?? null,
  refundable: r.refundable == null ? null : Boolean(r.refundable), // null = sold before v2.2
  lineSubtotalCents: r.line_subtotal_cents,
  lineTaxCents: r.line_tax_cents,
});
const mapPromotion = (r) => ({
  id: lower(r.id),
  storeId: lower(r.store_id),
  name: r.name,
  kind: r.kind,
  value: r.value,
  target: r.target,
  category: r.category,
  skus: r.skus ? r.skus.split(',') : [],
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  active: Boolean(r.active),
  createdAt: iso(r.created_at),
});
const PRODUCT_COLS = {
  sku: ['sku', () => sql.NVarChar(40)],
  name: ['name', () => sql.NVarChar(120)],
  category: ['category', () => sql.NVarChar(60)],
  priceCents: ['price_cents', () => sql.Int],
  taxRateBp: ['tax_rate_bp', () => sql.Int],
  stock: ['stock', () => sql.Int],
  active: ['active', () => sql.Bit],
  refundable: ['refundable', () => sql.Bit],
  subcategory: ['subcategory', () => sql.NVarChar(60)],
  barcode: ['barcode', () => sql.NVarChar(32)],
  expiresOn: ['expires_on', () => sql.Date],
};
const PRODUCT_COLUMN_VALUE = (k, v) => (k === 'expiresOn' ? toDate(v) : v);

/** SQL for the price after a batch change (same arithmetic as domain/reprice.js). */
function newPriceSql(price) {
  if (!price) return 'price_cents';
  if (price.mode === 'set') return '@pv';
  if (price.mode === 'amount') return '(price_cents + @pv)';
  return 'CAST(ROUND(price_cents * (10000.0 + @pv) / 10000.0, 0) AS INT)';
}

function createSqlDb(cfg, credential, log = console) {
  let poolPromise = null;
  const pool = () => {
    if (!poolPromise) {
      poolPromise = new sql.ConnectionPool({
        server: cfg.sql.server,
        database: cfg.sql.database,
        port: 1433,
        options: { encrypt: true, trustServerCertificate: false },
        authentication: { type: 'token-credential', options: { credential } },
        // Keep connections open: opening one to the database in another region
        // (managed-identity token, TLS, gateway redirect) can take several
        // seconds, and with min 0 / 30 s idle every quiet spell meant paying
        // that again (v2.3.1 test runs: 5-15 s sign-ins). TCP keep-alive keeps
        // the idle connections alive through the SQL gateway.
        pool: { max: 10, min: 2, idleTimeoutMillis: 600000 },
        connectionTimeout: 30000,
        requestTimeout: 30000,
      })
        .connect()
        .catch((err) => {
          poolPromise = null;
          throw err;
        });
    }
    return poolPromise;
  };
  const req = async () => (await pool()).request();

  async function inTransaction(fn) {
    const tx = new sql.Transaction(await pool());
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
    try {
      const out = await fn(() => new sql.Request(tx));
      await tx.commit();
      return out;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  async function insertProduct(r, storeId, p) {
    await r
      .input('id', sql.UniqueIdentifier, p.id)
      .input('s', sql.UniqueIdentifier, storeId)
      .input('sku', sql.NVarChar(40), p.sku)
      .input('n', sql.NVarChar(120), p.name)
      .input('c', sql.NVarChar(60), p.category ?? 'General')
      .input('pr', sql.Int, p.priceCents)
      .input('t', sql.Int, p.taxRateBp ?? 1300)
      .input('st', sql.Int, p.stock ?? 0)
      .input('rf', sql.Bit, p.refundable ?? true)
      .input('a', sql.Bit, p.active ?? true)
      .input('sc', sql.NVarChar(60), p.subcategory ?? null)
      .input('bc', sql.NVarChar(32), p.barcode ?? null)
      .input('ex', sql.Date, toDate(p.expiresOn))
      .query(
        `INSERT INTO dbo.products(id, store_id, sku, name, category, price_cents, tax_rate_bp, stock, refundable, active, subcategory, barcode, expires_on)
         VALUES (@id, @s, @sku, @n, @c, @pr, @t, @st, @rf, @a, @sc, @bc, @ex)`,
      );
  }

  /** SQL Server bulk load (TDS bulk copy) inside the caller's transaction. */
  async function bulkInsertProducts(r, storeId, list) {
    const t = new sql.Table('dbo.products');
    t.create = false;
    t.columns.add('id', sql.UniqueIdentifier, { nullable: false });
    t.columns.add('store_id', sql.UniqueIdentifier, { nullable: false });
    t.columns.add('sku', sql.NVarChar(40), { nullable: false });
    t.columns.add('name', sql.NVarChar(120), { nullable: false });
    t.columns.add('category', sql.NVarChar(60), { nullable: false });
    t.columns.add('price_cents', sql.Int, { nullable: false });
    t.columns.add('tax_rate_bp', sql.Int, { nullable: false });
    t.columns.add('stock', sql.Int, { nullable: false });
    t.columns.add('active', sql.Bit, { nullable: false });
    t.columns.add('refundable', sql.Bit, { nullable: false });
    t.columns.add('subcategory', sql.NVarChar(60), { nullable: true });
    t.columns.add('barcode', sql.NVarChar(32), { nullable: true });
    t.columns.add('expires_on', sql.Date, { nullable: true });
    for (const p of list) {
      t.rows.add(
        p.id,
        storeId,
        p.sku,
        p.name,
        p.category ?? 'General',
        p.priceCents,
        p.taxRateBp ?? 1300,
        p.stock ?? 0,
        p.active ?? true,
        p.refundable ?? true,
        p.subcategory ?? null,
        p.barcode ?? null,
        toDate(p.expiresOn),
      );
    }
    // checkConstraints: keep CHECK / FOREIGN KEY constraints checked (and trusted) during the bulk load
    await r.bulk(t, { checkConstraints: true });
  }

  /** Updates the given fields of one product; returns rows affected. */
  async function updateProductRow(r, storeId, id, patch) {
    r.input('s', sql.UniqueIdentifier, storeId).input('pid', sql.UniqueIdentifier, id);
    const sets = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in PRODUCT_COLS)) continue;
      r.input(`f_${k}`, PRODUCT_COLS[k][1](), PRODUCT_COLUMN_VALUE(k, v));
      sets.push(`${PRODUCT_COLS[k][0]} = @f_${k}`);
    }
    sets.push('updated_at = SYSUTCDATETIME()');
    const u = await r.query(`UPDATE dbo.products SET ${sets.join(', ')} WHERE store_id = @s AND id = @pid`);
    return u.rowsAffected[0];
  }

  // mk = request factory: the pool by default, or a transaction's requests.
  async function linesFor(saleIds, mk = req) {
    if (saleIds.length === 0) return new Map();
    const r = await mk();
    const params = saleIds.map((id, i) => {
      r.input(`s${i}`, sql.UniqueIdentifier, id);
      return `@s${i}`;
    });
    const rows = (await r.query(`SELECT * FROM dbo.sale_lines WHERE sale_id IN (${params.join(',')}) ORDER BY line_no`)).recordset;
    const m = new Map();
    for (const row of rows) {
      const k = lower(row.sale_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(mapLine(row));
    }
    return m;
  }

  /** Refunds (with their lines) for a set of sales, keyed by sale id. */
  async function refundsFor(saleIds, mk = req) {
    if (saleIds.length === 0) return new Map();
    const r = await mk();
    const params = saleIds.map((id, i) => {
      r.input(`s${i}`, sql.UniqueIdentifier, id);
      return `@s${i}`;
    });
    const list = params.join(',');
    const res = await r.query(`SELECT * FROM dbo.refunds WHERE sale_id IN (${list}) ORDER BY seq;
      SELECT l.* FROM dbo.refund_lines l JOIN dbo.refunds f ON f.id = l.refund_id WHERE f.sale_id IN (${list}) ORDER BY l.line_no`);
    const [heads, rows] = res.recordsets;
    const byRefund = new Map();
    for (const row of rows) {
      const k = lower(row.refund_id);
      if (!byRefund.has(k)) byRefund.set(k, []);
      byRefund.get(k).push(mapRefundLine(row));
    }
    const m = new Map();
    for (const h of heads) {
      const k = lower(h.sale_id);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(mapRefund(h, byRefund.get(lower(h.id)) || []));
    }
    return m;
  }

  return {
    kind: 'azure-sql',

    async init() {
      const p = await pool();
      await p.request().batch(BOOTSTRAP_SQL);
      const tx = new sql.Transaction(p);
      await tx.begin();
      try {
        const lock = await new sql.Request(tx).query(
          "DECLARE @r INT; EXEC @r = sp_getapplock @Resource = N'eurc-migrations', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000; SELECT @r AS r;",
        );
        if (lock.recordset[0].r < 0) throw new Error(`could not obtain migration lock (${lock.recordset[0].r})`);
        const applied = await new sql.Request(tx).query('SELECT version FROM dbo.schema_migrations');
        for (const m of pendingMigrations(applied.recordset.map((r) => r.version))) {
          log.info?.(`[migrate] applying ${m.version} ${m.name}`);
          await new sql.Request(tx).batch(m.sql);
          await new sql.Request(tx)
            .input('v', sql.Int, m.version)
            .input('n', sql.NVarChar(100), m.name)
            .input('a', sql.NVarChar(50), cfg.build.version)
            .query('INSERT INTO dbo.schema_migrations(version, name, app_version) VALUES (@v, @n, @a)');
        }
        // Every start: a store without an admin (e.g. signed up on an older
        // version during a slot swap or rollback) gets its first manager as admin.
        await new sql.Request(tx).batch(ENSURE_ADMIN_SQL); // schema is at version 6+ here
        await tx.commit();
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      }
      const v = await p.request().query('SELECT MAX(version) AS v FROM dbo.schema_migrations');
      return { schemaVersion: v.recordset[0].v || 0, expected: MIGRATIONS.at(-1).version };
    },
    async ping() {
      await (await req()).query('SELECT 1 AS ok');
      return true;
    },
    async close() {
      if (poolPromise) (await poolPromise).close();
    },

    // ---- stores ------------------------------------------------------------
    async createStore({ store, manager }) {
      try {
        await inTransaction(async (r) => {
          await r()
            .input('id', sql.UniqueIdentifier, store.id)
            .input('slug', sql.NVarChar(40), store.slug)
            .input('name', sql.NVarChar(120), store.name)
            .query('INSERT INTO dbo.stores(id, slug, name) VALUES (@id, @slug, @name)');
          await r()
            .input('id', sql.UniqueIdentifier, manager.id)
            .input('s', sql.UniqueIdentifier, store.id)
            .input('e', sql.NVarChar(254), manager.email)
            .input('n', sql.NVarChar(120), manager.name)
            .input('r', sql.NVarChar(20), manager.role)
            .input('h', sql.NVarChar(200), manager.passwordHash)
            .query('INSERT INTO dbo.users(id, store_id, email, name, role, password_hash) VALUES (@id, @s, @e, @n, @r, @h)');
        });
      } catch (err) {
        if (isDup(err)) throw dup('store');
        throw err;
      }
      return this.getStore(store.id);
    },
    async getStoreBySlug(slug) {
      const r = await (await req()).input('s', sql.NVarChar(40), slug).query('SELECT * FROM dbo.stores WHERE slug = @s');
      return mapStore(r.recordset[0]) || null;
    },
    async getStore(id) {
      const r = await (await req()).input('id', sql.UniqueIdentifier, id).query('SELECT * FROM dbo.stores WHERE id = @id');
      return mapStore(r.recordset[0]) || null;
    },
    async countStores() {
      return (await (await req()).query('SELECT COUNT(*) AS n FROM dbo.stores')).recordset[0].n;
    },
    async deleteStore(id) {
      // sale_lines cascade from sales; everything else cascades from stores
      await (await req()).input('id', sql.UniqueIdentifier, id).query('DELETE FROM dbo.stores WHERE id = @id');
    },

    // ---- users -------------------------------------------------------------
    async findUserByEmail(storeId, email) {
      const r = await (
        await req()
      )
        .input('s', sql.UniqueIdentifier, storeId)
        .input('e', sql.NVarChar(254), email)
        .query('SELECT * FROM dbo.users WHERE store_id = @s AND email = @e');
      return mapUser(r.recordset[0]) || null;
    },
    async getUser(storeId, id) {
      const r = await (
        await req()
      )
        .input('s', sql.UniqueIdentifier, storeId)
        .input('id', sql.UniqueIdentifier, id)
        .query('SELECT * FROM dbo.users WHERE store_id = @s AND id = @id');
      return mapUser(r.recordset[0]) || null;
    },
    async listUsers(storeId) {
      const r = await (await req()).input('s', sql.UniqueIdentifier, storeId).query('SELECT * FROM dbo.users WHERE store_id = @s ORDER BY email');
      return r.recordset.map(mapUser);
    },
    async createUser(storeId, u) {
      try {
        await (
          await req()
        )
          .input('id', sql.UniqueIdentifier, u.id)
          .input('s', sql.UniqueIdentifier, storeId)
          .input('e', sql.NVarChar(254), u.email)
          .input('n', sql.NVarChar(120), u.name)
          .input('r', sql.NVarChar(20), u.role)
          .input('h', sql.NVarChar(200), u.passwordHash)
          .query('INSERT INTO dbo.users(id, store_id, email, name, role, password_hash) VALUES (@id, @s, @e, @n, @r, @h)');
      } catch (err) {
        if (isDup(err)) throw dup('user');
        throw err;
      }
      return this.getUser(storeId, u.id);
    },
    async updateUser(storeId, id, patch) {
      const r = await req();
      r.input('s', sql.UniqueIdentifier, storeId).input('id', sql.UniqueIdentifier, id);
      const sets = [];
      if (patch.active !== undefined) {
        r.input('a', sql.Bit, patch.active);
        sets.push('active = @a');
      }
      if (patch.role !== undefined) {
        r.input('r', sql.NVarChar(20), patch.role);
        sets.push('role = @r');
      }
      if (sets.length) await r.query(`UPDATE dbo.users SET ${sets.join(', ')} WHERE store_id = @s AND id = @id`);
      return this.getUser(storeId, id);
    },
    async setUserActive(storeId, id, active) {
      await (
        await req()
      )
        .input('s', sql.UniqueIdentifier, storeId)
        .input('id', sql.UniqueIdentifier, id)
        .input('a', sql.Bit, active)
        .query('UPDATE dbo.users SET active = @a WHERE store_id = @s AND id = @id');
      return this.getUser(storeId, id);
    },

    // ---- products ----------------------------------------------------------
    /** Paged search: { items, total }. Filters are parameters, never string-built. */
    async searchProducts(storeId, { q = '', includeInactive = false, category, subcategory, expiresBefore, limit = 50, offset = 0 } = {}) {
      // filters: fixed SQL fragments + parameters (never user text in the SQL)
      const where = ['store_id = @s', '(active = 1 OR @all = 1)'];
      const params = [
        ['s', sql.UniqueIdentifier, storeId],
        ['all', sql.Bit, includeInactive],
      ];
      if (q) {
        params.push(['q', sql.NVarChar(200), `%${q.replace(/[%_[]/g, (c) => `[${c}]`)}%`]);
        if (q.length <= 32) {
          params.push(['code', sql.NVarChar(32), q.toUpperCase()]);
          where.push('(name LIKE @q OR sku LIKE @q OR barcode = @code)');
        } else where.push('(name LIKE @q OR sku LIKE @q)');
      }
      if (category) {
        params.push(['cat', sql.NVarChar(60), category]);
        where.push('category = @cat');
      }
      if (subcategory) {
        params.push(['sub', sql.NVarChar(60), subcategory]);
        where.push('subcategory = @sub');
      }
      if (expiresBefore) {
        params.push(['exb', sql.Date, toDate(expiresBefore)]);
        where.push('expires_on IS NOT NULL AND expires_on <= @exb');
      }
      const bind = (r) => {
        for (const [n, t, v] of params) r.input(n, t, v);
        return r;
      };
      // id last: rows with equal names keep a stable order across pages
      const order = expiresBefore ? 'expires_on, name, id' : 'name, id';
      const res = await bind(await req())
        .input('lim', sql.Int, limit)
        .input('off', sql.Int, offset).query(`SELECT *, COUNT(*) OVER () AS total_rows FROM dbo.products WHERE ${where.join(' AND ')}
                ORDER BY ${order} OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
      let total = res.recordset[0]?.total_rows ?? 0;
      if (res.recordset.length === 0 && offset > 0) {
        // past the end: COUNT(*) OVER() has no row to ride on - count with the same filters
        const c = await bind(await req()).query(`SELECT COUNT(*) AS n FROM dbo.products WHERE ${where.join(' AND ')}`);
        total = c.recordset[0].n;
      }
      return { items: res.recordset.map(mapProduct), total };
    },
    async listProducts(storeId, opts = {}) {
      return (await this.searchProducts(storeId, { ...opts, limit: 100000 })).items;
    },
    async findProductByCode(storeId, code) {
      const r = await (
        await req()
      )
        .input('s', sql.UniqueIdentifier, storeId)
        .input('c', sql.NVarChar(40), code)
        .query('SELECT TOP 1 * FROM dbo.products WHERE store_id = @s AND (barcode = @c OR sku = @c) ORDER BY CASE WHEN barcode = @c THEN 0 ELSE 1 END');
      return mapProduct(r.recordset[0]) || null;
    },
    /** Products whose SKU or barcode is in the lists (JSON arrays: no 2100-parameter limit). */
    async findProductsByCodes(storeId, { skus = [], barcodes = [] }) {
      if (skus.length === 0 && barcodes.length === 0) return [];
      const r = await (
        await req()
      )
        .input('s', sql.UniqueIdentifier, storeId)
        .input('skus', sql.NVarChar(sql.MAX), JSON.stringify(skus))
        .input('codes', sql.NVarChar(sql.MAX), JSON.stringify(barcodes))
        .query(`SELECT * FROM dbo.products WHERE store_id = @s AND (sku IN (SELECT value FROM OPENJSON(@skus))
                  OR barcode IN (SELECT value FROM OPENJSON(@codes)))`);
      return r.recordset.map(mapProduct);
    },
    /**
     * Batch price/tax change in ONE transaction and ONE UPDATE, however many
     * products match (a whole department of a 200k catalogue). Nothing changes
     * when a price would leave 0..MAX_PRICE or some listed ids are missing.
     */
    async repriceProducts(storeId, where, change, { dryRun = false, previewLimit = 50 } = {}) {
      return inTransaction(async (r) => {
        const bind = (q) => {
          q.input('s', sql.UniqueIdentifier, storeId);
          if (where.ids) q.input('ids', sql.NVarChar(sql.MAX), JSON.stringify(where.ids));
          if (where.category) q.input('cat', sql.NVarChar(60), where.category);
          if (change.price) q.input('pv', sql.Int, change.price.value);
          q.input('tax', sql.Int, change.taxRateBp ?? null);
          q.input('max', sql.Int, MAX_PRICE);
          q.input('lim', sql.Int, previewLimit);
          return q;
        };
        const filter = where.ids
          ? 'id IN (SELECT TRY_CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids))' // not a GUID: no match -> 404
          : where.category
            ? '(category = @cat OR subcategory = @cat)'
            : '1 = 1';
        const expr = newPriceSql(change.price);
        const scope = `FROM dbo.products WITH (UPDLOCK, HOLDLOCK) WHERE store_id = @s AND ${filter}`;
        const head = await bind(r()).query(`SELECT COUNT(*) AS n FROM dbo.products WITH (UPDLOCK, HOLDLOCK) WHERE store_id = @s AND ${filter};
          SELECT TOP 1 sku, ${expr} AS np ${scope} AND (${expr} < 0 OR ${expr} > @max);
          SELECT TOP (@lim) * ${scope} ORDER BY name`);
        const [[{ n }], badRows, previewRows] = head.recordsets;
        const preview = previewRows.map(mapProduct).map((p) => applyChange(p, change));
        const invalid = badRows[0] ? { sku: badRows[0].sku, priceCents: badRows[0].np } : null;
        const result = { count: n, preview, invalid };
        if (dryRun || invalid || (where.ids && n !== where.ids.length)) return result;
        await bind(r()).query(`UPDATE dbo.products SET price_cents = ${expr}, tax_rate_bp = COALESCE(@tax, tax_rate_bp), updated_at = SYSUTCDATETIME()
                               WHERE store_id = @s AND ${filter}`);
        return result;
      });
    },
    async getProductsByIds(storeId, ids) {
      if (ids.length === 0) return [];
      const r = await req();
      r.input('s', sql.UniqueIdentifier, storeId);
      const params = ids.map((id, i) => {
        r.input(`p${i}`, sql.UniqueIdentifier, id);
        return `@p${i}`;
      });
      const rows = (await r.query(`SELECT * FROM dbo.products WHERE store_id = @s AND id IN (${params.join(',')})`)).recordset;
      return rows.map(mapProduct);
    },
    async createProduct(storeId, p) {
      try {
        await insertProduct(await req(), storeId, p);
      } catch (err) {
        if (isDup(err)) throw dupProduct(err);
        throw err;
      }
      return (await this.getProductsByIds(storeId, [p.id]))[0];
    },
    async updateProduct(storeId, id, patch) {
      try {
        await updateProductRow(await req(), storeId, id, patch);
      } catch (err) {
        if (isDup(err)) throw dupProduct(err);
        throw err;
      }
      return (await this.getProductsByIds(storeId, [id]))[0] || null;
    },
    /** All-or-nothing bulk write (Excel import, price/tax changes): one transaction. */
    async saveProducts(storeId, items) {
      try {
        await inTransaction(async (r) => {
          const creates = items.filter((i) => i.create);
          if (creates.length > 20) await bulkInsertProducts(r(), storeId, creates); // big imports: one bulk load
          for (const { create, ...it } of items) {
            if (create && creates.length > 20) continue;
            if (create) await insertProduct(r(), storeId, it);
            else {
              const n = await updateProductRow(r(), storeId, it.id, it);
              if (n !== 1) throw Object.assign(new Error(`product ${it.id} not found`), { status: 404 });
            }
          }
        });
      } catch (err) {
        if (isDup(err)) throw dupProduct(err);
        throw err;
      }
      return this.getProductsByIds(
        storeId,
        items.map((i) => i.id),
      );
    },

    // ---- store settings and promotions --------------------------------------
    async updateStoreSettings(id, patch) {
      const r = await req();
      r.input('id', sql.UniqueIdentifier, id);
      const sets = [];
      if (patch.refundWindowDays !== undefined) {
        r.input('d', sql.Int, patch.refundWindowDays);
        sets.push('refund_window_days = @d');
      }
      if (patch.profile !== undefined) {
        r.input('p', sql.NVarChar(sql.MAX), patch.profile ? JSON.stringify(patch.profile) : null);
        sets.push('profile_json = @p');
      }
      if (patch.name !== undefined) {
        r.input('n', sql.NVarChar(120), patch.name);
        sets.push('name = @n');
      }
      if (sets.length) await r.query(`UPDATE dbo.stores SET ${sets.join(', ')} WHERE id = @id`);
      return this.getStore(id);
    },

    // ---- categories --------------------------------------------------------
    async listCategories(storeId) {
      const r = await (await req()).input('s', sql.UniqueIdentifier, storeId).query('SELECT * FROM dbo.categories WHERE store_id = @s ORDER BY name');
      return r.recordset.map(mapCategory);
    },
    async createCategory(storeId, c) {
      try {
        await (
          await req()
        )
          .input('id', sql.UniqueIdentifier, c.id)
          .input('s', sql.UniqueIdentifier, storeId)
          .input('p', sql.UniqueIdentifier, c.parentId || null)
          .input('n', sql.NVarChar(60), c.name)
          .input('f', sql.Bit, Boolean(c.finalSale))
          .query('INSERT INTO dbo.categories(id, store_id, parent_id, name, final_sale) VALUES (@id, @s, @p, @n, @f)');
      } catch (err) {
        if (isDup(err)) throw dup('category');
        throw err;
      }
      return (await this.listCategories(storeId)).find((x) => x.id === lower(c.id));
    },
    async updateCategory(storeId, id, patch) {
      const r = await req();
      r.input('s', sql.UniqueIdentifier, storeId).input('id', sql.UniqueIdentifier, id);
      const sets = [];
      if (patch.name !== undefined) {
        r.input('n', sql.NVarChar(60), patch.name);
        sets.push('name = @n');
      }
      if (patch.finalSale !== undefined) {
        r.input('f', sql.Bit, patch.finalSale);
        sets.push('final_sale = @f');
      }
      try {
        if (sets.length) await r.query(`UPDATE dbo.categories SET ${sets.join(', ')} WHERE store_id = @s AND id = @id`);
      } catch (err) {
        if (isDup(err)) throw dup('category');
        throw err;
      }
      return (await this.listCategories(storeId)).find((x) => x.id === lower(id)) || null;
    },
    async listPromotions(storeId) {
      const r = await (await req()).input('s', sql.UniqueIdentifier, storeId).query('SELECT * FROM dbo.promotions WHERE store_id = @s ORDER BY starts_at DESC');
      return r.recordset.map(mapPromotion);
    },
    async createPromotion(storeId, p) {
      await (
        await req()
      )
        .input('id', sql.UniqueIdentifier, p.id)
        .input('s', sql.UniqueIdentifier, storeId)
        .input('n', sql.NVarChar(120), p.name)
        .input('k', sql.NVarChar(10), p.kind)
        .input('v', sql.Int, p.value)
        .input('t', sql.NVarChar(10), p.target)
        .input('c', sql.NVarChar(60), p.category ?? null)
        .input('skus', sql.NVarChar(4000), p.skus?.length ? p.skus.join(',') : null)
        .input('from', sql.DateTime2, new Date(p.startsAt))
        .input('to', sql.DateTime2, p.endsAt ? new Date(p.endsAt) : null)
        .query(`INSERT INTO dbo.promotions(id, store_id, name, kind, value, target, category, skus, starts_at, ends_at)
                VALUES (@id, @s, @n, @k, @v, @t, @c, @skus, @from, @to)`);
      return (await this.listPromotions(storeId)).find((x) => x.id === lower(p.id));
    },
    async updatePromotion(storeId, id, patch) {
      const cols = {
        name: ['name', sql.NVarChar(120)],
        active: ['active', sql.Bit],
        endsAt: ['ends_at', sql.DateTime2],
        startsAt: ['starts_at', sql.DateTime2],
      };
      const r = await req();
      r.input('s', sql.UniqueIdentifier, storeId).input('id', sql.UniqueIdentifier, id);
      const sets = [];
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in cols)) continue;
        r.input(k, cols[k][1], k.endsWith('At') && v ? new Date(v) : v);
        sets.push(`${cols[k][0]} = @${k}`);
      }
      if (sets.length) await r.query(`UPDATE dbo.promotions SET ${sets.join(', ')} WHERE store_id = @s AND id = @id`);
      return (await this.listPromotions(storeId)).find((x) => x.id === lower(id)) || null;
    },

    // ---- sales -------------------------------------------------------------
    async recordSale(storeId, sale) {
      const receiptNo = await inTransaction(async (r) => {
        // Touch product rows in one fixed order (by id) in sales and refunds
        // alike, so two tills never lock the same products in opposite order.
        for (const l of byProduct(sale.lines)) {
          const u = await r()
            .input('s', sql.UniqueIdentifier, storeId)
            .input('p', sql.UniqueIdentifier, l.productId)
            .input('q', sql.Int, l.qty)
            .query('UPDATE dbo.products SET stock = stock - @q WHERE store_id = @s AND id = @p AND active = 1 AND stock >= @q');
          if (u.rowsAffected[0] !== 1) {
            throw Object.assign(new Error(`insufficient stock for ${l.sku}`), { code: 'INSUFFICIENT_STOCK', sku: l.sku });
          }
        }
        // UPDLOCK + HOLDLOCK serialises receipt numbers per store
        const n = await r()
          .input('s', sql.UniqueIdentifier, storeId)
          .query('SELECT ISNULL(MAX(receipt_no), 1000) + 1 AS n FROM dbo.sales WITH (UPDLOCK, HOLDLOCK) WHERE store_id = @s');
        const no = n.recordset[0].n;
        await r()
          .input('id', sql.UniqueIdentifier, sale.id)
          .input('s', sql.UniqueIdentifier, storeId)
          .input('no', sql.Int, no)
          .input('cid', sql.UniqueIdentifier, sale.cashierId)
          .input('cn', sql.NVarChar(120), sale.cashierName)
          .input('sub', sql.Int, sale.subtotalCents)
          .input('tax', sql.Int, sale.taxCents)
          .input('tot', sql.Int, sale.totalCents)
          .input('disc', sql.Int, sale.discountCents ?? 0)
          .input('pm', sql.NVarChar(10), sale.payment.method)
          .input('ten', sql.Int, sale.payment.tenderedCents)
          .input('chg', sql.Int, sale.payment.changeCents)
          .input('ref', sql.NVarChar(40), sale.payment.cardReference)
          .input('blob', sql.NVarChar(400), sale.receiptBlob)
          .query(`INSERT INTO dbo.sales(id, store_id, receipt_no, cashier_id, cashier_name, subtotal_cents, tax_cents, total_cents,
                    discount_cents, payment_method, tendered_cents, change_cents, card_reference, receipt_blob)
                  VALUES (@id, @s, @no, @cid, @cn, @sub, @tax, @tot, @disc, @pm, @ten, @chg, @ref, @blob)`);
        for (const l of sale.lines) {
          await r()
            .input('sid', sql.UniqueIdentifier, sale.id)
            .input('ln', sql.Int, l.lineNo)
            .input('pid', sql.UniqueIdentifier, l.productId)
            .input('sku', sql.NVarChar(40), l.sku)
            .input('n', sql.NVarChar(120), l.name)
            .input('q', sql.Int, l.qty)
            .input('up', sql.Int, l.unitPriceCents)
            .input('tr', sql.Int, l.taxRateBp)
            .input('ls', sql.Int, l.lineSubtotalCents)
            .input('lt', sql.Int, l.lineTaxCents)
            .input('ld', sql.Int, l.discountCents ?? 0)
            .input('lp', sql.NVarChar(120), l.promotionName ?? null)
            .input('lr', sql.Bit, l.refundable ?? true)
            .query(`INSERT INTO dbo.sale_lines(sale_id, line_no, product_id, sku, name, qty, unit_price_cents, tax_rate_bp, line_subtotal_cents, line_tax_cents,
                      discount_cents, promotion_name, refundable)
                    VALUES (@sid, @ln, @pid, @sku, @n, @q, @up, @tr, @ls, @lt, @ld, @lp, @lr)`);
        }
        return no;
      });
      const saved = await this.getSale(storeId, sale.id);
      saved.receiptNo = receiptNo;
      return saved;
    },
    async getSale(storeId, id) {
      const r = await (
        await req()
      )
        .input('s', sql.UniqueIdentifier, storeId)
        .input('id', sql.UniqueIdentifier, id)
        .query('SELECT * FROM dbo.sales WHERE store_id = @s AND id = @id');
      if (!r.recordset[0]) return null;
      const [lines, refunds] = await Promise.all([linesFor([id]), refundsFor([id])]);
      return mapSale(r.recordset[0], lines.get(lower(id)) || [], refunds.get(lower(id)) || []);
    },
    async listSales(storeId, { from, to, limit = 50 } = {}) {
      const r = await (
        await req()
      )
        .input('s', sql.UniqueIdentifier, storeId)
        .input('from', sql.DateTime2, from ? new Date(from) : new Date(0))
        .input('to', sql.DateTime2, to ? new Date(to) : new Date('9999-12-31'))
        .input('lim', sql.Int, Math.min(limit, 500))
        .query('SELECT TOP (@lim) * FROM dbo.sales WHERE store_id = @s AND created_at >= @from AND created_at < @to ORDER BY created_at DESC');
      const ids = r.recordset.map((x) => x.id);
      const [lines, refunds] = await Promise.all([linesFor(ids), refundsFor(ids)]);
      return r.recordset.map((x) => mapSale(x, lines.get(lower(x.id)) || [], refunds.get(lower(x.id)) || []));
    },
    /**
     * Records a refund in one transaction. The sale row is locked first
     * (UPDLOCK, HOLDLOCK), so two tills refunding the same receipt at once are
     * serialised and the second sees the first one's refund before planning.
     */
    async recordRefund(storeId, saleId, meta, plan) {
      const out = await inTransaction(async (r) => {
        const head = await r()
          .input('s', sql.UniqueIdentifier, storeId)
          .input('id', sql.UniqueIdentifier, saleId)
          .query('SELECT * FROM dbo.sales WITH (UPDLOCK, HOLDLOCK) WHERE store_id = @s AND id = @id');
        if (!head.recordset[0]) return null;
        const [lines, refunds] = [await linesFor([saleId], r), await refundsFor([saleId], r)];
        const sale = mapSale(head.recordset[0], lines.get(lower(saleId)) || [], refunds.get(lower(saleId)) || []);
        const draft = plan(sale); // throws to refuse; the transaction rolls back
        const seq = sale.refunds.length + 1;
        await r()
          .input('id', sql.UniqueIdentifier, meta.id)
          .input('s', sql.UniqueIdentifier, storeId)
          .input('sid', sql.UniqueIdentifier, saleId)
          .input('seq', sql.Int, seq)
          .input('cid', sql.UniqueIdentifier, meta.cashierId)
          .input('cn', sql.NVarChar(120), meta.cashierName)
          .input('m', sql.NVarChar(10), sale.payment.method)
          .input('why', sql.NVarChar(200), meta.reason ?? null)
          .input('ovr', sql.Bit, meta.policyOverride ?? false)
          .input('sub', sql.Int, draft.subtotalCents)
          .input('tax', sql.Int, draft.taxCents)
          .input('tot', sql.Int, draft.totalCents)
          .query(`INSERT INTO dbo.refunds(id, store_id, sale_id, seq, cashier_id, cashier_name, method, reason, policy_override, subtotal_cents, tax_cents, total_cents)
                  VALUES (@id, @s, @sid, @seq, @cid, @cn, @m, @why, @ovr, @sub, @tax, @tot)`);
        for (const l of byProduct(draft.lines)) {
          await r()
            .input('rid', sql.UniqueIdentifier, meta.id)
            .input('ln', sql.Int, l.lineNo)
            .input('pid', sql.UniqueIdentifier, l.productId)
            .input('sku', sql.NVarChar(40), l.sku)
            .input('n', sql.NVarChar(120), l.name)
            .input('q', sql.Int, l.qty)
            .input('ls', sql.Int, l.lineSubtotalCents)
            .input('lt', sql.Int, l.lineTaxCents)
            .query(`INSERT INTO dbo.refund_lines(refund_id, line_no, product_id, sku, name, qty, line_subtotal_cents, line_tax_cents)
                    VALUES (@rid, @ln, @pid, @sku, @n, @q, @ls, @lt)`);
          await r()
            .input('s', sql.UniqueIdentifier, storeId)
            .input('p', sql.UniqueIdentifier, l.productId)
            .input('q', sql.Int, l.qty)
            .query('UPDATE dbo.products SET stock = stock + @q, updated_at = SYSUTCDATETIME() WHERE store_id = @s AND id = @p');
        }
        if (draft.completesSale) {
          await r()
            .input('s', sql.UniqueIdentifier, storeId)
            .input('id', sql.UniqueIdentifier, saleId)
            .query("UPDATE dbo.sales SET status = N'refunded', refunded_at = SYSUTCDATETIME() WHERE store_id = @s AND id = @id");
        }
        return true;
      });
      if (!out) return null;
      const sale = await this.getSale(storeId, saleId);
      return { sale, refund: sale.refunds.find((x) => x.id === lower(meta.id)) };
    },
  };
}

function createBlobAdapter(cfg, credential) {
  const container = new BlobServiceClient(cfg.blobUrl, credential).getContainerClient(cfg.blobContainer);
  return {
    kind: 'azure-blob',
    async ping() {
      await container.getProperties();
      return true;
    },
    async putJson(name, obj) {
      const body = Buffer.from(JSON.stringify(obj, null, 2));
      await container.getBlockBlobClient(name).upload(body, body.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
    },
    async getJson(name) {
      try {
        const buf = await container.getBlockBlobClient(name).downloadToBuffer();
        return JSON.parse(buf.toString('utf8'));
      } catch (err) {
        if (err.statusCode === 404) return null;
        throw err;
      }
    },
    async deletePrefix(prefix) {
      for await (const b of container.listBlobsFlat({ prefix })) await container.deleteBlob(b.name);
    },
  };
}

function createSecretAdapter(cfg, credential) {
  const client = new SecretClient(cfg.keyVaultUrl, credential);
  return {
    kind: 'azure-keyvault',
    async ping() {
      const it = client.listPropertiesOfSecrets().byPage({ maxPageSize: 1 });
      await it.next();
      return true;
    },
    async get(name) {
      try {
        return (await client.getSecret(name)).value;
      } catch (err) {
        if (err.statusCode === 404) return null;
        throw err;
      }
    },
    // Delete every version, then purge when allowed. Key Vault soft delete keeps
    // a deleted name reserved until it is purged or recovered (see set()).
    async remove(name) {
      try {
        await (await client.beginDeleteSecret(name)).pollUntilDone();
      } catch (err) {
        if (err.statusCode === 404) return;
        throw err;
      }
      await client.purgeDeletedSecret(name).catch(() => {}); // needs purge permission; otherwise expires with the retention period
    },
    async set(name, value) {
      const put = () => client.setSecret(name, value, { contentType: name.startsWith('bank-') ? 'eurc/bank' : 'eurc/hmac-key' });
      try {
        await put();
      } catch (err) {
        if (err.statusCode !== 409) throw err;
        // the name is soft-deleted: purge it if we may, otherwise recover it and
        // disable the recovered (old) versions before writing the new value
        const purged = await client.purgeDeletedSecret(name).then(
          () => true,
          () => false,
        );
        if (!purged) {
          await (await client.beginRecoverDeletedSecret(name)).pollUntilDone();
          for await (const v of client.listPropertiesOfSecretVersions(name)) {
            if (v.enabled) await client.updateSecretProperties(name, v.version, { enabled: false });
          }
        } else {
          await new Promise((res) => setTimeout(res, 2000)); // purge completes asynchronously
        }
        await put();
      }
    },
  };
}

function createAzureAdapters(cfg, log) {
  const credential = createCredential(cfg);
  return {
    db: createSqlDb(cfg, credential, log),
    blobs: createBlobAdapter(cfg, credential),
    secrets: createSecretAdapter(cfg, credential),
  };
}

module.exports = { createAzureAdapters };
