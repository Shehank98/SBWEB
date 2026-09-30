import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db/pool.js';
import { authenticate, requireBusiness, requireOwner, requirePermission } from '../middleware/auth.js';
import { wrap, badRequest, notFound, conflict, forbidden, HttpError } from '../utils/http.js';
import { saveUpload, savePrivate, SLIP_TYPES } from '../services/uploads.js';
import { config } from '../config.js';
import { startSubscriptionCheckout } from '../services/cardPayments.js';
import { platformCreds } from '../services/onepay.js';
import { listGateways, saveGateway, cardAvailability, gatewayUrls } from '../services/gateways.js';
import QRCode from 'qrcode';
import { waybillMissing, isCod, receiptExpired, toWhatsAppIntl, receiptUrl, trackUrl } from '../services/orderLinks.js';
import { onepayGuide } from '../services/onepayGuide.js';
import { trafficSources, trafficBuckets } from '../services/traffic.js';
import { hashPassword, verifyPassword } from '../utils/auth.js';
import { queueNotification, templates } from '../services/notifications.js';
import { currentPlan, cap, businessAccess, assertFeature, hasFeature, paywall, trialInfo } from '../services/plan.js';
import { getSetting } from '../services/settings.js';
import { POLICY_KINDS, TEMPLATES, loadPolicies, compliance, validateContact } from '../services/policies.js';
import * as S from '../services/serialize.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
export const dashboardRouter = Router();

dashboardRouter.use(authenticate, requireBusiness);
// Payment wall: once a trial expires (or a paid plan lapses into SUSPENDED) only the
// endpoints needed to understand the problem and pay stay open. Nothing is deleted.
export const PAYWALL_ALLOW = [
  ['GET', /^\/access$/],
  ['GET', /^\/badges$/],
  ['*', /^\/subscription(\/|$)/],
  ['GET', /^\/store$/],
  ['DELETE', /^\/account$/],
];
dashboardRouter.use(paywall(PAYWALL_ALLOW));
const bid = (req) => req.user.business_id;

// ---- Access state: plan, feature flags, trial countdown, payment-wall lock ----
dashboardRouter.get(
  '/access',
  wrap(async (req, res) => {
    const a = await businessAccess(bid(req));
    if (!a) throw notFound('Business not found.');
    res.json(a);
  })
);

const ORDER_FLOW = ['PENDING', 'CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];

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
    const plan = await currentPlan(b);
    await assertFeature(b, 'reports', 'Reports are available on the Business and Pro plans.');
    const advanced = !!(plan.feature_flags && plan.feature_flags.advanced_reports);

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
    // Advanced customer insights are gated by the plan's advanced_reports flag (Pro by default).
    if (advanced) {
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
    const { rows } = await query(
      `SELECT o.*, s.slug AS business_slug FROM orders o LEFT JOIN stores s ON s.business_id = o.business_id
        WHERE o.business_id=$1 ORDER BY o.created_at DESC`,
      [b]
    );
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
    // "Refunded": the refund itself is made in the seller's OnePay dashboard (or by
    // bank transfer); here the seller records it with a note.
    const note = req.body && req.body.note ? String(req.body.note).trim().slice(0, 500) : null;
    if (status === 'REFUNDED' && !note) throw badRequest('Add a note about the refund (amount, how and when it was refunded).');
    await withTransaction(async (client) => {
      await client.query('UPDATE orders SET status=$3 WHERE business_id=$1 AND code=$2', [b, req.params.code, status]);
      if (status === 'REFUNDED') {
        await client.query(`UPDATE orders SET refund_note=$2, refunded_at=now(), payment_status=CASE WHEN payment_status='PAID' THEN 'REFUNDED' ELSE payment_status END WHERE id=$1`, [order.id, note]);
      }
      await client.query(
        'INSERT INTO order_status_history (order_id, status, changed_by, note) VALUES ($1,$2,$3,$4)',
        [order.id, status, req.user.sub, note]
      );
      // Email the buyer a status update (on behalf of the shop) for each step on
      // the tracking timeline. The dedupe key makes a repeated click a no-op;
      // "Processing" and "Ready to ship" both count as Packed, so one email.
      if (order.customer_email && status !== order.status) {
        const shop = (await client.query(
          `SELECT COALESCE(s.name, bz.name) AS name, s.slug, s.phone, s.whatsapp, s.address, COALESCE(NULLIF(s.contact_email, ''), bz.email) AS email
             FROM businesses bz LEFT JOIN stores s ON s.business_id = bz.id
            WHERE bz.id = $1`,
          [b]
        )).rows[0] || { name: 'Your store' };
        const items = (await client.query('SELECT name, qty, price FROM order_items WHERE order_id=$1', [order.id])).rows;
        const mail = status === 'CONFIRMED' ? templates.orderConfirmed(shop, order, items)
          : status === 'SHIPPED' ? templates.orderShipped(shop, order, items)
          : templates.orderStatusUpdate(shop, order, items, status);
        const key = status === 'PROCESSING' || status === 'READY_TO_SHIP' ? 'PACKED' : status;
        if (mail) await queueNotification({ businessId: b, recipient: order.customer_email, dedupeKey: `${key}:${order.id}`, ...mail }, client);
      }
    });
    res.json({ ok: true, status });
  })
);

// ---- Mark as shipped with courier + tracking number; emails the buyer ----
dashboardRouter.put(
  '/orders/:code/ship',
  requirePermission('orders'),
  wrap(async (req, res) => {
    const b = bid(req);
    const courier = String((req.body && req.body.courier) || '').trim().slice(0, 60);
    const number = String((req.body && req.body.trackingNumber) || '').trim().slice(0, 80);
    let url = String((req.body && req.body.trackingUrl) || '').trim().slice(0, 300);
    if (!courier) throw badRequest('Choose or type the courier name.');
    if (!number) throw badRequest('Enter the tracking number.');
    if (url && !/^https:\/\/[^\s]+$/i.test(url)) throw badRequest('The tracking link must start with https://');
    const order = (await query('SELECT * FROM orders WHERE business_id=$1 AND code=$2', [b, req.params.code])).rows[0];
    if (!order) throw notFound('Order not found.');
    if (['CANCELLED', 'REFUNDED'].includes(order.status)) throw badRequest('This order is cancelled.');
    const updated = await withTransaction(async (client) => {
      const o = (await client.query(
        `UPDATE orders SET courier_name=$2, tracking_number=$3, tracking_url=$4, shipped_at=COALESCE(shipped_at, now()),
                status = CASE WHEN status = 'DELIVERED' THEN status ELSE 'SHIPPED' END
          WHERE id=$1 RETURNING *`,
        [order.id, courier, number, url || null]
      )).rows[0];
      if (order.status !== o.status) {
        await client.query('INSERT INTO order_status_history (order_id, status, changed_by, note) VALUES ($1,$2,$3,$4)', [o.id, o.status, req.user.sub, `${courier} ${number}`]);
      }
      if (o.customer_email) {
        const shop = (await client.query(`SELECT s.name, s.slug, s.phone, s.whatsapp, s.address, COALESCE(NULLIF(s.contact_email, ''), bz.email) AS email FROM stores s JOIN businesses bz ON bz.id = s.business_id WHERE s.business_id=$1`, [b])).rows[0];
        const items = (await client.query('SELECT name, qty, price FROM order_items WHERE order_id=$1', [o.id])).rows;
        // New tracking number = new email; saving the same one twice sends once.
        await queueNotification({ businessId: b, recipient: o.customer_email, dedupeKey: `SHIPPED_TRACK:${o.id}:${number}`, ...templates.orderShippedTracking(shop, o, items) }, client);
      }
      return o;
    });
    res.json({ ok: true, status: updated.status, emailed: !!updated.customer_email, tracking: { courier, number, url: url || '' } });
  })
);

// ---- Waybills: print-ready data for one or many orders (A6 labels) ----
// GET /api/dashboard/waybills?codes=ORD-1,ORD-2  (max 50). Each waybill carries
// the fields still missing; the page prints only the ready ones.
dashboardRouter.get(
  '/waybills',
  requirePermission('orders'),
  wrap(async (req, res) => {
    const b = bid(req);
    const codes = String(req.query.codes || '').split(',').map((c) => c.trim()).filter((c, i, all) => c && all.indexOf(c) === i).slice(0, 50);
    if (!codes.length) throw badRequest('Choose at least one order.');
    const shop = (await query(
      `SELECT COALESCE(s.name, bz.name) AS name, s.logo_url, s.address, s.phone, bz.phone AS biz_phone, bz.city, bz.district
         FROM businesses bz LEFT JOIN stores s ON s.business_id = bz.id WHERE bz.id = $1`,
      [b]
    )).rows[0];
    const orders = (await query('SELECT * FROM orders WHERE business_id = $1 AND code = ANY($2)', [b, codes])).rows;
    const ids = orders.map((o) => o.id);
    const items = ids.length ? (await query('SELECT order_id, name, qty FROM order_items WHERE order_id = ANY($1) ORDER BY id', [ids])).rows : [];
    const byOrder = items.reduce((m, i) => { (m[i.order_id] = m[i.order_id] || []).push(i); return m; }, {});
    const waybills = await Promise.all(codes.map(async (code) => {
      const o = orders.find((x) => x.code === code);
      if (!o) return { code, missing: ['Order not found'] };
      const its = byOrder[o.id] || [];
      return {
        code: o.code,
        date: o.created_at,
        customer: o.customer_name,
        phone: o.phone,
        whatsapp: o.whatsapp || '',
        address: o.address || '',
        city: o.city || '',
        district: o.district || '',
        items: its.map((i) => ({ name: i.name, qty: i.qty })),
        pieces: its.reduce((n, i) => n + Number(i.qty || 0), 0),
        payment: o.payment_method || '',
        cod: isCod(o) ? Number(o.total) : 0,
        total: Number(o.total),
        courier: o.courier_name || '',
        trackingNumber: o.tracking_number || '',
        note: o.note || '',
        // QR of the order id (the courier or the shop can scan it back to the order).
        qr: await QRCode.toString(o.code, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }),
        missing: waybillMissing(o, its),
      };
    }));
    res.json({
      shop: { name: shop.name, logo: shop.logo_url || null, address: shop.address || '', phone: shop.phone || shop.biz_phone || '', city: shop.city || '', district: shop.district || '' },
      waybills,
    });
  })
);

// POST /api/dashboard/waybills/printed { codes } — remember what was printed.
dashboardRouter.post(
  '/waybills/printed',
  requirePermission('orders'),
  wrap(async (req, res) => {
    const codes = (Array.isArray(req.body && req.body.codes) ? req.body.codes : []).map(String).slice(0, 50);
    const r = await query('UPDATE orders SET waybill_printed_at = now() WHERE business_id = $1 AND code = ANY($2)', [bid(req), codes]);
    res.json({ ok: true, updated: r.rowCount });
  })
);

// POST /api/dashboard/orders/:code/receipt-share — the seller shares the digital
// receipt on WhatsApp. Returns the wa.me link (buyer number normalised to 94...).
dashboardRouter.post(
  '/orders/:code/receipt-share',
  requirePermission('orders'),
  wrap(async (req, res) => {
    const b = bid(req);
    const o = (await query('SELECT * FROM orders WHERE business_id = $1 AND code = $2', [b, req.params.code])).rows[0];
    if (!o) throw notFound('Order not found.');
    if (receiptExpired(o)) throw badRequest('This receipt link has expired (receipts work for 30 days after purchase).');
    const phone = toWhatsAppIntl(o.whatsapp || o.phone);
    if (!phone) throw badRequest("The buyer's number is not a Sri Lankan mobile number, so WhatsApp cannot be opened.");
    const shop = (await query('SELECT COALESCE(s.name, bz.name) AS name FROM businesses bz LEFT JOIN stores s ON s.business_id = bz.id WHERE bz.id = $1', [b])).rows[0];
    const first = String(o.customer_name || '').trim().split(' ')[0] || 'there';
    const until = new Date(o.receipt_expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const text = `Hi ${first}, thank you for shopping with ${shop.name}! Here is your receipt for order ${o.code}: ${receiptUrl(o)}\nTrack your order: ${trackUrl(o)}\n(The receipt link works until ${until}.)`;
    await query('UPDATE orders SET receipt_shared_at = now() WHERE id = $1', [o.id]);
    res.json({ ok: true, waUrl: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`, phone });
  })
);

// ---- Seller preferences: weekly summary on/off (+ channels for later) ----
dashboardRouter.get(
  '/preferences',
  requireOwner,
  wrap(async (req, res) => {
    const s = (await query('SELECT weekly_summary_enabled, digest_channels FROM stores WHERE business_id=$1', [bid(req)])).rows[0] || {};
    res.json({ weeklySummary: s.weekly_summary_enabled !== false, channels: s.digest_channels || { email: true } });
  })
);
dashboardRouter.put(
  '/preferences',
  requireOwner,
  wrap(async (req, res) => {
    const on = !!(req.body && req.body.weeklySummary);
    await query(`UPDATE stores SET weekly_summary_enabled=$2 WHERE business_id=$1`, [bid(req), on]);
    res.json({ ok: true, weeklySummary: on });
  })
);

// ---- Where visitors came from (Pro only; gated here, not just in the UI) ----
// GET /api/dashboard/traffic?from=YYYY-MM-DD&to=YYYY-MM-DD (Sri Lanka dates,
// inclusive) or ?days=N. Other plans get 403 UPGRADE_REQUIRED and no data.
const SL_DAY = /^\d{4}-\d{2}-\d{2}$/;
dashboardRouter.get(
  '/traffic',
  wrap(async (req, res) => {
    const b = bid(req);
    if (!(await hasFeature(b, 'traffic_sources'))) {
      throw new HttpError(403, 'See where your visitors come from on the Pro plan.', { code: 'UPGRADE_REQUIRED', feature: 'traffic_sources', upgrade: true });
    }
    let from, to;
    if (SL_DAY.test(String(req.query.from || '')) && SL_DAY.test(String(req.query.to || ''))) {
      from = new Date(`${req.query.from}T00:00:00+05:30`);
      to = new Date(new Date(`${req.query.to}T00:00:00+05:30`).getTime() + 86400000);
      if (!(from < to)) throw badRequest('The start date must be on or before the end date.');
      if (to - from > 366 * 86400000) throw badRequest('Choose a range of one year or less.');
    } else {
      const days = Math.min(366, Math.max(1, Number(req.query.days) || 7));
      to = new Date(); from = new Date(Date.now() - days * 86400000);
    }
    const [summary, sources] = await Promise.all([trafficBuckets(b, from, to), trafficSources(b, from, to, 8)]);
    res.json({ from: from.toISOString(), to: to.toISOString(), ...summary, sources });
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
    const biz = (await query('SELECT status, trial_started_at, trial_ends_at, preferred_plan_id FROM businesses WHERE id=$1', [b])).rows[0];
    const payments = (
      await query(
        `SELECT p.*, pl.name plan_name FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id
          WHERE p.business_id=$1 ORDER BY p.submitted_at DESC`,
        [b]
      )
    ).rows.map((p) => ({
      id: p.id, amount: p.amount, method: p.method, ref: p.reference || '', plan: p.plan_name || '',
      status: p.status, submitted: p.submitted_at.toISOString().slice(0, 10), reason: p.reason || undefined,
      paidOn: p.reviewed_at ? p.reviewed_at.toISOString().slice(0, 10) : null,
    }));
    const trial = biz ? trialInfo(biz) : null;
    const onTrial = !!(sub && sub.status === 'TRIAL');
    res.json({
      status: biz ? biz.status : null,
      plan: sub ? { id: sub.plan_id, name: sub.plan_name, price: sub.price, durationDays: sub.duration_days, maxProducts: sub.max_products, features: sub.features } : null,
      onTrial,
      trial,
      startDate: sub && sub.start_date ? sub.start_date.toISOString().slice(0, 10) : null,
      expiryDate: sub && sub.expiry_date ? sub.expiry_date.toISOString().slice(0, 10) : null,
      // Next renewal: the paid period's end. During a trial the first payment is due when the trial ends.
      renewalDate: sub && sub.expiry_date ? sub.expiry_date.toISOString().slice(0, 10) : null,
      preferredPlanId: biz ? biz.preferred_plan_id : null,
      bankAccounts: await getSetting('platform_bank_accounts', []),
      cardPayments: await platformCreds().then((c) => ({ enabled: !!c, mode: c ? c.mode : null })),
      payments,
    });
  })
);

// ---- Pay the platform subscription by card (OnePay, the platform's own account) ----
// Returns the OnePay page to send the seller to (same window). Activation happens
// only after the payment is verified (webhook or return page).
dashboardRouter.post(
  '/subscription/onepay',
  requireOwner,
  wrap(async (req, res) => {
    const out = await startSubscriptionCheckout(bid(req), String((req.body && req.body.planId) || ''));
    res.status(201).json(out);
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
    const plan = (await query("SELECT * FROM plans WHERE id=$1 AND status='ACTIVE'", [planId])).rows[0];
    if (!plan) throw badRequest('Unknown plan.');
    let slipUrl = null;
    if (req.file) slipUrl = await saveUpload(req.file, 'slips', { allow: SLIP_TYPES });
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
    const biz = (await query('SELECT status, facebook, instagram FROM businesses WHERE id=$1', [b])).rows[0];
    res.json({ store: { ...S.storePublic({ ...store, facebook: biz && biz.facebook, instagram: biz && biz.instagram }, cats), status: biz ? biz.status : store.status } });
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
    // Autosave sends partial or in-progress edits: never blank the name, and keep
    // fields the page did not send (city was previously wiped on every save).
    if (s.name !== undefined && !String(s.name || '').trim()) throw badRequest('Your store needs a name.');
    if (d.fee != null && !(Number(d.fee) >= 0 && Number(d.fee) <= 100000)) throw badRequest('Enter a delivery fee between 0 and 100,000.');
    if (d.freeAbove != null && !(Number(d.freeAbove) >= 0)) throw badRequest('Free delivery amount cannot be negative.');
    const keep = (v, cur) => (v === undefined ? cur : (String(v || '').trim() || null));
    // Structured bank account (shown to customers, copyable). Keep bank_details as a
    // human-readable one-line summary composed from the fields, for the plain-text
    // fallback and any legacy readers.
    const clean = (v) => String(v == null ? '' : v).trim().slice(0, 120);
    let bankAccount = store.bank_account || {};
    let bankLine = store.bank_details;
    if (s.bankAccount && typeof s.bankAccount === 'object') {
      bankAccount = {
        bankName: clean(s.bankAccount.bankName),
        holder: clean(s.bankAccount.holder),
        branch: clean(s.bankAccount.branch),
        accountNo: clean(s.bankAccount.accountNo),
      };
      bankLine = [bankAccount.bankName, bankAccount.holder, bankAccount.branch && bankAccount.branch + ' branch', bankAccount.accountNo && 'A/C ' + bankAccount.accountNo]
        .filter(Boolean).join(', ');
    } else if (s.bank != null) {
      bankLine = s.bank;
    }
    await query(
      `UPDATE stores SET name=$2, tagline=$3, about=$4, preset=$5, phone=$6, whatsapp=$7, address=$8, city=$9,
              delivery_fee=$10, delivery_free_above=$11, pickup=$12, pay_cod=$13, pay_bank=$14, pay_online=$15, bank_details=$16, template=$17, bank_account=$18
        WHERE business_id=$1`,
      [b, String(s.name || '').trim() || store.name, keep(s.tagline, store.tagline), keep(s.about, store.about), s.preset || store.preset,
       keep(s.phone, store.phone), keep(s.whatsapp, store.whatsapp), keep(s.address, store.address), keep(s.city, store.city),
       d.fee != null ? d.fee : store.delivery_fee, d.freeAbove != null ? d.freeAbove : store.delivery_free_above,
       d.pickup != null ? d.pickup : store.pickup,
       p.cod != null ? p.cod : store.pay_cod, p.bank != null ? p.bank : store.pay_bank, p.online != null ? p.online : store.pay_online,
       bankLine,
       ['classic', 'showcase', 'minimal'].includes(s.template) ? s.template : store.template,
       JSON.stringify(bankAccount)]
    );
    // Social links for the storefront footer (a handle or a full https link).
    const social = (v) => { const t = String(v || '').trim().slice(0, 200); if (!t) return null; if (/^https?:\/\//i.test(t)) return t; if (/^@?[A-Za-z0-9._-]{1,80}$/.test(t)) return t.replace(/^@/, ''); throw badRequest('Enter a Facebook or Instagram page name, or its full link.'); };
    if (s.facebook !== undefined || s.instagram !== undefined) {
      await query('UPDATE businesses SET facebook = COALESCE($2, facebook), instagram = COALESCE($3, instagram) WHERE id = $1', [b, s.facebook !== undefined ? social(s.facebook) || '' : null, s.instagram !== undefined ? social(s.instagram) || '' : null]);
    }

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

// ---- Store logo upload (owner). Saves the image and stores its URL. ----
dashboardRouter.post(
  '/store/logo',
  requireOwner,
  upload.single('logo'),
  wrap(async (req, res) => {
    const b = bid(req);
    if (!req.file) throw badRequest('Choose an image to upload.');
    const store = (await query('SELECT slug FROM stores WHERE business_id=$1', [b])).rows[0];
    if (!store) throw notFound('Store not found.');
    const url = await saveUpload(req.file, `logos/${store.slug}`);
    await query('UPDATE stores SET logo_url=$2 WHERE business_id=$1', [b, url]);
    res.json({ logo: url });
  })
);

// ---- Payment gateways (seller's own OnePay / PayHere accounts) ----
dashboardRouter.get(
  '/gateways',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    res.json({ gateways: await listGateways(b), card: await cardAvailability(b), urls: gatewayUrls(), guide: await onepayGuide() });
  })
);

dashboardRouter.put(
  '/gateways/:provider',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    try {
      await saveGateway(b, req.params.provider, req.body || {});
    } catch (e) {
      if (e.status) throw new HttpError(e.status, e.message);
      throw e;
    }
    res.json({ gateways: await listGateways(b), card: await cardAvailability(b) });
  })
);

// ---- Seller verification: ID copy + address proof, stored PRIVATELY ----
dashboardRouter.get(
  '/verification',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const biz = (await query('SELECT verification_status, verification_reason, verification_submitted_at, verification_reviewed_at FROM businesses WHERE id=$1', [b])).rows[0];
    const docs = (await query('SELECT kind, filename, uploaded_at FROM verification_documents WHERE business_id=$1', [b])).rows;
    res.json({
      status: biz.verification_status,
      reason: biz.verification_status === 'REJECTED' ? biz.verification_reason : null,
      submittedAt: biz.verification_submitted_at,
      reviewedAt: biz.verification_reviewed_at,
      // File names only. Sellers never get a link back: the documents stay private.
      documents: docs.map((d) => ({ kind: d.kind, filename: d.filename, uploadedAt: d.uploaded_at })),
    });
  })
);

dashboardRouter.post(
  '/verification',
  requireOwner,
  upload.fields([{ name: 'idDoc', maxCount: 1 }, { name: 'addressDoc', maxCount: 1 }]),
  wrap(async (req, res) => {
    const b = bid(req);
    const f = (k) => (req.files && req.files[k] && req.files[k][0]) || null;
    const biz = (await query('SELECT id, name, verification_status FROM businesses WHERE id=$1', [b])).rows[0];
    if (biz.verification_status === 'VERIFIED') throw badRequest('Your business is already verified.');
    const have = new Set((await query('SELECT kind FROM verification_documents WHERE business_id=$1', [b])).rows.map((r) => r.kind));
    // On a resubmission after a rejection, both documents must be uploaded again.
    const needBoth = biz.verification_status === 'REJECTED';
    if ((!f('idDoc') && (needBoth || !have.has('id'))) || (!f('addressDoc') && (needBoth || !have.has('address')))) {
      throw badRequest('Upload both your ID copy and your address proof.');
    }
    for (const [field, kind] of [['idDoc', 'id'], ['addressDoc', 'address']]) {
      const file = f(field);
      if (!file) continue;
      const key = await savePrivate(file, b, kind);
      await query(
        `INSERT INTO verification_documents (business_id, kind, storage_key, filename, content_type, size_bytes, uploaded_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (business_id, kind) DO UPDATE SET storage_key=EXCLUDED.storage_key, filename=EXCLUDED.filename,
           content_type=EXCLUDED.content_type, size_bytes=EXCLUDED.size_bytes, uploaded_at=now()`,
        [b, kind, key, String(file.originalname || kind).slice(0, 120), file.mimetype, file.size]
      );
    }
    await query(
      `UPDATE businesses SET verification_status='PENDING', verification_reason=NULL, verification_submitted_at=now() WHERE id=$1`,
      [b]
    );
    await queueNotification({ businessId: b, recipient: config.admin.email, dedupeKey: `VERIFY_SUBMITTED:${b}:${Date.now()}`, ...templates.verificationSubmitted(biz) });
    res.status(201).json({ ok: true, status: 'PENDING' });
  })
);

// ---- Policies & compliance (card network / OnePay requirements) ----
dashboardRouter.get(
  '/compliance',
  wrap(async (req, res) => res.json(await compliance(bid(req))))
);

dashboardRouter.get(
  '/policies',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const { policies, store, biz } = await loadPolicies(b);
    res.json({
      policies: POLICY_KINDS.map((k) => policies[k]),
      settings: { returnDays: store.return_days, refundDays: store.refund_days, returnShipping: store.return_shipping },
      contact: { email: store.contact_email || biz.email || '', phone: store.phone || '', address: store.address || '' },
      compliance: await compliance(b),
      slug: store.slug,
    });
  })
);

// Save (and optionally publish) a policy. Text identical to the template stays
// template-backed, so it keeps following shop name/contact changes.
dashboardRouter.put(
  '/policies/:kind',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const kind = req.params.kind;
    if (!POLICY_KINDS.includes(kind)) throw notFound('Unknown policy.');
    const body = req.body || {};
    const { ctx } = await loadPolicies(b);
    const text = body.content != null ? String(body.content).replace(/\r\n/g, '\n').trim() : null;
    if (text != null && text.length < 80) throw badRequest('This policy looks too short. Keep the key sections so buyers and OnePay can review it.');
    if (text != null && text.length > 20000) throw badRequest('This policy is too long (max 20,000 characters).');
    const isCustom = text != null && text !== TEMPLATES[kind](ctx).trim();
    await query(
      `UPDATE store_policies SET content = $3, is_custom = $4, updated_at = now(),
              confirmed_at = CASE WHEN $5 THEN now() ELSE confirmed_at END
        WHERE business_id = $1 AND kind = $2`,
      [b, kind, isCustom ? text : null, isCustom, !!body.publish]
    );
    res.json({ ok: true, compliance: await compliance(b) });
  })
);

dashboardRouter.post(
  '/policies/:kind/reset',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    if (!POLICY_KINDS.includes(req.params.kind)) throw notFound('Unknown policy.');
    await query(`UPDATE store_policies SET content = NULL, is_custom = false, confirmed_at = NULL, updated_at = now() WHERE business_id = $1 AND kind = $2`, [b, req.params.kind]);
    res.json({ ok: true, compliance: await compliance(b) });
  })
);

dashboardRouter.put(
  '/policy-settings',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const s = req.body || {};
    const days = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 90) throw badRequest(`${name} must be 1 to 90 days.`); return n; };
    const ship = ['buyer', 'seller', 'seller_if_faulty'].includes(s.returnShipping) ? s.returnShipping : 'buyer';
    await query('UPDATE stores SET return_days = $2, refund_days = $3, return_shipping = $4 WHERE business_id = $1',
      [b, days(s.returnDays ?? 14, 'Return window'), days(s.refundDays ?? 7, 'Refund request window'), ship]);
    res.json({ ok: true });
  })
);

// Contact Details (compliance item 5): business email, physical address (no P.O. Box), phone.
dashboardRouter.put(
  '/contact',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    const c = { email: String(req.body?.email || '').trim(), phone: String(req.body?.phone || '').trim(), address: String(req.body?.address || '').trim() };
    const errors = validateContact(c);
    if (Object.keys(errors).length) throw badRequest(Object.values(errors)[0], { fields: errors });
    await query('UPDATE stores SET contact_email = $2, phone = $3, address = $4 WHERE business_id = $1', [b, c.email.slice(0, 120), c.phone.slice(0, 30), c.address.slice(0, 300)]);
    res.json({ ok: true, compliance: await compliance(b) });
  })
);

// ---- Store cover photo (owner): the wide banner at the top of the storefront. ----
dashboardRouter.post(
  '/store/cover',
  requireOwner,
  upload.single('cover'),
  wrap(async (req, res) => {
    const b = bid(req);
    if (!req.file) throw badRequest('Choose an image to upload.');
    const store = (await query('SELECT slug FROM stores WHERE business_id=$1', [b])).rows[0];
    if (!store) throw notFound('Store not found.');
    const url = await saveUpload(req.file, `covers/${store.slug}`);
    await query('UPDATE stores SET cover_url=$2 WHERE business_id=$1', [b, url]);
    res.json({ cover: url });
  })
);
dashboardRouter.delete(
  '/store/cover',
  requireOwner,
  wrap(async (req, res) => {
    await query('UPDATE stores SET cover_url=NULL WHERE business_id=$1', [bid(req)]);
    res.json({ ok: true });
  })
);

// ---- Remove the store logo (owner). ----
dashboardRouter.delete(
  '/store/logo',
  requireOwner,
  wrap(async (req, res) => {
    const b = bid(req);
    await query('UPDATE stores SET logo_url=NULL WHERE business_id=$1', [b]);
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
function requireCouponsPlan(businessId) {
  return assertFeature(businessId, 'coupons', 'Coupons are available on the Business and Pro plans.');
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
function requireProPlan(businessId) {
  return assertFeature(businessId, 'staff', 'Staff accounts are a Pro feature.');
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
