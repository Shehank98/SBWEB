-- 006: sellers' own payment gateways (OnePay, PayHere, generic slot), card-paid
-- orders, manual "Refunded" status, and the admin-editable "How to get OnePay" guide.

-- Credentials are AES-256-GCM encrypted by the app (GATEWAY_ENC_KEY) before they
-- reach the database, and are never returned to the browser. `meta` only holds
-- masked hints (e.g. last 4 characters of the app id) for the settings screen.
CREATE TABLE IF NOT EXISTS store_gateways (
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,                       -- onepay | payhere | <future>
  enabled         BOOLEAN NOT NULL DEFAULT false,
  mode            TEXT NOT NULL DEFAULT 'sandbox',     -- sandbox | live
  credentials_enc TEXT,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, provider)
);

-- Online payment state of an order (NULL on older cash/bank orders = not tracked).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT;   -- PENDING | PAID | FAILED | CANCELLED | REFUNDED
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_on TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
