// Daily subscription lifecycle job. Run on Railway with a Cron schedule:
//   node src/jobs/subscriptions.js
// It advances ACTIVE -> EXPIRING -> GRACE_PERIOD -> SUSPENDED by expiry date and
// queues reminder/suspension emails into the notifications outbox.
import { pool } from '../db/pool.js';
import { runLifecycle } from '../services/subscription.js';

async function main() {
  const summary = await runLifecycle();
  console.log('[job] subscription lifecycle:', summary);
  await pool.end();
}

main().catch((err) => {
  console.error('[job] subscription lifecycle failed:', err);
  process.exit(1);
});
