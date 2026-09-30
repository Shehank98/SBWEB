import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop, outbox, adminToken } from './helpers.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

async function shopOrder() {
  const shop = await registerShop();
  const fd = new FormData(); fd.append('name', 'Batik Shirt'); fd.append('price', '3950'); fd.append('stock', '20');
  shop.product = (await api('POST', '/api/products', { token: shop.token, form: fd })).data.product;
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: { customer: 'Kasun Silva', phone: '0771234567', email: 'kasun@example.com', address: '12 Temple Road', city: 'Kandy', payment: 'Cash on delivery', acceptTerms: true, items: [{ pid: shop.product.id, qty: 1 }] } });
  assert.equal(o.status, 201);
  shop.order = o.data;
  return shop;
}
const buyerMails = async (bizId) => (await db.query(`SELECT type FROM notifications WHERE business_id = $1 AND recipient = 'kasun@example.com' ORDER BY created_at`, [bizId])).rows.map((r) => r.type);

test('only the essential emails: placed (buyer + seller), confirmed, shipped with tracking', async () => {
  const shop = await shopOrder();
  const code = shop.order.code;
  for (const s of ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP']) await api('PUT', `/api/dashboard/orders/${code}/status`, { token: shop.token, body: { status: s } });
  await api('PUT', `/api/dashboard/orders/${code}/ship`, { token: shop.token, body: { courier: 'Domex', trackingNumber: 'DX1' } });
  await api('PUT', `/api/dashboard/orders/${code}/ship`, { token: shop.token, body: { courier: 'Domex', trackingNumber: 'DX2' } }); // corrected number: no second email
  await api('PUT', `/api/dashboard/orders/${code}/status`, { token: shop.token, body: { status: 'DELIVERED' } });
  assert.deepEqual(await buyerMails(shop.bizId), ['ORDER_PLACED', 'ORDER_CONFIRMED', 'ORDER_SHIPPED']);
  assert.equal((await outbox(shop.bizId, 'NEW_ORDER')).length, 1);
});

test('buyer confirms delivery on the tracking page; reviews only when an admin enabled them', async () => {
  const shop = await shopOrder();
  const { code, token } = shop.order;
  await api('PUT', `/api/dashboard/orders/${code}/status`, { token: shop.token, body: { status: 'CONFIRMED' } });
  let t = await api('GET', `/api/track/${code}?k=${token}`);
  assert.equal(t.data.canConfirmDelivery, true);
  assert.equal(t.data.reviewsEnabled, false);
  assert.equal((await api('POST', `/api/track/${code}/delivered?k=${'0'.repeat(24)}`)).status, 404);
  assert.equal((await api('POST', `/api/track/${code}/delivered?k=${token}`)).status, 200);
  t = await api('GET', `/api/track/${code}?k=${token}`);
  assert.equal(t.data.order.status, 'DELIVERED');
  assert.equal(t.data.canConfirmDelivery, false);
  const review = { reviews: [{ productId: shop.product.id, rating: 5, body: 'Lovely shirt' }] };
  assert.equal((await api('POST', `/api/track/${code}/reviews?k=${token}`, { body: review })).status, 403); // reviews off
  assert.equal((await api('PUT', `/api/admin/shops/${shop.bizId}/reviews`, { token: await adminToken(), body: { enabled: true } })).status, 200);
  assert.equal((await api('POST', `/api/track/${code}/reviews?k=${token}`, { body: review })).status, 201);
  assert.equal((await api('POST', `/api/track/${code}/reviews?k=${token}`, { body: review })).status, 400); // once per product
  const store = await api('GET', `/api/store/${shop.slug}`);
  assert.equal(store.data.store.reviewsEnabled, true);
  assert.equal(store.data.store.rating.count, 1);
  await api('PUT', `/api/admin/shops/${shop.bizId}/reviews`, { token: await adminToken(), body: { enabled: false } });
  const hidden = await api('GET', `/api/store/${shop.slug}`);
  assert.equal(hidden.data.store.rating.count, 0);
  assert.equal(hidden.data.products[0].reviews, undefined);
});

test('order items carry the product photo for summaries and emails', async () => {
  const shop = await shopOrder();
  const t = await api('GET', `/api/track/${shop.order.code}?k=${shop.order.token}`);
  assert.ok('image' in t.data.order.items[0]);
});
