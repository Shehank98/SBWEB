-- 003: mandatory policy pages (card network / OnePay compliance) and contact details.

-- Business contact details shown on the Contact page and in the footer.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS contact_email TEXT;
-- Values the default templates are filled with (seller-editable).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS return_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS refund_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS return_shipping TEXT NOT NULL DEFAULT 'buyer'; -- buyer | seller | seller_if_faulty

-- One row per shop per policy. While is_custom = false the text is rendered from the
-- template on every read, so it follows changes to the shop name/contact details.
-- confirmed_at = the seller reviewed and published it (counts toward compliance).
CREATE TABLE IF NOT EXISTS store_policies (
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('refund', 'privacy', 'return', 'terms')),
  content      TEXT,
  is_custom    BOOLEAN NOT NULL DEFAULT false,
  confirmed_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, kind)
);

-- Every existing shop gets its four policy rows (template-backed) right away.
INSERT INTO store_policies (business_id, kind)
SELECT b.id, k.kind FROM businesses b CROSS JOIN (VALUES ('refund'), ('privacy'), ('return'), ('terms')) AS k(kind)
ON CONFLICT DO NOTHING;

-- Prefill the contact email from the owner's account email where empty.
UPDATE stores s SET contact_email = b.email FROM businesses b WHERE b.id = s.business_id AND s.contact_email IS NULL;

-- Checkout records the buyer's agreement to the Terms & Conditions.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- Platform (Sidadiya) contact details and legal pages, editable in Admin Settings.
INSERT INTO platform_settings (key, value) VALUES
  ('platform_contact', '{"businessName":"Sidadiya","email":"","phone":"","whatsapp":"","address":"","hours":""}'::jsonb),
  ('platform_policies', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;
