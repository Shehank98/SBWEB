-- Bank transfer payment slips uploaded by buyers at checkout. Stored privately
-- (never a public URL); the shop views them through a short-lived signed link.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS slip_key TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS slip_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS slip_type TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS slip_uploaded_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS slip_note TEXT;   -- why the shop asked for a new slip
