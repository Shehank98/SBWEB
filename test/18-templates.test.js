import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, registerShop } from './helpers.js';
import { pool } from '../src/db/pool.js';

after(async () => { await db.end(); await pool.end(); });

test('templates: the five new templates are accepted at sign-up and in settings, unknown ones are ignored', async () => {
  const shop = await registerShop({ template: 'link' });
  assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.store.template, 'link');
  for (const t of ['soft', 'night', 'quick', 'pop']) {
    assert.equal((await api('PUT', '/api/dashboard/store', { token: shop.token, body: { template: t } })).status, 200);
    assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.store.template, t);
  }
  await api('PUT', '/api/dashboard/store', { token: shop.token, body: { template: 'not-a-template' } });
  assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.store.template, 'pop', 'unknown template keeps the current one');
  const other = await registerShop({ template: 'nope' });
  assert.equal((await api('GET', `/api/store/${other.slug}`)).data.store.template, 'classic');
});
