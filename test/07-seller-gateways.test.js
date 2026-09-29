import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, BASE, registerShop, outbox } from './helpers.js';
import { startOnePayMock } from './onepay-mock.js';

let mock;
before(async () => { mock = await startOnePayMock(); });
after(async () => { await mock.close(); await db.end(); });

async function compliantShop() {
  const shop = await registerShop();
  await api('PUT', '/api/dashboard/contact', { token: shop.token, body: { email: 'hi@shop.lk', phone: '0771234567', address: 'No. 24, Dalada Veediya, Kandy' } });
  for (const p of (await api('GET', '/api/dashboard/policies', { token: shop.token })).data.policies) {
    await api('PUT', `/api/dashboard/policies/${p.key}`, { token: shop.token, body: { content: p.content, publish: true } });
  }
  const fd = new FormData(); fd.append('name', 'Handloom Saree'); fd.append('price', '8500'); fd.append('stock', '5');
  shop.product = (await api('POST', '/api/products', { token: shop.token, form: fd })).data.product;
  return shop;
}
const order = (pid, extra = {}) => ({ customer: 'Nadeesha Perera', phone: '0771234567', address: '45 Temple Rd', city: 'Kandy', district: 'Kandy', acceptTerms: true, items: [{ pid, qty: 2 }], ...extra });

test('gateway credentials are encrypted, masked, and card needs gateway + compliance', async () => {
  const shop = await registerShop();
  let g = await api('GET', '/api/dashboard/gateways', { token: shop.token });
  assert.equal(g.status, 200);
  assert.deepEqual(g.data.gateways.map((x) => x.provider), ['onepay', 'payhere']);
  assert.equal(g.data.card.available, false);
  assert.match(g.data.urls.callbackUrl, /\/api\/onepay\/callback$/);
  assert.ok(g.data.guide.documents.length >= 6);
  assert.equal((await api('PUT', '/api/dashboard/gateways/onepay', { token: shop.token, body: { enabled: true } })).status, 400);
  const saved = await api('PUT', '/api/dashboard/gateways/onepay', { token: shop.token, body: { enabled: true, mode: 'sandbox', credentials: { appId: 'test-app', hashSalt: 'test-salt' } } });
  assert.equal(saved.status, 200);
  const txt = JSON.stringify(saved.data);
  assert.ok(!txt.includes('test-salt'), 'salt never returned');
  assert.equal(saved.data.gateways[0].fields.find((f) => f.key === 'hashSalt').hint, '••••salt');
  const { rows } = await db.query(`SELECT credentials_enc FROM store_gateways WHERE business_id=$1 AND provider='onepay'`, [shop.bizId]);
  assert.match(rows[0].credentials_enc, /^v1:/);
  assert.ok(!rows[0].credentials_enc.includes('test-salt'));
  // Blank on re-save keeps the existing secret.
  await api('PUT', '/api/dashboard/gateways/onepay', { token: shop.token, body: { enabled: true, mode: 'sandbox', credentials: { appId: '', hashSalt: '' } } });
  assert.equal((await api('GET', '/api/dashboard/gateways', { token: shop.token })).data.gateways[0].configured, true);
  // Still not compliant -> no card at checkout.
  assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.store.payments.card, false);
  // PayHere alone never turns card on (checkout not built).
  const ph = await api('PUT', '/api/dashboard/gateways/payhere', { token: shop.token, body: { enabled: true, credentials: { merchantId: '1211', merchantSecret: 'x' } } });
  assert.equal(ph.data.gateways[1].checkoutSupported, false);
});

test('card order: pays through the shop\'s own OnePay account and settles once', async (t) => {
  const shop = await compliantShop();
  await api('PUT', '/api/dashboard/gateways/onepay', { token: shop.token, body: { enabled: true, mode: 'sandbox', credentials: { appId: 'test-app', hashSalt: 'test-salt' } } });
  const store = await api('GET', `/api/store/${shop.slug}`);
  if (!store.data.store.payments.card) return t.skip('app not started with the OnePay mock env');
  assert.equal((await api('POST', `/api/store/${shop.slug}/orders`, { body: order(shop.product.id, { paymentMethod: 'card' }) })).status, 400); // email needed
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: order(shop.product.id, { paymentMethod: 'card', email: 'buyer@example.com' }) });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  assert.ok(o.data.payment.redirectUrl);
  const ipg = o.data.payment.redirectUrl.split('/pay/')[1];
  const sent = mock.calls.find((c) => c.path === '/v3/checkout/link/' && JSON.parse(c.body.additionalData).shop_id === shop.bizId).body;
  assert.equal(sent.amount, '17350.00'); // 2 x 8500 + 350 delivery
  mock.set(ipg, { outcome: 'paid' });
  // Buyer returns to their order page.
  const ret = await fetch(`${BASE}/api/onepay/return?ref=${encodeURIComponent(sent.reference)}`, { redirect: 'manual' });
  assert.match(ret.headers.get('location'), /\/store\/order\?s=.*&payment=success/);
  await api('POST', '/api/onepay/callback', { body: { transaction_id: ipg, status: 1 } }); // duplicate
  const st = await api('GET', `/api/store/${shop.slug}/orders/${o.data.code}?k=${o.data.token}`);
  assert.equal(st.data.order.paymentStatus, 'PAID');
  assert.equal((await outbox(shop.bizId, 'ORDER_PAID')).length, 1);
  assert.equal((await outbox(shop.bizId, 'ORDER_PAYMENT_RECEIPT')).length, 1);
  // Refund is recorded with a note.
  assert.equal((await api('PUT', `/api/dashboard/orders/${o.data.code}/status`, { token: shop.token, body: { status: 'REFUNDED' } })).status, 400);
  assert.equal((await api('PUT', `/api/dashboard/orders/${o.data.code}/status`, { token: shop.token, body: { status: 'REFUNDED', note: 'Full refund via OnePay dashboard 30 Sep' } })).status, 200);
  const list = await api('GET', '/api/dashboard/orders', { token: shop.token });
  const row = list.data.orders.find((x) => x.id === o.data.code);
  assert.equal(row.status, 'REFUNDED');
  assert.equal(row.paymentStatus, 'REFUNDED');
});

test('a failed card payment cancels the order and returns the stock', async (t) => {
  const shop = await compliantShop();
  await api('PUT', '/api/dashboard/gateways/onepay', { token: shop.token, body: { enabled: true, mode: 'sandbox', credentials: { appId: 'test-app', hashSalt: 'test-salt' } } });
  if (!(await api('GET', `/api/store/${shop.slug}`)).data.store.payments.card) return t.skip('app not started with the OnePay mock env');
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: order(shop.product.id, { paymentMethod: 'card', email: 'b@example.com' }) });
  assert.equal((await db.query('SELECT stock FROM products WHERE id=$1', [shop.product.id])).rows[0].stock, 3);
  const ipg = o.data.payment.redirectUrl.split('/pay/')[1];
  await api('POST', '/api/onepay/callback', { body: { transaction_id: ipg, status: 0, status_message: 'Declined' } });
  const st = await api('GET', `/api/store/${shop.slug}/orders/${o.data.code}?k=${o.data.token}`);
  assert.equal(st.data.order.status, 'CANCELLED');
  assert.equal(st.data.order.paymentStatus, 'FAILED');
  assert.equal((await db.query('SELECT stock FROM products WHERE id=$1', [shop.product.id])).rows[0].stock, 5);
  // Bad credentials at OnePay: order is not left hanging.
  await api('PUT', '/api/dashboard/gateways/onepay', { token: shop.token, body: { enabled: true, mode: 'sandbox', credentials: { hashSalt: 'wrong-salt' } } });
  const bad = await api('POST', `/api/store/${shop.slug}/orders`, { body: order(shop.product.id, { paymentMethod: 'card', email: 'b@example.com' }) });
  assert.equal(bad.status, 502);
  assert.equal((await db.query('SELECT stock FROM products WHERE id=$1', [shop.product.id])).rows[0].stock, 5);
});
