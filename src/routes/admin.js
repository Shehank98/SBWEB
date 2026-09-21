import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { wrap, badRequest, notFound } from '../utils/http.js';
import * as S from '../services/serialize.js';
import { queueNotification, templates } from '../services/notifications.js';
import { activateSubscription, extendSubscription } from '../services/subscription.js';

export const adminRouter = Router();

// Every route here is platform-admin only.
adminRouter.use(authenticate, requireRole('SUPER_ADMIN'));

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
    res.json({
      totalBusinesses: Number(totals.total),
      activeStores: Number(totals.active),
      pendingApproval: Number(totals.pending),
      suspended: Number(totals.suspended),
      revenue: Number(revenue.revenue),
      orders: Number(orderCount.c),
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
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payments SET status='APPROVED', reviewed_at=now(), reviewed_by=$2 WHERE id=$1`,
        [pay.id, req.user.sub]
      );
      const dates = await activateSubscription(client, pay.business_id, pay.plan_id);
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
