// Daily subscription + trial lifecycle job. Run on Railway with a Cron schedule:
//   node src/jobs/subscriptions.js          (claims today's Sri Lanka date; a second
//                                           run the same day is a no-op)
//   node src/jobs/subscriptions.js --force  (run again regardless, e.g. for testing;
//                                           emails are still de-duplicated)
// Advances ACTIVE -> EXPIRING -> GRACE_PERIOD -> SUSPENDED by expiry date, sends
// trial reminders (day 10, day 13) and expires trials (TRIAL -> TRIAL_EXPIRED).
import { pool } from '../db/pool.js';
import { runDaily } from './runner.js';

async function main() {
  const summary = await runDaily({ force: process.argv.includes('--force') });
  console.log('[job] daily lifecycle:', summary);
  await pool.end();
}

main().catch((err) => {
  console.error('[job] daily lifecycle failed:', err);
  process.exit(1);
});
