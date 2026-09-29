-- 002: storefront redesign support. Buyer order-status links and verified reviews.

-- A private, unguessable token per order so the buyer can open their order status
-- page (and leave a review) without an account. Existing orders get one too: a
-- volatile default is evaluated per existing row.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS public_token TEXT NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex');
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_public_token ON orders(public_token);

-- Reviews: only from a delivered order (verified buyer), one per product per order.
CREATE TABLE IF NOT EXISTS product_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id    UUID REFERENCES products(id) ON DELETE SET NULL,
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,              -- snapshot, survives product deletion
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT,
  customer_name TEXT NOT NULL,              -- shown as first name + initial
  status        TEXT NOT NULL DEFAULT 'PUBLISHED',  -- PUBLISHED | HIDDEN (seller can hide)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_business ON product_reviews(business_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_id, status);
