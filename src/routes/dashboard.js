import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db/pool.js';
import { authenticate, requireBusiness, requireOwner, requirePermission } from '../middleware/auth.js';
import { wrap, badRequest, notFound, conflict, forbidden } from '../utils/http.js';
import { saveUpload } from '../services/uploads.js';
import { hashPassword, verifyPassword } from '../utils/auth.js';
import { queueNotification, templates } from '../services/notifications.js';
import { currentPlan, cap } from '../services/plan.js';
import * as S from '../services/serialize.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
export const dashboardRouter = Router();

dashboardRouter.use(authenticate, requireBusiness);
const bid = (req) => req.user.business_id;

const ORDER_FLOW = ['PENDING', 'CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

// ---- Badge counts for the sidebar/tab navigation (cheap, called on every page) ----
dashboardRouter.get(
  '/badges',
  wrap(async (req, res) => {
    const b = bid(req);
    const pendingOrders = Number(
      (await query("SELECT COUNT(*) c FROM orders WHERE business_id=$1 AND status='PENDING'", [b])).rows[0].c
    );
    res.json({ pendingOrders });
  })
);

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
  requirePermission('reports'),
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

    // Optional date range (YYYY-MM-DD). Applies to every order-based metric below;
    // stock counts are always "now". `to` is treated as an inclusive day.
    function parseDate(s) { return (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? new Date(s + 'T00:00:00Z') : null; }
    const fromD = parseDate(req.query.from);
    const toD = parseDate(req.query.to);
    // Build a reusable "AND date >= .. AND date < .." fragment. Every order query
    // below uses business_id as $1 and no other params, so the range params are $2/$3.
    const dParams = [];
    let plainClause = '', oClause = '';
    if (fromD) { dParams.push(fromD); const i = 1 + dParams.length; plainClause += ` AND created_at >= $${i}`; oClause += ` AND o.created_at >= $${i}`; }
    if (toD) { const end = new Date(toD); end.setUTCDate(end.getUTCDate() + 1); dParams.push(end); const i = 1 + dParams.length; plainClause += ` AND created_at < $${i}`; oClause += ` AND o.created_at < $${i}`; }
    const P = [b, ...dParams];

    const totals = (
      await query(
        `SELECT COALESCE(SUM(total),0) revenue, COUNT(*) orders,
                COUNT(*) FILTER (WHERE status <> 'CANCELLED') paid
           FROM orders WHERE business_id = $1${plainClause}`,
        P
      )
    ).rows[0];
    const itemsSold = (
      await query(
        `SELECT COALESCE(SUM(oi.qty),0) n FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE o.business_id = $1 AND o.status <> 'CANCELLED'${oClause}`,
        P
      )
    ).rows[0].n;
    const byStatus = (
      await query(`SELECT status, COUNT(*) n FROM orders WHERE business_id = $1${plainClause} GROUP BY status`, P)
    ).rows.map((r) => ({ status: r.status, count: Number(r.n) }));
    const topProducts = (
      await query(
        `SELECT oi.name, SUM(oi.qty) units, SUM(oi.qty * oi.price) revenue
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.business_id = $1 AND o.status <> 'CANCELLED'${oClause}
          GROUP BY oi.name ORDER BY units DESC LIMIT 10`,
        P
      )
    ).rows.map((r) => ({ name: r.name, units: Number(r.units), revenue: Number(r.revenue) }));
    const lowStock = Number(
      (await query('SELECT COUNT(*) c FROM products WHERE business_id = $1 AND stock <= low_at', [b])).rows[0].c
    );

    // Sales over time — adaptive: daily bars for a short span, monthly for a long one
    // (and the last 6 months when no range is set).
    let granularity = 'month';
    let series;
    const effFrom = fromD || null;
    const effTo = toD || new Date();
    const spanDays = effFrom ? (effTo - effFrom) / 86400000 : null;
    if (effFrom && spanDays <= 31) {
      granularity = 'day';
      series = (
        await query(
          `SELECT d::date date, COALESCE(SUM(o.total),0) value
             FROM generate_series($2::date, $3::date, INTERVAL '1 day') d
             LEFT JOIN orders o ON o.business_id=$1 AND o.created_at::date=d::date AND o.status <> 'CANCELLED'
            GROUP BY d ORDER BY d`,
          [b, effFrom, effTo]
        )
      ).rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), value: Number(r.value) }));
    } else {
      const startMonth = effFrom || null;
      series = (
        await query(
          `SELECT to_char(m,'Mon') label, m::date date, COALESCE(SUM(o.total),0) value
             FROM generate_series(date_trunc('month', $2::date), date_trunc('month', $3::date), INTERVAL '1 month') m
             LEFT JOIN orders o ON o.business_id=$1 AND date_trunc('month', o.created_at)=m AND o.status <> 'CANCELLED'
            GROUP BY m ORDER BY m`,
          [b, startMonth || new Date(Date.now() - 155 * 86400000), effTo]
        )
      ).rows.map((r) => ({ label: r.label, date: r.date.toISOString().slice(0, 10), value: Number(r.value) }));
    }

    // Units and revenue grouped by product category (Business+). Order items snapshot
    // the name with any variant "(L, White)", so match back to the base product name.
    const categories = (
      await query(
        `SELECT COALESCE(NULLIF(p.category,''),'Other') category,
                SUM(oi.qty) units, SUM(oi.qty * oi.price) revenue
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.business_id = o.business_id
                                   AND p.name = split_part(oi.name, ' (', 1)
          WHERE o.business_id = $1 AND o.status <> 'CANCELLED'${oClause}
          GROUP BY 1 ORDER BY revenue DESC`,
        P
      )
    ).rows.map((r) => ({ category: r.category, units: Number(r.units), revenue: Number(r.revenue) }));
    // How customers pay (Business+).
    const payments = (
      await query(
        `SELECT COALESCE(NULLIF(payment_method,''),'Other') method, COUNT(*) orders,
                COALESCE(SUM(total),0) revenue
           FROM orders WHERE business_id = $1 AND status <> 'CANCELLED'${plainClause}
          GROUP BY 1 ORDER BY orders DESC`,
        P
      )
    ).rows.map((r) => ({ method: r.method, orders: Number(r.orders), revenue: Number(r.revenue) }));

    const revenue = Number(totals.revenue);
    const paid = Number(totals.paid);
    const report = {
      plan: plan.name,
      range: { from: req.query.from || null, to: req.query.to || null },
      revenue,
      orders: Number(totals.orders),
      paidOrders: paid,
      avgOrder: paid ? Math.round(revenue / paid) : 0,
      itemsSold: Number(itemsSold),
      lowStock,
      series: { granularity, points: series },
      byStatus,
      topProducts,
      categories,
      payments,
    };
    // Advanced customer insights are Pro-only.
    if (planId === 'pro') {
      report.cities = (
        await query(
          `SELECT COALESCE(NULLIF(city,''),'Unknown') city, COUNT(*) n
             FROM orders WHERE business_id = $1 AND status <> 'CANCELLED'${plainClause}
             GROUP BY 1 ORDER BY n DESC`,
          P
        )
      ).rows.map((r) => ({ city: r.city, orders: Number(r.n) }));
      report.topCustomers = (
        await query(
          `SELECT customer_name name, COUNT(*) orders, COALESCE(SUM(total),0) spent
             FROM orders WHERE business_id = $1 AND status <> 'CANCELLED'${plainClause}
             GROUP BY customer_name ORDER BY spent DESC LIMIT 8`,
          P
        )
      ).rows.map((r) => ({ name: r.name, orders: Number(r.orders), spent: Number(r.spent) }));
      const rep = (
        await query(
          `SELECT COUNT(*) customers, COUNT(*) FILTER (WHERE c > 1) repeat_customers
             FROM (SELECT customer_name, COUNT(*) c FROM orders
                    WHERE business_id = $1 AND status <> 'CANCELLED'${plainClause}
                    GROUP BY customer_name) t`,
          P
        )
      ).rows[0];
      const customers = Number(rep.customers);
      const repeatCustomers = Number(rep.repeat_customers);
      report.repeat = {
        customers,
        repeatCustomers,
        repeatRate: customers ? Math.round((repeatCustomers / customers) * 100) : 0,
      };
      report.weekdays = (
        await query(
          `SELECT EXTRACT(DOW FROM created_at)::int dow, COUNT(*) n
             FROM orders WHERE business_id = $1 AND status <> 'CANCELLED'${plainClause}
             GROUP BY 1`,
          P
        )
      ).rows.map((r) => ({ dow: Number(r.dow), orders: Number(r.n) }));
      report.coupons = (
        await query(
          `SELECT coupon_code code, COUNT(*) uses, COALESCE(SUM(discount),0) discount
             FROM orders WHERE business_id = $1 AND status <> 'CANCELLED'${plainClause}
                   AND coupon_code IS NOT NULL AND coupon_code <> ''
             GROUP BY coupon_code ORDER BY uses DESC`,
          P
        )
      ).rows.map((r) => ({ code: r.code, uses: Number(r.uses), discount: Number(r.discount) }));
    }
    res.json({ report });
  })
);

// ---- Orders list ----
dashboardRouter.get(
  '/orders',
  requirePermission('orders'),
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
  requirePermission('orders'),
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
      // Email the customer only at the two milestones that matter to them:
      // when the shop confirms the order and when it ships. Other status changes
      // stay internal. The dedupe key makes a repeated click a no-op.
      if (order.customer_email && (status === 'CONFIRMED' || status === 'SHIPPED')) {
        const shop = (await client.query(
          `SELECT COALESCE(s.name, bz.name) AS name, s.slug, s.phone, s.whatsapp, s.address
             FROM businesses bz LEFT JOIN stores s ON s.business_id = bz.id
            WHERE bz.id = $1`,
          [b]
        )).rows[0] || { name: 'Your store' };
        const items = (await client.query('SELECT name, qty, price FROM order_items WHERE order_id=$1', [order.id])).rows;
        const tpl = status === 'CONFIRMED' ? templates.orderConfirmed : templates.orderShipped;
        await queueNotification(
          { businessId: b, recipient: order.customer_email, dedupeKey: `${status}:${order.id}`, ...tpl(shop, order, items) },
          client
        );
      }
    });
    res.json({ ok: true, status });
  })
);

// ---- Subscription view (owner-facing) ----
dashboardRouter.get(
  '/subscription',
  requireOwner,
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
  requireOwner,
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

// ---- Categories (seller-created, tier-capped) ----
// GET usage + list
dashboardRouter.get(
  '/categories',
  wrap(async (req, res) => {
    const b = bid(req);
    const rows = (await query('SELECT name FROM categories WHERE business_id=$1 ORDER BY sort_order, name', [b])).rows.map((r) => r.name);
    const plan = await currentPlan(b);
    const max = plan ? plan.max_categories : null;
    res.json({ categories: rows, usage: { count: rows.length, maxCategories: max, plan: plan ? plan.name : null } });
  })
);

// POST create one category (enforces the tier cap)
dashboardRouter.post(
  '/categories',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const name = (req.body && req.body.name || '').trim();
    if (!name) throw badRequest('Enter a category name.');
    if (name.length > 40) throw badRequest('Keep category names under 40 characters.');
    const plan = await currentPlan(b);
    const limit = cap(plan && plan.max_categories);
    const count = Number((await query('SELECT COUNT(*) c FROM categories WHERE business_id=$1', [b])).rows[0].c);
    // Don't count against the cap if it already exists (idempotent create).
    const exists = (await query('SELECT 1 FROM categories WHERE business_id=$1 AND lower(name)=lower($2)', [b, name])).rowCount;
    if (exists) throw conflict('You already have a category with that name.');
    if (count >= limit) {
      throw forbidden(`Your ${plan ? plan.name : ''} plan allows up to ${limit} categories. Upgrade to add more.`);
    }
    await query('INSERT INTO categories (business_id, name, sort_order) VALUES ($1,$2,$3)', [b, name, count]);
    res.status(201).json({ name });
  })
);

// PUT rename a category. Renames the category and updates the denormalized
// products.category for every product in that category, so existing
// product-category links are preserved.
dashboardRouter.put(
  '/categories/:name',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const from = req.params.name;
    const to = (req.body && req.body.name || '').trim();
    if (!to) throw badRequest('Enter a category name.');
    if (to.length > 40) throw badRequest('Keep category names under 40 characters.');
    // A rename that only changes letter case (e.g. "shoes" -> "Shoes") is allowed;
    // any other name that already exists on this shop is a duplicate.
    if (to.toLowerCase() !== from.toLowerCase()) {
      const clash = (await query('SELECT 1 FROM categories WHERE business_id=$1 AND lower(name)=lower($2)', [b, to])).rowCount;
      if (clash) throw conflict('You already have a category with that name.');
    }
    const result = await withTransaction(async (client) => {
      const r = await client.query('UPDATE categories SET name=$3 WHERE business_id=$1 AND name=$2', [b, from, to]);
      if (!r.rowCount) throw notFound('Category not found.');
      // Move every product that pointed at the old name to the new name.
      await client.query('UPDATE products SET category=$3 WHERE business_id=$1 AND category=$2', [b, from, to]);
      return true;
    });
    res.json({ name: to, ok: result });
  })
);

// DELETE a category by name
dashboardRouter.delete(
  '/categories/:name',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const r = await query('DELETE FROM categories WHERE business_id=$1 AND name=$2', [b, req.params.name]);
    if (!r.rowCount) throw notFound('Category not found.');
    res.json({ ok: true });
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
  requireOwner,
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

    // Replace category list if provided (deduped, and capped to the plan's limit).
    if (Array.isArray(s.categories)) {
      const clean = [];
      const seen = new Set();
      for (const name of s.categories) {
        const n = String(name || '').trim();
        if (!n || seen.has(n.toLowerCase())) continue;
        seen.add(n.toLowerCase());
        clean.push(n);
      }
      const plan = await currentPlan(b);
      const limit = cap(plan && plan.max_categories);
      if (clean.length > limit) {
        throw forbidden(`Your ${plan ? plan.name : ''} plan allows up to ${limit} categories. Upgrade to add more.`);
      }
      await withTransaction(async (client) => {
        await client.query('DELETE FROM categories WHERE business_id=$1', [b]);
        let i = 0;
        for (const name of clean) {
          await client.query('INSERT INTO categories (business_id, name, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [b, name, i++]);
        }
      });
    }
    res.json({ ok: true });
  })
);

// ---- Owner closes (deletes) their own shop and ALL its data (irreversible) ----
// Re-verifies the owner's password first. Deleting the business cascades to the
// store, staff users, products, orders, payments, subscriptions, categories and
// coupons. After this the owner's session is invalid, so the client logs out.
dashboardRouter.delete(
  '/account',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const password = (req.body && req.body.password) || '';
    const me = (await query('SELECT password_hash FROM users WHERE id=$1', [req.user.sub])).rows[0];
    if (!me || !(await verifyPassword(password, me.password_hash))) throw badRequest('Password is incorrect.');
    await query('DELETE FROM businesses WHERE id=$1', [b]);
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
  requirePermission('coupons'),
  wrap(async (req, res) => {
    const b = bid(req);
    await requireCouponsPlan(b);
    const { rows } = await query('SELECT * FROM coupons WHERE business_id = $1 ORDER BY created_at DESC', [b]);
    res.json({ coupons: rows.map(S.coupon) });
  })
);

dashboardRouter.post(
  '/coupons',
  requirePermission('coupons'),
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
  requirePermission('coupons'),
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
  requirePermission('coupons'),
  wrap(async (req, res) => {
    const b = bid(req);
    await requireCouponsPlan(b);
    const r = await query('DELETE FROM coupons WHERE id = $1 AND business_id = $2', [req.params.id, b]);
    if (!r.rowCount) throw notFound('Coupon not found.');
    res.json({ ok: true });
  })
);

// ---- Staff accounts (Pro plan, owner only) ----
const STAFF_SECTIONS = ['orders', 'products', 'reports', 'coupons'];
async function requireProPlan(businessId) {
  const plan = (
    await query(
      `SELECT pl.id FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [businessId]
    )
  ).rows[0];
  if (!plan || plan.id !== 'pro') throw badRequest('Staff accounts are a Pro feature.');
}
function cleanPerms(input) {
  const arr = Array.isArray(input) ? input : [];
  return STAFF_SECTIONS.filter((s) => arr.includes(s));
}
function staffOut(u) {
  return {
    id: u.id, name: u.name, email: u.email,
    permissions: u.permissions || [], status: u.status,
    createdAt: u.created_at ? u.created_at.toISOString().slice(0, 10) : null,
  };
}

dashboardRouter.get(
  '/staff',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    await requireProPlan(b);
    const { rows } = await query(
      `SELECT * FROM users WHERE business_id = $1 AND role = 'BUSINESS_STAFF' ORDER BY created_at`,
      [b]
    );
    res.json({ staff: rows.map(staffOut), sections: STAFF_SECTIONS });
  })
);

dashboardRouter.post(
  '/staff',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    await requireProPlan(b);
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!name) throw badRequest("Enter the staff member's name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email.');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters.');
    const dupe = await query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
    if (dupe.rowCount) throw conflict('That email is already in use.');
    const perms = cleanPerms(body.permissions);
    const { rows } = await query(
      `INSERT INTO users (business_id, name, email, password_hash, role, permissions)
       VALUES ($1,$2,$3,$4,'BUSINESS_STAFF',$5) RETURNING *`,
      [b, name, email, await hashPassword(password), JSON.stringify(perms)]
    );
    res.status(201).json({ staff: staffOut(rows[0]) });
  })
);

dashboardRouter.put(
  '/staff/:id',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    await requireProPlan(b);
    const existing = (
      await query(`SELECT * FROM users WHERE id = $1 AND business_id = $2 AND role = 'BUSINESS_STAFF'`, [req.params.id, b])
    ).rows[0];
    if (!existing) throw notFound('Staff member not found.');
    const body = req.body || {};
    const name = body.name != null ? String(body.name).trim() : existing.name;
    const perms = body.permissions != null ? cleanPerms(body.permissions) : (existing.permissions || []);
    const status = body.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
    let passHash = existing.password_hash;
    if (body.password) {
      if (String(body.password).length < 8) throw badRequest('Password must be at least 8 characters.');
      passHash = await hashPassword(String(body.password));
    }
    const { rows } = await query(
      `UPDATE users SET name=$3, permissions=$4, status=$5, password_hash=$6 WHERE id=$1 AND business_id=$2 RETURNING *`,
      [req.params.id, b, name, JSON.stringify(perms), status, passHash]
    );
    res.json({ staff: staffOut(rows[0]) });
  })
);

dashboardRouter.delete(
  '/staff/:id',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    await requireProPlan(b);
    const r = await query(`DELETE FROM users WHERE id = $1 AND business_id = $2 AND role = 'BUSINESS_STAFF'`, [req.params.id, b]);
    if (!r.rowCount) throw notFound('Staff member not found.');
    res.json({ ok: true });
  })
);
