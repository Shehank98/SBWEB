// Buyer-facing order links (tracking, 30-day receipt), the status timeline,
// Sri Lankan phone normalisation for WhatsApp, and waybill readiness checks.
import { config } from '../config.js';

const BASE = (config.publicBaseUrl || '').replace(/\/$/, '');

// Public tracking page: /track/<order code>?k=<public_token> (no login).
export const trackPath = (o) => `/track/${encodeURIComponent(o.code)}?k=${o.public_token}`;
export const trackUrl = (o) => BASE + trackPath(o);
// Digital receipt: /receipt/<receipt_token>, valid until orders.receipt_expires_at.
export const receiptPath = (o) => `/receipt/${o.receipt_token}`;
export const receiptUrl = (o) => BASE + receiptPath(o);

export const RECEIPT_DAYS = 30;
export const receiptExpired = (o, now = new Date()) => !o.receipt_expires_at || new Date(o.receipt_expires_at) <= now;

// 07XXXXXXXX / 7XXXXXXXX / +94 7X... / 0094... -> 947XXXXXXXX. Returns '' when it
// is not a Sri Lankan mobile number (landlines cannot receive WhatsApp reliably).
export function toWhatsAppIntl(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0094')) d = d.slice(2);
  if (d.startsWith('94')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return /^7\d{8}$/.test(d) ? '94' + d : '';
}

// Placed, Confirmed, Packed, Shipped, Delivered (+ Cancelled). Each step gets the
// time it was reached, from order_status_history (latest entry per status).
export const TIMELINE = [
  { key: 'PLACED', label: 'Placed', statuses: ['PENDING'] },
  { key: 'CONFIRMED', label: 'Confirmed', statuses: ['CONFIRMED'] },
  { key: 'PACKED', label: 'Packed', statuses: ['PROCESSING', 'READY_TO_SHIP'] },
  { key: 'SHIPPED', label: 'Shipped', statuses: ['SHIPPED'] },
  { key: 'DELIVERED', label: 'Delivered', statuses: ['DELIVERED'] },
];
const RANK = { PENDING: 0, CONFIRMED: 1, PROCESSING: 2, READY_TO_SHIP: 2, SHIPPED: 3, DELIVERED: 4 };

export function timeline(order, history) {
  const at = {};
  for (const h of history || []) at[h.status] = h.created_at;
  const cancelled = order.status === 'CANCELLED' || order.status === 'REFUNDED';
  // How far the order got: its current status, or (if cancelled) the furthest
  // status reached before that.
  let reached = RANK[order.status];
  if (reached === undefined) reached = Math.max(0, ...Object.keys(at).map((s) => RANK[s] ?? 0));
  const steps = TIMELINE.map((s, i) => {
    const when = s.key === 'PLACED' ? order.created_at : s.statuses.map((x) => at[x]).filter(Boolean).sort().pop() || (s.key === 'SHIPPED' ? order.shipped_at : null);
    return { key: s.key, label: s.label, done: i <= reached, at: i <= reached ? when || null : null };
  });
  if (cancelled) {
    // Keep what happened, then end the line with "Cancelled".
    const kept = steps.filter((s) => s.done);
    kept.push({ key: 'CANCELLED', label: order.status === 'REFUNDED' ? 'Cancelled and refunded' : 'Cancelled', done: true, at: at[order.status] || null });
    return kept;
  }
  return steps;
}

// A payment method that is collected on delivery (so the waybill shows COD).
export const isCod = (o) => /cash|cod/i.test(String(o.payment_method || '')) && o.payment_status !== 'PAID';
export const isPickup = (o) => /pickup/i.test(String(o.delivery_method || '')) || String(o.city || '').toLowerCase() === 'pickup';

// Fields a courier needs before a waybill can be printed. Returns the list of
// missing ones (empty = ready).
export function waybillMissing(o, items) {
  const miss = [];
  if (!String(o.customer_name || '').trim()) miss.push('Customer name');
  if (!/^(?:\+?94|0)?7\d{8}$|^(?:\+?94|0)?[1-9]\d{8}$/.test(String(o.phone || '').replace(/[\s-]/g, ''))) miss.push('Phone number');
  if (isPickup(o)) miss.push('Delivery address (this is a pickup order)');
  else {
    if (String(o.address || '').trim().length < 5) miss.push('Full address');
    if (!String(o.city || '').trim()) miss.push('City');
  }
  if (!items || !items.length) miss.push('Items');
  if (!String(o.payment_method || '').trim()) miss.push('Payment method');
  if (isCod(o) && !(Number(o.total) > 0)) miss.push('COD amount');
  if (o.status === 'CANCELLED' || o.status === 'REFUNDED') miss.push('Order is cancelled');
  return miss;
}
