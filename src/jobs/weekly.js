// Weekly seller summary job. Railway Cron (Monday 08:00 Sri Lanka = 02:30 UTC):
//   node src/jobs/weekly.js          (claims this ISO week; a second run is a no-op)
//   node src/jobs/weekly.js --force  (run again; emails are still de-duplicated)
import { pool } from '../db/pool.js';
import { runWeekly } from './runner.js';

runWeekly({ force: process.argv.includes('--force') })
  .then((r) => { console.log('[job] weekly:', r); return pool.end(); })
  .catch((e) => { console.error('[job] weekly failed:', e); process.exit(1); });
