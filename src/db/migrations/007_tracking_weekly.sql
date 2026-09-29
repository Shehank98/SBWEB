-- 007: storefront traffic sources, weekly seller summary (data model ready for
-- WhatsApp/SMS digests), and courier tracking on orders.

-- One row per storefront page view. Privacy: no IP, no full URLs, only the
-- referrer's host and campaign tags. session_id is a random id kept in the buyer's
-- browser for the session (not linked to any person).
CREATE TABLE IF NOT EXISTS store_visits (
  id            BIGSERIAL PRIMARY KEY,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  visited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  page          TEXT,                 -- home | product | cart | order | policy
  source        TEXT NOT NULL,        -- facebook | instagram | whatsapp | google | tiktok | direct | <utm_source> | other site host
  medium        TEXT,
  campaign      TEXT,
  referrer_host TEXT,
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_business_time ON store_visits(business_id, visited_at DESC);

-- First-touch attribution on orders.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS medium TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS campaign TEXT;

-- Courier tracking.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;

-- Seller preferences. digest_channels is ready for WhatsApp/SMS later:
-- {"email": true, "whatsapp": false, "sms": false}
ALTER TABLE stores ADD COLUMN IF NOT EXISTS weekly_summary_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS digest_channels JSONB NOT NULL DEFAULT '{"email": true, "whatsapp": false, "sms": false}'::jsonb;

-- Every computed weekly digest is stored once, whatever channel delivers it. A future
-- WhatsApp/SMS sender reads `payload` and records its outcome in `deliveries`.
CREATE TABLE IF NOT EXISTS seller_digests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  payload      JSONB NOT NULL,
  deliveries   JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"email":"QUEUED","whatsapp":"SKIPPED",...}
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, period_start)
);
