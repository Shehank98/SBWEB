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
import { runWeeklySummary } from '../services/weeklySummary.js';

export { slNow, slDate, slIsoWeek } from '../utils/time.js';
import { slDate, slIsoWeek } from '../utils/time.js';

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

// Weekly jobs (Monday 08:00 Sri Lanka time).
const weeklyJobs = [{ name: 'weekly-summary', fn: () => runWeeklySummary() }];
export function registerWeekly(name, fn) { weeklyJobs.push({ name, fn }); }
export async function runWeekly(opts) {
  const period = slIsoWeek();
  const out = [];
  for (const j of weeklyJobs) out.push(await once(j.name, period, j.fn, opts));
  return out;
}
