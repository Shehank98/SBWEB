import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop, adminToken } from './helpers.js';
import { pool } from '../src/db/pool.js';

after(async () => {
  await db.query(`DELETE FROM platform_settings WHERE key = 'buyer_notice'`);
  const t = await adminToken(); await api('PUT', '/api/admin/settings', { token: t, body: { buyer_notice: { on: true, message: '{shop} is responsible for its products.' } } });
  await db.query(`DELETE FROM platform_settings WHERE key = 'buyer_notice'`);
  await db.end(); await pool.end();
});

test('buyer notice: on by default, admin edits or switches it off, edits get a new version', async () => {
  const shop = await registerShop();
  const admin = await adminToken();
  await db.query(`DELETE FROM platform_settings WHERE key = 'buyer_notice'`);
  await api('PUT', '/api/admin/settings', { token: admin, body: { trial_days: 14 } }); // clears the settings cache
  let s = (await api('GET', `/api/store/${shop.slug}`)).data.store;
  assert.ok(s.notice, 'default notice is on');
  assert.match(s.notice.message, /\{shop\} is responsible/);
  assert.equal(s.notice.version, 'default');

  assert.equal((await api('PUT', '/api/admin/settings', { token: admin, body: { buyer_notice: { on: true, message: '' } } })).status, 400);
  assert.equal((await api('PUT', '/api/admin/settings', { token: admin, body: { buyer_notice: { on: true, title: 'Please note', message: '{shop} handles delivery and refunds.', button: 'OK' } } })).status, 200);
  s = (await api('GET', `/api/store/${shop.slug}`)).data.store;
  assert.equal(s.notice.title, 'Please note');
  assert.equal(s.notice.button, 'OK');
  assert.notEqual(s.notice.version, 'default', 'edited text shows again to buyers who dismissed it');
  assert.equal((await api('GET', '/api/admin/settings', { token: admin })).data.settings.buyer_notice.title, 'Please note');

  await api('PUT', '/api/admin/settings', { token: admin, body: { buyer_notice: { on: false, message: 'x' } } });
  s = (await api('GET', `/api/store/${shop.slug}`)).data.store;
  assert.equal(s.notice, null);
  // Only admins can change it.
  assert.equal((await api('PUT', '/api/admin/settings', { token: shop.token, body: { buyer_notice: { on: false } } })).status, 403);
});
