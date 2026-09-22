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
      `SELECT id, type, recipient, subject, message, data, created_at
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

// POST /api/notifications/:id/failed — record a failed attempt. The row stays
// PENDING (so the next run retries it) until it has failed several times, then
// it is parked as FAILED. `attempts` gives the admin an audit trail either way.
notificationsRouter.post(
  '/:id/failed',
  wrap(async (req, res) => {
    const r = await query(
      `UPDATE notifications
          SET attempts = attempts + 1,
              status = CASE WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'PENDING' END
        WHERE id=$1
        RETURNING attempts, status`,
      [req.params.id]
    );
    res.json({ ok: true, attempts: r.rows[0] ? r.rows[0].attempts : null, status: r.rows[0] ? r.rows[0].status : null });
  })
);
