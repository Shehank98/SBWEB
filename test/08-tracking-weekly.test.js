import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop, outbox, adminToken } from './helpers.js';
import { classify, bucketOf } from '../src/services/traffic.js';
import { lastWeekRange, runWeeklySummary } from '../src/services/weeklySummary.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

test('traffic source classification', () => {
  assert.equal(classify({ referrer: 'https://l.facebook.com/l.php?u=x' }).source, 'facebook');
  assert.equal(classify({ referrer: 'https://www.instagram.com/' }).source, 'instagram');
  assert.equal(classify({ referrer: 'https://www.google.lk/' }).source, 'google');
  assert.equal(classify({ referrer: '', utmSource: 'WhatsApp', utmMedium: 'status', utmCampaign: 'avurudu' }).source, 'whatsapp');
  assert.equal(classify({ referrer: '' }).source, 'direct');
  assert.equal(classify({ referrer: 'https://someblog.lk/post' }).source, 'someblog.lk');
  assert.equal(classify({ referrer: 'https://sidadiya.com/store/x', ownHost: 'sidadiya.com' }), null); // internal navigation
  assert.deepEqual(['direct', 'whatsapp', 'tiktok', 'youtube', 'someblog.lk', null].map(bucketOf), ['direct', 'whatsapp', 'tiktok', 'other', 'other', 'direct']);
});

async function shopWithProduct() {
  const shop = await registerShop();
  const fd = new FormData(); fd.append('name', 'Batik Shirt'); fd.append('price', '3950'); fd.append('stock', '20');
  shop.product = (await api('POST', '/api/products', { token: shop.token, form: fd })).data.product;
  return shop;
}

test('visits are recorded by source (bots skipped) and orders keep first-touch attribution', async () => {
  const shop = await shopWithProduct();
  const hit = (body, ua = 'Mozilla/5.0 (Linux; Android 14)') => api('POST', `/api/store/${shop.slug}/visit`, { body, headers: { 'User-Agent': ua } });
  assert.equal((await hit({ page: 'home', referrer: 'https://l.facebook.com/', sid: 'abcdefgh1' })).status, 204);
  await hit({ page: 'home', utm_source: 'whatsapp', sid: 'abcdefgh2' });
  await hit({ page: 'home', referrer: 'https://l.facebook.com/', sid: 'abcdefgh3' });
  await hit({ page: 'home', referrer: 'https://l.facebook.com/' }, 'facebookexternalhit/1.1');
  // Visitor sources are a Pro feature: refused (no data) until the shop is on Pro.
  const locked = await api('GET', '/api/dashboard/traffic?days=7', { token: shop.token });
  assert.equal(locked.status, 403);
  assert.equal(locked.data.details.code, 'UPGRADE_REQUIRED');
  assert.equal(locked.data.sources, undefined);
  assert.equal((await api('POST', `/api/admin/shops/${shop.bizId}/plan`, { token: await adminToken(), body: { planId: 'pro' } })).status, 200);
  // Same session again: only the first page view per session counts.
  await hit({ page: 'product', referrer: 'https://l.facebook.com/', sid: 'abcdefgh1' });
  const t = await api('GET', '/api/dashboard/traffic?days=7', { token: shop.token });
  assert.equal(t.status, 200);
  assert.equal(t.data.total, 3);
  const fb = t.data.buckets.find((b) => b.key === 'facebook');
  assert.deepEqual([fb.visitors, fb.pct], [2, 66.7]);
  assert.deepEqual(t.data.buckets.map((b) => b.key).sort(), ['direct', 'facebook', 'google', 'instagram', 'other', 'tiktok', 'whatsapp']);
  const range = await api('GET', '/api/dashboard/traffic?from=2020-01-01&to=2020-01-31', { token: shop.token });
  assert.equal(range.data.total, 0);
  assert.equal((await api('GET', '/api/dashboard/traffic?from=2020-02-01&to=2020-01-01', { token: shop.token })).status, 400);
  assert.deepEqual(t.data.sources.map((s) => [s.source, s.sessions]), [['facebook', 2], ['whatsapp', 1]]);
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: { customer: 'Kasun Silva', phone: '0771234567', address: '1 Main St', acceptTerms: true, items: [{ pid: shop.product.id, qty: 1 }], attribution: { utm_source: 'instagram', utm_campaign: 'new-drop' } } });
  assert.equal(o.status, 201);
  const { rows } = await db.query('SELECT source, campaign FROM orders WHERE business_id=$1', [shop.bizId]);
  assert.deepEqual(rows[0], { source: 'instagram', campaign: 'new-drop' });
});

test('mark as shipped: courier + tracking saved, buyer emailed once per tracking number, shown on the order page', async () => {
  const shop = await shopWithProduct();
  const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: { customer: 'Kasun Silva', phone: '0771234567', email: 'kasun@example.com', address: '1 Main St', acceptTerms: true, items: [{ pid: shop.product.id, qty: 1 }] } });
  const ship = (body) => api('PUT', `/api/dashboard/orders/${o.data.code}/ship`, { token: shop.token, body });
  assert.equal((await ship({ courier: 'Domex' })).status, 400);
  assert.equal((await ship({ courier: 'Domex', trackingNumber: 'X1', trackingUrl: 'http://insecure' })).status, 400);
  const r = await ship({ courier: 'Domex', trackingNumber: 'DMX123456', trackingUrl: 'https://domex.lk/track?n=DMX123456' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'SHIPPED');
  await ship({ courier: 'Domex', trackingNumber: 'DMX123456' }); // same number again: no second email
  let mails = await outbox(shop.bizId, 'ORDER_SHIPPED');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].data.trackingNumber, 'DMX123456');
  assert.equal(mails[0].data.courier, 'Domex');
  await ship({ courier: 'Pronto', trackingNumber: 'PR999' }); // corrected number: email again
  mails = await outbox(shop.bizId, 'ORDER_SHIPPED');
  assert.equal(mails.length, 2);
  const page = await api('GET', `/api/store/${shop.slug}/orders/${o.data.code}?k=${o.data.token}`);
  assert.deepEqual([page.data.order.tracking.courier, page.data.order.tracking.number, page.data.order.status], ['Pronto', 'PR999', 'SHIPPED']);
});

test('weekly summary: last week numbers, stored digest, one email, respects opt-out', async () => {
  const shop = await shopWithProduct();
  const off = await shopWithProduct();
  assert.equal((await api('PUT', '/api/dashboard/preferences', { token: off.token, body: { weeklySummary: false } })).data.weeklySummary, false);
  const range = lastWeekRange();
  const mid = new Date(range.from.getTime() + 2 * 86400000);
  for (let i = 0; i < 3; i++) {
    const o = await api('POST', `/api/store/${shop.slug}/orders`, { body: { customer: 'A B', phone: '0771234567', address: '1 Main St', acceptTerms: true, items: [{ pid: shop.product.id, qty: 2 }] } });
    await db.query('UPDATE orders SET created_at=$2 WHERE business_id=$1 AND code=$3', [shop.bizId, mid, o.data.code]);
  }
  await db.query(`INSERT INTO store_visits (business_id, visited_at, page, source, session_id) VALUES ($1,$2,'home','facebook','s1'),($1,$2,'home','facebook','s2'),($1,$2,'home','google','s3')`, [shop.bizId, mid]);
  const r1 = await runWeeklySummary();
  const r2 = await runWeeklySummary();
  assert.ok(r1.weeklyEmails >= 1);
  const mails = await outbox(shop.bizId, 'WEEKLY_SUMMARY');
  assert.equal(mails.length, 1, 'sent once');
  const d = mails[0].data;
  assert.equal(d.orders, 3);
  assert.equal(d.revenue, 3 * (2 * 3950 + 350));
  assert.equal(d.topProducts[0].name, 'Batik Shirt');
  assert.equal(d.trafficLocked, true); // visitor sources are Pro only: trial shops get a teaser, not the data
  assert.deepEqual(d.trafficSources, []);
  const digest = await db.query('SELECT deliveries FROM seller_digests WHERE business_id=$1', [shop.bizId]);
  assert.equal(digest.rows[0].deliveries.email, 'QUEUED');
  assert.equal((await outbox(off.bizId, 'WEEKLY_SUMMARY')).length, 0);
  assert.equal(r2.weeklyEmails, 0, 'second run sends nothing');
  assert.equal(digest.rows.length, 1, 'one digest per week');
});
