import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop, adminToken, outbox } from './helpers.js';
import { runTrialLifecycle } from '../src/services/subscription.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

test('public plans expose editable prices, compare-at price and flags', async () => {
  const r = await api('GET', '/api/plans');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.plans.map((p) => [p.id, p]));
  assert.ok(byId.starter && byId.business && byId.pro);
  assert.equal(typeof byId.starter.price, 'number');
  assert.ok('compareAtPrice' in byId.starter);
  assert.equal(byId.starter.flags.coupons, false);
  assert.equal(byId.pro.flags.staff, true);
});

test('signup starts a 14-day Starter trial, signs the owner in and opens the store', async () => {
  const shop = await registerShop();
  assert.ok(shop.token);
  assert.equal(shop.user.businessStatus, 'TRIAL');
  const acc = await api('GET', '/api/dashboard/access', { token: shop.token });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.status, 'TRIAL');
  assert.equal(acc.data.locked, false);
  assert.equal(acc.data.plan.id, 'starter');
  assert.ok(acc.data.trial.daysLeft >= 13 && acc.data.trial.daysLeft <= 14);
  const store = await api('GET', `/api/store/${shop.slug}`);
  assert.equal(store.data.available, true);
  const welcome = await outbox(shop.bizId, 'TRIAL_STARTED');
  assert.equal(welcome.length, 1);
  // Starter during the trial: Business/Pro features are gated.
  const cp = await api('GET', '/api/dashboard/coupons', { token: shop.token });
  assert.equal(cp.status, 400);
  assert.match(cp.data.error, /Business and Pro/);
  const staff = await api('GET', '/api/dashboard/staff', { token: shop.token });
  assert.equal(staff.status, 400);
});

test('trial reminders on day 10 and 13 are sent once each, then the trial expires and locks', async () => {
  const shop = await registerShop();
  const day = 86400000;
  const setDay = (n) => db.query(
    'UPDATE businesses SET trial_started_at = $2, trial_ends_at = $3 WHERE id = $1',
    [shop.bizId, new Date(Date.now() - (n - 1) * day - 60000), new Date(Date.now() - (n - 1) * day - 60000 + 14 * day)]
  );
  await setDay(10);
  await runTrialLifecycle();
  await runTrialLifecycle(); // re-run: no duplicate
  let rem = await outbox(shop.bizId, 'TRIAL_REMINDER');
  assert.equal(rem.length, 1);
  await setDay(13);
  await runTrialLifecycle();
  rem = await outbox(shop.bizId, 'TRIAL_REMINDER');
  assert.equal(rem.length, 2);
  assert.match(rem[1].subject, /ends in 2 days/); // day 13 of 14: today and tomorrow remain

  await setDay(15); // past the end
  await runTrialLifecycle();
  await runTrialLifecycle();
  assert.equal((await outbox(shop.bizId, 'TRIAL_EXPIRED')).length, 1);
  const acc = await api('GET', '/api/dashboard/access', { token: shop.token });
  assert.equal(acc.data.status, 'TRIAL_EXPIRED');
  assert.equal(acc.data.locked, true);

  // Storefront locked for buyers, data intact.
  const store = await api('GET', `/api/store/${shop.slug}`);
  assert.equal(store.data.available, false);
  // Payment wall: catalogue/orders blocked, subscription page open.
  assert.equal((await api('GET', '/api/products', { token: shop.token })).status, 402);
  assert.equal((await api('GET', '/api/dashboard/orders', { token: shop.token })).status, 402);
  const sub = await api('GET', '/api/dashboard/subscription', { token: shop.token });
  assert.equal(sub.status, 200);
  assert.equal(sub.data.preferredPlanId, 'business');

  // Bank-transfer fallback: seller submits, admin approves -> ACTIVE, unlocked.
  const fd = new FormData(); fd.append('planId', 'business'); fd.append('method', 'Bank transfer'); fd.append('ref', 'TXN1');
  assert.equal((await api('POST', '/api/dashboard/subscription/renew', { token: shop.token, form: fd })).status, 201);
  const admin = await adminToken();
  const pays = await api('GET', '/api/admin/payments?status=PENDING', { token: admin });
  const mine = pays.data.payments.find((p) => p.business === shop.fields.bizName);
  assert.ok(mine);
  assert.equal((await api('POST', `/api/admin/payments/${mine.id}/approve`, { token: admin })).status, 200);
  assert.equal((await api('POST', `/api/admin/payments/${mine.id}/approve`, { token: admin })).status, 200); // idempotent
  const acc2 = await api('GET', '/api/dashboard/access', { token: shop.token });
  assert.equal(acc2.data.status, 'ACTIVE');
  assert.equal(acc2.data.plan.id, 'business');
  assert.equal((await api('GET', '/api/dashboard/coupons', { token: shop.token })).status, 200);
  assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.available, true);
});

test('admin edits plan price and feature flags; flags gate features immediately', async () => {
  const admin = await adminToken();
  const list = await api('GET', '/api/admin/plans', { token: admin });
  assert.equal(list.status, 200);
  assert.ok(list.data.featureDefs.find((d) => d.key === 'coupons'));
  const starter = list.data.plans.find((p) => p.id === 'starter');
  const shop = await registerShop();
  try {
    const up = await api('PUT', '/api/admin/plans/starter', { token: admin, body: { flags: { coupons: true }, price: starter.price, compareAtPrice: starter.compareAtPrice } });
    assert.equal(up.status, 200);
    assert.equal((await api('GET', '/api/dashboard/coupons', { token: shop.token })).status, 200);
    const bad = await api('PUT', '/api/admin/plans/starter', { token: admin, body: { compareAtPrice: 1 } });
    assert.equal(bad.status, 400);
  } finally {
    await api('PUT', '/api/admin/plans/starter', { token: admin, body: { flags: { coupons: false } } });
  }
});

test('existing (pre-upgrade) shops keep working unchanged', async () => {
  const r = await api('GET', '/api/store/abc-fashion');
  if (r.status === 404) return; // demo data not seeded in this database
  assert.equal(r.data.available, true);
  assert.ok(r.data.products.length > 0);
});
