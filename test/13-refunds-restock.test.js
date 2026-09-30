import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop } from './helpers.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

async function shopWithProduct() {
  const shop = await registerShop();
  const fd = new FormData(); fd.append('name', 'Batik Shirt'); fd.append('price', '2000'); fd.append('stock', '20');
  shop.product = (await api('POST', '/api/products', { token: shop.token, form: fd })).data.product;
  return shop;
}
async function order(shop, qty) {
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: { customer: 'Kasun Silva', phone: '0771234567', address: '12 Temple Road', city: 'Kandy', payment: 'Cash on delivery', delivery: 'Pickup', acceptTerms: true, items: [{ pid: shop.product.id, qty }] } });
  assert.equal(o.status, 201);
  return o.data;
}
const stock = async (shop) => (await db.query('SELECT stock FROM products WHERE id = $1', [shop.product.id])).rows[0].stock;
const status = (shop, code, body) => api('PUT', `/api/dashboard/orders/${code}/status`, { token: shop.token, body });
// Pro unlocks every report section; turn it on for this shop.
async function pro(shop) { await db.query(`UPDATE subscriptions SET plan_id = 'pro' WHERE business_id = $1`, [shop.bizId]); }

test('cancel or refund: the seller chooses whether items go back in stock, never twice', async () => {
  const shop = await shopWithProduct();
  const a = await order(shop, 2);
  assert.equal(await stock(shop), 18);
  assert.equal((await status(shop, a.code, { status: 'CANCELLED', restock: false })).data.restocked, false);
  assert.equal(await stock(shop), 18, 'kept as it is');

  const b = await order(shop, 3);
  assert.equal(await stock(shop), 15);
  const r = await status(shop, b.code, { status: 'CANCELLED', restock: true });
  assert.equal(r.data.restocked, true);
  assert.equal(await stock(shop), 18);
  // Refunding the same order later with restock again does not add stock twice.
  const again = await status(shop, b.code, { status: 'REFUNDED', note: 'Refunded by bank transfer', restock: true });
  assert.equal(again.status, 200);
  assert.equal(again.data.restocked, false);
  assert.equal(again.data.alreadyRestocked, true);
  assert.equal(await stock(shop), 18);
});

test('refund amount: full by default, partial allowed, never more than the order total', async () => {
  const shop = await shopWithProduct();
  const o = await order(shop, 1);
  assert.equal((await status(shop, o.code, { status: 'REFUNDED', note: 'x', refundAmount: 999999 })).status, 400);
  assert.equal((await status(shop, o.code, { status: 'REFUNDED', note: 'x', refundAmount: 0 })).status, 400);
  assert.equal((await status(shop, o.code, { status: 'REFUNDED' })).status, 400, 'a note is required');
  const r = await status(shop, o.code, { status: 'REFUNDED', note: 'Half refunded via OnePay', refundAmount: 500 });
  assert.equal(r.status, 200);
  assert.equal(r.data.refundAmount, 500);
  const list = (await api('GET', '/api/dashboard/orders', { token: shop.token })).data.orders;
  const mine = list.find((x) => x.id === o.code);
  assert.equal(mine.refundAmount, 500);
  assert.equal(mine.restocked, false);
});

test('reports deduct refunds and ignore cancelled orders', async () => {
  const shop = await shopWithProduct();
  await pro(shop);
  const keep = await order(shop, 1);     // Rs. 2,000 stays
  const full = await order(shop, 2);     // Rs. 4,000 fully refunded
  const part = await order(shop, 1);     // Rs. 2,000, Rs. 500 refunded
  const gone = await order(shop, 1);     // Rs. 2,000 cancelled
  await status(shop, full.code, { status: 'REFUNDED', note: 'Full refund', restock: true });
  await status(shop, part.code, { status: 'REFUNDED', note: 'Partial', refundAmount: 500 });
  await status(shop, gone.code, { status: 'CANCELLED' });
  assert.ok(keep.code);
  const T = {};
  for (const x of [keep, full, part, gone]) T[x.code] = (await db.query('SELECT total FROM orders WHERE business_id = $1 AND code = $2', [shop.bizId, x.code])).rows[0].total;
  const R = (await api('GET', '/api/dashboard/reports', { token: shop.token })).data.report;
  assert.equal(R.grossSales, T[keep.code] + T[full.code] + T[part.code], 'gross leaves out the cancelled order');
  assert.equal(R.refunds, T[full.code] + 500);
  assert.equal(R.revenue, T[keep.code] + T[part.code] - 500, 'net = gross minus refunds');
  assert.equal(R.refundedOrders, 2);
  assert.equal(R.paidOrders, 2, 'the fully refunded and the cancelled orders do not count as sales');
  assert.equal(R.itemsSold, 2);
  const ov = (await api('GET', '/api/dashboard/overview', { token: shop.token })).data;
  assert.equal(ov.todaySales, T[keep.code] + T[part.code] - 500);
  assert.equal(ov.todayOrders, 2);
});
