import { query } from '../db/pool.js';
import { queueNotification, templates } from './notifications.js';
import { trialDays } from './settings.js';

// Days-from-expiry thresholds that drive the lifecycle. Tunable without code
// changes elsewhere.
export const EXPIRING_WITHIN_DAYS = 7; // ACTIVE -> EXPIRING
export const GRACE_DAYS = 5; // days after expiry before SUSPENDED

const DAY = 86400000;

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }

// Start the free trial for a freshly created business: Starter features for
// `trial_days` (admin setting, default 14). The subscription row mirrors the trial
// window so plan lookups (limits, feature flags) resolve to Starter.
export async function startTrial(client, businessId) {
  const days = await trialDays();
  const start = new Date();
  const ends = new Date(start.getTime() + days * DAY);
  await client.query(
    `UPDATE businesses SET status = 'TRIAL', trial_started_at = $2, trial_ends_at = $3 WHERE id = $1`,
    [businessId, start, ends]
  );
  await client.query(
    `INSERT INTO subscriptions (business_id, plan_id, status, start_date, expiry_date)
     VALUES ($1, 'starter', 'TRIAL', $2, $3)`,
    [businessId, start, ends]
  );
  return { start, ends, days };
}

// Activate a business after payment approval: set dates from the plan duration and
// flip business + subscription to ACTIVE. (Kept for the registration approval flow.)
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

// Apply a PAID plan period (card or approved bank transfer). Unlike
// activateSubscription, remaining time is never lost: the new period starts at the
// later of today and the current paid expiry / trial end. Paying during the trial
// therefore keeps the rest of the free days. Must run inside a transaction.
export async function applyPaidPlan(client, businessId, planId) {
  const plan = (await client.query('SELECT * FROM plans WHERE id = $1', [planId])).rows[0];
  if (!plan) throw new Error(`Unknown plan ${planId}`);
  const biz = (await client.query('SELECT status, trial_ends_at FROM businesses WHERE id = $1 FOR UPDATE', [businessId])).rows[0];
  const sub = (
    await client.query(`SELECT * FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`, [businessId])
  ).rows[0];

  const now = new Date();
  let base = now;
  if (biz && biz.status === 'TRIAL' && biz.trial_ends_at && new Date(biz.trial_ends_at) > now) base = new Date(biz.trial_ends_at);
  else if (sub && sub.status !== 'TRIAL' && sub.expiry_date && new Date(sub.expiry_date) > now
    && ['ACTIVE', 'EXPIRING', 'GRACE_PERIOD'].includes(biz && biz.status)) base = new Date(sub.expiry_date);
  const expiry = addDays(base, plan.duration_days || 30);

  if (sub && sub.status !== 'TRIAL') {
    await client.query(
      `UPDATE subscriptions SET status = 'ACTIVE', plan_id = $2, start_date = COALESCE(start_date, $3), expiry_date = $4 WHERE id = $1`,
      [sub.id, planId, now, expiry]
    );
  } else {
    // First paid period (from a trial or a lapsed trial): a fresh subscription row
    // keeps the trial row as history.
    await client.query(
      `INSERT INTO subscriptions (business_id, plan_id, status, start_date, expiry_date) VALUES ($1, $2, 'ACTIVE', $3, $4)`,
      [businessId, planId, base, expiry]
    );
  }
  await client.query(`UPDATE businesses SET status = 'ACTIVE' WHERE id = $1`, [businessId]);
  return { start: now, expiry, plan };
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

// Extend a running (or expired) trial by N days. Reopens an expired trial.
export async function extendTrial(client, businessId, days) {
  const biz = (await client.query('SELECT trial_ends_at FROM businesses WHERE id = $1', [businessId])).rows[0];
  const now = new Date();
  const base = biz && biz.trial_ends_at && new Date(biz.trial_ends_at) > now ? new Date(biz.trial_ends_at) : now;
  const ends = new Date(base.getTime() + days * DAY);
  await client.query(
    `UPDATE businesses SET status = 'TRIAL', trial_ends_at = $2, trial_started_at = COALESCE(trial_started_at, now()) WHERE id = $1`,
    [businessId, ends]
  );
  const sub = (await client.query(`SELECT id, status FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`, [businessId])).rows[0];
  if (sub && ['TRIAL', 'EXPIRED'].includes(sub.status)) {
    await client.query(`UPDATE subscriptions SET status = 'TRIAL', expiry_date = $2 WHERE id = $1`, [sub.id, ends]);
  } else {
    await client.query(
      `INSERT INTO subscriptions (business_id, plan_id, status, start_date, expiry_date) VALUES ($1, 'starter', 'TRIAL', now(), $2)`,
      [businessId, ends]
    );
  }
  return ends;
}

// Trial lifecycle, part of the daily job. For a T-day trial (T = 14 by default):
//   day T-4 (day 10) -> first reminder, day T-1 (day 13) -> last reminder,
//   end reached      -> TRIAL_EXPIRED (storefront locked, payment wall) + email.
// Every email carries a dedupe key, so re-running the job never double-sends.
export async function runTrialLifecycle(now = new Date()) {
  const summary = { trialReminders: 0, trialsExpired: 0 };
  const T = await trialDays();
  const { rows } = await query(
    `SELECT id, name, email, trial_started_at, trial_ends_at FROM businesses WHERE status = 'TRIAL' AND trial_ends_at IS NOT NULL`
  );
  for (const b of rows) {
    const ends = new Date(b.trial_ends_at);
    const started = b.trial_started_at ? new Date(b.trial_started_at) : new Date(ends.getTime() - T * DAY);
    const day = Math.floor((now - started) / DAY) + 1;
    const daysLeft = Math.max(0, Math.ceil((ends - now) / DAY));
    const info = { name: b.name, endsOn: isoDate(ends) };

    if (ends <= now) {
      await query(`UPDATE businesses SET status = 'TRIAL_EXPIRED' WHERE id = $1 AND status = 'TRIAL'`, [b.id]);
      await query(`UPDATE subscriptions SET status = 'EXPIRED' WHERE business_id = $1 AND status = 'TRIAL'`, [b.id]);
      await queueNotification({ businessId: b.id, recipient: b.email, dedupeKey: `TRIAL_EXPIRED:${b.id}:${isoDate(ends)}`, ...templates.trialExpired(info) });
      summary.trialsExpired += 1;
      continue;
    }
    // Last reminder takes precedence if the job was down on the first reminder day.
    let key = null;
    if (day >= T - 1) key = 'D13';
    else if (day >= T - 4) key = 'D10';
    if (key) {
      const row = await queueNotification({
        businessId: b.id,
        recipient: b.email,
        dedupeKey: `TRIAL_${key}:${b.id}:${isoDate(ends)}`,
        ...templates.trialReminder(info, daysLeft),
      });
      if (row) summary.trialReminders += 1;
    }
  }
  return summary;
}

// The daily job: move ACTIVE stores through EXPIRING -> GRACE_PERIOD -> SUSPENDED
// based on their expiry date, queue reminder/suspension emails, and run the trial
// lifecycle.
export async function runLifecycle() {
  const summary = { expiring: 0, grace: 0, suspended: 0, reminders: 0 };

  // Businesses that are in a lifecycle-managed state.
  const { rows: subs } = await query(
    `SELECT DISTINCT ON (s.business_id) s.business_id, s.expiry_date, b.name, b.email, b.status
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
      WHERE b.status IN ('ACTIVE','EXPIRING','GRACE_PERIOD')
        AND s.expiry_date IS NOT NULL
      ORDER BY s.business_id, s.created_at DESC`
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
        await queueNotification({ businessId: s.business_id, recipient: s.email, dedupeKey: `SUSPENDED:${s.business_id}:${isoDate(expiry)}`, ...templates.suspended({ name: s.name }) });
      } else if (next === 'GRACE_PERIOD') {
        summary.grace += 1;
      } else if (next === 'EXPIRING') {
        summary.expiring += 1;
      }
    }

    // Reminder emails at 7 and 3 days out and on expiry day.
    if ([7, 3, 1].includes(daysLeft)) {
      const row = await queueNotification({
        businessId: s.business_id,
        recipient: s.email,
        dedupeKey: `EXPIRY:${s.business_id}:${isoDate(expiry)}:${daysLeft}`,
        ...templates.expiryReminder({ name: s.name, expiry: isoDate(expiry) }, daysLeft),
      });
      if (row) summary.reminders += 1;
    }
  }
  Object.assign(summary, await runTrialLifecycle());
  return summary;
}
