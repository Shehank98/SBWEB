import { query } from '../db/pool.js';
import { queueNotification, templates } from './notifications.js';

// Days-from-expiry thresholds that drive the lifecycle. Tunable without code
// changes elsewhere.
export const EXPIRING_WITHIN_DAYS = 7; // ACTIVE -> EXPIRING
export const GRACE_DAYS = 5; // days after expiry before SUSPENDED

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Activate a business after payment approval: set dates from the plan duration and
// flip business + subscription to ACTIVE.
export async function activateSubscription(client, businessId, planId) {
  const { rows: planRows } = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
  const plan = planRows[0];
  const duration = plan ? plan.duration_days : 30;
  const start = new Date();
  const expiry = addDays(start, duration);

  const { rows: subRows } = await client.query(
    `SELECT id FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [businessId]
  );
  if (subRows[0]) {
    await client.query(
      `UPDATE subscriptions SET status = 'ACTIVE', plan_id = $2, start_date = $3, expiry_date = $4 WHERE id = $1`,
      [subRows[0].id, planId, start, expiry]
    );
  } else {
    await client.query(
      `INSERT INTO subscriptions (business_id, plan_id, status, start_date, expiry_date)
       VALUES ($1, $2, 'ACTIVE', $3, $4)`,
      [businessId, planId, start, expiry]
    );
  }
  await client.query(`UPDATE businesses SET status = 'ACTIVE' WHERE id = $1`, [businessId]);
  return { start, expiry };
}

// Extend an active (or lapsed) subscription by N days from the later of today/expiry.
export async function extendSubscription(client, businessId, days) {
  const { rows } = await client.query(
    `SELECT id, expiry_date FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [businessId]
  );
  const sub = rows[0];
  const base = sub && sub.expiry_date && new Date(sub.expiry_date) > new Date()
    ? new Date(sub.expiry_date)
    : new Date();
  const expiry = addDays(base, days);
  if (sub) {
    await client.query(
      `UPDATE subscriptions SET status = 'ACTIVE', expiry_date = $2 WHERE id = $1`,
      [sub.id, expiry]
    );
  }
  await client.query(`UPDATE businesses SET status = 'ACTIVE' WHERE id = $1`, [businessId]);
  return expiry;
}

// The daily job: move ACTIVE stores through EXPIRING -> GRACE_PERIOD -> SUSPENDED
// based on their expiry date, and queue reminder/suspension emails.
export async function runLifecycle() {
  const summary = { expiring: 0, grace: 0, suspended: 0, reminders: 0 };

  // Businesses that are in a lifecycle-managed state.
  const { rows: subs } = await query(
    `SELECT s.business_id, s.expiry_date, b.name, b.email, b.status
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
      WHERE b.status IN ('ACTIVE','EXPIRING','GRACE_PERIOD')
        AND s.expiry_date IS NOT NULL`
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const s of subs) {
    const expiry = new Date(s.expiry_date);
    expiry.setHours(0, 0, 0, 0);
    const daysLeft = Math.round((expiry - today) / 86400000);

    let next = s.status;
    if (daysLeft < -GRACE_DAYS) next = 'SUSPENDED';
    else if (daysLeft < 0) next = 'GRACE_PERIOD';
    else if (daysLeft <= EXPIRING_WITHIN_DAYS) next = 'EXPIRING';
    else next = 'ACTIVE';

    if (next !== s.status) {
      await query('UPDATE businesses SET status = $2 WHERE id = $1', [s.business_id, next]);
      if (next === 'SUSPENDED') {
        summary.suspended += 1;
        await queueNotification({ businessId: s.business_id, recipient: s.email, ...templates.suspended({ name: s.name }) });
      } else if (next === 'GRACE_PERIOD') {
        summary.grace += 1;
      } else if (next === 'EXPIRING') {
        summary.expiring += 1;
      }
    }

    // Reminder emails at 7 and 3 days out and on expiry day.
    if ([7, 3, 1].includes(daysLeft)) {
      summary.reminders += 1;
      await queueNotification({
        businessId: s.business_id,
        recipient: s.email,
        ...templates.expiryReminder({ name: s.name }, daysLeft),
      });
    }
  }
  return summary;
}
