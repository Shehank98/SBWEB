-- 001: editable plans with feature flags, 14-day Starter trial, platform settings,
-- and an idempotency log for scheduled jobs. Additive only: existing shops keep
-- their status, plan and dates untouched.

-- ---- Plans: admin-editable pricing + per-plan feature flags --------------------
ALTER TABLE plans ADD COLUMN IF NOT EXISTS compare_at_price INTEGER;          -- shown struck through (e.g. 1500)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The catalogue of gateable features. Plans store { "<key>": true|false }; adding a
-- row here (plus a check in code) is all it takes to gate a new feature.
CREATE TABLE IF NOT EXISTS plan_feature_defs (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO plan_feature_defs (key, label, description, sort_order) VALUES
  ('card_payments',    'Card payments',          'Accept cards at checkout through the shop''s own OnePay account', 1),
  ('weekly_summary',   'Weekly sales email',     'Monday summary of sales, orders, top products and traffic',       2),
  ('coupons',          'Coupons and discounts',  'Create discount codes for customers',                              3),
  ('reports',          'Sales reports',          'Reports page with charts and top products',                        4),
  ('advanced_reports', 'Advanced reports',       'Customer insights: cities, repeat buyers, weekdays, coupon use',   5),
  ('staff',            'Staff accounts',         'Give staff their own login with limited access',                   6)
ON CONFLICT (key) DO NOTHING;

-- New prices (LKR / month). Runs once; after this the admin edits them in Admin Settings.
UPDATE plans SET price = 999,  compare_at_price = 1500 WHERE id = 'starter';
UPDATE plans SET price = 1399, compare_at_price = NULL WHERE id = 'business';
UPDATE plans SET price = 2000, compare_at_price = NULL WHERE id = 'pro';

-- Default feature flags, matching what the code previously hard-coded per plan id.
UPDATE plans SET feature_flags = '{"card_payments":true,"weekly_summary":true,"coupons":false,"reports":false,"advanced_reports":false,"staff":false}'::jsonb WHERE id = 'starter';
UPDATE plans SET feature_flags = '{"card_payments":true,"weekly_summary":true,"coupons":true,"reports":true,"advanced_reports":false,"staff":false}'::jsonb   WHERE id = 'business';
UPDATE plans SET feature_flags = '{"card_payments":true,"weekly_summary":true,"coupons":true,"reports":true,"advanced_reports":true,"staff":true}'::jsonb     WHERE id = 'pro';
UPDATE plans SET tagline = 'Everything to start selling online' WHERE id = 'starter'  AND tagline IS NULL;
UPDATE plans SET tagline = 'Coupons and sales reports'          WHERE id = 'business' AND tagline IS NULL;
UPDATE plans SET tagline = 'Staff accounts and deep insights'   WHERE id = 'pro'      AND tagline IS NULL;

-- ---- Trial -----------------------------------------------------------------------
-- New business statuses: TRIAL (14 days, Starter features) and TRIAL_EXPIRED
-- (storefront locked, dashboard behind a payment wall). No CHECK constraint exists
-- on businesses.status, so no constraint change is needed.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_started_at  TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_ends_at     TIMESTAMPTZ;
-- The plan the seller picked at signup, to preselect on the payment page.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS preferred_plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses(status);
CREATE INDEX IF NOT EXISTS idx_businesses_trial_ends ON businesses(trial_ends_at) WHERE status = 'TRIAL';

-- ---- Platform settings (admin-editable key/value) ----------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO platform_settings (key, value) VALUES
  ('trial_days', '14'::jsonb),
  -- The bank accounts shown for the manual-transfer fallback (previously hard-coded in the page).
  ('platform_bank_accounts', '[{"bank":"Commercial Bank","holder":"PS Kavishka","accountNo":"8006307123","branch":"Arpico Super Hyde Park"},{"bank":"Sampath Bank","holder":"PS Kavishka","accountNo":"121057700812","branch":"Karagampitiya"}]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---- Scheduled job idempotency ------------------------------------------------------
-- One row per (job, period). A job claims its period with INSERT ... ON CONFLICT DO
-- NOTHING, so restarts, retries or two instances never run the same period twice.
CREATE TABLE IF NOT EXISTS job_runs (
  job         TEXT NOT NULL,
  period      TEXT NOT NULL,          -- e.g. '2026-09-29' (daily) or '2026-W40' (weekly)
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  summary     JSONB,
  PRIMARY KEY (job, period)
);
