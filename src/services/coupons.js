import { query } from '../db/pool.js';

// Evaluate a coupon code for a business against a cart subtotal.
// `runner` is a pg client (inside a transaction) or falls back to the pool.
// Returns { valid, discount, message, code?, coupon? }.
export async function evalCoupon(runner, businessId, code, subtotal) {
  const r = runner || { query };
  if (!code) return { valid: false, discount: 0, message: 'Enter a code.' };
  const c = (
    await r.query('SELECT * FROM coupons WHERE business_id = $1 AND code = $2', [businessId, String(code).trim().toUpperCase()])
  ).rows[0];
  if (!c) return { valid: false, discount: 0, message: 'That code is not valid.' };
  if (c.status !== 'ACTIVE') return { valid: false, discount: 0, message: 'That code is no longer active.' };
  if (c.expires_on) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(c.expires_on) < today) return { valid: false, discount: 0, message: 'That code has expired.' };
  }
  if (c.usage_limit != null && c.used_count >= c.usage_limit) {
    return { valid: false, discount: 0, message: 'That code has reached its usage limit.' };
  }
  if (subtotal < c.min_order) {
    return { valid: false, discount: 0, message: `Spend at least Rs. ${c.min_order.toLocaleString('en-US')} to use this code.` };
  }
  const discount = c.type === 'percent'
    ? Math.round((subtotal * c.value) / 100)
    : Math.min(c.value, subtotal);
  return { valid: true, discount, message: 'Code applied.', code: c.code, coupon: c };
}
