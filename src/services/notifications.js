import { query } from '../db/pool.js';
import { config } from '../config.js';

const BASE = (config.publicBaseUrl || '').replace(/\/$/, '');
const storeUrl = (slug) => `${BASE}/store/${slug}`;
const loginUrl = () => `${BASE}/login`;
const dashUrl = (page = '') => `${BASE}/dashboard/${page}`;

// Writes a row to the notifications outbox. A Google Apps Script (or any worker)
// polls `WHERE status = 'PENDING'`, sends the email, then marks it SENT.
// This decouples the API from the mail transport, exactly as the plan describes.
export async function queueNotification({ businessId = null, type, recipient, subject, message, data = {}, dedupeKey = null }, client) {
  const runner = client || { query };
  if (!recipient) return null;
  // When a dedupeKey is given, ON CONFLICT DO NOTHING makes the enqueue idempotent:
  // a repeated status change (or a race between two writers) inserts nothing the
  // second time. Rows without a key skip the unique index entirely.
  const { rows } = await runner.query(
    `INSERT INTO notifications (business_id, type, recipient, subject, message, data, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [businessId, type, recipient, subject, message, JSON.stringify(data || {}), dedupeKey]
  );
  return rows[0] || null;
}

// Build the structured payload the Apps Script order emails render: shop name,
// order summary lines, totals and the delivery-or-pickup block plus shop contact.
function orderEmailData(shop, order, items) {
  const method = String(order.delivery_method || '').toLowerCase();
  const isPickup = method.includes('pickup') || String(order.city || '').toLowerCase() === 'pickup';
  return {
    business: shop.name,
    storeName: shop.name,
    orderCode: order.code,
    customer: order.customer_name,
    items: (items || []).map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
    subtotal: order.subtotal,
    discount: order.discount || 0,
    deliveryFee: order.delivery_fee || 0,
    total: order.total,
    fulfilment: isPickup ? 'pickup' : 'delivery',
    address: order.address || '',
    city: isPickup ? '' : (order.city || ''),
    district: order.district || '',
    payment: order.payment_method || '',
    shopPhone: shop.phone || '',
    shopWhatsapp: shop.whatsapp || '',
    shopAddress: shop.address || '',
    storeUrl: shop.slug ? storeUrl(shop.slug) : '',
  };
}

// Each template returns { type, subject, message, data }. `message` is the plain-text
// fallback; `data` carries structured fields the email template renders (links, totals).
export const templates = {
  registered: (business) => ({
    type: 'REGISTERED',
    subject: 'We received your Sidadiya application',
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
    subject: 'Update on your Sidadiya application',
    message: `We could not approve ${business.name} yet. Reason: ${reason || 'Please contact support.'} You can reply to this email to resolve it.`,
    data: { heading: 'Application needs attention', business: business.name, reason: reason || '' },
  }),
  newOrder: (business, order) => ({
    type: 'NEW_ORDER',
    subject: `New order ${order.code} for ${business.name}`,
    message: `${business.name} received a new order ${order.code} from ${order.customer_name} for a total of Rs. ${order.total}. Log in to your dashboard to manage it.`,
    data: {
      heading: 'New order received',
      business: business.name,
      orderCode: order.code,
      customer: order.customer_name,
      phone: order.phone,
      total: order.total,
      items: order.items || [],
      ordersUrl: dashUrl('orders'),
    },
  }),
  // Sent to the CUSTOMER when they place an order (shop name included).
  orderConfirmation: (store, order, items) => ({
    type: 'ORDER_CONFIRMATION',
    subject: `Your ${store.name} order ${order.code} is confirmed`,
    message: `Thank you for ordering from ${store.name}. Your order ${order.code} totals Rs. ${order.total}. We will let you know when it is on the way.`,
    data: {
      heading: 'Thank you for your order',
      business: store.name,
      storeName: store.name,
      orderCode: order.code,
      customer: order.customer_name,
      total: order.total,
      items: items || [],
      storeUrl: store.slug ? storeUrl(store.slug) : '',
    },
  }),
  orderStatus: (business, order, status) => ({
    type: 'ORDER_STATUS',
    subject: `Your order ${order.code} is ${status.toLowerCase()}`,
    message: `${business.name}: your order ${order.code} is now ${status}.`,
    data: { heading: 'Order update', business: business.name, orderCode: order.code, status },
  }),
  // Sent to the CUSTOMER when the shop marks the order confirmed.
  orderConfirmed: (shop, order, items) => ({
    type: 'ORDER_CONFIRMED',
    subject: `Your ${shop.name} order ${order.code} is confirmed`,
    message: `Thank you for ordering from ${shop.name}. Your order ${order.code} is confirmed. Total Rs. ${order.total}. We will let you know when it is on the way.`,
    data: {
      ...orderEmailData(shop, order, items),
      heading: 'Your order is confirmed',
      intro: `Thanks for shopping with ${shop.name}. We have confirmed your order and started getting it ready.`,
    },
  }),
  // Sent to the CUSTOMER when the shop marks the order shipped.
  orderShipped: (shop, order, items) => ({
    type: 'ORDER_SHIPPED',
    subject: `Your ${shop.name} order ${order.code} is on the way`,
    message: `Good news. Your ${shop.name} order ${order.code} has shipped. Total Rs. ${order.total}.`,
    data: {
      ...orderEmailData(shop, order, items),
      heading: 'Your order is on the way',
      intro: `Your order from ${shop.name} has left the shop and is on its way to you.`,
    },
  }),
  expiryReminder: (business, days) => ({
    type: 'EXPIRY_REMINDER',
    subject: `Your subscription expires in ${days} day${days === 1 ? '' : 's'}`,
    message: `${business.name}'s subscription expires in ${days} day${days === 1 ? '' : 's'}. Renew now to keep your store online.`,
    data: { heading: 'Renewal reminder', business: business.name, days, expiry: business.expiry || '', renewUrl: dashUrl('subscription') },
  }),
  suspended: (business) => ({
    type: 'SUSPENDED',
    subject: 'Your store has been paused',
    message: `${business.name}'s subscription has lapsed and the store is now suspended. Your products and orders are safe. Renew to bring the store back online.`,
    data: { heading: 'Store paused', business: business.name, renewUrl: dashUrl('subscription') },
  }),
};
