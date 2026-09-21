-- Kade platform schema — multi-tenant commerce SaaS.
-- Every business-owned record carries business_id so all tenant data is isolated
-- by a single WHERE clause derived from the authenticated user's session.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Plans (platform-wide, not tenant scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,               -- 'starter' | 'business' | 'pro'
  name           TEXT NOT NULL,
  price          INTEGER NOT NULL,               -- in rupees
  duration_days  INTEGER NOT NULL DEFAULT 30,
  max_products   INTEGER,                        -- NULL = unlimited
  max_images     INTEGER,
  features       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  sort_order     INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Businesses (the tenant) and their owner/staff users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  type         TEXT,
  description  TEXT,
  phone        TEXT,
  whatsapp     TEXT,
  email        TEXT,
  address      TEXT,
  city         TEXT,
  district     TEXT,
  facebook     TEXT,
  instagram    TEXT,
  logo_url     TEXT,
  -- Subscription lifecycle status lives on the business for fast reads:
  -- PENDING_PAYMENT | PENDING_APPROVAL | ACTIVE | EXPIRING | GRACE_PERIOD | SUSPENDED | CANCELLED
  status       TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID REFERENCES businesses(id) ON DELETE CASCADE,  -- NULL for SUPER_ADMIN
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'BUSINESS_OWNER',            -- SUPER_ADMIN | BUSINESS_OWNER | BUSINESS_STAFF
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);

-- ---------------------------------------------------------------------------
-- Store (customer-facing shopfront, one per business)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  tagline            TEXT,
  about              TEXT,
  preset             TEXT NOT NULL DEFAULT 'orchid',   -- storefront colour preset
  phone              TEXT,
  whatsapp           TEXT,
  address            TEXT,
  city               TEXT,
  logo_url           TEXT,
  cover_url          TEXT,
  delivery_fee       INTEGER NOT NULL DEFAULT 350,
  delivery_free_above INTEGER NOT NULL DEFAULT 0,
  pickup             BOOLEAN NOT NULL DEFAULT true,
  pay_cod            BOOLEAN NOT NULL DEFAULT true,
  pay_bank           BOOLEAN NOT NULL DEFAULT true,
  pay_online         BOOLEAN NOT NULL DEFAULT false,
  bank_details       TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stores_business ON stores(business_id);

-- ---------------------------------------------------------------------------
-- Subscriptions & payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_id      TEXT NOT NULL REFERENCES plans(id),
  status       TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  start_date   DATE,
  expiry_date  DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subs_business ON subscriptions(business_id);

CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_id         TEXT REFERENCES plans(id),
  amount          INTEGER NOT NULL,
  method          TEXT NOT NULL DEFAULT 'Bank transfer',
  reference       TEXT,
  slip_url        TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED
  reason          TEXT,                              -- rejection reason
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_business ON payments(business_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_categories_business ON categories(business_id);

CREATE TABLE IF NOT EXISTS products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category     TEXT,
  name         TEXT NOT NULL,
  description  TEXT,
  price        INTEGER NOT NULL,
  sale_price   INTEGER,
  sku          TEXT,
  stock        INTEGER NOT NULL DEFAULT 0,
  low_at       INTEGER NOT NULL DEFAULT 5,
  -- Variants kept as { "Size": ["S","M"], "Colour": ["Red"] } to match the storefront's
  -- option picker. A dedicated product_variants table is the v2 upgrade path.
  options      JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_url    TEXT,
  tone         TEXT NOT NULL DEFAULT 'f',           -- placeholder tile colour until image_url is set
  status       TEXT NOT NULL DEFAULT 'ACTIVE',      -- ACTIVE | HIDDEN
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,                    -- human reference e.g. ORD-10452
  customer_name   TEXT NOT NULL,
  phone           TEXT NOT NULL,
  whatsapp        TEXT,
  address         TEXT,
  city            TEXT,
  district        TEXT,
  delivery_method TEXT,
  payment_method  TEXT,
  subtotal        INTEGER NOT NULL,
  delivery_fee    INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,
  -- PENDING | CONFIRMED | PROCESSING | READY_TO_SHIP | SHIPPED | DELIVERED | CANCELLED
  status          TEXT NOT NULL DEFAULT 'PENDING',
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);
CREATE INDEX IF NOT EXISTS idx_orders_business ON orders(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  UUID REFERENCES products(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,      -- product name incl. chosen variant, snapshotted
  qty         INTEGER NOT NULL,
  price       INTEGER NOT NULL    -- price at time of order (never recomputed)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  note        TEXT,
  changed_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history(order_id);

-- ---------------------------------------------------------------------------
-- Coupons (Business/Pro plans). Applied by customers at checkout.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,                  -- stored uppercase
  type         TEXT NOT NULL DEFAULT 'percent',-- 'percent' | 'fixed'
  value        INTEGER NOT NULL,               -- percent 1..100, or rupees
  min_order    INTEGER NOT NULL DEFAULT 0,     -- minimum subtotal to qualify
  expires_on   DATE,                           -- NULL = no expiry
  usage_limit  INTEGER,                        -- NULL = unlimited
  used_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | DISABLED
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);
CREATE INDEX IF NOT EXISTS idx_coupons_business ON coupons(business_id);

-- Discount columns on orders (idempotent for existing databases).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount INTEGER NOT NULL DEFAULT 0;
-- Optional customer email so we can send order-status updates by email.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email TEXT;

-- Staff permissions: which dashboard sections a BUSINESS_STAFF user may use
-- (e.g. ["orders","products"]). Owners have full access regardless.
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Notifications outbox — Apps Script (or any worker) polls status = 'PENDING'
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID REFERENCES businesses(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,      -- REGISTERED | APPROVED | REJECTED | NEW_ORDER | ORDER_CONFIRMED | EXPIRY_REMINDER | SUSPENDED ...
  recipient    TEXT NOT NULL,      -- email address
  subject      TEXT NOT NULL,
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | SENT | FAILED
  data         JSONB NOT NULL DEFAULT '{}'::jsonb, -- structured fields for the email template
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;
