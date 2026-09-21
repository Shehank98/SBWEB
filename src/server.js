import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { UPLOAD_DIR } from './services/uploads.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { query } from './db/pool.js';
import { hashPassword } from './utils/auth.js';

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
const FRONTEND_DIR = path.join(__dirname, '..', 'kade-frontend_V2');

import { authRouter } from './routes/auth.js';
import { plansRouter } from './routes/plans.js';
import { adminRouter } from './routes/admin.js';
import { productsRouter } from './routes/products.js';
import { dashboardRouter } from './routes/dashboard.js';
import { storeRouter } from './routes/store.js';
import { notificationsRouter } from './routes/notifications.js';

const app = express();

app.use(
  cors({
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
  })
);
app.use(express.json({ limit: '1mb' }));

// Serve locally-stored uploads (product photos / payment slips) when UPLOAD_DRIVER=local.
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRouter);
app.use('/api/plans', plansRouter);
app.use('/api/admin', adminRouter);
app.use('/api/products', productsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/store', storeRouter);
app.use('/api/notifications', notificationsRouter);

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

// Serve the frontend (landing, storefront, dashboard, admin) from the same origin.
// This makes the whole platform a single deployable service: the pages call the API
// at a relative path, so there is no CORS and no second service to run.
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

// Unknown /api routes -> JSON 404; everything else falls through to the frontend 404.
app.use('/api', notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`[kade] API listening on http://localhost:${config.port}`);
  // Ensure the platform admin exists, from env vars (ADMIN_EMAIL / ADMIN_PASSWORD).
  // Runs every boot so changing the Railway variables updates the admin login.
  ensureAdmin().catch((e) => console.warn('[admin] ensureAdmin skipped:', e.message));
});

// Graceful shutdown so Railway restarts cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

export default app;
