import { Router } from 'express';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { wrap, unauthorized, badRequest } from '../utils/http.js';

export const notificationsRouter = Router();

// The notifications outbox API is consumed by Google Apps Script (or any worker).
// It authenticates with a shared secret header so it does not need a user session.
// Set NOTIFY_TOKEN in the environment; if unset it falls back to JWT_SECRET.
function requireWorkerToken(req, _res, next) {
  const expected = process.env.NOTIFY_TOKEN || config.jwtSecret;
  const given = req.headers['x-notify-token'];
  if (!given || given !== expected) return next(unauthorized('Invalid worker token.'));
  next();
}

notificationsRouter.use(requireWorkerToken);

// GET /api/notifications/pending — the queue Apps Script polls.
notificationsRouter.get(
  '/pending',
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, type, recipient, subject, message, created_at
         FROM notifications WHERE status = 'PENDING' ORDER BY created_at LIMIT 50`
    );
    res.json({ notifications: rows });
  })
);

// POST /api/notifications/:id/sent — mark a row delivered.
notificationsRouter.post(
  '/:id/sent',
  wrap(async (req, res) => {
    const r = await query(`UPDATE notifications SET status='SENT', sent_at=now() WHERE id=$1`, [req.params.id]);
    if (!r.rowCount) throw badRequest('Notification not found.');
    res.json({ ok: true });
  })
);

// POST /api/notifications/:id/failed — mark a row failed (Apps Script can retry later).
notificationsRouter.post(
  '/:id/failed',
  wrap(async (req, res) => {
    await query(`UPDATE notifications SET status='FAILED' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  })
);
