-- 004: seller verification (ID copy + address proof) reviewed by the admin.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'NOT_SUBMITTED'; -- NOT_SUBMITTED | PENDING | VERIFIED | REJECTED
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verification_reason TEXT;          -- rejection reason shown to the seller
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verification_submitted_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verification_reviewed_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS verification_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_businesses_verification ON businesses(verification_status);

-- Private documents. storage_key is a PRIVATE object path (Firebase: private/shops/<id>/...,
-- local driver: a folder that is never served). No public URL is ever stored; admins
-- read them through short-lived signed URLs.
CREATE TABLE IF NOT EXISTS verification_documents (
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('id', 'address')),
  storage_key  TEXT NOT NULL,
  filename     TEXT,
  content_type TEXT,
  size_bytes   INTEGER,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, kind)
);
