import { query } from '../db/pool.js';

// The business's current plan row (most recent subscription), or null.
export async function currentPlan(businessId) {
  return (
    await query(
      `SELECT pl.* FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [businessId]
    )
  ).rows[0] || null;
}

// A tier limit where NULL/undefined means "unlimited" (Infinity). Keeps the
// enforcement pattern in one place so categories, images and variants agree.
export function cap(value) {
  return value == null ? Infinity : Number(value);
}
