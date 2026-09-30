import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import * as S from '../services/serialize.js';
import { wrap, notFound, badRequest } from '../utils/http.js';
import { timeline, receiptExpired, receiptPath, isCod } from '../services/orderLinks.js';
import { saveBuyerReviews } from '../services/reviews.js';

// Public, no-login pages for buyers: order tracking and the 30-day digital receipt.
// Both are addressed by unguessable tokens; nothing here lists or searches orders.
export const publicRouter = Router();

const HEX = /^[a-f0-9]{16,64}$/;
// Statuses from which the buyer may say "I received my order".
const CONFIRMABLE = ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED'];

async function storeFor(businessId) {
  const st = (await query(
    `SELECT st.*, b.name AS biz_name, b.email AS biz_email, b.verification_status, b.facebook, b.instagram
       FROM stores st JOIN businesses b ON b.id = st.business_id WHERE st.business_id = $1`,
    [businessId]
  )).rows[0];
  if (!st) return null;
  const store = S.storePublic(st, []);
  store.verified = st.verification_status === 'VERIFIED';
  return { st, store };
}

async function trackedOrder(req) {
  const token = String(req.query.k || (req.body && req.body.k) || '');
  if (!HEX.test(token)) throw notFound('We could not find this order. Check the link in your email.');
  const order = (await query('SELECT * FROM orders WHERE code = $1 AND public_token = $2', [req.params.code, token])).rows[0];
  if (!order) throw notFound('We could not find this order. Check the link in your email.');
  return order;
}

// GET /api/track/:code?k=<public_token>
publicRouter.get(
  '/track/:code',
  wrap(async (req, res) => {
    const order = await trackedOrder(req);
    const [items, history, shop] = await Promise.all([
      query('SELECT oi.*, COALESCE(pr.image_url, pr.images->>0) AS image FROM order_items oi LEFT JOIN products pr ON pr.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id', [order.id]).then((r) => r.rows),
      query('SELECT status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at', [order.id]).then((r) => r.rows),
      storeFor(order.business_id),
    ]);
    const reviewed = new Set((await query('SELECT product_id FROM product_reviews WHERE order_id = $1', [order.id])).rows.map((r) => r.product_id));
    const o = S.buyerOrder(order, items, history, reviewed);
    res.set('Cache-Control', 'no-store');
    res.json({
      order: { ...o, customer: String(o.customer || '').split(' ')[0] },
      timeline: timeline(order, history),
      receiptUrl: receiptExpired(order) ? null : receiptPath(order),
      // The buyer confirms delivery here; reviews open only where an admin enabled them.
      canConfirmDelivery: CONFIRMABLE.includes(order.status),
      reviewsEnabled: !!(shop && shop.st.reviews_enabled),
      store: shop ? shop.store : null,
    });
  })
);

// POST /api/track/:code/delivered?k=<token> — the buyer confirms the parcel arrived.
publicRouter.post(
  '/track/:code/delivered',
  wrap(async (req, res) => {
    const order = await trackedOrder(req);
    if (order.status === 'DELIVERED') return res.json({ ok: true, status: 'DELIVERED' });
    if (!CONFIRMABLE.includes(order.status)) throw badRequest('This order cannot be marked as delivered.');
    await withTransaction(async (client) => {
      const r = await client.query(`UPDATE orders SET status = 'DELIVERED' WHERE id = $1 AND status = ANY($2) RETURNING id`, [order.id, CONFIRMABLE]);
      if (r.rowCount) await client.query(`INSERT INTO order_status_history (order_id, status, note) VALUES ($1, 'DELIVERED', 'Confirmed by the buyer')`, [order.id]);
    });
    res.json({ ok: true, status: 'DELIVERED' });
  })
);

// POST /api/track/:code/reviews?k=<token> { reviews: [{ productId, rating, body }] }
publicRouter.post(
  '/track/:code/reviews',
  wrap(async (req, res) => {
    const order = await trackedOrder(req);
    const saved = await saveBuyerReviews(order.business_id, order, req.body && req.body.reviews);
    res.status(201).json({ ok: true, saved });
  })
);

// GET /api/receipt/:token  -> 200 receipt, 410 { expired: true } after 30 days.
publicRouter.get(
  '/receipt/:token',
  wrap(async (req, res) => {
    const token = String(req.params.token || '');
    if (!HEX.test(token)) throw notFound('This receipt link is not valid.');
    const order = (await query('SELECT * FROM orders WHERE receipt_token = $1', [token])).rows[0];
    if (!order) throw notFound('This receipt link is not valid.');
    const shop = await storeFor(order.business_id);
    res.set('Cache-Control', 'no-store');
    if (receiptExpired(order)) {
      // Enforced here, not in the page: no order details are sent after expiry.
      return res.status(410).json({ expired: true, expiredAt: order.receipt_expires_at, store: shop ? shop.store : null });
    }
    const items = (await query('SELECT oi.name, oi.qty, oi.price, COALESCE(pr.image_url, pr.images->>0) AS image FROM order_items oi LEFT JOIN products pr ON pr.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id', [order.id])).rows;
    res.json({
      receipt: {
        number: order.code,
        date: order.created_at,
        expiresAt: order.receipt_expires_at,
        customer: order.customer_name,
        items: items.map((i) => ({ name: i.name, qty: i.qty, price: i.price, total: i.qty * i.price, image: i.image || null })),
        subtotal: order.subtotal,
        discount: order.discount || 0,
        delivery: order.delivery_fee || 0,
        total: order.total,
        payment: order.payment_method,
        paymentStatus: order.payment_status || (isCod(order) ? 'DUE_ON_DELIVERY' : null),
        paidOn: order.paid_on || null,
        status: order.status,
      },
      store: shop ? {
        ...shop.store,
        email: shop.st.contact_email || shop.st.biz_email || '',
        address: shop.st.address || '',
        phone: shop.st.phone || '',
      } : null,
    });
  })
);
