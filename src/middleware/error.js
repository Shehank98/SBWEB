import { HttpError } from '../utils/http.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Route not found.' });
}

// Central error formatter. Known HttpErrors surface their message; everything else
// is logged and returned as a generic 500 so internals never leak to clients.
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // Postgres unique-violation -> 409 with a friendly message.
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'That value is already taken.' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
