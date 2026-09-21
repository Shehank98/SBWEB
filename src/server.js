import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { UPLOAD_DIR } from './services/uploads.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

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
});

// Graceful shutdown so Railway restarts cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

export default app;
