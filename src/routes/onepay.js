import { Router } from 'express';
import { query } from '../db/pool.js';
import { wrap } from '../utils/http.js';
import { settle } from '../services/cardPayments.js';

// OnePay webhook + buyer return. One platform endpoint for every OnePay app (the
// platform's and each shop's): the callback URL registered in every OnePay app is
//   https://<your domain>/api/onepay/callback
// and payments are routed by the transaction id (and additional_data).
export const onepayRouter = Router();

async function findTx({ transactionId, additional }) {
  if (transactionId) {
    const r = (await query('SELECT * FROM gateway_transactions WHERE ipg_transaction_id = $1', [String(transactionId)])).rows[0];
    if (r) return r;
  }
  // Fallback: our own tx id inside additional_data (JSON string we sent).
  let a = additional;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (a && typeof a === 'object' && /^[0-9a-f-]{36}$/i.test(String(a.tx || ''))) {
    return (await query('SELECT * FROM gateway_transactions WHERE id = $1', [a.tx])).rows[0] || null;
  }
  return null;
}

// POST /api/onepay/callback  { transaction_id, status, status_message, additional_data }
// Always answers 200 once recorded, so OnePay does not keep retrying; the payload is
// never trusted on its own: settle() re-checks with OnePay's status API.
onepayRouter.post(
  '/callback',
  wrap(async (req, res) => {
    const b = req.body || {};
    const tx = await findTx({ transactionId: b.transaction_id, additional: b.additional_data });
    if (!tx) {
      console.warn('[onepay] callback for unknown transaction', String(b.transaction_id || '').slice(0, 64));
      return res.status(200).json({ ok: false, reason: 'unknown transaction' });
    }
    await query('UPDATE gateway_transactions SET raw_callback = $2, updated_at = now() WHERE id = $1', [tx.id, JSON.stringify(b).slice(0, 20000)]);
    const r = await settle(tx, { callbackStatus: b.status, statusMessage: b.status_message ? String(b.status_message).slice(0, 300) : undefined });
    res.json({ ok: true, status: r.status });
  })
);

// GET /api/onepay/return?ref=<our reference>  (transaction_redirect_url)
// The buyer lands here after OnePay. Verify, then send them to the right page.
onepayRouter.get(
  '/return',
  wrap(async (req, res) => {
    const tx = (await query('SELECT * FROM gateway_transactions WHERE reference = $1', [String(req.query.ref || '')])).rows[0];
    if (!tx) return res.redirect(302, '/');
    const r = await settle(tx).catch(() => ({ status: tx.status }));
    const outcome = r.status === 'PAID' ? 'success' : (r.status === 'FAILED' || r.status === 'CANCELLED' ? 'failed' : 'pending');
    if (tx.kind === 'SUBSCRIPTION') return res.redirect(302, `/dashboard/subscription?payment=${outcome}&ref=${encodeURIComponent(tx.reference)}`);
    // Shop order: back to the buyer's private order page.
    const o = (await query(
      `SELECT o.code, o.public_token, s.slug FROM orders o JOIN stores s ON s.business_id = o.business_id WHERE o.id = $1`,
      [tx.order_id]
    )).rows[0];
    if (!o) return res.redirect(302, '/');
    res.redirect(302, `/store/order?s=${encodeURIComponent(o.slug)}&o=${encodeURIComponent(o.code)}&k=${o.public_token}&payment=${outcome}`);
  })
);
