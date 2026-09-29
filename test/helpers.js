// Integration-test helpers. The tests talk to a RUNNING server (npm start) over HTTP
// and to the same database directly (to time-travel trials, inspect the outbox, …).
//   TEST_BASE_URL  default http://localhost:4000
//   DATABASE_URL   the server's database (use a throwaway/dev database, never production)
import 'dotenv/config';
import pg from 'pg';

export const BASE = (process.env.TEST_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function api(method, path, { body, token, form, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

export const uniq = () => Math.random().toString(36).slice(2, 8);

// Register a brand-new shop through the public signup and return its session.
export async function registerShop(extra = {}) {
  const id = uniq();
  const fd = new FormData();
  const fields = {
    bizName: `Test Shop ${id}`, ownerName: 'Test Owner', ownerEmail: `owner-${id}@example.com`,
    password: 'password123', slug: `test-${id}`, planId: 'business', bizPhone: '0771234567',
    bizWhatsapp: '0771234567', city: 'Kandy', district: 'Kandy', bizType: 'Fashion and clothing', ...extra,
  };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await api('POST', '/api/auth/register', { form: fd });
  if (r.status !== 201) throw new Error('register failed: ' + JSON.stringify(r.data));
  return { ...r.data, fields, slug: fields.slug, bizId: r.data.business.id };
}

export async function login(email, password) {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error('login failed: ' + JSON.stringify(r.data));
  return r.data.token;
}

export async function adminToken() {
  return login(process.env.ADMIN_EMAIL || 'admin@sidadiya.lk', process.env.ADMIN_PASSWORD || 'admin12345');
}

export async function outbox(businessId, type) {
  const { rows } = await db.query(
    'SELECT * FROM notifications WHERE business_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY created_at',
    [businessId, type || null]
  );
  return rows;
}
