'use strict';

// Azure adapters: Azure SQL, Blob Storage and Key Vault, all authenticated with
// the environment's user-assigned managed identity (no keys, no passwords).

const sql = require('mssql');
const { ManagedIdentityCredential, DefaultAzureCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');
const { SecretClient } = require('@azure/keyvault-secrets');
const { MIGRATIONS, BOOTSTRAP_SQL, pendingMigrations } = require('../migrations');

function createCredential(cfg) {
  if (cfg.runningInAzure) return new ManagedIdentityCredential({ clientId: cfg.managedIdentityClientId });
  return new DefaultAzureCredential({ managedIdentityClientId: cfg.managedIdentityClientId });
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
const lower = (g) => (g ? String(g).toLowerCase() : g);
const dup = (what) => Object.assign(new Error(`${what} already exists`), { code: 'DUPLICATE' });
const isDup = (err) => err && (err.number === 2627 || err.number === 2601);

const mapStore = (r) => r && { id: lower(r.id), slug: r.slug, name: r.name, currency: r.currency, createdAt: iso(r.created_at) };
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
    updatedAt: iso(r.updated_at),
  };
const mapSale = (r, lines = []) =>
  r && {
    id: lower(r.id),
    storeId: lower(r.store_id),
    receiptNo: r.receipt_no,
    cashierId: lower(r.cashier_id),
    cashierName: r.cashier_name,
    subtotalCents: r.subtotal_cents,
    taxCents: r.tax_cents,
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
  };
const mapLine = (r) => ({
  lineNo: r.line_no,
  productId: lower(r.product_id),
  sku: r.sku,
  name: r.name,
  qty: r.qty,
  unitPriceCents: r.unit_price_cents,
  taxRateBp: r.tax_rate_bp,
  lineSubtotalCents: r.line_subtotal_cents,
  lineTaxCents: r.line_tax_cents,
});

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
        pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
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

  async function linesFor(saleIds) {
    if (saleIds.length === 0) return new Map();
    const r = await req();
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
      const r = await (await req())
        .input('s', sql.UniqueIdentifier, storeId)
        .input('e', sql.NVarChar(254), email)
        .query('SELECT * FROM dbo.users WHERE store_id = @s AND email = @e');
      return mapUser(r.recordset[0]) || null;
    },
    async getUser(storeId, id) {
      const r = await (await req())
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
        await (await req())
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
    async setUserActive(storeId, id, active) {
      await (await req())
        .input('s', sql.UniqueIdentifier, storeId)
        .input('id', sql.UniqueIdentifier, id)
        .input('a', sql.Bit, active)
        .query('UPDATE dbo.users SET active = @a WHERE store_id = @s AND id = @id');
      return this.getUser(storeId, id);
    },

    // ---- products ----------------------------------------------------------
    async listProducts(storeId, { q = '', includeInactive = false } = {}) {
      const r = await (await req())
        .input('s', sql.UniqueIdentifier, storeId)
        .input('q', sql.NVarChar(130), `%${q.replace(/[%_[]/g, (c) => `[${c}]`)}%`)
        .input('all', sql.Bit, includeInactive)
        .query('SELECT * FROM dbo.products WHERE store_id = @s AND (active = 1 OR @all = 1) AND (name LIKE @q OR sku LIKE @q) ORDER BY name');
      return r.recordset.map(mapProduct);
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
        await (await req())
          .input('id', sql.UniqueIdentifier, p.id)
          .input('s', sql.UniqueIdentifier, storeId)
          .input('sku', sql.NVarChar(40), p.sku)
          .input('n', sql.NVarChar(120), p.name)
          .input('c', sql.NVarChar(60), p.category ?? 'General')
          .input('pr', sql.Int, p.priceCents)
          .input('t', sql.Int, p.taxRateBp ?? 1300)
          .input('st', sql.Int, p.stock ?? 0)
          .query(
            'INSERT INTO dbo.products(id, store_id, sku, name, category, price_cents, tax_rate_bp, stock) VALUES (@id, @s, @sku, @n, @c, @pr, @t, @st)',
          );
      } catch (err) {
        if (isDup(err)) throw dup('sku');
        throw err;
      }
      return (await this.getProductsByIds(storeId, [p.id]))[0];
    },
    async updateProduct(storeId, id, patch) {
      const cols = { sku: 'sku', name: 'name', category: 'category', priceCents: 'price_cents', taxRateBp: 'tax_rate_bp', stock: 'stock', active: 'active' };
      const types = { sku: sql.NVarChar(40), name: sql.NVarChar(120), category: sql.NVarChar(60), active: sql.Bit };
      const r = await req();
      r.input('s', sql.UniqueIdentifier, storeId).input('id', sql.UniqueIdentifier, id);
      const sets = [];
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in cols)) continue;
        r.input(k, types[k] || sql.Int, v);
        sets.push(`${cols[k]} = @${k}`);
      }
      sets.push('updated_at = SYSUTCDATETIME()');
      try {
        await r.query(`UPDATE dbo.products SET ${sets.join(', ')} WHERE store_id = @s AND id = @id`);
      } catch (err) {
        if (isDup(err)) throw dup('sku');
        throw err;
      }
      return (await this.getProductsByIds(storeId, [id]))[0] || null;
    },

    // ---- sales -------------------------------------------------------------
    async recordSale(storeId, sale) {
      const receiptNo = await inTransaction(async (r) => {
        for (const l of sale.lines) {
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
          .input('pm', sql.NVarChar(10), sale.payment.method)
          .input('ten', sql.Int, sale.payment.tenderedCents)
          .input('chg', sql.Int, sale.payment.changeCents)
          .input('ref', sql.NVarChar(40), sale.payment.cardReference)
          .input('blob', sql.NVarChar(400), sale.receiptBlob)
          .query(`INSERT INTO dbo.sales(id, store_id, receipt_no, cashier_id, cashier_name, subtotal_cents, tax_cents, total_cents,
                    payment_method, tendered_cents, change_cents, card_reference, receipt_blob)
                  VALUES (@id, @s, @no, @cid, @cn, @sub, @tax, @tot, @pm, @ten, @chg, @ref, @blob)`);
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
            .query(`INSERT INTO dbo.sale_lines(sale_id, line_no, product_id, sku, name, qty, unit_price_cents, tax_rate_bp, line_subtotal_cents, line_tax_cents)
                    VALUES (@sid, @ln, @pid, @sku, @n, @q, @up, @tr, @ls, @lt)`);
        }
        return no;
      });
      const saved = await this.getSale(storeId, sale.id);
      saved.receiptNo = receiptNo;
      return saved;
    },
    async getSale(storeId, id) {
      const r = await (await req())
        .input('s', sql.UniqueIdentifier, storeId)
        .input('id', sql.UniqueIdentifier, id)
        .query('SELECT * FROM dbo.sales WHERE store_id = @s AND id = @id');
      if (!r.recordset[0]) return null;
      const lines = await linesFor([id]);
      return mapSale(r.recordset[0], lines.get(lower(id)) || []);
    },
    async listSales(storeId, { from, to, limit = 50 } = {}) {
      const r = await (await req())
        .input('s', sql.UniqueIdentifier, storeId)
        .input('from', sql.DateTime2, from ? new Date(from) : new Date(0))
        .input('to', sql.DateTime2, to ? new Date(to) : new Date('9999-12-31'))
        .input('lim', sql.Int, Math.min(limit, 500))
        .query('SELECT TOP (@lim) * FROM dbo.sales WHERE store_id = @s AND created_at >= @from AND created_at < @to ORDER BY created_at DESC');
      const lines = await linesFor(r.recordset.map((x) => x.id));
      return r.recordset.map((x) => mapSale(x, lines.get(lower(x.id)) || []));
    },
    async refundSale(storeId, id) {
      const done = await inTransaction(async (r) => {
        const u = await r()
          .input('s', sql.UniqueIdentifier, storeId)
          .input('id', sql.UniqueIdentifier, id)
          .query("UPDATE dbo.sales SET status = N'refunded', refunded_at = SYSUTCDATETIME() WHERE store_id = @s AND id = @id AND status = N'completed'");
        if (u.rowsAffected[0] !== 1) return false;
        await r()
          .input('s', sql.UniqueIdentifier, storeId)
          .input('id', sql.UniqueIdentifier, id)
          .query(`UPDATE p SET p.stock = p.stock + l.qty FROM dbo.products p
                  JOIN dbo.sale_lines l ON l.product_id = p.id WHERE l.sale_id = @id AND p.store_id = @s`);
        return true;
      });
      const sale = await this.getSale(storeId, id);
      if (!sale) return null;
      if (!done) throw Object.assign(new Error('already refunded'), { code: 'ALREADY_REFUNDED' });
      return sale;
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
    async set(name, value) {
      await client.setSecret(name, value, { contentType: 'eurc/hmac-key' });
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
