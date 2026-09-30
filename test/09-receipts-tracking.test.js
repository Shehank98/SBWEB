import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop, outbox } from './helpers.js';
import { toWhatsAppIntl, timeline, waybillMissing } from '../src/services/orderLinks.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

async function shopWithOrder(extra = {}) {
  const shop = await registerShop();
  const fd = new FormData(); fd.append('name', 'Batik Shirt'); fd.append('price', '3950'); fd.append('stock', '20');
  shop.product = (await api('POST', '/api/products', { token: shop.token, form: fd })).data.product;
  const o = await api('POST', `/api/store/${shop.slug}/orders`, {
    body: { customer: 'Kasun Silva', phone: '0771234567', email: 'kasun@example.com', address: '12 Temple Road', city: 'Kandy', district: 'Kandy', payment: 'Cash on delivery', acceptTerms: true, items: [{ pid: shop.product.id, qty: 2 }], ...extra },
  });
  assert.equal(o.status, 201);
  shop.order = o.data;
  return shop;
}

test('Sri Lankan numbers are normalised for WhatsApp', () => {
  assert.equal(toWhatsAppIntl('0771234567'), '94771234567');
  assert.equal(toWhatsAppIntl('077 123 4567'), '94771234567');
  assert.equal(toWhatsAppIntl('+94 77 123 4567'), '94771234567');
  assert.equal(toWhatsAppIntl('771234567'), '94771234567');
  assert.equal(toWhatsAppIntl('0094771234567'), '94771234567');
  assert.equal(toWhatsAppIntl('0112345678'), ''); // landline
  assert.equal(toWhatsAppIntl(''), '');
});

test('timeline: packed covers processing and ready to ship; cancelled ends the line', () => {
  const t0 = new Date('2026-09-01T10:00:00Z');
  const h = [{ status: 'PENDING', created_at: t0 }, { status: 'CONFIRMED', created_at: t0 }, { status: 'READY_TO_SHIP', created_at: t0 }];
  const tl = timeline({ status: 'READY_TO_SHIP', created_at: t0 }, h);
  assert.deepEqual(tl.map((s) => [s.key, s.done]), [['PLACED', true], ['CONFIRMED', true], ['PACKED', true], ['SHIPPED', false], ['DELIVERED', false]]);
  const c = timeline({ status: 'CANCELLED', created_at: t0 }, [...h.slice(0, 2), { status: 'CANCELLED', created_at: t0 }]);
  assert.deepEqual(c.map((s) => s.key), ['PLACED', 'CONFIRMED', 'CANCELLED']);
});

test('order placed: buyer email on behalf of the shop with receipt + tracking links', async () => {
  const shop = await shopWithOrder();
  assert.match(shop.order.trackUrl, /^\/track\/ORD-\d+\?k=[a-f0-9]{24}$/);
  assert.match(shop.order.receiptUrl, /^\/receipt\/[a-f0-9]{32}$/);
  const [mail] = await outbox(shop.bizId, 'ORDER_PLACED');
  assert.ok(mail, 'ORDER_PLACED queued');
  assert.equal(mail.recipient, 'kasun@example.com');
  assert.equal(mail.data.fromName, shop.fields.bizName);
  assert.equal(mail.data.replyTo, shop.fields.ownerEmail);
  assert.ok(mail.data.trackUrl.endsWith(shop.order.trackUrl));
  assert.ok(mail.data.receiptUrl.endsWith(shop.order.receiptUrl));
  assert.ok(!/—/.test(mail.subject + mail.message), 'no em dashes in the email');
});

test('tracking page API: token required, timeline follows status changes, one email per step', async () => {
  const shop = await shopWithOrder();
  const code = shop.order.code;
  assert.equal((await api('GET', `/api/track/${code}?k=${'0'.repeat(24)}`)).status, 404);
  assert.equal((await api('GET', `/api/track/${code}`)).status, 404);
  for (const s of ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP']) {
    assert.equal((await api('PUT', `/api/dashboard/orders/${code}/status`, { token: shop.token, body: { status: s } })).status, 200);
  }
  const t = await api('GET', `/api/track/${code}?k=${shop.order.token}`);
  assert.equal(t.status, 200);
  assert.deepEqual(t.data.timeline.filter((s) => s.done).map((s) => s.key), ['PLACED', 'CONFIRMED', 'PACKED']);
  assert.equal(t.data.order.customer, 'Kasun'); // first name only on a public page
  assert.equal((await outbox(shop.bizId, 'ORDER_PACKED')).length, 1);
  assert.equal((await outbox(shop.bizId, 'ORDER_CONFIRMED')).length, 1);
});

test('receipt: valid for 30 days, then 410 with no order data', async () => {
  const shop = await shopWithOrder();
  const token = shop.order.receiptUrl.split('/').pop();
  const r = await api('GET', `/api/receipt/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.receipt.number, shop.order.code);
  assert.equal(r.data.receipt.total, 3950 * 2 + (r.data.receipt.delivery || 0));
  const days = (new Date(r.data.receipt.expiresAt) - new Date(r.data.receipt.date)) / 86400000;
  assert.ok(Math.abs(days - 30) < 0.01, 'expires 30 days after purchase');
  await db.query(`UPDATE orders SET receipt_expires_at = now() - interval '1 second' WHERE receipt_token = $1`, [token]);
  const x = await api('GET', `/api/receipt/${token}`);
  assert.equal(x.status, 410);
  assert.equal(x.data.expired, true);
  assert.equal(x.data.receipt, undefined);
  assert.equal((await api('GET', '/api/receipt/nothex')).status, 404);
});

test('waybill readiness lists missing fields', () => {
  const ok = { customer_name: 'A B', phone: '0771234567', address: '12 Temple Road', city: 'Kandy', payment_method: 'Cash on delivery', total: 2000, status: 'CONFIRMED' };
  assert.deepEqual(waybillMissing(ok, [{ name: 'x' }]), []);
  assert.deepEqual(waybillMissing({ ...ok, address: '', city: '' }, [{ name: 'x' }]), ['Full address', 'City']);
  assert.deepEqual(waybillMissing({ ...ok, phone: '12' }, []), ['Phone number', 'Items']);
  assert.ok(waybillMissing({ ...ok, delivery_method: 'Pickup' }, [{}]).some((m) => /pickup/.test(m)));
});

test('waybills API: ready orders get a QR label, incomplete ones list missing fields; receipt share builds wa.me', async () => {
  const shop = await shopWithOrder();
  const pickup = await api('POST', `/api/store/${shop.slug}/orders`, { body: { customer: 'Pick Up', phone: '0771234567', address: 'x', city: 'Pickup', delivery: 'Pickup', acceptTerms: true, items: [{ pid: shop.product.id, qty: 1 }] } });
  const r = await api('GET', `/api/dashboard/waybills?codes=${shop.order.code},${pickup.data.code},${shop.order.code}`, { token: shop.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.waybills.length, 2); // duplicates removed
  const [ok, bad] = r.data.waybills;
  assert.deepEqual(ok.missing, []);
  assert.match(ok.qr, /^<svg/);
  assert.equal(ok.cod, 3950 * 2 + (r.data.waybills[0].total - 3950 * 2));
  assert.ok(bad.missing.length > 0);
  assert.equal(r.data.shop.name, shop.fields.bizName);
  const list = await api('GET', '/api/dashboard/orders', { token: shop.token });
  const mine = list.data.orders.find((o) => o.id === shop.order.code);
  assert.deepEqual(mine.waybillMissing, []);
  assert.equal(mine.waPhone, '94771234567');
  const share = await api('POST', `/api/dashboard/orders/${shop.order.code}/receipt-share`, { token: shop.token });
  assert.equal(share.status, 200);
  assert.match(share.data.waUrl, /^https:\/\/wa\.me\/94771234567\?text=/);
  assert.ok(decodeURIComponent(share.data.waUrl).includes('/receipt/'));
  // Other shops cannot print this order.
  const other = await registerShop();
  const x = await api('GET', `/api/dashboard/waybills?codes=${shop.order.code}`, { token: other.token });
  assert.deepEqual(x.data.waybills[0].missing, ['Order not found']);
});

test('store settings autosave: partial updates keep other fields, invalid values are refused', async () => {
  const shop = await registerShop();
  const before = (await api('GET', '/api/dashboard/store', { token: shop.token })).data.store;
  assert.equal((await api('PUT', '/api/dashboard/store', { token: shop.token, body: { tagline: 'Handmade in Kandy' } })).status, 200);
  assert.equal((await api('PUT', '/api/dashboard/store', { token: shop.token, body: { delivery: { fee: 400, freeAbove: 0, pickup: true } } })).status, 200);
  assert.equal((await api('PUT', '/api/dashboard/store', { token: shop.token, body: { name: '  ' } })).status, 400);
  assert.equal((await api('PUT', '/api/dashboard/store', { token: shop.token, body: { delivery: { fee: -5 } } })).status, 400);
  assert.equal((await api('PUT', '/api/dashboard/store', { token: shop.token, body: { facebook: '@kandyhandloom', instagram: 'https://instagram.com/kandy' } })).status, 200);
  assert.equal((await api('PUT', '/api/dashboard/store', { token: shop.token, body: { facebook: 'not a valid page!' } })).status, 400);
  const after = (await api('GET', '/api/dashboard/store', { token: shop.token })).data.store;
  assert.equal(after.name, before.name);
  assert.equal(after.tagline, 'Handmade in Kandy');
  assert.equal(after.delivery.fee, 400);
  assert.equal(after.phone, before.phone);
  assert.deepEqual(after.social, { facebook: 'kandyhandloom', instagram: 'https://instagram.com/kandy' });
  // The settings page never sends city: a save must not wipe it.
  await db.query(`UPDATE stores SET city = 'Kandy' WHERE business_id = $1`, [shop.bizId]);
  assert.equal((await api('PUT', '/api/dashboard/store', { token: shop.token, body: { about: 'Since 1998' } })).status, 200);
  const { rows } = await db.query('SELECT city, about FROM stores WHERE business_id = $1', [shop.bizId]);
  assert.deepEqual(rows[0], { city: 'Kandy', about: 'Since 1998' });
});
