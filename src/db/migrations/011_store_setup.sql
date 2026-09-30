-- Store setup progress: delivery and payment settings start with defaults
-- (Rs. 350, cash on delivery on), so "done" means the seller confirmed them.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS delivery_set_at TIMESTAMPTZ;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payments_set_at TIMESTAMPTZ;
-- Shops that existed before this change already chose their settings.
UPDATE stores SET delivery_set_at = created_at WHERE delivery_set_at IS NULL;
UPDATE stores SET payments_set_at = created_at WHERE payments_set_at IS NULL;
