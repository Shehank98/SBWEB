-- 005: card payments through OnePay (platform subscriptions now, shop orders in 006).
-- One row per OnePay checkout attempt. The unique ipg_transaction_id + row locks make
-- the webhook and the return page idempotent: whichever arrives first settles it.
CREATE TABLE IF NOT EXISTS gateway_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           TEXT NOT NULL DEFAULT 'onepay',
  kind               TEXT NOT NULL CHECK (kind IN ('SUBSCRIPTION', 'ORDER')),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  payment_id         UUID REFERENCES payments(id) ON DELETE SET NULL,   -- SUBSCRIPTION
  order_id           UUID REFERENCES orders(id) ON DELETE SET NULL,     -- ORDER
  reference          TEXT NOT NULL UNIQUE,         -- our reference sent to OnePay
  amount             NUMERIC(12, 2) NOT NULL,      -- exactly what was hashed and sent
  currency           TEXT NOT NULL DEFAULT 'LKR',
  mode               TEXT NOT NULL DEFAULT 'sandbox',  -- sandbox | live (which credentials)
  ipg_transaction_id TEXT UNIQUE,                  -- OnePay's transaction id
  status             TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | PAID | FAILED | CANCELLED
  status_message     TEXT,
  paid_on            TIMESTAMPTZ,
  raw_create         JSONB,
  raw_status         JSONB,
  raw_callback       JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gtx_business ON gateway_transactions(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gtx_pending ON gateway_transactions(status, created_at) WHERE status = 'PENDING';
