import { Router } from 'express';
import multer from 'multer';
import { query, withTransaction } from '../db/pool.js';
import { hashPassword, verifyPassword, signToken } from '../utils/auth.js';
import { slugify } from '../utils/slug.js';
import { wrap, badRequest, unauthorized, conflict } from '../utils/http.js';
import { saveUpload } from '../services/uploads.js';
import { queueNotification, templates } from '../services/notifications.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
export const authRouter = Router();

// POST /api/auth/register  (multipart: fields + optional payment slip file)
// Runs the whole registration flow atomically: user + business + store + subscription
// + pending payment, and queues the "we received your application" email.
authRouter.post(
  '/register',
  upload.single('slip'),
  wrap(async (req, res) => {
    const b = req.body;
    const required = ['bizName', 'ownerName', 'ownerEmail', 'password', 'slug', 'planId'];
    for (const f of required) {
      if (!b[f] || !String(b[f]).trim()) throw badRequest(`Missing field: ${f}`);
    }
    if (String(b.password).length < 8) throw badRequest('Password must be at least 8 characters.');

    const slug = slugify(b.slug);
    if (slug.length < 3) throw badRequest('Store link must be at least 3 characters.');

    // Uniqueness checks up front for friendly errors (DB constraints are the backstop).
    const dupe = await query(
      `SELECT 1 FROM users WHERE lower(email) = lower($1)
        UNION SELECT 1 FROM stores WHERE slug = $2`,
      [b.ownerEmail, slug]
    );
    if (dupe.rowCount) throw conflict('That email or store link is already taken.');

    const plan = (await query('SELECT * FROM plans WHERE id = $1', [b.planId])).rows[0];
    if (!plan) throw badRequest('Unknown plan.');

    // A storage hiccup must never block a signup. If the slip upload fails we still
    // create the business + pending payment (without the slip) and log the error,
    // so the application always reaches the admin and the owner can re-send the slip.
    let slipUrl = null;
    if (req.file) {
      try {
        slipUrl = await saveUpload(req.file, 'slips');
      } catch (e) {
        console.error('[register] slip upload failed, continuing without it:', e.message);
      }
    }

    const result = await withTransaction(async (client) => {
      const biz = (
        await client.query(
          `INSERT INTO businesses (name, type, description, phone, whatsapp, email, address, city, district, facebook, instagram, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING_APPROVAL') RETURNING *`,
          [b.bizName, b.bizType || null, b.description || null, b.bizPhone || null, b.bizWhatsapp || null,
           b.ownerEmail, b.address || null, b.city || null, b.district || null, b.facebook || null, b.instagram || null]
        )
      ).rows[0];

      const passwordHash = await hashPassword(b.password);
      const user = (
        await client.query(
          `INSERT INTO users (business_id, name, email, password_hash, role)
           VALUES ($1,$2,$3,$4,'BUSINESS_OWNER') RETURNING *`,
          [biz.id, b.ownerName, b.ownerEmail, passwordHash]
        )
      ).rows[0];

      const store = (
        await client.query(
          `INSERT INTO stores (business_id, slug, name, phone, whatsapp, city)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [biz.id, slug, b.bizName, b.bizPhone || null, b.bizWhatsapp || null, b.city || null]
        )
      ).rows[0];

      const sub = (
        await client.query(
          `INSERT INTO subscriptions (business_id, plan_id, status) VALUES ($1,$2,'PENDING_PAYMENT') RETURNING *`,
          [biz.id, plan.id]
        )
      ).rows[0];

      await client.query(
        `INSERT INTO payments (business_id, subscription_id, plan_id, amount, method, reference, slip_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')`,
        [biz.id, sub.id, plan.id, plan.price, b.method || 'Bank transfer', b.ref || null, slipUrl]
      );

      await queueNotification(
        { businessId: biz.id, recipient: b.ownerEmail, ...templates.registered(biz) },
        client
      );

      return { biz, user, store };
    });

    res.status(201).json({
      business: { id: result.biz.id, name: result.biz.name, status: result.biz.status },
      store: { slug: result.store.slug },
      message: 'Application received. We will email you once your store is approved.',
    });
  })
);

// POST /api/auth/login
authRouter.post(
  '/login',
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw badRequest('Enter your email and password.');
    const user = (await query('SELECT * FROM users WHERE lower(email) = lower($1)', [email])).rows[0];
    if (!user) throw unauthorized('No account found with that email.');
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) throw unauthorized('Incorrect email or password.');

    // Attach the store slug + name for owners so the client can label the dashboard
    // and link straight to the storefront.
    let slug = null;
    let businessStatus = null;
    let storeName = null;
    let planId = null;
    if (user.business_id) {
      const b = (await query('SELECT name, status FROM businesses WHERE id = $1', [user.business_id])).rows[0];
      businessStatus = b ? b.status : null;
      storeName = b ? b.name : null;
      const s = (await query('SELECT slug, name FROM stores WHERE business_id = $1', [user.business_id])).rows[0];
      slug = s ? s.slug : null;
      if (s && s.name) storeName = s.name;
      const sub = (await query('SELECT plan_id FROM subscriptions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1', [user.business_id])).rows[0];
      planId = sub ? sub.plan_id : null;
    }

    res.json({
      token: signToken(user),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        business_id: user.business_id,
        slug,
        storeName,
        planId,
        businessStatus,
        permissions: user.role === 'BUSINESS_STAFF' ? (user.permissions || []) : null,
      },
    });
  })
);

// GET /api/auth/me — decode the token to the current user (used by the client on load).
authRouter.get('/me', wrap(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  const { verifyToken } = await import('../utils/auth.js');
  let claims;
  try { claims = verifyToken(token); } catch { throw unauthorized(); }
  res.json({ user: claims });
}));
