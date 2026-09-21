import { query } from '../db/pool.js';

// Writes a row to the notifications outbox. A Google Apps Script (or any worker)
// polls `WHERE status = 'PENDING'`, sends the email, then marks it SENT.
// This decouples the API from the mail transport, exactly as the plan describes.
export async function queueNotification({ businessId = null, type, recipient, subject, message }, client) {
  const runner = client || { query };
  if (!recipient) return null;
  const { rows } = await runner.query(
    `INSERT INTO notifications (business_id, type, recipient, subject, message)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [businessId, type, recipient, subject, message]
  );
  return rows[0];
}

export const templates = {
  registered: (business) => ({
    type: 'REGISTERED',
    subject: 'We received your Kade application',
    message: `Thank you for registering ${business.name}. Your application is under review and we will email you once it is approved.`,
  }),
  approved: (business, store) => ({
    type: 'APPROVED',
    subject: 'Your online store is ready',
    message: `Good news! ${business.name} has been approved. Your store is live at /store/${store.slug}. Log in to add products and start selling.`,
  }),
  rejected: (business, reason) => ({
    type: 'REJECTED',
    subject: 'Update on your Kade application',
    message: `We could not approve ${business.name} yet. Reason: ${reason || 'Please contact support.'} You can reply to this email to resolve it.`,
  }),
  newOrder: (business, order) => ({
    type: 'NEW_ORDER',
    subject: `New order ${order.code} received`,
    message: `${business.name} received a new order ${order.code} from ${order.customer_name} for a total of Rs. ${order.total}. Log in to your dashboard to manage it.`,
  }),
  expiryReminder: (business, days) => ({
    type: 'EXPIRY_REMINDER',
    subject: `Your subscription expires in ${days} day${days === 1 ? '' : 's'}`,
    message: `${business.name}'s subscription expires in ${days} day${days === 1 ? '' : 's'}. Renew now to keep your store online.`,
  }),
  suspended: (business) => ({
    type: 'SUSPENDED',
    subject: 'Your store has been suspended',
    message: `${business.name}'s subscription has lapsed and the store is now suspended. Your products and orders are safe — renew to bring the store back online.`,
  }),
};
