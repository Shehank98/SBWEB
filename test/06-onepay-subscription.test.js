// Needs the app started against the mock:
//   ONEPAY_API_BASE=http://localhost:4455 ONEPAY_APP_ID=test-app ONEPAY_HASH_SALT=test-salt
// Skips itself when the app is not configured that way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, BASE, registerShop, outbox } from './helpers.js';
import { startOnePayMock } from './onepay-mock.js';
import { makeHash, formatAmount, toE164, verifyMatches } from '../src/services/onepay.js';

let mock;
before(async () => { mock = await startOnePayMock(); });
after(async () => { await mock.close(); await db.end(); });

test('hash and field formats follow the spec', () => {
  assert.equal(formatAmount(1399), '1399.00');
  assert.equal(formatAmount('999.5'), '999.50');
  // SHA256("APP" + "LKR" + "1399.00" + "SALT"), computed independently.
  assert.equal(makeHash('APP', 'LKR', '1399.00', 'SALT'), '51df6c8e92ec4e9ce04bd52ad212cf7ea7e6ff78ee3a5677fe9ff70612f99482');
  assert.equal(toE164('077 123 4567'), '+94771234567');
  assert.equal(toE164('+94 77 123 4567'), '+94771234567');
  assert.equal(toE164('12345'), null);
  assert.equal(verifyMatches({ paid: true, amount: 1399, currency: 'LKR' }, '1399.00').ok, true);
  assert.equal(verifyMatches({ paid: true, amount: 1000, currency: 'LKR' }, '1399.00').ok, false);
  assert.equal(verifyMatches({ paid: true, amount: 1399, currency: 'USD' }, '1399.00').ok, false);
  assert.equal(verifyMatches({ paid: false, amount: 1399, currency: 'LKR' }, '1399.00').ok, false);
});

async function configured(token) {
  const s = await api('GET', '/api/dashboard/subscription', { token });
  return s.data.cardPayments && s.data.cardPayments.enabled;
}

test('subscription card payment: activates once, receipt once, duplicates are no-ops', async (t) => {
  const shop = await registerShop();
  if (!(await configured(shop.token))) return t.skip('app not started with the OnePay mock env');
  const start = await api('POST', '/api/dashboard/subscription/onepay', { token: shop.token, body: { planId: 'business' } });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  assert.match(start.data.redirectUrl, /\/pay\/IPG/);
  const ipg = start.data.redirectUrl.split('/pay/')[1];
  const sent = mock.calls.find((c) => c.path === '/v3/checkout/link/' && c.body.reference === start.data.reference).body;
  assert.equal(sent.amount, '1399.00');
  assert.equal(sent.customer_phone_number, '+94771234567');
  assert.match(sent.transaction_redirect_url, /\/api\/onepay\/return\?ref=SUB-/);
  assert.equal(JSON.parse(sent.additionalData).shop_id, shop.bizId);

  // Unsigned webhook claiming success while OnePay says "not paid": ignored.
  let cb = await api('POST', '/api/onepay/callback', { body: { transaction_id: ipg, status: 1, status_message: 'Success', additional_data: sent.additionalData } });
  assert.equal(cb.data.status, 'PENDING');
  assert.equal((await api('GET', '/api/dashboard/access', { token: shop.token })).data.status, 'TRIAL');

  // Now OnePay reports it paid: the webhook settles it.
  mock.set(ipg, { outcome: 'paid' });
  cb = await api('POST', '/api/onepay/callback', { body: { transaction_id: ipg, status: 1, status_message: 'Success', additional_data: sent.additionalData } });
  assert.equal(cb.data.status, 'PAID');
  // Duplicates: another webhook + the return page.
  await Promise.all([
    api('POST', '/api/onepay/callback', { body: { transaction_id: ipg, status: 1 } }),
    api('POST', '/api/onepay/callback', { body: { transaction_id: ipg, status: 1 } }),
  ]);
  const ret = await fetch(`${BASE}/api/onepay/return?ref=${start.data.reference}`, { redirect: 'manual' });
  assert.equal(ret.status, 302);
  assert.match(ret.headers.get('location'), /\/dashboard\/subscription\?payment=success/);

  const acc = await api('GET', '/api/dashboard/access', { token: shop.token });
  assert.equal(acc.data.status, 'ACTIVE');
  assert.equal(acc.data.plan.id, 'business');
  // Trial days kept: paid period starts when the trial ends (~14 + 30 days).
  assert.ok((new Date(acc.data.expiryDate) - Date.now()) / 86400000 > 40);
  const subs = await db.query("SELECT COUNT(*) n FROM subscriptions WHERE business_id=$1 AND status='ACTIVE'", [shop.bizId]);
  assert.equal(Number(subs.rows[0].n), 1);
  assert.equal((await outbox(shop.bizId, 'SUBSCRIPTION_RECEIPT')).length, 1);
  const sub = await api('GET', '/api/dashboard/subscription', { token: shop.token });
  assert.equal(sub.data.payments.filter((p) => p.status === 'APPROVED').length, 1);
});

test('failed, cancelled and tampered-amount payments never activate', async (t) => {
  const shop = await registerShop();
  if (!(await configured(shop.token))) return t.skip('app not started with the OnePay mock env');
  // Failed via webhook.
  let s = await api('POST', '/api/dashboard/subscription/onepay', { token: shop.token, body: { planId: 'pro' } });
  let ipg = s.data.redirectUrl.split('/pay/')[1];
  const cb = await api('POST', '/api/onepay/callback', { body: { transaction_id: ipg, status: 0, status_message: 'Declined' } });
  assert.equal(cb.data.status, 'FAILED');
  let ret = await fetch(`${BASE}/api/onepay/return?ref=${s.data.reference}`, { redirect: 'manual' });
  assert.match(ret.headers.get('location'), /payment=failed/);
  // Buyer cancelled on OnePay's page: return shows pending, nothing activates.
  s = await api('POST', '/api/dashboard/subscription/onepay', { token: shop.token, body: { planId: 'pro' } });
  ret = await fetch(`${BASE}/api/onepay/return?ref=${s.data.reference}`, { redirect: 'manual' });
  assert.match(ret.headers.get('location'), /payment=pending/);
  // OnePay says paid but for a different amount: rejected.
  s = await api('POST', '/api/dashboard/subscription/onepay', { token: shop.token, body: { planId: 'pro' } });
  ipg = s.data.redirectUrl.split('/pay/')[1];
  mock.set(ipg, { outcome: 'paid', overrideAmount: '1.00' });
  const cb2 = await api('POST', '/api/onepay/callback', { body: { transaction_id: ipg, status: 1 } });
  assert.equal(cb2.data.status, 'PENDING');
  assert.equal((await api('GET', '/api/dashboard/access', { token: shop.token })).data.status, 'TRIAL');
  // Unknown transaction: 200 (no retries) but nothing happens.
  assert.equal((await api('POST', '/api/onepay/callback', { body: { transaction_id: 'NOPE', status: 1 } })).data.ok, false);
});
