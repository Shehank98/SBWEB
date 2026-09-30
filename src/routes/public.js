import { Router } from 'express';
import { query } from '../db/pool.js';
import * as S from '../services/serialize.js';
import { wrap, notFound } from '../utils/http.js';
import { timeline, receiptExpired, receiptPath, isCod } from '../services/orderLinks.js';

// Public, no-login pages for buyers: order tracking and the 30-day digital receipt.
// Both are addressed by unguessable tokens; nothing here lists or searches orders.
export const publicRouter = Router();

const HEX = /^[a-f0-9]{16,64}$/;

async function storeFor(businessId) {
  const st = (await query(
    `SELECT st.*, b.name AS biz_name, b.email AS biz_email, b.verification_status
       FROM stores st JOIN businesses b ON b.id = st.business_id WHERE st.business_id = $1`,
    [businessId]
  )).rows[0];
  if (!st) return null;
  const store = S.storePublic(st, []);
  store.verified = st.verification_status === 'VERIFIED';
  return { st, store };
}

// GET /api/track/:code?k=<public_token>
publicRouter.get(
  '/track/:code',
  wrap(async (req, res) => {
    const token = String(req.query.k || '');
    if (!HEX.test(token)) throw notFound('We could not find this order. Check the link in your email.');
    const order = (await query('SELECT * FROM orders WHERE code = $1 AND public_token = $2', [req.params.code, token])).rows[0];
    if (!order) throw notFound('We could not find this order. Check the link in your email.');
    const [items, history, shop] = await Promise.all([
      query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [order.id]).then((r) => r.rows),
      query('SELECT status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at', [order.id]).then((r) => r.rows),
      storeFor(order.business_id),
    ]);
    const o = S.buyerOrder(order, items, history);
    res.set('Cache-Control', 'no-store');
    res.json({
      order: { ...o, customer: String(o.customer || '').split(' ')[0] },
      timeline: timeline(order, history),
      receiptUrl: receiptExpired(order) ? null : receiptPath(order),
      reviewUrl: shop ? `/store/order?s=${encodeURIComponent(shop.store.slug)}&o=${encodeURIComponent(order.code)}&k=${order.public_token}` : null,
      store: shop ? shop.store : null,
    });
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
    const items = (await query('SELECT name, qty, price FROM order_items WHERE order_id = $1 ORDER BY id', [order.id])).rows;
    res.json({
      receipt: {
        number: order.code,
        date: order.created_at,
        expiresAt: order.receipt_expires_at,
        customer: order.customer_name,
        items: items.map((i) => ({ name: i.name, qty: i.qty, price: i.price, total: i.qty * i.price })),
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
