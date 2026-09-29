import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop } from './helpers.js';

after(() => db.end());

async function shopWithProduct() {
  const shop = await registerShop();
  const fd = new FormData();
  Object.entries({ name: 'Handloom Saree', price: '8500', stock: '5', category: '' }).forEach(([k, v]) => fd.append(k, v));
  const p = await api('POST', '/api/products', { token: shop.token, form: fd });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  return { shop, product: p.data.product };
}

function orderBody(pid, extra = {}) {
  return { customer: 'Nadeesha Perera', phone: '0771234567', address: '45 Temple Rd', city: 'Kandy', district: 'Kandy', delivery: 'Delivery', payment: 'Cash on delivery', acceptTerms: true, items: [{ pid, qty: 1 }], ...extra };
}

test('placing an order returns a private status link; wrong token is 404', async () => {
  const { shop, product } = await shopWithProduct();
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: orderBody(product.id) });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  assert.match(o.data.token, /^[a-f0-9]{24}$/);
  assert.match(o.data.statusUrl, /\/store\/order\?s=/);
  const ok = await api('GET', `/api/store/${shop.slug}/orders/${o.data.code}?k=${o.data.token}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.order.status, 'PENDING');
  assert.equal(ok.data.order.items[0].name, 'Handloom Saree');
  const bad = await api('GET', `/api/store/${shop.slug}/orders/${o.data.code}?k=${'0'.repeat(24)}`);
  assert.equal(bad.status, 404);
});

test('verified-buyer reviews only after delivery, once per product, and show on the store', async () => {
  const { shop, product } = await shopWithProduct();
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: orderBody(product.id) });
  const url = `/api/store/${shop.slug}/orders/${o.data.code}/reviews?k=${o.data.token}`;
  const early = await api('POST', url, { body: { reviews: [{ productId: product.id, rating: 5, body: 'Lovely' }] } });
  assert.equal(early.status, 400);
  await api('PUT', `/api/dashboard/orders/${o.data.code}/status`, { token: shop.token, body: { status: 'DELIVERED' } });
  const r = await api('POST', url, { body: { reviews: [{ productId: product.id, rating: 5, body: 'Lovely weave' }] } });
  assert.equal(r.status, 201);
  const dup = await api('POST', url, { body: { reviews: [{ productId: product.id, rating: 1 }] } });
  assert.equal(dup.status, 400);
  const store = await api('GET', `/api/store/${shop.slug}`);
  assert.deepEqual(store.data.store.rating, { avg: 5, count: 1 });
  assert.equal(store.data.store.latestReviews[0].name, 'Nadeesha P.');
  const p = store.data.products.find((x) => x.id === product.id);
  assert.equal(p.reviews, 1);
  const list = await api('GET', `/api/store/${shop.slug}/product/${product.id}/reviews`);
  assert.equal(list.data.reviews[0].body, 'Lovely weave');
});
