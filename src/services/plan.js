import { query } from '../db/pool.js';
import { HttpError } from '../utils/http.js';

// Business statuses in which the storefront is open to buyers.
export const LIVE_STATUSES = new Set(['ACTIVE', 'EXPIRING', 'GRACE_PERIOD', 'TRIAL']);
// Statuses that put the seller dashboard behind the payment wall. Data is untouched;
// only access is blocked until a plan is paid.
export const LOCKED_STATUSES = new Set(['TRIAL_EXPIRED', 'SUSPENDED']);

const DAY = 86400000;

// The business's current plan row (most recent subscription), or null.
export async function currentPlan(businessId) {
  return (
    await query(
      `SELECT pl.* FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [businessId]
    )
  ).rows[0] || null;
}

// A tier limit where NULL/undefined means "unlimited" (Infinity). Keeps the
// enforcement pattern in one place so categories, images and variants agree.
export function cap(value) {
  return value == null ? Infinity : Number(value);
}

// Trial facts for a business row (null when the shop is not on a trial).
export function trialInfo(biz, now = new Date()) {
  if (!biz || !biz.trial_ends_at) return null;
  const ends = new Date(biz.trial_ends_at);
  const started = biz.trial_started_at ? new Date(biz.trial_started_at) : null;
  return {
    active: biz.status === 'TRIAL' && ends > now,
    startedAt: started ? started.toISOString() : null,
    endsAt: ends.toISOString(),
    daysLeft: Math.max(0, Math.ceil((ends - now) / DAY)),
    // Day 1 is the signup day.
    day: started ? Math.floor((now - started) / DAY) + 1 : null,
  };
}

// Everything the dashboard needs to decide what to show: status, lock state, trial
// countdown, plan and its feature flags.
export async function businessAccess(businessId) {
  const biz = (
    await query(
      `SELECT id, status, trial_started_at, trial_ends_at, preferred_plan_id FROM businesses WHERE id = $1`,
      [businessId]
    )
  ).rows[0];
  if (!biz) return null;
  const sub = (
    await query(
      `SELECT s.status sub_status, s.expiry_date, pl.id, pl.name, pl.price, pl.feature_flags
         FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [businessId]
    )
  ).rows[0];
  const locked = LOCKED_STATUSES.has(biz.status);
  return {
    status: biz.status,
    locked,
    lockReason: locked ? biz.status : null,
    trial: trialInfo(biz),
    plan: sub ? { id: sub.id, name: sub.name, price: sub.price } : null,
    flags: sub ? sub.feature_flags || {} : {},
    expiryDate: sub && sub.expiry_date ? new Date(sub.expiry_date).toISOString().slice(0, 10) : null,
    preferredPlanId: biz.preferred_plan_id || null,
  };
}

export async function hasFeature(businessId, key) {
  const plan = await currentPlan(businessId);
  return !!(plan && plan.feature_flags && plan.feature_flags[key]);
}

// Throws a 400 with a friendly upsell message when the shop's plan lacks the feature.
// (400 rather than 403 keeps the existing frontend behaviour, which shows the message.)
export async function assertFeature(businessId, key, message) {
  if (!(await hasFeature(businessId, key))) throw new HttpError(400, message, { feature: key, upgrade: true });
}

// Express middleware form. Admin tokens (no business) pass through.
export function requireFeature(key, message) {
  return (req, _res, next) => {
    if (!req.user || !req.user.business_id) return next();
    assertFeature(req.user.business_id, key, message).then(() => next(), next);
  };
}

// Payment wall: blocks dashboard APIs for a locked shop except the ones needed to
// see the problem and pay. `allow` is a list of [method, regex] against req.path.
export function paywall(allow) {
  return (req, _res, next) => {
    if (!req.user || req.user.role === 'SUPER_ADMIN' || !req.user.business_id) return next();
    const ok = allow.some(([m, re]) => (m === '*' || m === req.method) && re.test(req.path));
    if (ok) return next();
    query('SELECT status FROM businesses WHERE id = $1', [req.user.business_id])
      .then(({ rows }) => {
        const st = rows[0] && rows[0].status;
        if (!LOCKED_STATUSES.has(st)) return next();
        const msg = st === 'TRIAL_EXPIRED'
          ? 'Your free trial has ended. Choose a plan to unlock your dashboard and reopen your store.'
          : 'Your store is paused. Renew your plan to unlock your dashboard and reopen your store.';
        next(new HttpError(402, msg, { code: 'PAYMENT_REQUIRED', status: st }));
      })
      .catch(next);
  };
}
