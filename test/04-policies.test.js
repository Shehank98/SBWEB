import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop } from './helpers.js';
import { isPoBox, validateContact } from '../src/services/policies.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

test('P.O. Box addresses are rejected, real addresses pass', () => {
  for (const a of ['P.O. Box 123, Colombo', 'PO Box 55 Kandy', 'p o box 9', 'Post Box 12, Galle', 'POB 44']) assert.ok(isPoBox(a), a);
  assert.equal(isPoBox('No. 24, Dalada Veediya, Kandy'), false);
  assert.equal(isPoBox('12 Post Office Road, Matara'), false); // a street named Post Office Road is fine
  assert.ok(validateContact({ email: 'a@b.lk', phone: '0771234567', address: 'P.O. Box 1, Colombo' }).address);
  assert.deepEqual(validateContact({ email: 'shop@example.com', phone: '077 123 4567', address: 'No. 24, Dalada Veediya, Kandy' }), {});
});

test('every shop gets 5 policy pages prefilled with its details; publishing completes the checklist', async () => {
  const shop = await registerShop({ bizName: 'Rukmali Handloom' });
  const store = await api('GET', `/api/store/${shop.slug}`);
  assert.deepEqual(store.data.store.policies.map((p) => p.key), ['refund', 'return', 'privacy', 'terms', 'contact']);
  for (const k of ['refund', 'privacy', 'return', 'terms']) {
    const p = await api('GET', `/api/store/${shop.slug}/policies/${k}`);
    assert.equal(p.status, 200);
    assert.match(p.data.content, /Rukmali Handloom/);
  }
  const priv = await api('GET', `/api/store/${shop.slug}/policies/privacy`);
  assert.match(priv.data.content, /Personal Data Protection Act/);
  const ret = await api('GET', `/api/store/${shop.slug}/policies/return`);
  assert.match(ret.data.content, /within 14 days/);
  const terms = await api('GET', `/api/store/${shop.slug}/policies/terms`);
  assert.match(terms.data.content, /laws of the Democratic Socialist Republic of Sri Lanka/);

  let c = await api('GET', '/api/dashboard/compliance', { token: shop.token });
  assert.equal(c.data.complete, false);
  assert.equal(c.data.doneCount, 0); // nothing published, address missing

  const po = await api('PUT', '/api/dashboard/contact', { token: shop.token, body: { email: 'hello@rukmali.lk', phone: '0771234567', address: 'P.O. Box 12, Kandy' } });
  assert.equal(po.status, 400);
  assert.ok(po.data.details.fields.address);
  const ok = await api('PUT', '/api/dashboard/contact', { token: shop.token, body: { email: 'hello@rukmali.lk', phone: '0771234567', address: 'No. 24, Dalada Veediya, Kandy' } });
  assert.equal(ok.status, 200);

  const list = await api('GET', '/api/dashboard/policies', { token: shop.token });
  for (const p of list.data.policies) {
    const r = await api('PUT', `/api/dashboard/policies/${p.key}`, { token: shop.token, body: { content: p.content, publish: true } });
    assert.equal(r.status, 200);
  }
  c = await api('GET', '/api/dashboard/compliance', { token: shop.token });
  assert.equal(c.data.complete, true);
  assert.equal(c.data.doneCount, 5);

  // Template-backed text follows later changes (return window).
  await api('PUT', '/api/dashboard/policy-settings', { token: shop.token, body: { returnDays: 30, refundDays: 7, returnShipping: 'seller' } });
  assert.match((await api('GET', `/api/store/${shop.slug}/policies/return`)).data.content, /within 30 days/);
  // Custom text sticks.
  const custom = 'Our own refund policy. '.repeat(10);
  await api('PUT', '/api/dashboard/policies/refund', { token: shop.token, body: { content: custom, publish: true } });
  assert.equal((await api('GET', `/api/store/${shop.slug}/policies/refund`)).data.content, custom.trim());
  const contact = await api('GET', `/api/store/${shop.slug}/policies/contact`);
  assert.equal(contact.data.contact.email, 'hello@rukmali.lk');
});

test('checkout requires agreeing to the Terms & Conditions', async () => {
  const shop = await registerShop();
  const fd = new FormData(); fd.append('name', 'Tote'); fd.append('price', '1500'); fd.append('stock', '3');
  const p = (await api('POST', '/api/products', { token: shop.token, form: fd })).data.product;
  const body = { customer: 'A', phone: '0771234567', address: '1 Main St', items: [{ pid: p.id, qty: 1 }] };
  const no = await api('POST', `/api/store/${shop.slug}/orders`, { body });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /Terms/);
  const yes = await api('POST', `/api/store/${shop.slug}/orders`, { body: { ...body, acceptTerms: true } });
  assert.equal(yes.status, 201);
  const { rows } = await db.query('SELECT terms_accepted_at FROM orders WHERE code = $1 AND business_id = $2', [yes.data.code, shop.bizId]);
  assert.ok(rows[0].terms_accepted_at);
});

test('platform legal pages and site info are public', async () => {
  const site = await api('GET', '/api/site');
  assert.equal(site.status, 200);
  assert.equal(site.data.policies.length, 5);
  for (const k of ['refund', 'privacy', 'return', 'terms', 'contact']) assert.equal((await api('GET', `/api/site/policies/${k}`)).status, 200);
  const page = await fetch((process.env.TEST_BASE_URL || 'http://localhost:4000') + '/legal/terms');
  assert.equal(page.status, 200);
});
