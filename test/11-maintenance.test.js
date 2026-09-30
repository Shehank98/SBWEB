import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, BASE, db, registerShop, adminToken } from './helpers.js';
import { pool } from '../src/db/pool.js';

const setMaint = async (token, m) => api('PUT', '/api/admin/settings', { token, body: { maintenance: m } });

after(async () => {
  // Never leave the site closed for the other test files.
  await db.query(`DELETE FROM platform_settings WHERE key = 'maintenance'`);
  const t = await adminToken(); await setMaint(t, { on: false });
  await db.end(); await pool.end();
});

test('maintenance mode: visitors get the closed page, admins and webhooks still work', async () => {
  const admin = await adminToken();
  const shop = await registerShop();
  assert.equal((await setMaint(admin, { on: true, message: 'Adding new features', until: 'not a date' })).status, 400);
  const on = await setMaint(admin, { on: true, message: 'Adding new features', until: '2030-01-01T10:00:00Z' });
  assert.equal(on.status, 200);

  const status = await api('GET', '/api/site/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.data.maintenance, { on: true, message: 'Adding new features', until: '2030-01-01T10:00:00.000Z' });

  // Pages: 503 with the animated closed page, never cached.
  const page = await fetch(`${BASE}/store/${shop.slug}`, { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 503);
  assert.equal(page.headers.get('x-sidadiya-maintenance'), '1');
  assert.match(page.headers.get('cache-control'), /no-store/);
  const html = await page.text();
  assert.match(html, /data-mode="checking"/);
  assert.match(html, /SIDADIYA_MAINT=\{"on":true,"message":"Adding new features"/);

  // Seller API: 503 JSON. Admin API and login stay open.
  const dash = await api('GET', '/api/dashboard/orders', { token: shop.token });
  assert.equal(dash.status, 503);
  assert.equal(dash.data.maintenance.on, true);
  assert.equal((await api('GET', '/api/admin/settings', { token: admin })).status, 200);
  assert.equal((await api('GET', '/api/dashboard/orders', { token: admin })).status !== 503, true);
  assert.equal((await fetch(`${BASE}/login`)).status, 200);
  assert.equal((await fetch(`${BASE}/admin/settings`)).status, 200);
  assert.equal((await fetch(`${BASE}/closed`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/health`)).status, 200);

  const off = await setMaint(admin, { on: false });
  assert.equal(off.status, 200);
  assert.equal((await api('GET', '/api/site/status')).data.maintenance, null);
  assert.equal((await fetch(`${BASE}/store/${shop.slug}`)).status, 200);
  assert.equal((await api('GET', '/api/dashboard/orders', { token: shop.token })).status, 200);
});

test('offline fallback: service worker is served with the deploy version, closed page is self-contained', async () => {
  const sw = await fetch(`${BASE}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  const src = await sw.text();
  assert.ok(!src.includes('__VERSION__'), 'version filled in');
  assert.match(src, /'\/closed'/);
  const html = await (await fetch(`${BASE}/closed`)).text();
  assert.ok(!/<link[^>]+stylesheet/.test(html) && !/<script[^>]+src=/.test(html), 'no external files: it must work offline');
  assert.ok(!/—/.test(html), 'no em dashes');
});
