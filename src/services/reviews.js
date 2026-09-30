// Buyer reviews: one per product per delivered order, only on stores where a
// Sidadiya admin has enabled reviews (stores.reviews_enabled).
import { query } from '../db/pool.js';
import { badRequest, HttpError } from '../utils/http.js';

export async function reviewsEnabled(businessId) {
  const r = (await query('SELECT reviews_enabled FROM stores WHERE business_id = $1', [businessId])).rows[0];
  return !!(r && r.reviews_enabled);
}

// list: [{ productId, rating 1..5, body? }]. Returns how many were saved.
export async function saveBuyerReviews(businessId, order, list) {
  if (!(await reviewsEnabled(businessId))) throw new HttpError(403, 'Reviews are not open for this shop yet.');
  if (order.status !== 'DELIVERED') throw badRequest('You can review your order once it has been delivered.');
  list = Array.isArray(list) ? list.slice(0, 50) : [];
  if (!list.length) throw badRequest('Add a star rating first.');
  const items = (await query('SELECT product_id, name FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL', [order.id])).rows;
  const byId = new Map(items.map((i) => [i.product_id, i.name]));
  let saved = 0;
  for (const r of list) {
    const rating = Math.round(Number(r.rating));
    if (!byId.has(r.productId) || !(rating >= 1 && rating <= 5)) continue;
    const body = r.body ? String(r.body).trim().slice(0, 1000) : null;
    const ins = await query(
      `INSERT INTO product_reviews (business_id, product_id, order_id, product_name, rating, body, customer_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (order_id, product_id) DO NOTHING RETURNING id`,
      [businessId, r.productId, order.id, byId.get(r.productId).split(' (')[0], rating, body, order.customer_name]
    );
    saved += ins.rowCount;
  }
  if (!saved) throw badRequest('These products are already reviewed, or the rating is missing.');
  return saved;
}
