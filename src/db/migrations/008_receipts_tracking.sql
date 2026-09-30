-- 008: digital receipts (30-day links), order tracking, waybills, visitor-source gating.

-- Digital receipt: a separate unguessable token from the tracking token, so a
-- receipt link can expire without breaking order tracking. Existing orders get a
-- token and expire 30 days after they were placed (so old ones show "expired").
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_token TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_expires_at TIMESTAMPTZ;
UPDATE orders SET receipt_token = encode(gen_random_bytes(16), 'hex') WHERE receipt_token IS NULL;
UPDATE orders SET receipt_expires_at = created_at + interval '30 days' WHERE receipt_expires_at IS NULL;
ALTER TABLE orders ALTER COLUMN receipt_token SET DEFAULT encode(gen_random_bytes(16), 'hex');
ALTER TABLE orders ALTER COLUMN receipt_token SET NOT NULL;
ALTER TABLE orders ALTER COLUMN receipt_expires_at SET DEFAULT (now() + interval '30 days');
ALTER TABLE orders ALTER COLUMN receipt_expires_at SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_receipt_token ON orders(receipt_token);

-- When the seller last shared the receipt by WhatsApp (shown on the order).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_shared_at TIMESTAMPTZ;
-- When a waybill was last printed (helps sellers see what is ready to hand over).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS waybill_printed_at TIMESTAMPTZ;

-- Order tracking uses the existing orders.public_token (002) as its URL token.
-- Timeline timestamps come from order_status_history; index it for the lookup.
CREATE INDEX IF NOT EXISTS idx_osh_order_time ON order_status_history(order_id, created_at);

-- "Where visitors came from" is a Pro feature (the API refuses other plans).
INSERT INTO plan_feature_defs (key, label, description, sort_order)
VALUES ('traffic_sources', 'Visitor sources', 'See where your visitors come from: WhatsApp, Facebook, Instagram, Google, TikTok', 7)
ON CONFLICT (key) DO NOTHING;
UPDATE plans SET feature_flags = feature_flags || jsonb_build_object('traffic_sources', id = 'pro')
 WHERE NOT (feature_flags ? 'traffic_sources');
