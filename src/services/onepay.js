// OnePay (onepay.lk) Redirection API client. One module for both the platform's
// subscription payments (credentials from env) and each shop's checkout (the shop's
// own encrypted credentials); only `creds` differs.
//
// Implemented from the integration spec supplied by the product owner (verified by
// them against docs.onepay.lk; the docs site itself was not reachable from the build
// environment):
//   1. hash = SHA256(app_id + currency + amount + HASH_SALT), plain concatenation, no
//      separators; amount is a 2-decimal string identical in the hash and the body.
//   2. POST {base}/v3/checkout/link/ with app_id, amount, currency, hash, reference,
//      customer_first_name, customer_last_name, customer_phone_number (E.164),
//      customer_email, transaction_redirect_url (HTTPS), additionalData (string).
//   3. Save ipg_transaction_id, redirect the buyer to redirect_url (same window).
//   4. Webhook: JSON { transaction_id, status (1 = success), status_message,
//      additional_data }. NOT signed, never trusted on its own.
//   5. Verify server-side: POST {base}/v3/transaction/status/ { app_id,
//      onepay_transaction_id }. Paid only when status is true AND amount + currency
//      match our records.
//   6. HTTP 429 = rate limited: retry with exponential backoff.
// Points the spec leaves open are handled defensively and listed in the README
// ("OnePay: open questions").
import { createHash } from 'crypto';

export const ONEPAY_LIVE_BASE = 'https://api.onepay.lk';

export function formatAmount(n) {
  const v = Math.round(Number(n) * 100) / 100;
  if (!Number.isFinite(v) || v <= 0) throw new Error('Invalid amount');
  return v.toFixed(2);
}

export function makeHash(appId, currency, amount, salt) {
  return createHash('sha256').update(`${appId}${currency}${amount}${salt}`).digest('hex');
}

// Sri Lankan number -> E.164 (+94XXXXXXXXX). Returns null when it cannot be parsed.
export function toE164(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  let m;
  if ((m = d.match(/^\+94(\d{9})$/))) return '+94' + m[1];
  if ((m = d.match(/^94(\d{9})$/))) return '+94' + m[1];
  if ((m = d.match(/^0(\d{9})$/))) return '+94' + m[1];
  if ((m = d.match(/^(7\d{8})$/))) return '+94' + m[1];
  return null;
}

export function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Customer', last: '-' };
  return { first: parts[0], last: parts.slice(1).join(' ') || parts[0] };
}

// Platform credentials (Sidadiya's own OnePay merchant account) from env.
export function platformCreds() {
  const appId = process.env.ONEPAY_APP_ID || '';
  const salt = process.env.ONEPAY_HASH_SALT || '';
  const mode = process.env.ONEPAY_MODE === 'live' ? 'live' : 'sandbox';
  return appId && salt ? { appId, salt, mode, appToken: process.env.ONEPAY_APP_TOKEN || '' } : null;
}

// Base URL. Live is api.onepay.lk. The sandbox base URL is shown in the OnePay
// merchant dashboard, so it is configurable (ONEPAY_SANDBOX_API_BASE); without it,
// sandbox credentials are sent to the same host (sandbox and live keys differ).
export function apiBase(mode) {
  if (process.env.ONEPAY_API_BASE) return process.env.ONEPAY_API_BASE.replace(/\/$/, '');
  if (mode !== 'live' && process.env.ONEPAY_SANDBOX_API_BASE) return process.env.ONEPAY_SANDBOX_API_BASE.replace(/\/$/, '');
  return ONEPAY_LIVE_BASE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(creds, path, body) {
  const url = apiBase(creds.mode) + path;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  // Optional: some OnePay apps issue an app token for an Authorization header. The
  // spec does not require one, so it is only sent when configured.
  if (creds.appToken) headers.Authorization = creds.appToken;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`OnePay ${res.status}`);
        await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
        continue;
      }
      return { status: res.status, data };
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('OnePay request failed');
}

// Find a key anywhere in a (small) JSON response: responses may wrap fields in
// `data` / `data.gateway`, which the spec does not pin down.
export function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/**
 * Create a checkout link.
 * @returns {{ ipgTransactionId: string, redirectUrl: string, raw: object, amount: string }}
 */
export async function createCheckout(creds, { amount, reference, customer, redirectUrl, additionalData }) {
  const currency = 'LKR';
  const amt = formatAmount(amount);
  const phone = toE164(customer.phone);
  if (!phone) throw new Error('A valid Sri Lankan mobile number is needed for card payments.');
  const body = {
    app_id: creds.appId,
    amount: amt,
    currency,
    hash: makeHash(creds.appId, currency, amt, creds.salt),
    reference,
    customer_first_name: customer.firstName,
    customer_last_name: customer.lastName,
    customer_phone_number: phone,
    customer_email: customer.email,
    transaction_redirect_url: redirectUrl,
    additionalData: typeof additionalData === 'string' ? additionalData : JSON.stringify(additionalData || {}),
  };
  const r = await post(creds, '/v3/checkout/link/', body);
  const ipg = findKey(r.data, 'ipg_transaction_id');
  const link = findKey(r.data, 'redirect_url');
  if (r.status >= 400 || !ipg || !link) {
    const msg = (r.data && (r.data.message || findKey(r.data, 'message'))) || `HTTP ${r.status}`;
    const err = new Error(`OnePay checkout failed: ${msg}`);
    err.raw = r.data;
    throw err;
  }
  return { ipgTransactionId: String(ipg), redirectUrl: String(link), raw: r.data, amount: amt };
}

/**
 * Ask OnePay for the authoritative state of a transaction.
 * @returns {{ paid: boolean, amount: number|null, currency: string|null, paidOn: string|null, raw: object }}
 */
export async function getTransactionStatus(creds, ipgTransactionId) {
  const r = await post(creds, '/v3/transaction/status/', { app_id: creds.appId, onepay_transaction_id: ipgTransactionId });
  const d = (r.data && typeof r.data.data === 'object' && r.data.data) || r.data || {};
  // "status is true" per the spec. Accept the obvious equivalents, never a bare HTTP code.
  const st = d.status !== undefined ? d.status : findKey(d, 'transaction_status');
  const paid = r.status < 400 && (st === true || st === 'true' || st === 1 || st === '1' || /^(success|paid|completed)$/i.test(String(st)));
  const amount = d.amount !== undefined ? Number(d.amount) : (findKey(d, 'amount') !== undefined ? Number(findKey(d, 'amount')) : null);
  const currency = d.currency || findKey(d, 'currency') || null;
  const paidOn = d.paid_on || findKey(d, 'paid_on') || null;
  return { paid, amount: Number.isFinite(amount) ? amount : null, currency, paidOn, raw: r.data };
}

// The "only mark paid when" rule in one place.
export function verifyMatches(status, expectedAmount, expectedCurrency = 'LKR') {
  if (!status.paid) return { ok: false, reason: 'not paid' };
  if (status.amount == null || Math.abs(status.amount - Number(expectedAmount)) > 0.001) return { ok: false, reason: `amount mismatch (${status.amount} vs ${expectedAmount})` };
  if (status.currency && String(status.currency).toUpperCase() !== expectedCurrency) return { ok: false, reason: `currency mismatch (${status.currency})` };
  return { ok: true, warn: status.currency ? null : 'currency not present in status response' };
}
