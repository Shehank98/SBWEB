import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { wrap, badRequest, notFound } from '../utils/http.js';
import { orderCode } from '../utils/slug.js';
import * as S from '../services/serialize.js';
import { queueNotification, templates } from '../services/notifications.js';
import { evalCoupon } from '../services/coupons.js';
import { LIVE_STATUSES } from '../services/plan.js';

export const storeRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Statuses in which the storefront is visible to customers (includes TRIAL; a
// TRIAL_EXPIRED shop is locked for buyers until the seller pays).
const LIVE = LIVE_STATUSES;

async function loadStore(slug) {
  const row = (
    await query(
      `SELECT st.*, b.status AS business_status, b.id AS biz_id, b.name AS biz_name, b.email AS biz_email
         FROM stores st JOIN businesses b ON b.id = st.business_id
        WHERE st.slug = $1`,
      [slug]
    )
  ).rows[0];
  if (!row) throw notFound('Store not found.');
  return row;
}

// GET /api/store/:slug — store profile + products. Suspended stores return 200 with
// status so the frontend can show its "temporarily unavailable" page.
storeRouter.get(
  '/:slug',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    const cats = (await query('SELECT name FROM categories WHERE business_id=$1 ORDER BY sort_order, name', [st.biz_id])).rows.map((r) => r.name);
    const store = S.storePublic(st, cats);
    store.status = st.business_status;

    if (!LIVE.has(st.business_status)) {
      return res.json({ store, products: [], available: false });
    }
    const products = (
      await query(
        `SELECT p.*, $2::text AS store_slug, r.avg_rating, r.review_count
           FROM products p
           LEFT JOIN (SELECT product_id, ROUND(AVG(rating)::numeric, 1) avg_rating, COUNT(*) review_count
                        FROM product_reviews WHERE business_id = $1 AND status = 'PUBLISHED' GROUP BY product_id) r
             ON r.product_id = p.id
          WHERE p.business_id=$1 AND p.status='ACTIVE' ORDER BY p.created_at DESC`,
        [st.biz_id, st.slug]
      )
    ).rows.map(S.product);
    Object.assign(store, await storeRatings(st.biz_id));
    res.json({ store, products, available: true });
  })
);

// Store-level rating summary + the latest few reviews for the "What buyers say" strip.
async function storeRatings(businessId) {
  const agg = (await query(
    `SELECT ROUND(AVG(rating)::numeric, 1) avg, COUNT(*) n FROM product_reviews WHERE business_id = $1 AND status = 'PUBLISHED'`,
    [businessId]
  )).rows[0];
  const latest = (await query(
    `SELECT rating, body, customer_name, product_name, created_at FROM product_reviews
      WHERE business_id = $1 AND status = 'PUBLISHED' AND COALESCE(body, '') <> '' ORDER BY created_at DESC LIMIT 6`,
    [businessId]
  )).rows.map(S.review);
  return { rating: { avg: agg.avg != null ? Number(agg.avg) : null, count: Number(agg.n) }, latestReviews: latest };
}

// GET /api/store/:slug/product/:id/reviews — published reviews for one product.
storeRouter.get(
  '/:slug/product/:id/reviews',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    if (!LIVE.has(st.business_status) || !UUID_RE.test(req.params.id)) throw notFound('Product not found.');
    const { rows } = await query(
      `SELECT rating, body, customer_name, product_name, created_at FROM product_reviews
        WHERE business_id = $1 AND product_id = $2 AND status = 'PUBLISHED' ORDER BY created_at DESC LIMIT 50`,
      [st.biz_id, req.params.id]
    );
    res.json({ reviews: rows.map(S.review) });
  })
);

// ---- Buyer order status page (no account: the private token from the order link) ----
async function loadBuyerOrder(req) {
  const st = await loadStore(req.params.slug);
  const token = String(req.query.k || (req.body && req.body.k) || '');
  if (!/^[a-f0-9]{16,64}$/.test(token)) throw notFound('Order not found.');
  const order = (await query('SELECT * FROM orders WHERE business_id = $1 AND code = $2 AND public_token = $3', [st.biz_id, req.params.code, token])).rows[0];
  if (!order) throw notFound('Order not found.');
  return { st, order };
}

// GET /api/store/:slug/orders/:code?k=<token>
storeRouter.get(
  '/:slug/orders/:code',
  wrap(async (req, res) => {
    const { st, order } = await loadBuyerOrder(req);
    const items = (await query('SELECT * FROM order_items WHERE order_id = $1', [order.id])).rows;
    const history = (await query('SELECT status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at', [order.id])).rows;
    const reviewed = new Set((await query('SELECT product_id FROM product_reviews WHERE order_id = $1', [order.id])).rows.map((r) => r.product_id));
    res.json({ order: S.buyerOrder(order, items, history, reviewed), store: { name: st.name, slug: st.slug, phone: st.phone || '', whatsapp: st.whatsapp || '' } });
  })
);

// POST /api/store/:slug/orders/:code/reviews?k=<token>  { reviews: [{ productId, rating, body }] }
// Only for delivered orders; one review per product per order (later posts are ignored).
storeRouter.post(
  '/:slug/orders/:code/reviews',
  wrap(async (req, res) => {
    const { st, order } = await loadBuyerOrder(req);
    if (order.status !== 'DELIVERED') throw badRequest('You can review your order once it has been delivered.');
    const list = Array.isArray(req.body && req.body.reviews) ? req.body.reviews.slice(0, 50) : [];
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
        [st.biz_id, r.productId, order.id, byId.get(r.productId).split(' (')[0], rating, body, order.customer_name]
      );
      saved += ins.rowCount;
    }
    if (!saved) throw badRequest('These products are already reviewed, or the rating is missing.');
    res.status(201).json({ ok: true, saved });
  })
);

// GET /api/store/:slug/product/:id — single product (for the product page + SEO tags).
storeRouter.get(
  '/:slug/product/:id',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    if (!LIVE.has(st.business_status)) throw notFound('Store is unavailable.');
    const p = (await query('SELECT *, $3::text AS store_slug FROM products WHERE id=$1 AND business_id=$2', [req.params.id, st.biz_id, st.slug])).rows[0];
    if (!p) throw notFound('Product not found.');
    res.json({ product: S.product(p) });
  })
);

// POST /api/store/:slug/coupon — validate a coupon code against a subtotal.
storeRouter.post(
  '/:slug/coupon',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    if (!LIVE.has(st.business_status)) throw badRequest('This store is not available right now.');
    const subtotal = Math.max(0, Math.floor(Number(req.body && req.body.subtotal) || 0));
    const result = await evalCoupon(null, st.biz_id, req.body && req.body.code, subtotal);
    res.json(result.valid
      ? { valid: true, code: result.code, discount: result.discount, message: result.message }
      : { valid: false, discount: 0, message: result.message });
  })
);

// POST /api/store/:slug/orders — customer checkout. No auth. Prices are re-read from
// the DB (never trusted from the client) and snapshotted onto the order.
storeRouter.post(
  '/:slug/orders',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    if (!LIVE.has(st.business_status)) throw badRequest('This store is not accepting orders right now.');

    const body = req.body || {};
    const { customer, phone } = body;
    if (!customer || !phone) throw badRequest('Name and phone are required.');
    // Address is always required, regardless of delivery, pickup or payment method.
    if (!body.address || !String(body.address).trim()) throw badRequest('An address is required.');
    if (!Array.isArray(body.items) || !body.items.length) throw badRequest('Your cart is empty.');

    // Re-price each line from the catalogue. Prices are never trusted from the client.
    const lines = [];
    let subtotal = 0;
    for (const it of body.items) {
      const p = (await query('SELECT * FROM products WHERE id=$1 AND business_id=$2', [it.pid, st.biz_id])).rows[0];
      if (!p) throw badRequest('One of the products is no longer available.');
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      const variants = Array.isArray(p.variants) ? p.variants : [];
      let price, label = it.variant || '';
      if (variants.length) {
        // Priced variant: the label must match one of the product's variants.
        const v = variants.find((x) => x.label === it.variant);
        if (!v) throw badRequest(`Please choose an option for ${p.name}.`);
        price = v.sale != null ? v.sale : v.price;
        label = v.label;
      } else {
        // Simple product: any label is just the chosen options, shown for reference.
        price = p.sale_price != null ? p.sale_price : p.price;
      }
      const suffix = label ? ` (${label})` : '';
      lines.push({ product_id: p.id, name: p.name + suffix, qty, price, variantLabel: variants.length ? label : null });
      subtotal += price * qty;
    }

    const fee = st.delivery_free_above && subtotal >= st.delivery_free_above ? 0 : st.delivery_fee;

    const order = await withTransaction(async (client) => {
      // Apply a coupon if one was sent and is valid (re-checked server-side).
      let discount = 0;
      let couponCode = null;
      if (body.coupon) {
        const cp = await evalCoupon(client, st.biz_id, body.coupon, subtotal);
        if (cp.valid) { discount = cp.discount; couponCode = cp.code; }
      }
      const total = Math.max(0, subtotal - discount) + fee;

      // Retry a couple of times on the (rare) order-code collision.
      let created = null;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        try {
          created = (
            await client.query(
              `INSERT INTO orders (business_id, code, customer_name, phone, whatsapp, address, city, district,
                                   delivery_method, payment_method, subtotal, delivery_fee, total, note, coupon_code, discount, customer_email)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
              [st.biz_id, orderCode(), customer, phone, body.whatsapp || null, body.address || null,
               body.city || null, body.district || null, body.delivery || 'Delivery',
               body.payment || 'Cash on delivery', subtotal, fee, total, body.note || null, couponCode, discount, body.email || null]
            )
          ).rows[0];
        } catch (e) {
          if (e.code !== '23505') throw e; // not a code collision -> rethrow
        }
      }
      if (!created) throw badRequest('Could not place the order, please try again.');

      if (couponCode) await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE business_id=$1 AND code=$2', [st.biz_id, couponCode]);

      for (const l of lines) {
        await client.query(
          'INSERT INTO order_items (order_id, product_id, name, qty, price) VALUES ($1,$2,$3,$4,$5)',
          [created.id, l.product_id, l.name, l.qty, l.price]
        );
        if (l.variantLabel) {
          // Decrement the chosen variant's stock, then re-derive the product total.
          const cur = (await client.query('SELECT variants FROM products WHERE id=$1', [l.product_id])).rows[0];
          const vs = (Array.isArray(cur.variants) ? cur.variants : []).map((v) =>
            v.label === l.variantLabel ? { ...v, stock: Math.max(0, Number(v.stock) - l.qty) } : v
          );
          const total = vs.reduce((n, v) => n + Number(v.stock || 0), 0);
          await client.query('UPDATE products SET variants=$2, stock=$3 WHERE id=$1', [l.product_id, JSON.stringify(vs), total]);
        } else {
          // Simple product: decrement the single stock, floored at zero.
          await client.query('UPDATE products SET stock = GREATEST(stock - $2, 0) WHERE id=$1', [l.product_id, l.qty]);
        }
      }
      await client.query('INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)', [created.id, 'PENDING']);

      // Notify the store owner of the new order. The customer is not emailed at
      // placement: they receive a branded email only when the shop confirms the
      // order and again when it ships (see the order-status handler).
      await queueNotification(
        { businessId: st.biz_id, recipient: st.biz_email, ...templates.newOrder({ name: st.biz_name }, created) },
        client
      );
      return created;
    });

    res.status(201).json({
      order: S.order(order, lines),
      code: order.code,
      // Private link to the buyer's order status page (tracking, reviews).
      token: order.public_token,
      statusUrl: `/store/order?s=${encodeURIComponent(st.slug)}&o=${encodeURIComponent(order.code)}&k=${order.public_token}`,
    });
  })
);
