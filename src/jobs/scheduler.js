// In-process scheduler (on by default; set ENABLE_SCHEDULER=false to turn off and
// rely on Railway Cron services instead). Checks every 5 minutes:
//   - daily job   from 07:00 Sri Lanka time (subscription lifecycle, trial reminders)
//   - weekly jobs from 08:00 Sri Lanka time on Mondays (weekly seller summary)
// Each job claims its period in job_runs, so running this on several instances or
// alongside Railway Cron is safe: every period runs once.
import { slNow, runDaily, runWeekly } from './runner.js';

const EVERY_MS = 5 * 60 * 1000;
export const DAILY_HOUR_SL = 7;
export const WEEKLY_HOUR_SL = 8; // Monday morning

async function tick() {
  const t = slNow();
  const hour = t.getUTCHours();
  try {
    if (hour >= DAILY_HOUR_SL) {
      const r = await runDaily();
      if (!r.skipped) console.log('[jobs] daily lifecycle:', r);
    }
    if (t.getUTCDay() === 1 && hour >= WEEKLY_HOUR_SL) {
      for (const r of await runWeekly()) if (!r.skipped) console.log('[jobs] weekly:', r);
    }
  } catch (e) {
    console.error('[jobs] scheduler tick failed:', e.message);
  }
}

export function startScheduler() {
  if (process.env.ENABLE_SCHEDULER === 'false') {
    console.log('[jobs] in-process scheduler disabled (ENABLE_SCHEDULER=false)');
    return null;
  }
  setTimeout(tick, 30 * 1000);
  const h = setInterval(tick, EVERY_MS);
  h.unref();
  console.log('[jobs] scheduler on: daily 07:00 SLT, weekly Monday 08:00 SLT');
  return h;
}
