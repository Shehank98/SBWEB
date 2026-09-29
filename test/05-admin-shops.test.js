import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, db, BASE, registerShop, adminToken, outbox } from './helpers.js';

after(() => db.end());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
function docs({ id = true, address = true, idType = 'image/png' } = {}) {
  const fd = new FormData();
  if (id) fd.append('idDoc', new Blob([idType === 'image/png' ? PNG : Buffer.from('<svg/>')], { type: idType }), idType === 'image/png' ? 'nic.png' : 'x.svg');
  if (address) fd.append('addressDoc', new Blob([PDF], { type: 'application/pdf' }), 'bill.pdf');
  return fd;
}

test('seller submits ID + address proof privately; admin reviews via short-lived signed URLs', async () => {
  const shop = await registerShop();
  const admin = await adminToken();
  assert.equal((await api('GET', '/api/dashboard/verification', { token: shop.token })).data.status, 'NOT_SUBMITTED');
  assert.equal((await api('POST', '/api/dashboard/verification', { token: shop.token, form: docs({ address: false }) })).status, 400);
  assert.equal((await api('POST', '/api/dashboard/verification', { token: shop.token, form: docs({ idType: 'image/svg+xml' }) })).status, 400);
  const sub = await api('POST', '/api/dashboard/verification', { token: shop.token, form: docs() });
  assert.equal(sub.status, 201);
  const v = await api('GET', '/api/dashboard/verification', { token: shop.token });
  assert.equal(v.data.status, 'PENDING');
  assert.equal(v.data.documents.length, 2);
  assert.ok(!JSON.stringify(v.data).includes('private/'), 'seller never gets storage paths');

  // Documents are not reachable by guessing: the uploads folder does not serve them.
  const { rows } = await db.query('SELECT storage_key FROM verification_documents WHERE business_id=$1', [shop.bizId]);
  assert.ok(rows.every((r) => r.storage_key.startsWith(`private/shops/${shop.bizId}/verification/`)));
  assert.notEqual((await fetch(`${BASE}/uploads/${rows[0].storage_key}`)).status, 200);

  // Sellers cannot use admin endpoints.
  assert.equal((await api('GET', `/api/admin/shops/${shop.bizId}/documents/id`, { token: shop.token })).status, 403);

  const link = await api('GET', `/api/admin/shops/${shop.bizId}/documents/id`, { token: admin });
  assert.equal(link.status, 200);
  assert.equal(link.data.expiresIn, 300);
  const file = await fetch(BASE + link.data.url);
  assert.equal(file.status, 200);
  assert.equal(Buffer.from(await file.arrayBuffer()).length, PNG.length);
  const tampered = link.data.url.replace(/sig=[^&]+/, 'sig=AAAA');
  assert.equal((await fetch(BASE + tampered)).status, 403);
  const expired = link.data.url.replace(/exp=\d+/, 'exp=' + (Date.now() - 1000));
  assert.equal((await fetch(BASE + expired)).status, 403);

  // Reject needs a reason, then the seller sees it and resubmits both.
  assert.equal((await api('POST', `/api/admin/shops/${shop.bizId}/verification/reject`, { token: admin, body: {} })).status, 400);
  assert.equal((await api('POST', `/api/admin/shops/${shop.bizId}/verification/reject`, { token: admin, body: { reason: 'NIC photo is blurry' } })).status, 200);
  const rej = await api('GET', '/api/dashboard/verification', { token: shop.token });
  assert.equal(rej.data.status, 'REJECTED');
  assert.equal(rej.data.reason, 'NIC photo is blurry');
  assert.equal((await outbox(shop.bizId, 'VERIFICATION_REJECTED')).length, 1);
  assert.equal((await api('POST', '/api/dashboard/verification', { token: shop.token, form: docs({ address: false }) })).status, 400);
  assert.equal((await api('POST', '/api/dashboard/verification', { token: shop.token, form: docs() })).status, 201);

  assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.store.verified, false);
  assert.equal((await api('POST', `/api/admin/shops/${shop.bizId}/verification/approve`, { token: admin })).status, 200);
  assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.store.verified, true);
  assert.equal((await outbox(shop.bizId, 'VERIFICATION_APPROVED')).length, 1);
});

test('admin shops list: search, filters, pagination, counts', async () => {
  const shop = await registerShop({ bizName: 'Zebra Batik Unique' });
  const admin = await adminToken();
  const r = await api('GET', '/api/admin/shops?q=zebra batik unique', { token: admin });
  assert.equal(r.status, 200);
  const row = r.data.shops.find((s) => s.id === shop.bizId);
  assert.ok(row);
  assert.equal(row.status, 'TRIAL');
  assert.equal(row.plan, 'Starter');
  assert.ok(row.daysLeft >= 13);
  assert.equal(row.verification, 'NOT_SUBMITTED');
  assert.equal(row.owner, 'Test Owner');
  const trial = await api('GET', '/api/admin/shops?filter=trial&pageSize=5', { token: admin });
  assert.ok(trial.data.shops.every((s) => s.status === 'TRIAL'));
  assert.ok(trial.data.shops.length <= 5);
  assert.ok(trial.data.counts.trial >= 1);
  const p2 = await api('GET', '/api/admin/shops?page=2&pageSize=5', { token: admin });
  assert.equal(p2.data.page, 2);
});

test('admin quick actions: extend trial, change plan, activate, deactivate', async () => {
  const shop = await registerShop();
  const admin = await adminToken();
  const before = (await api('GET', `/api/admin/shops/${shop.bizId}`, { token: admin })).data.shop;
  assert.ok(before.compliance === undefined);
  const ext = await api('POST', `/api/admin/shops/${shop.bizId}/extend-trial`, { token: admin, body: { days: 7 } });
  assert.equal(ext.status, 200);
  const acc = await api('GET', '/api/dashboard/access', { token: shop.token });
  assert.ok(acc.data.trial.daysLeft >= 20);
  assert.equal((await api('POST', `/api/admin/shops/${shop.bizId}/plan`, { token: admin, body: { planId: 'pro' } })).status, 200);
  assert.equal((await api('GET', '/api/dashboard/staff', { token: shop.token })).status, 200); // pro flag now on
  assert.equal((await api('POST', `/api/admin/businesses/${shop.bizId}/suspend`, { token: admin })).status, 200);
  assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.available, false);
  const act = await api('POST', `/api/admin/shops/${shop.bizId}/activate`, { token: admin, body: { days: 30, planId: 'business' } });
  assert.equal(act.status, 200);
  const d = (await api('GET', `/api/admin/shops/${shop.bizId}`, { token: admin })).data;
  assert.equal(d.shop.status, 'ACTIVE');
  assert.equal(d.shop.planId, 'business');
  assert.equal(d.compliance.items.length, 5);
  assert.equal((await api('GET', `/api/store/${shop.slug}`)).data.available, true);
});
