import { query } from '../db/pool.js';
import { config } from '../config.js';

const BASE = (config.publicBaseUrl || '').replace(/\/$/, '');
const storeUrl = (slug) => `${BASE}/store/${slug}`;
const loginUrl = () => `${BASE}/login`;
const dashUrl = (page = '') => `${BASE}/dashboard/${page}`;

// Writes a row to the notifications outbox. A Google Apps Script (or any worker)
// polls `WHERE status = 'PENDING'`, sends the email, then marks it SENT.
// This decouples the API from the mail transport, exactly as the plan describes.
export async function queueNotification({ businessId = null, type, recipient, subject, message, data = {} }, client) {
  const runner = client || { query };
  if (!recipient) return null;
  const { rows } = await runner.query(
    `INSERT INTO notifications (business_id, type, recipient, subject, message, data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [businessId, type, recipient, subject, message, JSON.stringify(data || {})]
  );
  return rows[0];
}

// Each template returns { type, subject, message, data }. `message` is the plain-text
// fallback; `data` carries structured fields the email template renders (links, totals).
export const templates = {
  registered: (business) => ({
    type: 'REGISTERED',
    subject: 'We received your Kade application',
    message: `Thank you for registering ${business.name}. Your application is under review and we will email you once it is approved.`,
    data: { heading: 'Application received', business: business.name, planName: business.planName || '', loginUrl: loginUrl() },
  }),
  approved: (business, store) => ({
    type: 'APPROVED',
    subject: 'Your online store is ready 🎉',
    message: `Good news! ${business.name} has been approved. Your store is live at ${storeUrl(store.slug)}. Log in at ${loginUrl()} to add products and start selling.`,
    data: {
      heading: 'Your store is live',
      business: business.name,
      storeName: store.name || business.name,
      slug: store.slug,
      storeUrl: storeUrl(store.slug),
      loginUrl: loginUrl(),
      email: business.email,
      planName: business.planName || '',
    },
  }),
  rejected: (business, reason) => ({
    type: 'REJECTED',
    subject: 'Update on your Kade application',
    message: `We could not approve ${business.name} yet. Reason: ${reason || 'Please contact support.'} You can reply to this email to resolve it.`,
    data: { heading: 'Application needs attention', business: business.name, reason: reason || '' },
  }),
  newOrder: (business, order) => ({
    type: 'NEW_ORDER',
    subject: `New order ${order.code} — ${business.name}`,
    message: `${business.name} received a new order ${order.code} from ${order.customer_name} for a total of Rs. ${order.total}. Log in to your dashboard to manage it.`,
    data: {
      heading: 'New order received',
      business: business.name,
      orderCode: order.code,
      customer: order.customer_name,
      phone: order.phone,
      total: order.total,
      items: order.items || [],
      ordersUrl: dashUrl('orders.html'),
    },
  }),
  orderStatus: (business, order, status) => ({
    type: 'ORDER_STATUS',
    subject: `Your order ${order.code} is ${status.toLowerCase()}`,
    message: `${business.name}: your order ${order.code} is now ${status}.`,
    data: { heading: 'Order update', business: business.name, orderCode: order.code, status },
  }),
  expiryReminder: (business, days) => ({
    type: 'EXPIRY_REMINDER',
    subject: `Your subscription expires in ${days} day${days === 1 ? '' : 's'}`,
    message: `${business.name}'s subscription expires in ${days} day${days === 1 ? '' : 's'}. Renew now to keep your store online.`,
    data: { heading: 'Renewal reminder', business: business.name, days, expiry: business.expiry || '', renewUrl: dashUrl('subscription.html') },
  }),
  suspended: (business) => ({
    type: 'SUSPENDED',
    subject: 'Your store has been paused',
    message: `${business.name}'s subscription has lapsed and the store is now suspended. Your products and orders are safe — renew to bring the store back online.`,
    data: { heading: 'Store paused', business: business.name, renewUrl: dashUrl('subscription.html') },
  }),
};
