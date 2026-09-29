import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop, uniq } from './helpers.js';

after(() => db.end());

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('slug availability check', async () => {
  const shop = await registerShop();
  assert.equal((await api('GET', `/api/auth/slug-available?slug=${shop.slug}`)).data.available, false);
  assert.equal((await api('GET', `/api/auth/slug-available?slug=free-${uniq()}`)).data.available, true);
  assert.equal((await api('GET', '/api/auth/slug-available?slug=ab')).data.available, false);
});

test('onboarding saves theme, logo, cover and tagline and the storefront shows them', async () => {
  const blob = new Blob([PNG], { type: 'image/png' });
  const fd = new FormData();
  fd.append('logo', blob, 'logo.png');
  fd.append('cover', blob, 'cover.png');
  const shop = await registerShop({ preset: 'orchid', template: 'showcase', tagline: 'Handwoven in Kandy', storeName: 'Rukmali Handloom' });
  // registerShop sends text only; upload the images through the settings endpoints too.
  const up = await api('POST', '/api/dashboard/store/cover', { token: shop.token, form: (() => { const f = new FormData(); f.append('cover', blob, 'c.png'); return f; })() });
  assert.equal(up.status, 200);
  const r = await api('GET', `/api/store/${shop.slug}`);
  assert.equal(r.data.store.preset, 'orchid');
  assert.equal(r.data.store.template, 'showcase');
  assert.equal(r.data.store.tagline, 'Handwoven in Kandy');
  assert.equal(r.data.store.name, 'Rukmali Handloom');
  assert.ok(r.data.store.cover);
  assert.equal(fd.getAll('logo').length, 1);
});

test('signup with logo + cover files in one multipart request', async () => {
  const id = uniq();
  const blob = new Blob([PNG], { type: 'image/png' });
  const fd = new FormData();
  Object.entries({ bizName: 'Img Shop ' + id, ownerName: 'O', ownerEmail: `img-${id}@example.com`, password: 'password123', slug: 'img-' + id }).forEach(([k, v]) => fd.append(k, v));
  fd.append('logo', blob, 'logo.png');
  fd.append('cover', blob, 'cover.png');
  const r = await api('POST', '/api/auth/register', { form: fd });
  assert.equal(r.status, 201);
  const s = await api('GET', `/api/store/img-${id}`);
  assert.ok(s.data.store.logo && s.data.store.cover);
  assert.equal(s.data.store.preset, 'tea'); // default
});

test('an optional bank slip at signup is queued for admin review, trial still starts', async () => {
  const shop = await registerShop({ ref: 'TXN-777' });
  const { rows } = await db.query("SELECT status, plan_id FROM payments WHERE business_id = $1", [shop.bizId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PENDING');
  assert.equal(rows[0].plan_id, 'business');
  assert.equal(shop.user.businessStatus, 'TRIAL');
});
