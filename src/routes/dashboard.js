import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db/pool.js';
import { authenticate, requireBusiness } from '../middleware/auth.js';
import { wrap, badRequest, notFound } from '../utils/http.js';
import { saveUpload } from '../services/uploads.js';
import * as S from '../services/serialize.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
export const dashboardRouter = Router();

dashboardRouter.use(authenticate, requireBusiness);
const bid = (req) => req.user.business_id;

const ORDER_FLOW = ['PENDING', 'CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

// ---- Overview: today's sales, order/product counts, low stock, last 7 days ----
dashboardRouter.get(
  '/overview',
  wrap(async (req, res) => {
    const b = bid(req);
    const today = (
      await query(
        `SELECT COALESCE(SUM(total),0) s, COUNT(*) c FROM orders
          WHERE business_id=$1 AND created_at::date = CURRENT_DATE AND status <> 'CANCELLED'`,
        [b]
      )
    ).rows[0];
    const orders = (await query(`SELECT COUNT(*) c FROM orders WHERE business_id=$1`, [b])).rows[0];
    const products = (await query(`SELECT COUNT(*) c FROM products WHERE business_id=$1`, [b])).rows[0];
    const lowStock = (
      await query(`SELECT COUNT(*) c FROM products WHERE business_id=$1 AND stock <= low_at`, [b])
    ).rows[0];
    const sales7 = (
      await query(
        `SELECT d::date AS date, COALESCE(SUM(o.total),0) AS value
           FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') d
           LEFT JOIN orders o ON o.business_id=$1 AND o.created_at::date = d::date AND o.status <> 'CANCELLED'
          GROUP BY d ORDER BY d`,
        [b]
      )
    ).rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), value: Number(r.value) }));

    res.json({
      todaySales: Number(today.s),
      todayOrders: Number(today.c),
      orders: Number(orders.c),
      products: Number(products.c),
      lowStock: Number(lowStock.c),
      sales7,
    });
  })
);

// ---- Reports / analytics (Business and Pro plans only) ----
dashboardRouter.get(
  '/reports',
  wrap(async (req, res) => {
    const b = bid(req);
    const plan = (
      await query(
        `SELECT pl.id, pl.name FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
          WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
        [b]
      )
    ).rows[0];
    const planId = plan ? plan.id : null;
    if (planId === 'starter' || !planId) {
      throw badRequest('Reports are available on the Business and Pro plans.');
    }

    const totals = (
      await query(
        `SELECT COALESCE(SUM(total),0) revenue, COUNT(*) orders,
                COUNT(*) FILTER (WHERE status <> 'CANCELLED') paid
           FROM orders WHERE business_id = $1`,
        [b]
      )
    ).rows[0];
    const itemsSold = (
      await query(
        `SELECT COALESCE(SUM(oi.qty),0) n FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.business_id = $1 AND o.status <> 'CANCELLED'`,
        [b]
      )
    ).rows[0].n;
    const byStatus = (
      await query(`SELECT status, COUNT(*) n FROM orders WHERE business_id = $1 GROUP BY status`, [b])
    ).rows.map((r) => ({ status: r.status, count: Number(r.n) }));
    const topProducts = (
      await query(
        `SELECT oi.name, SUM(oi.qty) units, SUM(oi.qty * oi.price) revenue
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.business_id = $1 AND o.status <> 'CANCELLED'
          GROUP BY oi.name ORDER BY units DESC LIMIT 10`,
        [b]
      )
    ).rows.map((r) => ({ name: r.name, units: Number(r.units), revenue: Number(r.revenue) }));
    const lowStock = Number(
      (await query('SELECT COUNT(*) c FROM products WHERE business_id = $1 AND stock <= low_at', [b])).rows[0].c
    );
    const sales7 = (
      await query(
        `SELECT d::date AS date, COALESCE(SUM(o.total),0) AS value
           FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') d
           LEFT JOIN orders o ON o.business_id=$1 AND o.created_at::date = d::date AND o.status <> 'CANCELLED'
          GROUP BY d ORDER BY d`,
        [b]
      )
    ).rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), value: Number(r.value) }));

    const revenue = Number(totals.revenue);
    const paid = Number(totals.paid);
    const report = {
      plan: plan.name,
      revenue,
      orders: Number(totals.orders),
      paidOrders: paid,
      avgOrder: paid ? Math.round(revenue / paid) : 0,
      itemsSold: Number(itemsSold),
      lowStock,
      sales7,
      byStatus,
      topProducts,
    };
    // Advanced insights are Pro-only.
    if (planId === 'pro') {
      report.cities = (
        await query(
          `SELECT COALESCE(NULLIF(city,''),'Unknown') city, COUNT(*) n
             FROM orders WHERE business_id = $1 AND status <> 'CANCELLED'
             GROUP BY 1 ORDER BY n DESC`,
          [b]
        )
      ).rows.map((r) => ({ city: r.city, orders: Number(r.n) }));
    }
    res.json({ report });
  })
);

// ---- Orders list ----
dashboardRouter.get(
  '/orders',
  wrap(async (req, res) => {
    const b = bid(req);
    const { rows } = await query(`SELECT * FROM orders WHERE business_id=$1 ORDER BY created_at DESC`, [b]);
    const ids = rows.map((r) => r.id);
    let itemsByOrder = {};
    if (ids.length) {
      const items = (await query(`SELECT * FROM order_items WHERE order_id = ANY($1)`, [ids])).rows;
      itemsByOrder = items.reduce((m, i) => { (m[i.order_id] = m[i.order_id] || []).push(i); return m; }, {});
    }
    res.json({ orders: rows.map((r) => S.order(r, itemsByOrder[r.id])) });
  })
);

// ---- Change order status (validated against the workflow) ----
dashboardRouter.put(
  '/orders/:code/status',
  wrap(async (req, res) => {
    const b = bid(req);
    const status = (req.body && req.body.status || '').toUpperCase();
    if (!ORDER_FLOW.includes(status)) throw badRequest('Unknown order status.');
    const order = (await query('SELECT * FROM orders WHERE business_id=$1 AND code=$2', [b, req.params.code])).rows[0];
    if (!order) throw notFound('Order not found.');
    await withTransaction(async (client) => {
      await client.query('UPDATE orders SET status=$3 WHERE business_id=$1 AND code=$2', [b, req.params.code, status]);
      await client.query(
        'INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1,$2,$3)',
        [order.id, status, req.user.sub]
      );
    });
    res.json({ ok: true, status });
  })
);

// ---- Subscription view (owner-facing) ----
dashboardRouter.get(
  '/subscription',
  wrap(async (req, res) => {
    const b = bid(req);
    const sub = (
      await query(
        `SELECT s.*, pl.name plan_name, pl.price, pl.duration_days, pl.max_products, pl.features
           FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
          WHERE s.business_id=$1 ORDER BY s.created_at DESC LIMIT 1`,
        [b]
      )
    ).rows[0];
    const biz = (await query('SELECT status FROM businesses WHERE id=$1', [b])).rows[0];
    const payments = (
      await query(`SELECT * FROM payments WHERE business_id=$1 ORDER BY submitted_at DESC`, [b])
    ).rows.map((p) => ({
      id: p.id, amount: p.amount, method: p.method, ref: p.reference || '',
      status: p.status, submitted: p.submitted_at.toISOString().slice(0, 10), reason: p.reason || undefined,
    }));
    res.json({
      status: biz ? biz.status : null,
      plan: sub ? { id: sub.plan_id, name: sub.plan_name, price: sub.price, durationDays: sub.duration_days, maxProducts: sub.max_products, features: sub.features } : null,
      startDate: sub && sub.start_date ? sub.start_date.toISOString().slice(0, 10) : null,
      expiryDate: sub && sub.expiry_date ? sub.expiry_date.toISOString().slice(0, 10) : null,
      payments,
    });
  })
);

// ---- Submit a renewal payment slip ----
dashboardRouter.post(
  '/subscription/renew',
  upload.single('slip'),
  wrap(async (req, res) => {
    const b = bid(req);
    const sub = (await query('SELECT * FROM subscriptions WHERE business_id=$1 ORDER BY created_at DESC LIMIT 1', [b])).rows[0];
    const planId = (req.body && req.body.planId) || (sub ? sub.plan_id : null);
    if (!planId) throw badRequest('Choose a plan to renew.');
    const plan = (await query('SELECT * FROM plans WHERE id=$1', [planId])).rows[0];
    if (!plan) throw badRequest('Unknown plan.');
    let slipUrl = null;
    if (req.file) slipUrl = await saveUpload(req.file, 'slips');
    await query(
      `INSERT INTO payments (business_id, subscription_id, plan_id, amount, method, reference, slip_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')`,
      [b, sub ? sub.id : null, planId, plan.price, req.body.method || 'Bank transfer', req.body.ref || null, slipUrl]
    );
    res.status(201).json({ ok: true, message: 'Renewal submitted. We will confirm your payment shortly.' });
  })
);

// ---- Store settings (read + update) ----
dashboardRouter.get(
  '/store',
  wrap(async (req, res) => {
    const b = bid(req);
    const store = (await query('SELECT * FROM stores WHERE business_id=$1', [b])).rows[0];
    if (!store) throw notFound('Store not found.');
    const cats = (await query('SELECT name FROM categories WHERE business_id=$1 ORDER BY sort_order, name', [b])).rows.map((r) => r.name);
    const biz = (await query('SELECT status FROM businesses WHERE id=$1', [b])).rows[0];
    res.json({ store: { ...S.storePublic(store, cats), status: biz ? biz.status : store.status } });
  })
);

dashboardRouter.put(
  '/store',
  wrap(async (req, res) => {
    const b = bid(req);
    const s = req.body || {};
    const store = (await query('SELECT * FROM stores WHERE business_id=$1', [b])).rows[0];
    if (!store) throw notFound('Store not found.');
    const d = s.delivery || {};
    const p = s.payments || {};
    await query(
      `UPDATE stores SET name=$2, tagline=$3, about=$4, preset=$5, phone=$6, whatsapp=$7, address=$8, city=$9,
              delivery_fee=$10, delivery_free_above=$11, pickup=$12, pay_cod=$13, pay_bank=$14, pay_online=$15, bank_details=$16
        WHERE business_id=$1`,
      [b, s.name || store.name, s.tagline || null, s.about || null, s.preset || store.preset,
       s.phone || null, s.whatsapp || null, s.address || null, s.city || null,
       d.fee != null ? d.fee : store.delivery_fee, d.freeAbove != null ? d.freeAbove : store.delivery_free_above,
       d.pickup != null ? d.pickup : store.pickup,
       p.cod != null ? p.cod : store.pay_cod, p.bank != null ? p.bank : store.pay_bank, p.online != null ? p.online : store.pay_online,
       s.bank != null ? s.bank : store.bank_details]
    );

    // Replace category list if provided.
    if (Array.isArray(s.categories)) {
      await withTransaction(async (client) => {
        await client.query('DELETE FROM categories WHERE business_id=$1', [b]);
        let i = 0;
        for (const name of s.categories) {
          if (!name || !String(name).trim()) continue;
          await client.query('INSERT INTO categories (business_id, name, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [b, String(name).trim(), i++]);
        }
      });
    }
    res.json({ ok: true });
  })
);

// ---- Coupons (Business/Pro plans) ----
async function requireCouponsPlan(businessId) {
  const plan = (
    await query(
      `SELECT pl.id FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [businessId]
    )
  ).rows[0];
  if (!plan || plan.id === 'starter') throw badRequest('Coupons are available on the Business and Pro plans.');
}

function parseCoupon(body) {
  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(code)) throw badRequest('Use 2–24 letters, numbers or hyphens for the code.');
  const type = body.type === 'fixed' ? 'fixed' : 'percent';
  const value = Number(body.value);
  if (type === 'percent' && !(value >= 1 && value <= 100)) throw badRequest('Percent must be between 1 and 100.');
  if (type === 'fixed' && !(value > 0)) throw badRequest('Enter a discount amount above zero.');
  const minOrder = Math.max(0, Number(body.minOrder) || 0);
  const usageLimit = body.usageLimit === '' || body.usageLimit == null ? null : Math.max(1, Number(body.usageLimit));
  let expiresOn = body.expiresOn || null; if (expiresOn === '') expiresOn = null;
  const status = body.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
  return { code, type, value: Math.round(value), minOrder, usageLimit, expiresOn, status };
}

dashboardRouter.get(
  '/coupons',
  wrap(async (req, res) => {
    const b = bid(req);
    await requireCouponsPlan(b);
    const { rows } = await query('SELECT * FROM coupons WHERE business_id = $1 ORDER BY created_at DESC', [b]);
    res.json({ coupons: rows.map(S.coupon) });
  })
);

dashboardRouter.post(
  '/coupons',
  wrap(async (req, res) => {
    const b = bid(req);
    await requireCouponsPlan(b);
    const c = parseCoupon(req.body || {});
    const { rows } = await query(
      `INSERT INTO coupons (business_id, code, type, value, min_order, usage_limit, expires_on, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b, c.code, c.type, c.value, c.minOrder, c.usageLimit, c.expiresOn, c.status]
    );
    res.status(201).json({ coupon: S.coupon(rows[0]) });
  })
);

dashboardRouter.put(
  '/coupons/:id',
  wrap(async (req, res) => {
    const b = bid(req);
    await requireCouponsPlan(b);
    const existing = (await query('SELECT * FROM coupons WHERE id = $1 AND business_id = $2', [req.params.id, b])).rows[0];
    if (!existing) throw notFound('Coupon not found.');
    const merged = Object.assign(
      { code: existing.code, type: existing.type, value: existing.value, minOrder: existing.min_order, usageLimit: existing.usage_limit, expiresOn: existing.expires_on, status: existing.status },
      req.body || {}
    );
    const c = parseCoupon(merged);
    const { rows } = await query(
      `UPDATE coupons SET code=$3, type=$4, value=$5, min_order=$6, usage_limit=$7, expires_on=$8, status=$9
        WHERE id=$1 AND business_id=$2 RETURNING *`,
      [req.params.id, b, c.code, c.type, c.value, c.minOrder, c.usageLimit, c.expiresOn, c.status]
    );
    res.json({ coupon: S.coupon(rows[0]) });
  })
);

dashboardRouter.delete(
  '/coupons/:id',
  wrap(async (req, res) => {
    const b = bid(req);
    await requireCouponsPlan(b);
    const r = await query('DELETE FROM coupons WHERE id = $1 AND business_id = $2', [req.params.id, b]);
    if (!r.rowCount) throw notFound('Coupon not found.');
    res.json({ ok: true });
  })
);
