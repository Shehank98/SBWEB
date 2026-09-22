// Remove the seeded demo shops (the sample businesses/orders/payments that appear
// in the admin panel) from a database that was already seeded — e.g. before going
// live. Pricing plans, the platform admin, and any REAL shops are left untouched.
//
// Deleting a business cascades to its stores, users, products, orders, payments,
// subscriptions, categories and coupons (all FKs are ON DELETE CASCADE).
//
// Run:  node src/db/purge-demo.js         (lists what it will remove, then removes)
//       node src/db/purge-demo.js --dry   (lists only, deletes nothing)
import { pool, query } from './pool.js';

// The slugs the seeder creates. A demo shop is only removed when BOTH its store
// slug is in this list AND its owner's email is "<slug>@sidadiya.lk" — so a real shop
// that happens to pick a similar slug can never be caught by this purge.
const DEMO_SLUGS = [
  'abc-fashion', 'nimal-bakery', 'kandy-mobile', 'green-leaf', 'lanka-handloom',
  'old-books', 'ceylon-spice', 'pet-palace', 'coastal-cakes', 'fit-gear',
];

async function purge() {
  const dry = process.argv.includes('--dry');
  const { rows } = await query(
    `SELECT b.id, b.name, s.slug
       FROM businesses b
       JOIN stores s ON s.business_id = b.id
      WHERE s.slug = ANY($1)
        AND EXISTS (SELECT 1 FROM users u WHERE u.business_id = b.id AND lower(u.email) = lower(s.slug || '@sidadiya.lk'))`,
    [DEMO_SLUGS]
  );

  if (!rows.length) {
    console.log('[purge-demo] No seeded demo shops found. Nothing to remove.');
    return;
  }
  console.log(`[purge-demo] ${dry ? 'Would remove' : 'Removing'} ${rows.length} demo shop(s):`);
  for (const r of rows) console.log(`  - ${r.name} (${r.slug})`);
  if (dry) { console.log('[purge-demo] Dry run — no changes made.'); return; }

  const ids = rows.map((r) => r.id);
  const res = await query('DELETE FROM businesses WHERE id = ANY($1)', [ids]);
  console.log(`[purge-demo] Removed ${res.rowCount} demo shop(s) and all their data. Plans and admin kept.`);
}

purge()
  .then(() => pool.end())
  .catch((err) => { console.error('[purge-demo] failed:', err); process.exit(1); });
