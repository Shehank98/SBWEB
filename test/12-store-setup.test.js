import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop } from './helpers.js';
import { SETUP_WEIGHTS } from '../src/services/setup.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

const setup = async (shop) => (await api('GET', '/api/dashboard/setup', { token: shop.token })).data;
const item = (d, k) => d.items.find((i) => i.key === k);

test('weights: counted steps add up to 100, optional extras weigh nothing', () => {
  const total = Object.values(SETUP_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
  assert.equal(SETUP_WEIGHTS.product, 20);
  assert.equal(SETUP_WEIGHTS.card, 0);
  assert.equal(SETUP_WEIGHTS.weekly, 0);
});

test('new shop: not ready, delivery and payments need confirming, next step is an essential', async () => {
  const shop = await registerShop();
  const d = await setup(shop);
  assert.equal(d.ready, false);
  assert.equal(d.complete, false);
  assert.equal(item(d, 'delivery').done, false, 'default delivery values are not a confirmed choice');
  assert.equal(item(d, 'payment').done, false);
  assert.equal(item(d, 'product').done, false);
  assert.equal(d.next.level, 'essential');
  assert.ok(d.percent < 60);
  // Staff and anonymous users cannot read it.
  assert.equal((await api('GET', '/api/dashboard/setup')).status, 401);
});

test('progress follows real actions with their weights; ready once the essentials are done', async () => {
  const shop = await registerShop();
  const before = (await setup(shop)).percent;
  const fd = new FormData(); fd.append('name', 'Batik Shirt'); fd.append('price', '3950'); fd.append('stock', '5');
  await api('POST', '/api/products', { token: shop.token, form: fd });
  let d = await setup(shop);
  assert.equal(d.percent, before + 20, 'first product is worth 20%');

  await api('PUT', '/api/dashboard/store', { token: shop.token, body: { delivery: { fee: 400, freeAbove: 0, pickup: true } } });
  await api('PUT', '/api/dashboard/store', { token: shop.token, body: { payments: { cod: true, bank: false, online: false } } });
  await api('POST', '/api/dashboard/categories', { token: shop.token, body: { name: 'Shirts' } });
  await api('PUT', '/api/dashboard/store', { token: shop.token, body: { about: 'Handmade batik from Kandy', phone: '0771234567', address: '12 Temple Road, Kandy' } });
  d = await setup(shop);
  for (const k of ['product', 'delivery', 'payment', 'category', 'info']) assert.equal(item(d, k).done, true, k + ' done');
  assert.equal(d.ready, false, 'logo still missing');
  await db.query(`UPDATE stores SET logo_url = 'https://example.com/logo.png' WHERE business_id = $1`, [shop.bizId]);
  d = await setup(shop);
  assert.equal(d.ready, true);
  assert.equal(d.percent, 85, 'all essentials = 85%');
  assert.equal(d.next.level, 'recommended');

  // Recommended steps finish the score; optional extras do not change it.
  await db.query(`UPDATE stores SET cover_url = 'https://example.com/c.png', weekly_summary_enabled = false WHERE business_id = $1`, [shop.bizId]);
  await api('PUT', '/api/dashboard/store', { token: shop.token, body: { instagram: '@batikshop' } });
  await db.query(`UPDATE businesses SET verification_status = 'PENDING' WHERE id = $1`, [shop.bizId]);
  d = await setup(shop);
  assert.equal(d.percent, 100);
  assert.equal(d.complete, true);
  assert.equal(d.areas.payments.status, 'complete');
  assert.equal(item(d, 'weekly').done, false, 'optional and off, yet still 100%');
});

test('payment step needs a usable method: bank transfer alone needs bank details', async () => {
  const shop = await registerShop();
  await api('PUT', '/api/dashboard/store', { token: shop.token, body: { payments: { cod: false, bank: true, online: false }, bankAccount: { bankName: '', holder: '', branch: '', accountNo: '' } } });
  assert.equal(item(await setup(shop), 'payment').done, false);
  await api('PUT', '/api/dashboard/store', { token: shop.token, body: { payments: { cod: false, bank: true, online: false }, bankAccount: { bankName: 'BOC', holder: 'A Silva', branch: 'Kandy', accountNo: '1234567890' } } });
  assert.equal(item(await setup(shop), 'payment').done, true);
});
