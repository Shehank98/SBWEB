-- 010: customer reviews are switched on per store by a Sidadiya admin.
-- Off by default: until an admin enables them, the store shows no ratings or
-- reviews and buyers are not asked to review (existing reviews are kept).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS reviews_enabled BOOLEAN NOT NULL DEFAULT false;
