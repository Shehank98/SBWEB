// Card payments through OnePay: starting checkouts and settling them safely.
//
// settle() is the ONE place a transaction becomes PAID. Both the webhook and the
// buyer's return trip call it; it re-checks with OnePay's status API (the webhook is
// unsigned), then flips the row inside a transaction holding a row lock, so
// duplicate / concurrent callbacks can never apply a payment twice.
import { randomBytes } from 'crypto';
import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { badRequest, HttpError } from '../utils/http.js';
import { createCheckout, getTransactionStatus, verifyMatches, platformCreds, splitName, toE164 } from './onepay.js';
import { applyPaidPlan } from './subscription.js';
import { queueNotification, templates } from './notifications.js';

const BASE = (config.publicBaseUrl || '').replace(/\/$/, '');
export const returnUrl = (reference) => `${BASE}/api/onepay/return?ref=${encodeURIComponent(reference)}`;
export const CALLBACK_PATH = '/api/onepay/callback';

// Kind-specific hooks: credentials to verify with, and what "paid" means. Shop order
// payments register theirs from the seller gateway service.
const handlers = {
  SUBSCRIPTION: {
    creds: async () => platformCreds(),
    onPaid: onSubscriptionPaid,
    onFailed: async (client, tx, status) => {
      if (tx.payment_id) await client.query(`UPDATE payments SET status=$2, reason=$3, reviewed_at=now() WHERE id=$1 AND status='PENDING'`, [tx.payment_id, status, tx.status_message || null]);
    },
  },
};
export function registerKind(kind, handler) { handlers[kind] = handler; }

function newReference(prefix) { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`; }

// ---- Platform subscription checkout ----------------------------------------------
export async function startSubscriptionCheckout(businessId, planId) {
  const creds = platformCreds();
  if (!creds) throw new HttpError(503, 'Card payments are not available yet. Please pay by bank transfer.');
  const plan = (await query(`SELECT * FROM plans WHERE id = $1 AND status = 'ACTIVE'`, [planId])).rows[0];
  if (!plan) throw badRequest('Choose a plan to pay for.');
  const biz = (await query('SELECT * FROM businesses WHERE id = $1', [businessId])).rows[0];
  const owner = (await query(`SELECT name, email FROM users WHERE business_id = $1 AND role = 'BUSINESS_OWNER' ORDER BY created_at LIMIT 1`, [businessId])).rows[0] || {};
  const phone = toE164(biz.phone) || toE164(biz.whatsapp);
  if (!phone) throw badRequest('Add a mobile number in Store settings first. OnePay needs it for card payments.');
  const name = splitName(owner.name || biz.name);
  const reference = newReference('SUB');

  const { payment, tx } = await withTransaction(async (c) => {
    const payment = (await c.query(
      `INSERT INTO payments (business_id, plan_id, amount, method, reference, status) VALUES ($1,$2,$3,'Card (OnePay)',$4,'PENDING') RETURNING *`,
      [businessId, plan.id, plan.price, reference]
    )).rows[0];
    const tx = (await c.query(
      `INSERT INTO gateway_transactions (kind, business_id, payment_id, reference, amount, mode) VALUES ('SUBSCRIPTION',$1,$2,$3,$4,$5) RETURNING *`,
      [businessId, payment.id, reference, plan.price, creds.mode]
    )).rows[0];
    return { payment, tx };
  });

  try {
    const out = await createCheckout(creds, {
      amount: plan.price,
      reference,
      customer: { firstName: name.first, lastName: name.last, phone, email: owner.email || biz.email },
      redirectUrl: returnUrl(reference),
      // Routes the webhook back to this shop + payment (the webhook is unsigned; we still verify).
      additionalData: { k: 'sub', shop_id: businessId, payment_id: payment.id, tx: tx.id },
    });
    await query(`UPDATE gateway_transactions SET ipg_transaction_id=$2, raw_create=$3, updated_at=now() WHERE id=$1`, [tx.id, out.ipgTransactionId, JSON.stringify(out.raw)]);
    await query(`UPDATE payments SET reference=$2 WHERE id=$1`, [payment.id, `${reference} / ${out.ipgTransactionId}`]);
    return { redirectUrl: out.redirectUrl, reference };
  } catch (e) {
    await query(`UPDATE gateway_transactions SET status='FAILED', status_message=$2, raw_create=$3, updated_at=now() WHERE id=$1`, [tx.id, e.message, JSON.stringify(e.raw || null)]);
    await query(`UPDATE payments SET status='FAILED', reason=$2, reviewed_at=now() WHERE id=$1`, [payment.id, 'Could not start the card payment']);
    console.error('[onepay] checkout failed:', e.message);
    throw new HttpError(502, 'We could not open the card payment page. Please try again, or pay by bank transfer.');
  }
}

async function onSubscriptionPaid(client, tx) {
  const pay = (await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [tx.payment_id])).rows[0];
  if (!pay || pay.status === 'APPROVED') return;
  await client.query(`UPDATE payments SET status='APPROVED', reviewed_at=now(), reason=NULL WHERE id=$1`, [pay.id]);
  const { expiry, plan } = await applyPaidPlan(client, tx.business_id, pay.plan_id);
  const biz = (await client.query('SELECT id, name, email FROM businesses WHERE id=$1', [tx.business_id])).rows[0];
  await queueNotification({
    businessId: biz.id,
    recipient: biz.email,
    dedupeKey: `RECEIPT:${tx.id}`,
    ...templates.subscriptionReceipt(biz, {
      plan: plan.name, amount: Number(tx.amount), reference: tx.reference, transactionId: tx.ipg_transaction_id,
      paidOn: new Date().toISOString().slice(0, 10), validUntil: new Date(expiry).toISOString().slice(0, 10),
    }),
  }, client);
}

// ---- Settle (webhook + return page) --------------------------------------------------
// hint: { callbackStatus, statusMessage, raw } from the webhook when present.
export async function settle(tx, hint = {}) {
  const h = handlers[tx.kind];
  if (!h) throw new Error(`No handler for ${tx.kind}`);
  if (tx.status === 'PAID') return { status: 'PAID', tx };
  const creds = await h.creds(tx);
  if (!creds || !tx.ipg_transaction_id) return { status: tx.status, tx };

  let st;
  try {
    st = await getTransactionStatus(creds, tx.ipg_transaction_id);
  } catch (e) {
    console.error('[onepay] status check failed:', e.message);
    return { status: tx.status, tx, error: 'verify-failed' };
  }
  const check = verifyMatches(st, tx.amount, tx.currency);
  if (check.warn) console.warn(`[onepay] ${tx.reference}: ${check.warn}`);

  return withTransaction(async (client) => {
    const cur = (await client.query('SELECT * FROM gateway_transactions WHERE id = $1 FOR UPDATE', [tx.id])).rows[0];
    if (cur.status === 'PAID') return { status: 'PAID', tx: cur }; // duplicate: already applied
    if (check.ok) {
      const paidOn = st.paidOn && !Number.isNaN(Date.parse(st.paidOn)) ? new Date(st.paidOn) : new Date();
      const upd = (await client.query(
        `UPDATE gateway_transactions SET status='PAID', paid_on=$2, raw_status=$3, status_message=COALESCE($4, status_message), updated_at=now() WHERE id=$1 RETURNING *`,
        [cur.id, paidOn, JSON.stringify(st.raw), hint.statusMessage || null]
      )).rows[0];
      await h.onPaid(client, upd);
      return { status: 'PAID', tx: upd };
    }
    // Not paid (yet). A webhook explicitly reporting failure marks it FAILED; otherwise
    // it stays PENDING (e.g. buyer still on OnePay's page). A later success still wins.
    if (hint.callbackStatus !== undefined && Number(hint.callbackStatus) !== 1 && cur.status === 'PENDING') {
      const upd = (await client.query(
        `UPDATE gateway_transactions SET status='FAILED', status_message=$2, raw_status=$3, updated_at=now() WHERE id=$1 RETURNING *`,
        [cur.id, hint.statusMessage || 'Payment was not completed', JSON.stringify(st.raw)]
      )).rows[0];
      await h.onFailed(client, upd, 'FAILED');
      return { status: 'FAILED', tx: upd };
    }
    if (st.paid && !check.ok) console.error(`[onepay] ${cur.reference} reported paid but did not match: ${check.reason}`);
    await client.query('UPDATE gateway_transactions SET raw_status=$2, updated_at=now() WHERE id=$1', [cur.id, JSON.stringify(st.raw)]);
    return { status: cur.status, tx: cur, mismatch: st.paid && !check.ok ? check.reason : undefined };
  });
}

// Daily clean-up: checkouts abandoned for 24 hours become CANCELLED (after one last
// status check, so a late success is still honoured).
export async function cancelStaleCheckouts() {
  const { rows } = await query(`SELECT * FROM gateway_transactions WHERE status='PENDING' AND created_at < now() - INTERVAL '24 hours' LIMIT 200`);
  let cancelled = 0;
  for (const tx of rows) {
    const r = await settle(tx).catch(() => ({ status: 'PENDING' }));
    if (r.status !== 'PENDING') continue;
    await withTransaction(async (client) => {
      const cur = (await client.query(`UPDATE gateway_transactions SET status='CANCELLED', status_message='Checkout abandoned', updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING *`, [tx.id])).rows[0];
      if (cur && handlers[cur.kind]) await handlers[cur.kind].onFailed(client, cur, 'CANCELLED');
      if (cur) cancelled += 1;
    });
  }
  return { cancelledCheckouts: cancelled };
}
