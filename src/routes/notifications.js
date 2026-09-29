import { Router } from 'express';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { wrap, unauthorized, badRequest } from '../utils/http.js';

export const notificationsRouter = Router();

// The notifications outbox API is consumed by Google Apps Script (or any worker).
// It authenticates with a shared secret header so it does not need a user session.
// Set NOTIFY_TOKEN in the environment; if unset it falls back to JWT_SECRET.
function requireWorkerToken(req, _res, next) {
  const expected = process.env.NOTIFY_TOKEN || config.jwtSecret;
  const given = req.headers['x-notify-token'];
  if (!given || given !== expected) return next(unauthorized('Invalid worker token.'));
  next();
}

notificationsRouter.use(requireWorkerToken);

// ---------------------------------------------------------------------------------
// Read-only exports for the Apps Script Google Sheet sync (same worker token).
// Each returns { columns, rows } so the script writes headers + rows as-is; new
// columns can be added here without changing the script.
// ---------------------------------------------------------------------------------
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 19).replace('T', ' ') : '');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

notificationsRouter.get(
  '/export/shops',
  wrap(async (_req, res) => {
    const { rows } = await query(`
      SELECT b.id, b.name, b.type, b.status, b.email, b.phone, b.whatsapp, b.city, b.district, b.created_at,
             b.trial_started_at, b.trial_ends_at, b.preferred_plan_id, b.verification_status, b.verification_reason,
             b.verification_submitted_at, b.verification_reviewed_at,
             st.slug, st.name store_name, st.contact_email, st.address store_address, st.phone store_phone,
             st.return_days, st.refund_days, st.return_shipping, st.weekly_summary_enabled,
             u.name owner_name, u.email owner_email,
             sub.plan_id, sub.status sub_status, sub.expiry_date,
             (SELECT COUNT(*) FROM store_policies p WHERE p.business_id = b.id AND p.confirmed_at IS NOT NULL) policies_published,
             (SELECT string_agg(p.kind || ':' || CASE WHEN p.confirmed_at IS NULL THEN 'draft' WHEN p.is_custom THEN 'custom' ELSE 'template' END, ', ' ORDER BY p.kind)
                FROM store_policies p WHERE p.business_id = b.id) policy_status,
             (SELECT enabled FROM store_gateways g WHERE g.business_id = b.id AND g.provider = 'onepay') onepay_on,
             (SELECT mode FROM store_gateways g WHERE g.business_id = b.id AND g.provider = 'onepay') onepay_mode,
             (SELECT COUNT(*) FROM orders o WHERE o.business_id = b.id) orders
        FROM businesses b
        LEFT JOIN stores st ON st.business_id = b.id
        LEFT JOIN LATERAL (SELECT name, email FROM users WHERE business_id = b.id AND role = 'BUSINESS_OWNER' ORDER BY created_at LIMIT 1) u ON true
        LEFT JOIN LATERAL (SELECT plan_id, status, expiry_date FROM subscriptions WHERE business_id = b.id ORDER BY created_at DESC LIMIT 1) sub ON true
       ORDER BY b.created_at`);
    const columns = ['Shop ID', 'Shop name', 'Store link', 'Business type', 'Owner', 'Owner email', 'Phone', 'WhatsApp', 'Town', 'District',
      'Status', 'Plan', 'Subscription status', 'Paid until', 'Trial started', 'Trial ends', 'Plan after trial',
      'Verification', 'Verification reason', 'Verification submitted', 'Verification reviewed',
      'Contact email', 'Contact address', 'Contact phone', 'Policies published (of 4)', 'Policy status', 'Return days', 'Refund days', 'Return shipping paid by',
      'OnePay on', 'OnePay mode', 'Weekly summary', 'Orders', 'Created'];
    res.json({
      columns,
      rows: rows.map((r) => [r.id, r.store_name || r.name, r.slug ? `/store/${r.slug}` : '', r.type || '', r.owner_name || '', r.owner_email || r.email || '', r.phone || '', r.whatsapp || '', r.city || '', r.district || '',
        r.status, r.plan_id || '', r.sub_status || '', day(r.expiry_date), day(r.trial_started_at), day(r.trial_ends_at), r.preferred_plan_id || '',
        r.verification_status, r.verification_reason || '', iso(r.verification_submitted_at), iso(r.verification_reviewed_at),
        r.contact_email || '', r.store_address || '', r.store_phone || '', Number(r.policies_published), r.policy_status || '', r.return_days ?? '', r.refund_days ?? '', r.return_shipping || '',
        r.onepay_on ? 'yes' : 'no', r.onepay_mode || '', r.weekly_summary_enabled === false ? 'off' : 'on', Number(r.orders), iso(r.created_at)]),
    });
  })
);

notificationsRouter.get(
  '/export/payments',
  wrap(async (_req, res) => {
    const { rows } = await query(`
      SELECT p.id, p.submitted_at, p.reviewed_at, p.amount, p.method, p.reference, p.status, p.reason, p.plan_id,
             b.name business, st.slug, g.ipg_transaction_id, g.status gateway_status, g.mode, g.paid_on
        FROM payments p
        JOIN businesses b ON b.id = p.business_id
        LEFT JOIN stores st ON st.business_id = b.id
        LEFT JOIN gateway_transactions g ON g.payment_id = p.id
       ORDER BY p.submitted_at`);
    res.json({
      columns: ['Payment ID', 'Submitted', 'Shop', 'Store link', 'Plan', 'Amount (LKR)', 'Method', 'Reference', 'Status', 'Reason', 'Reviewed / paid', 'OnePay transaction', 'OnePay status', 'OnePay mode', 'OnePay paid on'],
      rows: rows.map((r) => [r.id, iso(r.submitted_at), r.business, r.slug ? `/store/${r.slug}` : '', r.plan_id || '', r.amount, r.method, r.reference || '', r.status, r.reason || '',
        iso(r.reviewed_at), r.ipg_transaction_id || '', r.gateway_status || '', r.mode || '', iso(r.paid_on)]),
    });
  })
);

notificationsRouter.get(
  '/export/shipments',
  wrap(async (_req, res) => {
    const { rows } = await query(`
      SELECT o.code, o.created_at, o.status, o.customer_name, o.city, o.district, o.total, o.payment_method, o.payment_status,
             o.courier_name, o.tracking_number, o.tracking_url, o.shipped_at, o.source, b.name business
        FROM orders o JOIN businesses b ON b.id = o.business_id
       WHERE o.tracking_number IS NOT NULL OR o.payment_status IS NOT NULL
       ORDER BY o.created_at`);
    res.json({
      columns: ['Order', 'Placed', 'Shop', 'Status', 'Customer', 'Town', 'District', 'Total (LKR)', 'Payment', 'Payment status', 'Courier', 'Tracking number', 'Tracking link', 'Shipped', 'Came from'],
      rows: rows.map((r) => [r.code, iso(r.created_at), r.business, r.status, r.customer_name, r.city || '', r.district || '', r.total, r.payment_method || '', r.payment_status || '',
        r.courier_name || '', r.tracking_number || '', r.tracking_url || '', iso(r.shipped_at), r.source || '']),
    });
  })
);

// GET /api/notifications/pending — the queue Apps Script polls.
notificationsRouter.get(
  '/pending',
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, type, recipient, subject, message, data, created_at
         FROM notifications WHERE status = 'PENDING' ORDER BY created_at LIMIT 50`
    );
    res.json({ notifications: rows });
  })
);

// POST /api/notifications/:id/sent — mark a row delivered.
notificationsRouter.post(
  '/:id/sent',
  wrap(async (req, res) => {
    const r = await query(`UPDATE notifications SET status='SENT', sent_at=now() WHERE id=$1`, [req.params.id]);
    if (!r.rowCount) throw badRequest('Notification not found.');
    res.json({ ok: true });
  })
);

// POST /api/notifications/:id/failed — record a failed attempt. The row stays
// PENDING (so the next run retries it) until it has failed several times, then
// it is parked as FAILED. `attempts` gives the admin an audit trail either way.
notificationsRouter.post(
  '/:id/failed',
  wrap(async (req, res) => {
    const r = await query(
      `UPDATE notifications
          SET attempts = attempts + 1,
              status = CASE WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'PENDING' END
        WHERE id=$1
        RETURNING attempts, status`,
      [req.params.id]
    );
    res.json({ ok: true, attempts: r.rows[0] ? r.rows[0].attempts : null, status: r.rows[0] ? r.rows[0].status : null });
  })
);
