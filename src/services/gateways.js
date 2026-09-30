// Sellers' own payment gateways (Shop settings > Payment gateways).
//
// GATEWAYS is the generic slot: to add a provider, add an entry with its credential
// fields and, when its checkout is implemented, `checkout: true` plus an adapter.
// Credentials are encrypted at rest (services/secrets.js) and never sent to browsers.
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { encryptJson, decryptJson, mask } from './secrets.js';
import { compliance } from './policies.js';
import { hasFeature } from './plan.js';
import { registerKind, CALLBACK_PATH } from './cardPayments.js';
import { queueNotification, templates } from './notifications.js';

const BASE = (config.publicBaseUrl || '').replace(/\/$/, '');

export const GATEWAYS = {
  onepay: {
    label: 'OnePay',
    website: 'https://www.onepay.lk',
    checkout: true,
    fields: [
      { key: 'appId', label: 'App ID', required: true, secret: false },
      { key: 'hashSalt', label: 'Hash salt', required: true, secret: true },
      { key: 'appToken', label: 'App token (only if OnePay gave you one)', required: false, secret: true },
    ],
  },
  payhere: {
    label: 'PayHere',
    website: 'https://www.payhere.lk',
    // Credentials can be saved now; checkout is not built yet (no PayHere spec was
    // provided), so PayHere alone never turns card payments on.
    checkout: false,
    fields: [
      { key: 'merchantId', label: 'Merchant ID', required: true, secret: false },
      { key: 'merchantSecret', label: 'Merchant secret', required: true, secret: true },
    ],
  },
};

async function rows(businessId) {
  return (await query('SELECT * FROM store_gateways WHERE business_id = $1', [businessId])).rows;
}

// What the settings screen shows: never the secrets themselves.
export async function listGateways(businessId) {
  const saved = Object.fromEntries((await rows(businessId)).map((r) => [r.provider, r]));
  return Object.entries(GATEWAYS).map(([provider, g]) => {
    const r = saved[provider];
    return {
      provider,
      label: g.label,
      website: g.website,
      checkoutSupported: g.checkout,
      enabled: !!(r && r.enabled),
      mode: (r && r.mode) || 'sandbox',
      configured: !!(r && r.credentials_enc),
      fields: g.fields.map((f) => ({ key: f.key, label: f.label, required: f.required, secret: f.secret, hint: r && r.meta ? r.meta[f.key] || '' : '' })),
      updatedAt: r ? r.updated_at : null,
    };
  });
}

export async function saveGateway(businessId, provider, { enabled, mode, credentials }) {
  const g = GATEWAYS[provider];
  if (!g) throw Object.assign(new Error('Unknown payment gateway.'), { status: 404 });
  const cur = (await query('SELECT * FROM store_gateways WHERE business_id = $1 AND provider = $2', [businessId, provider])).rows[0];
  let creds = cur && cur.credentials_enc ? decryptJson(cur.credentials_enc) : {};
  const meta = { ...(cur ? cur.meta : {}) };
  if (credentials && typeof credentials === 'object') {
    for (const f of g.fields) {
      const v = credentials[f.key];
      if (v === undefined || v === null || String(v).trim() === '') continue; // blank = keep existing
      const val = String(v).trim().slice(0, 500);
      creds[f.key] = val;
      meta[f.key] = f.secret ? mask(val) : (val.length > 8 ? mask(val) : val);
    }
  }
  const missing = g.fields.filter((f) => f.required && !creds[f.key]).map((f) => f.label);
  if (enabled && missing.length) throw Object.assign(new Error(`Add your ${missing.join(' and ')} before turning ${g.label} on.`), { status: 400 });
  await query(
    `INSERT INTO store_gateways (business_id, provider, enabled, mode, credentials_enc, meta, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (business_id, provider) DO UPDATE SET enabled=EXCLUDED.enabled, mode=EXCLUDED.mode,
       credentials_enc=EXCLUDED.credentials_enc, meta=EXCLUDED.meta, updated_at=now()`,
    [businessId, provider, !!enabled, mode === 'live' ? 'live' : 'sandbox', Object.keys(creds).length ? encryptJson(creds) : null, JSON.stringify(meta)]
  );
}

// The shop's OnePay credentials for server-side use only.
export async function shopOnePayCreds(businessId) {
  const r = (await query(`SELECT * FROM store_gateways WHERE business_id = $1 AND provider = 'onepay'`, [businessId])).rows[0];
  if (!r || !r.credentials_enc) return null;
  const c = decryptJson(r.credentials_enc);
  if (!c.appId || !c.hashSalt) return null;
  return { appId: c.appId, salt: c.hashSalt, appToken: c.appToken || '', mode: r.mode, enabled: r.enabled };
}

// Card payments show at checkout ONLY when: the plan allows it, a gateway with a
// working checkout is enabled and configured, and all 5 compliance items are done.
export async function cardAvailability(businessId) {
  const reasons = [];
  if (!(await hasFeature(businessId, 'card_payments'))) reasons.push('Your plan does not include card payments.');
  const op = await shopOnePayCreds(businessId);
  if (!op || !op.enabled) reasons.push('Turn on OnePay with your OnePay credentials.');
  const c = await compliance(businessId);
  if (!c.complete) reasons.push(`Finish your policy pages and contact details (${c.doneCount} of 5 done).`);
  return { available: reasons.length === 0, reasons, provider: 'onepay', mode: op ? op.mode : null, compliance: c };
}

export const gatewayUrls = () => ({ callbackUrl: BASE + CALLBACK_PATH, redirectUrl: BASE + '/api/onepay/return' });

// ---- Shop order payments: how they settle -----------------------------------------
// Put stock back for an order whose card payment never completed.
async function restock(client, orderId) {
  const items = (await client.query('SELECT product_id, name, qty FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL', [orderId])).rows;
  for (const it of items) {
    const p = (await client.query('SELECT id, name, variants FROM products WHERE id = $1 FOR UPDATE', [it.product_id])).rows[0];
    if (!p) continue;
    const vs = Array.isArray(p.variants) ? p.variants : [];
    const v = vs.find((x) => `${p.name} (${x.label})` === it.name);
    if (v) {
      const next = vs.map((x) => (x === v ? { ...x, stock: Number(x.stock || 0) + it.qty } : x));
      await client.query('UPDATE products SET variants=$2, stock=$3 WHERE id=$1', [p.id, JSON.stringify(next), next.reduce((n, x) => n + Number(x.stock || 0), 0)]);
    } else {
      await client.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [p.id, it.qty]);
    }
  }
}

registerKind('ORDER', {
  creds: async (tx) => shopOnePayCreds(tx.business_id),
  onPaid: async (client, tx) => {
    const o = (await client.query(`UPDATE orders SET payment_status='PAID', paid_on=$2 WHERE id=$1 AND COALESCE(payment_status,'') <> 'PAID' RETURNING *`, [tx.order_id, tx.paid_on || new Date()])).rows[0];
    if (!o) return;
    const shop = (await client.query(
      `SELECT s.name, s.slug, s.phone, s.whatsapp, s.address, COALESCE(NULLIF(s.contact_email, ''), b.email) AS email FROM stores s JOIN businesses b ON b.id = s.business_id WHERE s.business_id = $1`,
      [o.business_id]
    )).rows[0];
    const items = (await client.query('SELECT name, qty, price FROM order_items WHERE order_id=$1', [o.id])).rows;
    await queueNotification({ businessId: o.business_id, recipient: shop.email, dedupeKey: `ORDER_PAID_OWNER:${o.id}`, ...templates.orderPaidOwner(shop, o, tx) }, client);
    if (o.customer_email) await queueNotification({ businessId: o.business_id, recipient: o.customer_email, dedupeKey: `ORDER_PAID_BUYER:${o.id}`, ...templates.orderPaidBuyer(shop, o, items, tx) }, client);
  },
  onFailed: async (client, tx, status) => {
    // The buyer never paid: cancel the order and return the stock.
    const o = (await client.query(
      `UPDATE orders SET payment_status=$2, status=CASE WHEN status='PENDING' THEN 'CANCELLED' ELSE status END
        WHERE id=$1 AND COALESCE(payment_status,'') NOT IN ('PAID','REFUNDED') RETURNING *`,
      [tx.order_id, status]
    )).rows[0];
    if (o && o.status === 'CANCELLED') {
      await restock(client, o.id);
      await client.query(`INSERT INTO order_status_history (order_id, status, note) VALUES ($1,'CANCELLED',$2)`, [o.id, 'Card payment not completed']);
    }
  },
});
