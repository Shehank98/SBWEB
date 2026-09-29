import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { wrap, badRequest, notFound, conflict } from '../utils/http.js';
import { slugify } from '../utils/slug.js';
import * as S from '../services/serialize.js';
import { queueNotification, templates } from '../services/notifications.js';
import { activateSubscription, extendSubscription, applyPaidPlan, extendTrial } from '../services/subscription.js';
import { compliance } from '../services/policies.js';
import { signedPrivateUrl } from '../services/uploads.js';
import { onepayGuide } from '../services/onepayGuide.js';
import { getSetting, setSetting } from '../services/settings.js';

export const adminRouter = Router();

// Every route here is platform-admin only.
adminRouter.use(authenticate, requireRole('SUPER_ADMIN'));

// ---- Badge counts for the admin sidebar/tab navigation ----
adminRouter.get(
  '/badges',
  wrap(async (_req, res) => {
    const pendingApprovals = Number(
      (await query("SELECT COUNT(*) c FROM businesses WHERE status='PENDING_APPROVAL'")).rows[0].c
    );
    const pendingPayments = Number(
      (await query("SELECT COUNT(*) c FROM payments WHERE status='PENDING'")).rows[0].c
    );
    const pendingVerifications = Number(
      (await query("SELECT COUNT(*) c FROM businesses WHERE verification_status='PENDING'")).rows[0].c
    );
    res.json({ pendingApprovals, pendingPayments, pendingVerifications });
  })
);

// =====================================================================================
// Shops tab: every shop with plan, trial/subscription state, days left, verification
// and order count. Search, filters, pagination.
// =====================================================================================
const SHOP_FILTERS = {
  trial: "b.status = 'TRIAL'",
  active: "b.status IN ('ACTIVE','EXPIRING','GRACE_PERIOD')",
  expired: "b.status IN ('TRIAL_EXPIRED','SUSPENDED','CANCELLED')",
  verified: "b.verification_status = 'VERIFIED'",
  pending_verification: "b.verification_status = 'PENDING'",
  pending_approval: "b.status IN ('PENDING_APPROVAL','PENDING_PAYMENT')",
};

function daysLeftOf(row) {
  const end = row.status === 'TRIAL' || row.status === 'TRIAL_EXPIRED' ? row.trial_ends_at : row.expiry_date;
  if (!end) return null;
  return Math.ceil((new Date(end) - Date.now()) / 86400000);
}

function shopRow(r) {
  return {
    id: r.id,
    name: r.store_name || r.name,
    slug: r.slug,
    owner: r.owner_name || '',
    ownerEmail: r.owner_email || r.email || '',
    plan: r.plan_name || '',
    planId: r.plan_id || null,
    status: r.status,
    onTrial: r.status === 'TRIAL',
    daysLeft: daysLeftOf(r),
    endsOn: (r.status === 'TRIAL' || r.status === 'TRIAL_EXPIRED' ? r.trial_ends_at : r.expiry_date) || null,
    created: r.created_at,
    verification: r.verification_status,
    orders: Number(r.order_count || 0),
  };
}

const SHOP_SELECT = `
  SELECT b.*, st.slug, st.name AS store_name, u.name AS owner_name, u.email AS owner_email,
         sub.plan_id, pl.name AS plan_name, sub.expiry_date,
         (SELECT COUNT(*) FROM orders o WHERE o.business_id = b.id) AS order_count
    FROM businesses b
    LEFT JOIN stores st ON st.business_id = b.id
    LEFT JOIN LATERAL (SELECT name, email FROM users WHERE business_id = b.id AND role = 'BUSINESS_OWNER' ORDER BY created_at LIMIT 1) u ON true
    LEFT JOIN LATERAL (SELECT plan_id, expiry_date FROM subscriptions WHERE business_id = b.id ORDER BY created_at DESC LIMIT 1) sub ON true
    LEFT JOIN plans pl ON pl.id = sub.plan_id`;

adminRouter.get(
  '/shops',
  wrap(async (req, res) => {
    const where = [];
    const params = [];
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(lower(b.name) LIKE $${params.length} OR lower(st.name) LIKE $${params.length} OR lower(st.slug) LIKE $${params.length}
                   OR lower(u.name) LIKE $${params.length} OR lower(u.email) LIKE $${params.length} OR lower(b.email) LIKE $${params.length})`);
    }
    const filter = String(req.query.filter || '');
    if (SHOP_FILTERS[filter]) where.push(SHOP_FILTERS[filter]);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const page = Math.max(1, Number(req.query.page) || 1);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await query(`SELECT COUNT(*) c FROM (${SHOP_SELECT} ${w}) t`, params)).rows[0].c);
    const { rows } = await query(
      `${SHOP_SELECT} ${w} ORDER BY b.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    );
    const counts = (await query(`SELECT
        COUNT(*) all_shops,
        COUNT(*) FILTER (WHERE ${SHOP_FILTERS.trial}) trial,
        COUNT(*) FILTER (WHERE ${SHOP_FILTERS.active}) active,
        COUNT(*) FILTER (WHERE ${SHOP_FILTERS.expired}) expired,
        COUNT(*) FILTER (WHERE ${SHOP_FILTERS.verified}) verified,
        COUNT(*) FILTER (WHERE ${SHOP_FILTERS.pending_verification}) pending_verification
      FROM businesses b`)).rows[0];
    res.json({
      shops: rows.map(shopRow),
      page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)),
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
    });
  })
);

adminRouter.get(
  '/shops/:id',
  wrap(async (req, res) => {
    const r = (await query(`${SHOP_SELECT} WHERE b.id = $1`, [req.params.id])).rows[0];
    if (!r) throw notFound('Shop not found.');
    const store = (await query('SELECT * FROM stores WHERE business_id = $1', [r.id])).rows[0] || {};
    const payments = (await query(
      `SELECT p.*, pl.name plan_name FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id WHERE p.business_id = $1 ORDER BY p.submitted_at DESC LIMIT 50`,
      [r.id]
    )).rows.map((p) => ({ id: p.id, plan: p.plan_name || '', amount: p.amount, method: p.method, ref: p.reference || '', status: p.status, submitted: p.submitted_at, reason: p.reason || null, slip: p.slip_url || null }));
    const docs = (await query('SELECT kind, filename, content_type, size_bytes, uploaded_at FROM verification_documents WHERE business_id = $1', [r.id])).rows;
    const sales = (await query("SELECT COALESCE(SUM(total),0) s FROM orders WHERE business_id = $1 AND status <> 'CANCELLED'", [r.id])).rows[0];
    const products = (await query('SELECT COUNT(*) c FROM products WHERE business_id = $1', [r.id])).rows[0];
    res.json({
      shop: {
        ...shopRow(r),
        business: { type: r.type, phone: r.phone, whatsapp: r.whatsapp, email: r.email, address: r.address, city: r.city, district: r.district, facebook: r.facebook, instagram: r.instagram },
        trial: r.trial_ends_at ? { startedAt: r.trial_started_at, endsAt: r.trial_ends_at } : null,
        preferredPlanId: r.preferred_plan_id,
        store: { slug: store.slug, name: store.name, logo: store.logo_url || null, contactEmail: store.contact_email || '', address: store.address || '' },
        sales: Number(sales.s),
        products: Number(products.c),
        verificationReason: r.verification_reason,
        verificationSubmittedAt: r.verification_submitted_at,
        documents: docs.map((d) => ({ kind: d.kind, filename: d.filename, contentType: d.content_type, size: d.size_bytes, uploadedAt: d.uploaded_at })),
      },
      payments,
      compliance: await compliance(r.id),
    });
  })
);

// Short-lived signed URL (5 minutes) for one verification document. Never public.
adminRouter.get(
  '/shops/:id/documents/:kind',
  wrap(async (req, res) => {
    const d = (await query('SELECT storage_key, content_type, filename FROM verification_documents WHERE business_id = $1 AND kind = $2', [req.params.id, req.params.kind])).rows[0];
    if (!d) throw notFound('Document not found.');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ url: await signedPrivateUrl(d.storage_key, 300), contentType: d.content_type, filename: d.filename, expiresIn: 300 });
  })
);

adminRouter.post(
  '/shops/:id/extend-trial',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    const days = Number(req.body && req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw badRequest('Extend by 1 to 90 days.');
    if (!['TRIAL', 'TRIAL_EXPIRED'].includes(biz.status)) throw badRequest('Only shops on a trial (or with an ended trial) can have it extended.');
    const ends = await withTransaction((c) => extendTrial(c, biz.id, days));
    res.json({ ok: true, status: 'TRIAL', trialEndsAt: ends });
  })
);

// Change the plan on the shop's current subscription (feature flags and limits
// switch immediately; dates are unchanged). Use "activate" to give paid time.
adminRouter.post(
  '/shops/:id/plan',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    const plan = (await query('SELECT id FROM plans WHERE id = $1', [req.body && req.body.planId])).rows[0];
    if (!plan) throw badRequest('Unknown plan.');
    const upd = await query(
      `UPDATE subscriptions SET plan_id = $2 WHERE id = (SELECT id FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [biz.id, plan.id]
    );
    if (!upd.rowCount) await query(`INSERT INTO subscriptions (business_id, plan_id, status) VALUES ($1, $2, 'PENDING_PAYMENT')`, [biz.id, plan.id]);
    res.json({ ok: true, planId: plan.id });
  })
);

// Activate (e.g. a manual deal): give N paid days on a plan and open the store.
adminRouter.post(
  '/shops/:id/activate',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    const days = Number(req.body && req.body.days) || 30;
    if (!Number.isInteger(days) || days < 1 || days > 366) throw badRequest('Activate for 1 to 366 days.');
    const planId = (req.body && req.body.planId) || (await query('SELECT plan_id FROM subscriptions WHERE business_id=$1 ORDER BY created_at DESC LIMIT 1', [biz.id])).rows[0]?.plan_id || 'starter';
    const out = await withTransaction(async (c) => {
      const cur = (await c.query('SELECT id, status FROM subscriptions WHERE business_id=$1 ORDER BY created_at DESC LIMIT 1', [biz.id])).rows[0];
      if (!cur || ['TRIAL', 'EXPIRED'].includes(cur.status)) {
        await c.query(`INSERT INTO subscriptions (business_id, plan_id, status, start_date, expiry_date) VALUES ($1,$2,'ACTIVE',now(), now() + ($3 || ' days')::interval)`, [biz.id, planId, String(days)]);
        await c.query(`UPDATE businesses SET status='ACTIVE' WHERE id=$1`, [biz.id]);
        return new Date(Date.now() + days * 86400000);
      }
      await c.query('UPDATE subscriptions SET plan_id=$2 WHERE id=$1', [cur.id, planId]);
      return extendSubscription(c, biz.id, days);
    });
    res.json({ ok: true, status: 'ACTIVE', expiry: out });
  })
);

adminRouter.post(
  '/shops/:id/verification/approve',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    if (biz.verification_status !== 'PENDING') throw badRequest('There is no pending verification for this shop.');
    await query(`UPDATE businesses SET verification_status='VERIFIED', verification_reason=NULL, verification_reviewed_at=now(), verification_reviewed_by=$2 WHERE id=$1`, [biz.id, req.user.sub]);
    const store = (await query('SELECT slug FROM stores WHERE business_id=$1', [biz.id])).rows[0];
    await queueNotification({ businessId: biz.id, recipient: biz.email, dedupeKey: `VERIFIED:${biz.id}:${Date.now()}`, ...templates.verificationApproved(biz, store) });
    res.json({ ok: true, verification: 'VERIFIED' });
  })
);

adminRouter.post(
  '/shops/:id/verification/reject',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
    if (!reason) throw badRequest('A reason is required to reject.');
    if (!['PENDING', 'VERIFIED'].includes(biz.verification_status)) throw badRequest('Nothing to reject for this shop.');
    await query(`UPDATE businesses SET verification_status='REJECTED', verification_reason=$2, verification_reviewed_at=now(), verification_reviewed_by=$3 WHERE id=$1`, [biz.id, reason, req.user.sub]);
    await queueNotification({ businessId: biz.id, recipient: biz.email, dedupeKey: `VERIFY_REJECTED:${biz.id}:${Date.now()}`, ...templates.verificationRejected(biz, reason) });
    res.json({ ok: true, verification: 'REJECTED' });
  })
);

// ---- Overview stats ----
adminRouter.get(
  '/stats',
  wrap(async (_req, res) => {
    const totals = (
      await query(`
        SELECT
          COUNT(*)                                            AS total,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')           AS active,
          COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL') AS pending,
          COUNT(*) FILTER (WHERE status = 'SUSPENDED')        AS suspended
        FROM businesses`)
    ).rows[0];
    const revenue = (
      await query(`SELECT COALESCE(SUM(amount),0) AS revenue FROM payments WHERE status = 'APPROVED'`)
    ).rows[0];
    const orderCount = (await query(`SELECT COUNT(*) AS c FROM orders`)).rows[0];
    const revenueMonths = (
      await query(`
        SELECT to_char(m, 'Mon') AS label, COALESCE(SUM(p.amount), 0) AS value
          FROM generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months', date_trunc('month', CURRENT_DATE), INTERVAL '1 month') m
          LEFT JOIN payments p ON p.status = 'APPROVED' AND date_trunc('month', COALESCE(p.reviewed_at, p.submitted_at)) = m
         GROUP BY m ORDER BY m`)
    ).rows.map((r) => ({ label: r.label, value: Number(r.value) }));
    res.json({
      totalBusinesses: Number(totals.total),
      activeStores: Number(totals.active),
      pendingApproval: Number(totals.pending),
      suspended: Number(totals.suspended),
      revenue: Number(revenue.revenue),
      orders: Number(orderCount.c),
      revenueMonths,
    });
  })
);

// ---- Businesses table ----
adminRouter.get(
  '/businesses',
  wrap(async (req, res) => {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE b.status = $1`; }
    const { rows } = await query(
      `SELECT b.*, st.slug,
              u.name AS owner_name,
              pl.name AS plan_name,
              sub.expiry_date,
              (SELECT COUNT(*) FROM orders o WHERE o.business_id = b.id) AS order_count,
              (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.business_id = b.id AND o.status = 'DELIVERED') AS revenue
         FROM businesses b
         LEFT JOIN stores st ON st.business_id = b.id
         LEFT JOIN LATERAL (SELECT * FROM users WHERE business_id = b.id AND role = 'BUSINESS_OWNER' ORDER BY created_at LIMIT 1) u ON true
         LEFT JOIN LATERAL (SELECT * FROM subscriptions WHERE business_id = b.id ORDER BY created_at DESC LIMIT 1) sub ON true
         LEFT JOIN plans pl ON pl.id = sub.plan_id
         ${where}
         ORDER BY b.created_at DESC`,
      params
    );
    res.json({ businesses: rows.map(S.businessAdmin) });
  })
);

async function loadBusiness(id) {
  const b = (await query('SELECT * FROM businesses WHERE id = $1', [id])).rows[0];
  if (!b) throw notFound('Business not found.');
  return b;
}

// ---- Approve (verifies the pending payment and activates the store) ----
adminRouter.post(
  '/businesses/:id/approve',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    const result = await withTransaction(async (client) => {
      const pay = (
        await client.query(
          `SELECT * FROM payments WHERE business_id = $1 AND status = 'PENDING' ORDER BY submitted_at DESC LIMIT 1`,
          [biz.id]
        )
      ).rows[0];
      const planId = pay ? pay.plan_id : (
        await client.query('SELECT plan_id FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1', [biz.id])
      ).rows[0]?.plan_id;
      if (!planId) throw badRequest('No plan on file for this business.');

      if (pay) {
        await client.query(
          `UPDATE payments SET status = 'APPROVED', reviewed_at = now(), reviewed_by = $2 WHERE id = $1`,
          [pay.id, req.user.sub]
        );
      }
      const dates = await activateSubscription(client, biz.id, planId);
      const store = (await client.query('SELECT * FROM stores WHERE business_id = $1', [biz.id])).rows[0];
      await queueNotification(
        { businessId: biz.id, recipient: biz.email, ...templates.approved(biz, store) },
        client
      );
      return dates;
    });
    res.json({ ok: true, status: 'ACTIVE', ...result });
  })
);

// ---- Reject (requires a reason) ----
adminRouter.post(
  '/businesses/:id/reject',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    const reason = (req.body && req.body.reason) || '';
    if (!reason.trim()) throw badRequest('A reason is required to reject.');
    await withTransaction(async (client) => {
      await client.query(`UPDATE businesses SET status = 'CANCELLED' WHERE id = $1`, [biz.id]);
      await client.query(
        `UPDATE payments SET status = 'REJECTED', reason = $2, reviewed_at = now(), reviewed_by = $3
          WHERE business_id = $1 AND status = 'PENDING'`,
        [biz.id, reason, req.user.sub]
      );
      await queueNotification(
        { businessId: biz.id, recipient: biz.email, ...templates.rejected(biz, reason) },
        client
      );
    });
    res.json({ ok: true, status: 'CANCELLED' });
  })
);

// ---- Suspend / Reactivate ----
adminRouter.post(
  '/businesses/:id/suspend',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    await query(`UPDATE businesses SET status = 'SUSPENDED' WHERE id = $1`, [biz.id]);
    res.json({ ok: true, status: 'SUSPENDED' });
  })
);

adminRouter.post(
  '/businesses/:id/reactivate',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    await query(`UPDATE businesses SET status = 'ACTIVE' WHERE id = $1`, [biz.id]);
    res.json({ ok: true, status: 'ACTIVE' });
  })
);

// ---- Change store link (slug) on the owner's request ----
adminRouter.post(
  '/businesses/:id/slug',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    const slug = slugify((req.body && req.body.slug) || '');
    if (slug.length < 3) throw badRequest('Store link must be at least 3 characters (lowercase letters, numbers and hyphens).');
    const taken = await query('SELECT 1 FROM stores WHERE slug = $1 AND business_id <> $2', [slug, biz.id]);
    if (taken.rowCount) throw conflict('That store link is already taken.');
    const upd = await query('UPDATE stores SET slug = $2 WHERE business_id = $1 RETURNING slug', [biz.id, slug]);
    if (!upd.rowCount) throw notFound('This business does not have a store yet.');
    res.json({ ok: true, slug });
  })
);

// ---- Extend subscription by N days ----
adminRouter.post(
  '/businesses/:id/extend',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    const days = Number(req.body && req.body.days) || 30;
    const expiry = await withTransaction((client) => extendSubscription(client, biz.id, days));
    res.json({ ok: true, status: 'ACTIVE', expiry });
  })
);

// ---- Delete a business and ALL its data (irreversible) ----
// Removing the business cascades to its store, users, products, orders, payments,
// subscriptions, categories, coupons and notifications (all FKs are ON DELETE CASCADE).
adminRouter.delete(
  '/businesses/:id',
  wrap(async (req, res) => {
    const biz = await loadBusiness(req.params.id);
    await query('DELETE FROM businesses WHERE id = $1', [biz.id]);
    res.json({ ok: true });
  })
);

// ---- Payments queue ----
adminRouter.get(
  '/payments',
  wrap(async (req, res) => {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE p.status = $1`; }
    const { rows } = await query(
      `SELECT p.*, b.name AS business_name, pl.name AS plan_name,
              u.name AS owner_name
         FROM payments p
         JOIN businesses b ON b.id = p.business_id
         LEFT JOIN plans pl ON pl.id = p.plan_id
         LEFT JOIN LATERAL (SELECT name FROM users WHERE business_id = b.id AND role='BUSINESS_OWNER' ORDER BY created_at LIMIT 1) u ON true
         ${where}
         ORDER BY p.submitted_at DESC`,
      params
    );
    res.json({ payments: rows.map(S.payment) });
  })
);

// ---- Approve / reject a single payment (e.g. a renewal slip) ----
adminRouter.post(
  '/payments/:id/approve',
  wrap(async (req, res) => {
    const pay = (await query('SELECT * FROM payments WHERE id = $1', [req.params.id])).rows[0];
    if (!pay) throw notFound('Payment not found.');
    if (pay.status === 'APPROVED') return res.json({ ok: true, status: 'APPROVED' }); // idempotent
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payments SET status='APPROVED', reviewed_at=now(), reviewed_by=$2 WHERE id=$1`,
        [pay.id, req.user.sub]
      );
      // Renewals and trial conversions keep any remaining paid/trial days.
      const dates = await applyPaidPlan(client, pay.business_id, pay.plan_id);
      const biz = (await client.query('SELECT * FROM businesses WHERE id=$1', [pay.business_id])).rows[0];
      const store = (await client.query('SELECT * FROM stores WHERE business_id=$1', [pay.business_id])).rows[0];
      await queueNotification({ businessId: biz.id, recipient: biz.email, ...templates.approved(biz, store) }, client);
      return dates;
    });
    res.json({ ok: true, status: 'APPROVED' });
  })
);

adminRouter.post(
  '/payments/:id/reject',
  wrap(async (req, res) => {
    const pay = (await query('SELECT * FROM payments WHERE id = $1', [req.params.id])).rows[0];
    if (!pay) throw notFound('Payment not found.');
    const reason = (req.body && req.body.reason) || '';
    if (!reason.trim()) throw badRequest('A reason is required to reject.');
    await query(
      `UPDATE payments SET status='REJECTED', reason=$2, reviewed_at=now(), reviewed_by=$3 WHERE id=$1`,
      [pay.id, reason, req.user.sub]
    );
    res.json({ ok: true, status: 'REJECTED' });
  })
);

// ---- Plans (Admin Settings): prices, limits, feature bullets and feature flags ----
adminRouter.get(
  '/plans',
  wrap(async (_req, res) => {
    const plans = (await query('SELECT * FROM plans ORDER BY sort_order, price')).rows.map(S.planAdmin);
    const featureDefs = (await query('SELECT key, label, description FROM plan_feature_defs ORDER BY sort_order, key')).rows;
    res.json({ plans, featureDefs });
  })
);

function intOrNull(v, field, { min = 0, max = 10000000 } = {}) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} must be a whole number between ${min} and ${max}.`);
  return n;
}

adminRouter.put(
  '/plans/:id',
  wrap(async (req, res) => {
    const cur = (await query('SELECT * FROM plans WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) throw notFound('Plan not found.');
    const b = req.body || {};
    const name = b.name != null ? String(b.name).trim().slice(0, 40) : cur.name;
    if (!name) throw badRequest('Plan name is required.');
    const price = b.price !== undefined ? intOrNull(b.price, 'Price', { min: 1 }) : cur.price;
    if (price == null) throw badRequest('Price is required.');
    const compareAt = b.compareAtPrice !== undefined ? intOrNull(b.compareAtPrice, 'Compare-at price', { min: 1 }) : cur.compare_at_price;
    if (compareAt != null && compareAt <= price) throw badRequest('The struck-through price must be higher than the price.');
    const duration = b.durationDays !== undefined ? intOrNull(b.durationDays, 'Duration', { min: 1, max: 366 }) : cur.duration_days;
    const lim = (k, col) => (b[k] !== undefined ? intOrNull(b[k], k, { min: 0 }) : cur[col]);
    const features = Array.isArray(b.features)
      ? b.features.map((f) => String(f).trim().slice(0, 80)).filter(Boolean).slice(0, 20)
      : cur.features;
    // Only known feature keys are stored, as booleans.
    const defs = (await query('SELECT key FROM plan_feature_defs')).rows.map((r) => r.key);
    const flags = { ...(cur.feature_flags || {}) };
    if (b.flags && typeof b.flags === 'object') for (const k of defs) if (k in b.flags) flags[k] = !!b.flags[k];
    const status = b.status === 'HIDDEN' ? 'HIDDEN' : (b.status === 'ACTIVE' ? 'ACTIVE' : cur.status);
    const tagline = b.tagline != null ? String(b.tagline).trim().slice(0, 80) : cur.tagline;
    const { rows } = await query(
      `UPDATE plans SET name=$2, price=$3, compare_at_price=$4, duration_days=$5, max_products=$6, max_images=$7,
              max_categories=$8, max_variants=$9, features=$10, feature_flags=$11, status=$12, tagline=$13, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [cur.id, name, price, compareAt, duration || cur.duration_days, lim('maxProducts', 'max_products'), lim('maxImages', 'max_images'),
       lim('maxCategories', 'max_categories'), lim('maxVariants', 'max_variants'), JSON.stringify(features), JSON.stringify(flags), status, tagline]
    );
    res.json({ plan: S.planAdmin(rows[0]) });
  })
);

// ---- Platform settings (Admin Settings). Each key has a validator/normaliser. ----
const cleanStr = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const POLICY_KEYS = ['refund', 'privacy', 'return', 'terms'];
export const SETTINGS_SCHEMA = {
  platform_contact: (v) => {
    if (!v || typeof v !== 'object') throw badRequest('Contact details must be an object.');
    const out = { businessName: cleanStr(v.businessName, 80) || 'Sidadiya', email: cleanStr(v.email, 120), phone: cleanStr(v.phone, 30), whatsapp: cleanStr(v.whatsapp, 30), address: cleanStr(v.address, 300), hours: cleanStr(v.hours, 80) };
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) throw badRequest('Enter a valid platform email.');
    if (out.address && /\bp\s*\.?\s*o\s*\.?\s*box\b/i.test(out.address)) throw badRequest('Use a physical address, not a P.O. Box.');
    return out;
  },
  social_proof: (v) => {
    const n = Number(v && v.count);
    if (!Number.isInteger(n) || n < 0 || n > 1000000) throw badRequest('Shop count must be a whole number.');
    return { count: n, label: cleanStr(v.label, 60) || 'shops onboarded' };
  },
  // "How to get OnePay" guide shown to sellers (lists: one item per entry).
  onepay_guide: (v) => {
    if (!v || typeof v !== 'object') throw badRequest('Guide must be an object.');
    const list = (a, n = 20) => (Array.isArray(a) ? a : String(a || '').split('\n')).map((x) => cleanStr(x, 400)).filter(Boolean).slice(0, n);
    const c = v.contacts || {};
    return {
      intro: cleanStr(v.intro, 600), steps: list(v.steps), documents: list(v.documents), costs: list(v.costs), unsupported: list(v.unsupported),
      complianceNote: cleanStr(v.complianceNote, 800), refunds: cleanStr(v.refunds, 600),
      contacts: { email: cleanStr(c.email, 120), email2: cleanStr(c.email2, 120), phone: cleanStr(c.phone, 40), website: cleanStr(c.website, 200), docs: cleanStr(c.docs, 200) },
    };
  },
  // Custom text per platform legal page; an empty string falls back to the template.
  platform_policies: (v) => {
    if (!v || typeof v !== 'object') throw badRequest('Policies must be an object.');
    const out = {};
    for (const k of POLICY_KEYS) if (typeof v[k] === 'string' && v[k].trim()) out[k] = v[k].trim().slice(0, 20000);
    return out;
  },
  trial_days: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 90) throw badRequest('Trial length must be 1 to 90 days.');
    return n;
  },
  platform_bank_accounts: (v) => {
    if (!Array.isArray(v)) throw badRequest('Bank accounts must be a list.');
    return v.slice(0, 5).map((a) => ({ bank: cleanStr(a.bank, 60), holder: cleanStr(a.holder, 80), accountNo: cleanStr(a.accountNo, 40), branch: cleanStr(a.branch, 60) }))
      .filter((a) => a.bank && a.accountNo);
  },
};

adminRouter.get(
  '/settings',
  wrap(async (_req, res) => {
    const out = {};
    for (const k of Object.keys(SETTINGS_SCHEMA)) out[k] = await getSetting(k, null);
    out.onepay_guide = await onepayGuide(); // defaults filled in until the admin edits it
    if (!out.social_proof) out.social_proof = { count: 40, label: 'shops onboarded' };
    res.json({ settings: out });
  })
);

adminRouter.put(
  '/settings',
  wrap(async (req, res) => {
    const body = req.body || {};
    const saved = {};
    for (const [k, v] of Object.entries(body)) {
      if (!SETTINGS_SCHEMA[k]) throw badRequest(`Unknown setting: ${k}`);
      saved[k] = SETTINGS_SCHEMA[k](v);
    }
    for (const [k, v] of Object.entries(saved)) await setSetting(k, v, req.user.sub);
    res.json({ ok: true, settings: saved });
  })
);
