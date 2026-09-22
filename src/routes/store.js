import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { wrap, badRequest, notFound } from '../utils/http.js';
import { orderCode } from '../utils/slug.js';
import * as S from '../services/serialize.js';
import { queueNotification, templates } from '../services/notifications.js';
import { evalCoupon } from '../services/coupons.js';

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

      // Notify the store owner of the new order.
      await queueNotification(
        { businessId: st.biz_id, recipient: st.biz_email, ...templates.newOrder({ name: st.biz_name }, created) },
        client
      );
      // Confirm the order to the customer (if they left an email), with the shop name.
      if (body.email) {
        await queueNotification(
          {
            businessId: st.biz_id,
            recipient: body.email,
            ...templates.orderConfirmation({ name: st.biz_name, slug: st.slug }, created, lines),
          },
          client
        );
      }
      return created;
    });

    res.status(201).json({ order: S.order(order, lines), code: order.code });
  })
);
