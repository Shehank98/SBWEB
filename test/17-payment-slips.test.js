import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, BASE, db, registerShop } from './helpers.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

// A tiny valid PNG (1x1 pixel).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const file = (buf, type, name) => { const fd = new FormData(); fd.append('slip', new Blob([buf], { type }), name); return fd; };

async function shopWithBankOrder(payment = 'Bank transfer', paymentMethod = 'bank') {
  const shop = await registerShop();
  const fd = new FormData(); fd.append('name', 'Batik Shirt'); fd.append('price', '2000'); fd.append('stock', '10');
  const p = (await api('POST', '/api/products', { token: shop.token, form: fd })).data.product;
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: { customer: 'Kasun Silva', phone: '0771234567', address: '12 Temple Road', city: 'Kandy', payment, paymentMethod, acceptTerms: true, items: [{ pid: p.id, qty: 1 }] } });
  assert.equal(o.status, 201);
  shop.order = o.data;
  return shop;
}
const upload = (shop, token, form) => api('POST', `/api/store/${shop.slug}/orders/${shop.order.code}/slip?k=${token}`, { form });
const sellerOrder = async (shop) => (await api('GET', '/api/dashboard/orders', { token: shop.token })).data.orders.find((x) => x.id === shop.order.code);
const buyerView = async (shop) => (await api('GET', `/api/track/${shop.order.code}?k=${shop.order.token}`)).data.order;

test('bank transfer: buyer uploads the slip privately, only the shop can open it', async () => {
  const shop = await shopWithBankOrder();
  assert.equal((await sellerOrder(shop)).paymentStatus, 'AWAITING_SLIP');
  // Wrong token, wrong file type, no file.
  assert.equal((await upload(shop, '0'.repeat(24), file(PNG, 'image/png', 'slip.png'))).status, 404);
  assert.equal((await upload(shop, shop.order.token, file(Buffer.from('hello'), 'text/plain', 'slip.txt'))).status, 400);
  assert.equal((await upload(shop, shop.order.token, new FormData())).status, 400);
  // A real slip.
  const up = await upload(shop, shop.order.token, file(PNG, 'image/png', 'my slip.png'));
  assert.equal(up.status, 201);
  const o = await sellerOrder(shop);
  assert.equal(o.paymentStatus, 'SLIP_UPLOADED');
  assert.equal(o.slip.name, 'my slip.png');
  assert.equal(JSON.stringify(o).includes('private/shops'), false, 'the storage key never reaches the page');
  // The shop gets a short-lived private link that works.
  const link = await api('GET', `/api/dashboard/orders/${shop.order.code}/slip`, { token: shop.token });
  assert.equal(link.status, 200);
  const img = await fetch(BASE + link.data.url);
  assert.equal(img.status, 200);
  assert.equal(Buffer.from(await img.arrayBuffer()).equals(PNG), true);
  // Nobody else can: another shop, or anyone without a login.
  const other = await registerShop();
  assert.equal((await api('GET', `/api/dashboard/orders/${shop.order.code}/slip`, { token: other.token })).status, 404);
  assert.equal((await api('GET', `/api/dashboard/orders/${shop.order.code}/slip`)).status, 401);
  // The storage folder is not public.
  assert.equal((await fetch(BASE + '/uploads-private/')).status, 404);
});

test('shop asks for a new slip, buyer uploads again, shop confirms payment', async () => {
  const shop = await shopWithBankOrder();
  await upload(shop, shop.order.token, file(PNG, 'image/png', 'blurry.png'));
  assert.equal((await api('POST', `/api/dashboard/orders/${shop.order.code}/payment`, { token: shop.token, body: { action: 'reject' } })).status, 400, 'a reason is required');
  const rej = await api('POST', `/api/dashboard/orders/${shop.order.code}/payment`, { token: shop.token, body: { action: 'reject', note: 'The amount is not readable' } });
  assert.equal(rej.status, 200);
  let b = await buyerView(shop);
  assert.equal(b.paymentStatus, 'SLIP_REJECTED');
  assert.equal(b.slipNote, 'The amount is not readable');
  await upload(shop, shop.order.token, file(PNG, 'image/png', 'clear.png'));
  b = await buyerView(shop);
  assert.equal(b.paymentStatus, 'SLIP_UPLOADED');
  assert.equal(b.slipNote, null);
  assert.equal((await api('POST', `/api/dashboard/orders/${shop.order.code}/payment`, { token: shop.token, body: { action: 'confirm' } })).status, 200);
  const o = await sellerOrder(shop);
  assert.equal(o.paymentStatus, 'PAID');
  assert.ok(o.paidOn);
  // After confirmation the slip can no longer be replaced.
  assert.equal((await upload(shop, shop.order.token, file(PNG, 'image/png', 'late.png'))).status, 400);
});

test('cash on delivery orders do not take slips', async () => {
  const shop = await shopWithBankOrder('Cash on delivery', 'cod');
  assert.equal((await sellerOrder(shop)).paymentStatus, null);
  assert.equal((await upload(shop, shop.order.token, file(PNG, 'image/png', 'x.png'))).status, 400);
  assert.equal((await api('POST', `/api/dashboard/orders/${shop.order.code}/payment`, { token: shop.token, body: { action: 'confirm' } })).status, 400);
});
