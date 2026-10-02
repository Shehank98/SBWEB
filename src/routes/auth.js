import { Router } from 'express';
import { setSessionCookie, clearSessionCookie } from '../services/session.js';
import { verifyToken } from '../utils/auth.js';
import multer from 'multer';
import { query, withTransaction } from '../db/pool.js';
import { hashPassword, verifyPassword, signToken } from '../utils/auth.js';
import { slugify } from '../utils/slug.js';
import { wrap, badRequest, unauthorized, conflict } from '../utils/http.js';
import { saveUpload, SLIP_TYPES } from '../services/uploads.js';

export const PRESETS = ['tea', 'sapphire', 'cinnamon', 'orchid', 'ink'];
export const TEMPLATES = ['classic', 'showcase', 'minimal', 'boutique', 'catalog', 'soft', 'night', 'quick', 'pop', 'link'];
import { queueNotification, templates } from '../services/notifications.js';
import { startTrial } from '../services/subscription.js';
import { ensurePolicies } from '../services/policies.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
export const authRouter = Router();

// POST /api/auth/register  (multipart: fields + optional payment slip file)
// Runs the whole registration flow atomically: user + business + store, then starts
// the free trial (Starter features, no approval needed) and queues the welcome email.
// The plan picked at signup is remembered as the preferred plan for after the trial.
// If the seller still sends a bank slip, a PENDING payment is recorded for the admin
// to approve (which converts the trial into that paid plan without losing trial days).
// GET /api/auth/slug-available?slug=my-shop — live check for the onboarding form.
authRouter.get(
  '/slug-available',
  wrap(async (req, res) => {
    const slug = slugify(req.query.slug || '');
    if (slug.length < 3) return res.json({ slug, available: false, reason: 'Use 3 or more letters or numbers.' });
    const taken = (await query('SELECT 1 FROM stores WHERE slug = $1', [slug])).rowCount > 0;
    res.json({ slug, available: !taken, reason: taken ? 'That link name is taken. Try adding your town.' : '' });
  })
);

authRouter.post(
  '/register',
  upload.fields([{ name: 'slip', maxCount: 1 }, { name: 'logo', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
  wrap(async (req, res) => {
    const b = req.body;
    const required = ['bizName', 'ownerName', 'ownerEmail', 'password', 'slug'];
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

    const plan = (await query("SELECT * FROM plans WHERE id = $1 AND status = 'ACTIVE'", [b.planId || 'starter'])).rows[0];
    if (!plan) throw badRequest('Unknown plan.');

    // A storage hiccup must never block a signup. If the slip upload fails we still
    // create the business + pending payment (without the slip) and log the error,
    // so the application always reaches the admin and the owner can re-send the slip.
    const file = (k) => (req.files && req.files[k] && req.files[k][0]) || null;
    // Same rule for the logo and cover photo chosen during onboarding: a failed upload
    // never blocks the signup; the seller can add them later in Store settings.
    async function tryUpload(f, folder, opts) {
      if (!f) return null;
      try { return await saveUpload(f, folder, opts); } catch (e) {
        console.error(`[register] ${folder} upload failed, continuing without it:`, e.message);
        return null;
      }
    }
    const slipUrl = await tryUpload(file('slip'), 'slips', { allow: SLIP_TYPES });
    const logoUrl = await tryUpload(file('logo'), `logos/${slug}`);
    const coverUrl = await tryUpload(file('cover'), `covers/${slug}`);
    const preset = PRESETS.includes(b.preset) ? b.preset : 'tea';
    const template = TEMPLATES.includes(b.template) ? b.template : 'classic';

    const result = await withTransaction(async (client) => {
      const biz = (
        await client.query(
          `INSERT INTO businesses (name, type, description, phone, whatsapp, email, address, city, district, facebook, instagram, status, preferred_plan_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'TRIAL',$12) RETURNING *`,
          [b.bizName, b.bizType || null, b.description || null, b.bizPhone || null, b.bizWhatsapp || null,
           b.ownerEmail, b.address || null, b.city || null, b.district || null, b.facebook || null, b.instagram || null, plan.id]
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
          `INSERT INTO stores (business_id, slug, name, phone, whatsapp, city, tagline, preset, template, logo_url, cover_url, contact_email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [biz.id, slug, (b.storeName && String(b.storeName).trim()) || b.bizName, b.bizPhone || null, b.bizWhatsapp || null, b.city || null,
           b.tagline ? String(b.tagline).trim().slice(0, 120) : null, preset, template, logoUrl, coverUrl, b.ownerEmail]
        )
      ).rows[0];

      const trial = await startTrial(client, biz.id);
      await ensurePolicies(biz.id, client);

      // Optional: the seller already paid by bank transfer. Record it for review.
      if (slipUrl || (b.ref && String(b.ref).trim())) {
        await client.query(
          `INSERT INTO payments (business_id, plan_id, amount, method, reference, slip_url, status)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING')`,
          [biz.id, plan.id, plan.price, b.method || 'Bank transfer', b.ref || null, slipUrl]
        );
      }

      await queueNotification(
        {
          businessId: biz.id,
          recipient: b.ownerEmail,
          dedupeKey: `TRIAL_STARTED:${biz.id}`,
          ...templates.trialStarted(biz, store, { days: trial.days, endsOn: trial.ends.toISOString().slice(0, 10) }),
        },
        client
      );

      return { biz, user, store, trial };
    });

    // Sign the new owner straight in: the trial starts now, no approval step.
    const u = result.user;
    const token = signToken(u);
    setSessionCookie(req, res, token);
    res.status(201).json({
      token,
      user: {
        id: u.id, name: u.name, email: u.email, role: u.role, business_id: u.business_id,
        slug: result.store.slug, storeName: result.store.name, planId: 'starter', businessStatus: 'TRIAL', permissions: null,
      },
      business: { id: result.biz.id, name: result.biz.name, status: 'TRIAL' },
      store: { slug: result.store.slug },
      trial: { days: result.trial.days, endsAt: result.trial.ends.toISOString() },
      message: `Your store is live. Your ${result.trial.days}-day free trial has started.`,
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

    const token = signToken(user);
    setSessionCookie(req, res, token);
    res.json({
      token,
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

// POST /api/auth/session (Bearer token): set the page cookie for a browser that
// signed in before page protection existed, so it is not sent back to login.
authRouter.post('/session', wrap(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let claims;
  try { claims = verifyToken(token); } catch { throw unauthorized('Your session has expired. Please sign in again.'); }
  setSessionCookie(req, res, token);
  res.json({ ok: true, role: claims.role });
}));

// POST /api/auth/logout: clear the page cookie.
authRouter.post('/logout', (req, res) => { clearSessionCookie(req, res); res.json({ ok: true }); });

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
