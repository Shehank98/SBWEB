// Runs on server start so a fresh deploy just works:
//  1) apply schema.sql (the idempotent baseline), then any pending versioned migrations
//  2) if the database has no businesses yet, seed the demo data (unless SEED_DEMO=false)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from './pool.js';
import { seed, seedPlans } from './seed.js';
import { runMigrations } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function bootstrapDb() {
  // 1) Schema — always safe to re-run.
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
  console.log('[db] schema ensured');

  // 1b) Versioned migrations (src/db/migrations) — each applied once, in order.
  await runMigrations();

  // 2) Pricing plans — essential reference data, always ensured (idempotent upsert).
  await seedPlans(query);
  console.log('[db] plans ensured');

  // 3) Demo shops (the sample businesses/orders/payments seen in the admin panel)
  //    are OPT-IN so production launches clean. Set SEED_DEMO=true to load them into
  //    an empty database (handy for local development).
  if (process.env.SEED_DEMO === 'true') {
    const empty = Number((await query('SELECT COUNT(*) n FROM businesses')).rows[0].n) === 0;
    if (empty) {
      console.log('[db] SEED_DEMO=true and no businesses — seeding demo shops');
      await seed();
    }
  }
}
