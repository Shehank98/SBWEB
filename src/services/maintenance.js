import path from 'path';
import { getSetting } from './settings.js';
import { verifyToken } from '../utils/auth.js';
import { readVersioned } from './assetVersion.js';

// Maintenance mode (Admin Settings > Maintenance). While it is on, buyers and
// sellers get the animated "shop is closed" page (HTTP 503) and API calls get a
// 503 JSON reply. Admins, login, payment webhooks and the email outbox keep
// working, so payments are not lost and the admin can switch it back off.
export async function maintenanceState() {
  try {
    const m = await getSetting('maintenance', null);
    return m && m.on ? m : null;
  } catch {
    return null; // database down: never lock the site because of the check itself
  }
}

const OPEN = [
  /^\/api\/(health|auth|admin|site|onepay|notifications)(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/login\/?$/,
  /^\/(css|js|img|assets|fonts|uploads|shots)\//,
  /^\/(favicon\.svg|sw\.js|closed|robots\.txt)$/,
];

function isAdmin(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  try { return verifyToken(h.slice(7)).role === 'SUPER_ADMIN'; } catch { return false; }
}

export function publicMaintenance(m) {
  return m ? { on: true, message: m.message || '', until: m.until || null } : null;
}

export function maintenanceGate(frontendDir) {
  const page = path.join(frontendDir, 'closed.html');
  return async (req, res, next) => {
    if (OPEN.some((re) => re.test(req.path))) return next();
    const m = await maintenanceState();
    if (!m || isAdmin(req)) return next();
    res.set({ 'Retry-After': '300', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Sidadiya-Maintenance': '1' });
    const body = { maintenance: publicMaintenance(m), error: 'Sidadiya is closed for maintenance. Please try again soon.' };
    if (req.path.startsWith('/api/') || req.method !== 'GET' || !req.accepts('html')) return res.status(503).json(body);
    const data = JSON.stringify(body.maintenance).replace(/</g, '\\u003c');
    res.status(503).type('html').send(readVersioned(page).replace('</head>', `<script>window.SIDADIYA_MAINT=${data};</script></head>`));
  };
}
