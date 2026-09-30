import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { UPLOAD_DIR, verifyPrivateRequest } from './services/uploads.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { query } from './db/pool.js';
import { bootstrapDb } from './db/bootstrap.js';
import { hashPassword } from './utils/auth.js';
import { startScheduler } from './jobs/scheduler.js';

// Create or update the SUPER_ADMIN account from environment variables, so admin
// credentials live in the deployment's variables (never hard-coded or exposed).
async function ensureAdmin() {
  const { email, password, name } = config.admin;
  if (!email || !password) return;
  const hash = await hashPassword(password);
  const existing = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.rowCount) {
    await query("UPDATE users SET password_hash=$2, name=$3, role='SUPER_ADMIN', business_id=NULL WHERE lower(email)=lower($1)", [email, hash, name]);
  } else {
    await query("INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'SUPER_ADMIN')", [name, email, hash]);
  }
  console.log(`[admin] ensured admin account for ${email}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, '..', config.frontendDir);

import { authRouter } from './routes/auth.js';
import { plansRouter } from './routes/plans.js';
import { adminRouter } from './routes/admin.js';
import { productsRouter } from './routes/products.js';
import { dashboardRouter } from './routes/dashboard.js';
import { storeRouter } from './routes/store.js';
import { notificationsRouter } from './routes/notifications.js';
import { siteRouter } from './routes/site.js';
import { publicRouter } from './routes/public.js';
import { onepayRouter } from './routes/onepay.js';
import { serveStorePage, serveProductPage } from './services/pages.js';
import { sendVersioned, htmlFileFor, ASSET_VERSION } from './services/assetVersion.js';
import fs from 'fs';
import { maintenanceGate } from './services/maintenance.js';

const app = express();
// Behind Railway's proxy: trust it so req.ip reflects the real client (used by the
// login rate limiter below).
app.set('trust proxy', 1);

// Baseline security headers on every response.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');       // don't sniff uploads as HTML/SVG
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');           // clickjacking
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

app.use(
  cors({
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
  })
);
app.use(express.json({ limit: '1mb' }));

// Maintenance mode: an admin switch that shows the "shop is closed" page to everyone else.
app.use(maintenanceGate(FRONTEND_DIR));

// Serve locally-stored uploads (product photos / payment slips) when UPLOAD_DRIVER=local.
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Local-driver signed links for PRIVATE files (verification documents). The HMAC
// signature and expiry in the query are the authorisation, like a cloud signed URL.
app.get('/api/files/private', (req, res) => {
  const file = verifyPrivateRequest(req.query.key, req.query.exp, req.query.sig);
  if (!file) return res.status(403).json({ error: 'This link has expired. Open the document again from the admin panel.' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.sendFile(file);
});

// Simple in-memory rate limit for login, to blunt password brute-forcing.
const loginHits = new Map();
function loginLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = 20;
  if (loginHits.size > 10000) loginHits.clear();
  let rec = loginHits.get(ip);
  if (!rec || now - rec.t > windowMs) rec = { c: 0, t: now };
  rec.c += 1;
  loginHits.set(ip, rec);
  if (rec.c > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  next();
}
app.use('/api/auth/login', loginLimiter);

app.use('/api/auth', authRouter);
app.use('/api/plans', plansRouter);
app.use('/api/admin', adminRouter);
app.use('/api/products', productsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/store', storeRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/site', siteRouter);
// Buyer tracking page + 30-day digital receipt (public, token-addressed).
app.use('/api', publicRouter);
// OnePay webhook (JSON per the spec; form-encoded accepted too) and buyer return page.
app.use('/api/onepay', express.urlencoded({ extended: false, limit: '100kb' }), onepayRouter);

// Clean URLs: never expose ".html". Redirect any .html request to the extensionless
// path (301), and let express.static resolve the extensionless path back to the file.
app.get(/\.html$/i, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  let clean = req.path.replace(/\.html$/i, '');
  if (clean.endsWith('/index')) clean = clean.slice(0, -'/index'.length) || '/';
  if (clean === '/index') clean = '/';
  const qs = req.originalUrl.slice(req.path.length); // preserve ?query
  res.redirect(301, clean + qs);
});

// Storefront and product pages: served with server-side social link previews
// (Open Graph / Twitter meta with the store name, product name and image) so a
// shared link shows the shop, not a generic page. Registered before the static
// middleware so they take precedence over the raw files. The page's own JS still
// renders the body. Pretty URL /store/<slug> also resolves the storefront here.
const RESERVED_STORE = new Set(['index', 'product', 'cart', 'order', 'policy']);
app.get('/store/product', (req, res, next) => serveProductPage(req, res, next));
app.get(['/store', '/store/index'], (req, res, next) => serveStorePage(req, res, next, req.query.s));
app.get('/store/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (slug.includes('.') || RESERVED_STORE.has(slug)) return next(); // real files handled by static
  serveStorePage(req, res, next, slug);
});

// Buyer pages addressed by private tokens: never indexed or cached.
app.get('/track/:code', (_req, res) => { res.set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' }); sendVersioned(res, path.join(FRONTEND_DIR, 'track.html')); });
app.get('/receipt/:token', (_req, res) => { res.set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' }); sendVersioned(res, path.join(FRONTEND_DIR, 'receipt.html')); });

// Service worker (offline / server-down fallback page). Tagged with the deploy
// version so browsers pick up a new "closed" page after every deploy.
const SW_SRC = fs.readFileSync(path.join(FRONTEND_DIR, 'sw.js'), 'utf8').replace('__VERSION__', ASSET_VERSION);
app.get('/sw.js', (_req, res) => { res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/javascript; charset=utf-8' }); res.send(SW_SRC); });
app.get('/closed', (_req, res) => { res.set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-cache' }); sendVersioned(res, path.join(FRONTEND_DIR, 'closed.html')); });

// Platform legal pages: /legal/refund, /legal/privacy, /legal/return, /legal/terms, /legal/contact.
app.get(/^\/legal\/(refund|privacy|return|terms|contact)\/?$/, (_req, res) => sendVersioned(res, path.join(FRONTEND_DIR, 'legal', 'index.html')));

// Serve the frontend (landing, storefront, dashboard, admin) from the same origin.
// This makes the whole platform a single deployable service: the pages call the API
// at a relative path, so there is no CORS and no second service to run.
// Every other HTML page: sent with version-tagged JS/CSS links (cache busting).
app.get(/^(?!\/api\/|\/uploads\/).*/, (req, res, next) => {
  const file = htmlFileFor(FRONTEND_DIR, req.path === '/' ? '/index.html' : req.path);
  if (!file) return next();
  sendVersioned(res, file);
});
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));
app.get('/', (_req, res) => sendVersioned(res, path.join(FRONTEND_DIR, 'index.html')));

// Unknown /api routes -> JSON 404; everything else falls through to the frontend 404.
app.use('/api', notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, async () => {
  console.log(`[kade] API listening on http://localhost:${config.port}`);
  // Surface the file-storage config so it's obvious in the deploy logs whether
  // uploads (payment slips, product photos) go to Firebase or the local disk.
  if (config.uploadDriver === 'firebase') {
    console.log(`[uploads] driver=firebase bucket=${config.firebase.bucket || '(FIREBASE_STORAGE_BUCKET not set!)'}`);
  } else {
    console.log('[uploads] driver=local — files save to ./uploads and are LOST on redeploy. Set UPLOAD_DRIVER=firebase for permanent storage.');
  }
  if (config.jwtSecret === 'dev-insecure-secret-change-me') {
    console.warn('[security] JWT_SECRET is the INSECURE DEFAULT. Anyone could forge login tokens. Set a long random JWT_SECRET before going live!');
  }
  // Prepare the database on boot: apply the schema (idempotent) and seed demo data
  // if empty, then ensure the admin from env vars. This makes a fresh deploy work
  // without running any manual db commands.
  try {
    await bootstrapDb();
    // Daily lifecycle + weekly summary. Needs the migrated schema, so start after bootstrap.
    startScheduler();
  } catch (e) {
    console.error('[db] bootstrap failed:', e.message);
  }
  ensureAdmin().catch((e) => console.warn('[admin] ensureAdmin skipped:', e.message));
});

// Graceful shutdown so Railway restarts cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

export default app;
