// Runs on server start so a fresh deploy just works:
//  1) apply schema.sql (idempotent — CREATE TABLE IF NOT EXISTS / ALTER … IF NOT EXISTS)
//  2) if the database has no businesses yet, seed the demo data (unless SEED_DEMO=false)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from './pool.js';
import { seed } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function bootstrapDb() {
  // 1) Schema — always safe to re-run.
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
  console.log('[db] schema ensured');

  // 2) Seed demo data only when the platform is empty.
  const empty = Number((await query('SELECT COUNT(*) n FROM businesses')).rows[0].n) === 0;
  if (empty && process.env.SEED_DEMO !== 'false') {
    console.log('[db] no businesses found — seeding demo data (set SEED_DEMO=false to disable)');
    await seed();
  }
}
