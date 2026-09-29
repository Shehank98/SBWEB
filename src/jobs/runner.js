// Scheduled jobs with exactly-once-per-period semantics.
//
// Each job claims its period (a Sri Lanka calendar date for daily jobs, an ISO week
// for weekly ones) in job_runs before doing any work. Whoever claims first runs it;
// everyone else skips. That makes it safe to trigger the same job from a Railway
// Cron service AND the in-process scheduler, across restarts and multiple instances.
// A claim that never finished (crash) can be re-claimed after an hour; every email
// the jobs queue also carries its own dedupe key as a second safety net.
import { query } from '../db/pool.js';
import { runLifecycle } from '../services/subscription.js';
import { cancelStaleCheckouts } from '../services/cardPayments.js';

const SL_OFFSET_MS = 5.5 * 3600 * 1000; // Asia/Colombo is UTC+05:30 all year (no DST)

// "Wall clock" in Sri Lanka as a Date whose UTC fields read as local SL time.
export function slNow(now = new Date()) { return new Date(now.getTime() + SL_OFFSET_MS); }
export function slDate(now = new Date()) { return slNow(now).toISOString().slice(0, 10); }

// ISO-8601 week id for the SL date, e.g. "2026-W40".
export function slIsoWeek(now = new Date()) {
  const d = slNow(now);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function claimRun(job, period) {
  const { rows } = await query(
    `INSERT INTO job_runs (job, period) VALUES ($1, $2)
     ON CONFLICT (job, period) DO UPDATE SET started_at = now()
       WHERE job_runs.finished_at IS NULL AND job_runs.started_at < now() - INTERVAL '1 hour'
     RETURNING job`,
    [job, period]
  );
  return rows.length > 0;
}

export async function finishRun(job, period, summary) {
  await query('UPDATE job_runs SET finished_at = now(), summary = $3 WHERE job = $1 AND period = $2', [job, period, JSON.stringify(summary || {})]);
}

async function once(job, period, fn, { force = false } = {}) {
  if (!force && !(await claimRun(job, period))) return { skipped: true, job, period };
  const summary = await fn();
  if (!force) await finishRun(job, period, summary);
  return { job, period, ...summary };
}

// Daily: subscription lifecycle + trial reminders/expiry.
export function runDaily(opts) {
  return once('daily-lifecycle', slDate(), async () => ({ ...(await runLifecycle()), ...(await cancelStaleCheckouts()) }), opts);
}

// Registry of weekly jobs (filled in by later features, e.g. the Monday summary).
const weeklyJobs = [];
export function registerWeekly(name, fn) { weeklyJobs.push({ name, fn }); }
export async function runWeekly(opts) {
  const period = slIsoWeek();
  const out = [];
  for (const j of weeklyJobs) out.push(await once(j.name, period, j.fn, opts));
  return out;
}
