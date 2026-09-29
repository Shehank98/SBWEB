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
  // ---- Card payment receipts ----
  subscriptionReceipt: (business, r) => ({
    type: 'SUBSCRIPTION_RECEIPT',
    subject: `Receipt: ${r.plan} plan, Rs. ${Number(r.amount).toLocaleString('en-US')}`,
    message: `Thank you. We received Rs. ${r.amount} for the ${r.plan} plan for ${business.name}. Reference ${r.reference} (OnePay ${r.transactionId}). Paid on ${r.paidOn}. Your plan is active until ${r.validUntil}.`,
    data: { heading: 'Payment received', business: business.name, plan: r.plan, amount: r.amount, reference: r.reference, transactionId: r.transactionId, paidOn: r.paidOn, validUntil: r.validUntil, method: 'Card (OnePay)', planUrl: dashUrl('subscription') },
  }),

  // Weekly seller summary (Monday morning).
  weeklySummary: (shop, d) => {
    const rs = (n) => `Rs. ${Math.round(n).toLocaleString('en-US')}`;
    const lines = [
      `${shop.name}: your week ${d.periodStart} to ${d.periodEnd}`,
      `Sales: ${rs(d.revenue)} from ${d.orders} order${d.orders === 1 ? '' : 's'}${d.revenueChangePct != null ? ` (${d.revenueChangePct >= 0 ? '+' : ''}${d.revenueChangePct}% vs the week before)` : ''}`,
      d.topProducts.length ? `Top products: ${d.topProducts.map((p) => `${p.name} (${p.units})`).join(', ')}` : 'No products sold this week.',
      d.trafficSources.length ? `Where visitors came from: ${d.trafficSources.map((t) => `${t.source} ${t.sessions}`).join(', ')}` : 'No store visits recorded this week. Share your store link!',
    ];
    return {
      type: 'WEEKLY_SUMMARY',
      subject: `Your week at ${shop.name}: ${rs(d.revenue)} from ${d.orders} order${d.orders === 1 ? '' : 's'}`,
      message: lines.join('\n'),
      data: { heading: 'Your weekly summary', business: shop.name, ...d, storeUrl: shop.slug ? storeUrl(shop.slug) : '', reportsUrl: dashUrl('reports'), settingsUrl: dashUrl('settings#weekly') },
    };
  },
  // Sent to the CUSTOMER when the shop adds courier tracking and marks it shipped.
  orderShippedTracking: (shop, order, items) => ({
    type: 'ORDER_SHIPPED',
    subject: `Your ${shop.name} order ${order.code} is on the way`,
    message: `Good news. Your ${shop.name} order ${order.code} has shipped with ${order.courier_name}. Tracking number: ${order.tracking_number}.${order.tracking_url ? ' Track it: ' + order.tracking_url : ''}`,
    data: {
      ...orderEmailData(shop, order, items),
      heading: 'Your order is on the way',
      intro: `Your order from ${shop.name} has shipped with ${order.courier_name}.`,
      courier: order.courier_name,
      trackingNumber: order.tracking_number,
      trackingUrl: order.tracking_url || '',
      statusUrl: shop.slug ? `${BASE}/store/order?s=${encodeURIComponent(shop.slug)}&o=${encodeURIComponent(order.code)}&k=${order.public_token}` : '',
    },
  }),
  // Card-paid shop orders.
  orderPaidOwner: (shop, order, tx) => ({
    type: 'ORDER_PAID',
    subject: `Card payment received: ${order.code} (Rs. ${Number(order.total).toLocaleString('en-US')})`,
    message: `${order.customer_name} paid Rs. ${order.total} by card for order ${order.code}. OnePay transaction ${tx.ipg_transaction_id}. The money is paid out to your bank by OnePay.`,
    data: { heading: 'Card payment received', business: shop.name, orderCode: order.code, customer: order.customer_name, total: order.total, transactionId: tx.ipg_transaction_id, ordersUrl: dashUrl('orders') },
  }),
  orderPaidBuyer: (shop, order, items, tx) => ({
    type: 'ORDER_PAYMENT_RECEIPT',
    subject: `Payment received for your ${shop.name} order ${order.code}`,
    message: `Thank you. We received your card payment of Rs. ${order.total} for order ${order.code} at ${shop.name}. OnePay reference ${tx.ipg_transaction_id}.`,
    data: {
      ...orderEmailData(shop, order, items),
      heading: 'Payment received',
      intro: `Thank you for paying by card. ${shop.name} will confirm your order soon.`,
      transactionId: tx.ipg_transaction_id,
      statusUrl: shop.slug ? `${BASE}/store/order?s=${encodeURIComponent(shop.slug)}&o=${encodeURIComponent(order.code)}&k=${order.public_token}` : '',
    },
  }),

  // ---- Seller verification ----
  verificationSubmitted: (business) => ({
    type: 'VERIFICATION_SUBMITTED',
    subject: `Verification to review: ${business.name}`,
    message: `${business.name} uploaded an ID copy and address proof. Review them in the admin panel: ${BASE}/admin/shop?id=${business.id}`,
    data: { heading: 'New verification to review', business: business.name, reviewUrl: `${BASE}/admin/shop?id=${business.id}` },
  }),
  verificationApproved: (business, store) => ({
    type: 'VERIFICATION_APPROVED',
    subject: 'Your business is verified ✓',
    message: `Good news! ${business.name} is now a Verified Sri Lankan Business on Sidadiya. The verified seal now shows on your store and product pages.`,
    data: { heading: 'Your business is verified', business: business.name, storeUrl: store && store.slug ? storeUrl(store.slug) : '' },
  }),
  verificationRejected: (business, reason) => ({
    type: 'VERIFICATION_REJECTED',
    subject: 'We could not verify your business yet',
    message: `We could not verify ${business.name} yet. Reason: ${reason}. Please upload clearer documents in Store settings and submit again.`,
    data: { heading: 'Verification needs attention', business: business.name, reason, settingsUrl: dashUrl('settings#verification') },
  }),

  // ---- Free trial ----
  trialStarted: (business, store, trial) => ({
    type: 'TRIAL_STARTED',
    subject: `Your ${trial.days}-day free trial has started 🎉`,
    message: `Welcome to Sidadiya! ${business.name} is live at ${storeUrl(store.slug)}. Your free trial (Starter features) runs until ${trial.endsOn}. Log in at ${loginUrl()} to add products.`,
    data: {
      heading: 'Your store is live',
      business: business.name,
      storeName: store.name || business.name,
      slug: store.slug,
      storeUrl: storeUrl(store.slug),
      loginUrl: loginUrl(),
      dashboardUrl: dashUrl(''),
      email: business.email,
      trialDays: trial.days,
      trialEndsOn: trial.endsOn,
      planUrl: dashUrl('subscription'),
    },
  }),
  trialReminder: (business, daysLeft) => ({
    type: 'TRIAL_REMINDER',
    subject: daysLeft <= 1
      ? 'Your free trial ends tomorrow'
      : `Your free trial ends in ${daysLeft} days`,
    message: `${business.name}'s free trial ends on ${business.endsOn}. Choose a plan so your store stays open. Your products, orders and settings are kept.`,
    data: { heading: 'Your free trial is ending', business: business.name, daysLeft, trialEndsOn: business.endsOn, planUrl: dashUrl('subscription') },
  }),
  trialExpired: (business) => ({
    type: 'TRIAL_EXPIRED',
    subject: 'Your free trial has ended',
    message: `${business.name}'s free trial has ended, so the store is closed to buyers for now. Everything you set up is saved. Choose a plan to reopen instantly.`,
    data: { heading: 'Your free trial has ended', business: business.name, trialEndsOn: business.endsOn, planUrl: dashUrl('subscription') },
  }),
  suspended: (business) => ({
    type: 'SUSPENDED',
    subject: 'Your store has been paused',
    message: `${business.name}'s subscription has lapsed and the store is now suspended. Your products and orders are safe. Renew to bring the store back online.`,
    data: { heading: 'Store paused', business: business.name, renewUrl: dashUrl('subscription') },
  }),
};
