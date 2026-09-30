import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, api, db, registerShop, adminToken } from './helpers.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

const page = (path, cookie) => fetch(BASE + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
const sessionCookie = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('admin and seller pages need a signed-in user with the right role', async () => {
  const shop = await registerShop();
  const admin = await adminToken();
  const ownerCookie = sessionCookie(await fetch(BASE + '/api/auth/session', { method: 'POST', headers: { Authorization: 'Bearer ' + shop.token } }));
  const adminCookie = sessionCookie(await fetch(BASE + '/api/auth/session', { method: 'POST', headers: { Authorization: 'Bearer ' + admin } }));
  assert.match(ownerCookie, /^kade_session=.+/);

  // Nobody signed in: every admin / dashboard address, however it is written, goes to login.
  for (const p of ['/admin/index', '/admin/', '/admin', '/admin/index.html', '/%61dmin/index', '/ADMIN/index', '/dashboard/orders', '/admin/index?demo=1']) {
    const r = await page(p);
    assert.equal(r.status, 302, p);
    assert.match(r.headers.get('location'), /^\/login\?next=/, p);
  }
  // A seller cannot open the admin panel; an admin is sent to the admin panel.
  assert.equal((await page('/admin/settings', ownerCookie)).headers.get('location'), '/dashboard/');
  assert.equal((await page('/dashboard/orders', ownerCookie)).status, 200);
  assert.equal((await page('/admin/settings', adminCookie)).status, 200);
  assert.equal((await page('/dashboard/orders', adminCookie)).headers.get('location'), '/admin/index');
  // A forged or expired cookie counts as signed out.
  assert.equal((await page('/admin/index', 'kade_session=not-a-real-token')).status, 302);
  // The public demo opens sample seller pages only, never admin.
  assert.equal((await page('/dashboard/index?demo=1')).status, 200);
  assert.equal((await page('/dashboard/orders', 'kade_demo=1')).status, 200);
  assert.equal((await page('/admin/index', 'kade_demo=1')).status, 302);
  // Public pages stay public; internal notes are not served.
  assert.equal((await page('/store/' + shop.slug)).status, 200);
  assert.equal((await page('/login')).status, 200);
  assert.equal((await page('/README.md')).status, 404);
});

test('login sets the page cookie, logout clears it', async () => {
  const shop = await registerShop();
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: shop.fields.ownerEmail, password: shop.fields.password }) });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie') || '';
  assert.match(sc, /kade_session=/);
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Lax/i);
  const out = await fetch(BASE + '/api/auth/logout', { method: 'POST' });
  assert.match(out.headers.get('set-cookie') || '', /kade_session=;.*Max-Age=0/i);
  assert.equal((await api('POST', '/api/auth/session')).status, 401);
});
