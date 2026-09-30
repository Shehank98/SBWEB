-- Refunds: how much was refunded (full or partial), so reports can deduct it,
-- and when the order's items went back into stock (never twice).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restocked_at TIMESTAMPTZ;
-- Orders marked refunded before this change were full refunds.
UPDATE orders SET refund_amount = total WHERE status = 'REFUNDED' AND refund_amount IS NULL;
