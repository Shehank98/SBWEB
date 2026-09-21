import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { UPLOAD_DIR } from './services/uploads.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

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

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`[kade] API listening on http://localhost:${config.port}`);
});

// Graceful shutdown so Railway restarts cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

export default app;
