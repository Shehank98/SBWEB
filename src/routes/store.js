import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { wrap, badRequest, notFound } from '../utils/http.js';
import { orderCode } from '../utils/slug.js';
import * as S from '../services/serialize.js';
import { queueNotification, templates } from '../services/notifications.js';

export const storeRouter = Router();

// Statuses in which the storefront is visible to customers.
const LIVE = new Set(['ACTIVE', 'EXPIRING', 'GRACE_PERIOD']);

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
      await query(`SELECT *, $2::text AS store_slug FROM products WHERE business_id=$1 AND status='ACTIVE' ORDER BY created_at DESC`, [st.biz_id, st.slug])
    ).rows.map(S.product);
    res.json({ store, products, available: true });
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
    if (!Array.isArray(body.items) || !body.items.length) throw badRequest('Your cart is empty.');

    // Re-price each line from the catalogue.
    const lines = [];
    let subtotal = 0;
    for (const it of body.items) {
      const p = (await query('SELECT * FROM products WHERE id=$1 AND business_id=$2', [it.pid, st.biz_id])).rows[0];
      if (!p) throw badRequest('One of the products is no longer available.');
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      const price = p.sale_price != null ? p.sale_price : p.price;
      const variant = it.variant ? ` (${it.variant})` : '';
      lines.push({ product_id: p.id, name: p.name + variant, qty, price });
      subtotal += price * qty;
    }

    const fee = st.delivery_free_above && subtotal >= st.delivery_free_above ? 0 : st.delivery_fee;
    const total = subtotal + fee;

    const order = await withTransaction(async (client) => {
      // Retry a couple of times on the (rare) order-code collision.
      let created = null;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        try {
          created = (
            await client.query(
              `INSERT INTO orders (business_id, code, customer_name, phone, whatsapp, address, city, district,
                                   delivery_method, payment_method, subtotal, delivery_fee, total, note)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
              [st.biz_id, orderCode(), customer, phone, body.whatsapp || null, body.address || null,
               body.city || null, body.district || null, body.delivery || 'Delivery',
               body.payment || 'Cash on delivery', subtotal, fee, total, body.note || null]
            )
          ).rows[0];
        } catch (e) {
          if (e.code !== '23505') throw e; // not a code collision -> rethrow
        }
      }
      if (!created) throw badRequest('Could not place the order, please try again.');

      for (const l of lines) {
        await client.query(
          'INSERT INTO order_items (order_id, product_id, name, qty, price) VALUES ($1,$2,$3,$4,$5)',
          [created.id, l.product_id, l.name, l.qty, l.price]
        );
        // Decrement stock, floored at zero.
        await client.query('UPDATE products SET stock = GREATEST(stock - $2, 0) WHERE id=$1', [l.product_id, l.qty]);
      }
      await client.query('INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)', [created.id, 'PENDING']);

      // Notify the store owner of the new order.
      await queueNotification(
        { businessId: st.biz_id, recipient: st.biz_email, ...templates.newOrder({ name: st.biz_name }, created) },
        client
      );
      return created;
    });

    res.status(201).json({ order: S.order(order, lines), code: order.code });
  })
);
