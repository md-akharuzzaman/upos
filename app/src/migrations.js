'use strict';

// Versioned, forward-only database migrations for the eURC Point of Sale.
//
// Rule for this project (expand / contract): every migration must be backward
// compatible with the previous app version. During a production release the
// staging slot (new version) and the production slot (old version) run against
// the SAME database, and a rollback swaps the old version back in. So:
//   - add tables / nullable columns / indexes  -> OK in one release
//   - rename / drop / make NOT NULL             -> split across two releases
//
// The app applies pending migrations itself at start-up, using its managed
// identity, inside an application lock (sp_getapplock) so two instances or
// two slots never migrate at the same time. The CI/CD runner therefore never
// needs network access to the database, and no SQL password exists anywhere.
//
// Data model: a store (= SaaS tenant) has users (manager / cashier), products
// and sales; a sale has lines. Money is stored in integer cents.

const MIGRATIONS = [
  {
    version: 1,
    name: 'create_stores_and_users',
    sql: `
IF OBJECT_ID(N'dbo.stores', N'U') IS NULL
CREATE TABLE dbo.stores (
  id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_stores PRIMARY KEY,
  slug        NVARCHAR(40)     NOT NULL CONSTRAINT uq_stores_slug UNIQUE,
  name        NVARCHAR(120)    NOT NULL,
  currency    NCHAR(3)         NOT NULL CONSTRAINT df_stores_currency DEFAULT N'CAD',
  created_at  DATETIME2(3)     NOT NULL CONSTRAINT df_stores_created DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID(N'dbo.users', N'U') IS NULL
CREATE TABLE dbo.users (
  id            UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_users PRIMARY KEY,
  store_id      UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_users_store REFERENCES dbo.stores(id) ON DELETE CASCADE,
  email         NVARCHAR(254)    NOT NULL,
  name          NVARCHAR(120)    NOT NULL,
  role          NVARCHAR(20)     NOT NULL,
  password_hash NVARCHAR(200)    NOT NULL,
  active        BIT              NOT NULL CONSTRAINT df_users_active DEFAULT 1,
  created_at    DATETIME2(3)     NOT NULL CONSTRAINT df_users_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_users_store_email UNIQUE (store_id, email),
  CONSTRAINT ck_users_role CHECK (role IN (N'manager', N'cashier'))
);`,
  },
  {
    version: 2,
    name: 'create_products',
    sql: `
IF OBJECT_ID(N'dbo.products', N'U') IS NULL
CREATE TABLE dbo.products (
  id            UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_products PRIMARY KEY,
  store_id      UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_products_store REFERENCES dbo.stores(id) ON DELETE CASCADE,
  sku           NVARCHAR(40)     NOT NULL,
  name          NVARCHAR(120)    NOT NULL,
  category      NVARCHAR(60)     NOT NULL CONSTRAINT df_products_category DEFAULT N'General',
  price_cents   INT              NOT NULL CONSTRAINT ck_products_price CHECK (price_cents >= 0),
  tax_rate_bp   INT              NOT NULL CONSTRAINT df_products_tax DEFAULT 1300,
  stock         INT              NOT NULL CONSTRAINT df_products_stock DEFAULT 0,
  active        BIT              NOT NULL CONSTRAINT df_products_active DEFAULT 1,
  updated_at    DATETIME2(3)     NOT NULL CONSTRAINT df_products_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_products_store_sku UNIQUE (store_id, sku)
);`,
  },
  {
    version: 3,
    name: 'create_sales',
    sql: `
IF OBJECT_ID(N'dbo.sales', N'U') IS NULL
CREATE TABLE dbo.sales (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_sales PRIMARY KEY,
  store_id        UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_sales_store REFERENCES dbo.stores(id) ON DELETE CASCADE,
  receipt_no      INT              NOT NULL,
  cashier_id      UNIQUEIDENTIFIER NOT NULL,
  cashier_name    NVARCHAR(120)    NOT NULL,
  subtotal_cents  INT              NOT NULL,
  tax_cents       INT              NOT NULL,
  total_cents     INT              NOT NULL,
  payment_method  NVARCHAR(10)     NOT NULL,
  tendered_cents  INT              NULL,
  change_cents    INT              NULL,
  card_reference  NVARCHAR(40)     NULL,
  status          NVARCHAR(10)     NOT NULL CONSTRAINT df_sales_status DEFAULT N'completed',
  receipt_blob    NVARCHAR(400)    NOT NULL,
  created_at      DATETIME2(3)     NOT NULL CONSTRAINT df_sales_created DEFAULT SYSUTCDATETIME(),
  refunded_at     DATETIME2(3)     NULL,
  CONSTRAINT uq_sales_store_receipt UNIQUE (store_id, receipt_no),
  CONSTRAINT ck_sales_payment CHECK (payment_method IN (N'cash', N'card'))
);
IF OBJECT_ID(N'dbo.sale_lines', N'U') IS NULL
CREATE TABLE dbo.sale_lines (
  sale_id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_lines_sale REFERENCES dbo.sales(id) ON DELETE CASCADE,
  line_no          INT              NOT NULL,
  product_id       UNIQUEIDENTIFIER NOT NULL,
  sku              NVARCHAR(40)     NOT NULL,
  name             NVARCHAR(120)    NOT NULL,
  qty              INT              NOT NULL,
  unit_price_cents INT              NOT NULL,
  tax_rate_bp      INT              NOT NULL,
  line_subtotal_cents INT           NOT NULL,
  line_tax_cents   INT              NOT NULL,
  CONSTRAINT pk_sale_lines PRIMARY KEY (sale_id, line_no)
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'ix_sales_store_created')
CREATE INDEX ix_sales_store_created ON dbo.sales(store_id, created_at);`,
  },
  {
    // v2.1 item-level refunds. Expand only: two new tables, nothing changed on
    // existing ones, so v2.0 still starts and runs against this schema. Caveat
    // after a rollback to v2.0: it ignores these tables, so its "Refund sale"
    // on a partly refunded receipt would restock the already-returned units
    // again, and its report ignores part refunds. Avoid refunds until v2.1 is
    // back, or re-deploy v2.1 (roll forward).
    // store_id has no foreign key on purpose: refunds already cascade from
    // sales, and SQL Server refuses a second cascade path from stores.
    version: 4,
    name: 'create_refunds',
    sql: `
IF OBJECT_ID(N'dbo.refunds', N'U') IS NULL
CREATE TABLE dbo.refunds (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_refunds PRIMARY KEY,
  store_id        UNIQUEIDENTIFIER NOT NULL,
  sale_id         UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_refunds_sale REFERENCES dbo.sales(id) ON DELETE CASCADE,
  seq             INT              NOT NULL,
  cashier_id      UNIQUEIDENTIFIER NOT NULL,
  cashier_name    NVARCHAR(120)    NOT NULL,
  method          NVARCHAR(10)     NOT NULL,
  reason          NVARCHAR(200)    NULL,
  subtotal_cents  INT              NOT NULL,
  tax_cents       INT              NOT NULL,
  total_cents     INT              NOT NULL,
  created_at      DATETIME2(3)     NOT NULL CONSTRAINT df_refunds_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_refunds_sale_seq UNIQUE (sale_id, seq),
  CONSTRAINT ck_refunds_method CHECK (method IN (N'cash', N'card'))
);
IF OBJECT_ID(N'dbo.refund_lines', N'U') IS NULL
CREATE TABLE dbo.refund_lines (
  refund_id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_refund_lines_refund REFERENCES dbo.refunds(id) ON DELETE CASCADE,
  line_no             INT              NOT NULL,
  product_id          UNIQUEIDENTIFIER NOT NULL,
  sku                 NVARCHAR(40)     NOT NULL,
  name                NVARCHAR(120)    NOT NULL,
  qty                 INT              NOT NULL CONSTRAINT ck_refund_lines_qty CHECK (qty > 0),
  line_subtotal_cents INT              NOT NULL,
  line_tax_cents      INT              NOT NULL,
  CONSTRAINT pk_refund_lines PRIMARY KEY (refund_id, line_no)
);`, // uq_refunds_sale_seq already indexes refunds by sale_id
  },
  {
    // v2.2 store management. Expand only: new columns are NULL-able or have a
    // default, so v2.0/v2.1 keep inserting rows exactly as before. Caveat after
    // a rollback to v2.1: it ignores promotions and the refund policy, and its
    // part refunds pay back list price on promoted lines. Pause refunds of
    // promoted or final-sale items until v2.2 is back (roll forward).
    version: 5,
    name: 'refund_policy_and_promotions',
    sql: `
IF COL_LENGTH(N'dbo.products', N'refundable') IS NULL
  ALTER TABLE dbo.products ADD refundable BIT NOT NULL CONSTRAINT df_products_refundable DEFAULT 1;
IF COL_LENGTH(N'dbo.stores', N'refund_window_days') IS NULL
  ALTER TABLE dbo.stores ADD refund_window_days INT NOT NULL CONSTRAINT df_stores_refund_window DEFAULT 30;
IF COL_LENGTH(N'dbo.sales', N'discount_cents') IS NULL
  ALTER TABLE dbo.sales ADD discount_cents INT NULL;
IF COL_LENGTH(N'dbo.sale_lines', N'refundable') IS NULL
  ALTER TABLE dbo.sale_lines ADD refundable BIT NULL;
IF COL_LENGTH(N'dbo.sale_lines', N'discount_cents') IS NULL
  ALTER TABLE dbo.sale_lines ADD discount_cents INT NULL;
IF COL_LENGTH(N'dbo.sale_lines', N'promotion_name') IS NULL
  ALTER TABLE dbo.sale_lines ADD promotion_name NVARCHAR(120) NULL;
IF COL_LENGTH(N'dbo.refunds', N'policy_override') IS NULL
  ALTER TABLE dbo.refunds ADD policy_override BIT NULL;
IF OBJECT_ID(N'dbo.promotions', N'U') IS NULL
CREATE TABLE dbo.promotions (
  id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_promotions PRIMARY KEY,
  store_id    UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_promotions_store REFERENCES dbo.stores(id) ON DELETE CASCADE,
  name        NVARCHAR(120)    NOT NULL,
  kind        NVARCHAR(10)     NOT NULL CONSTRAINT ck_promotions_kind CHECK (kind IN (N'percent', N'amount')),
  value       INT              NOT NULL CONSTRAINT ck_promotions_value CHECK (value > 0),
  target      NVARCHAR(10)     NOT NULL CONSTRAINT ck_promotions_target CHECK (target IN (N'all', N'category', N'skus')),
  category    NVARCHAR(60)     NULL,
  skus        NVARCHAR(4000)   NULL,
  starts_at   DATETIME2(3)     NOT NULL,
  ends_at     DATETIME2(3)     NULL,
  active      BIT              NOT NULL CONSTRAINT df_promotions_active DEFAULT 1,
  created_at  DATETIME2(3)     NOT NULL CONSTRAINT df_promotions_created DEFAULT SYSUTCDATETIME()
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'ix_promotions_store')
CREATE INDEX ix_promotions_store ON dbo.promotions(store_id, active);`,
  },
];

const BOOTSTRAP_SQL = `
IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
CREATE TABLE dbo.schema_migrations (
  version     INT           NOT NULL CONSTRAINT pk_schema_migrations PRIMARY KEY,
  name        NVARCHAR(100) NOT NULL,
  app_version NVARCHAR(50)  NULL,
  applied_at  DATETIME2(3)  NOT NULL CONSTRAINT df_schema_migrations DEFAULT SYSUTCDATETIME()
);`;

function pendingMigrations(appliedVersions) {
  const applied = new Set(appliedVersions);
  return MIGRATIONS.filter((m) => !applied.has(m.version));
}

function validateMigrations(list = MIGRATIONS) {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration ${m.name}: expected version ${i + 1}, got ${m.version}`);
    if (/\b(DROP\s+(TABLE|COLUMN)|sp_rename)\b/i.test(m.sql)) {
      throw new Error(`migration ${m.version} (${m.name}) contains a destructive statement; use expand/contract`);
    }
  });
  return true;
}

module.exports = { MIGRATIONS, BOOTSTRAP_SQL, pendingMigrations, validateMigrations };
