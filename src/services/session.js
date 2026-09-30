import path from 'path';
import { verifyToken } from '../utils/auth.js';

// Page protection. The API is authorised by the Bearer token the pages keep in
// localStorage, but a browser does not send that when it opens a page. So login
// also sets an httpOnly cookie holding the same signed token, and the server
// checks it before sending any admin or seller dashboard page. Without it the
// visitor is sent to the login page and never sees the panel.
export const SESSION_COOKIE = 'kade_session';
const DEMO_COOKIE = 'kade_demo';

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function cookieFlags(req) {
  return `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;
}

export function setSessionCookie(req, res, token) {
  let maxAge = 7 * 86400;
  try { const c = verifyToken(token); if (c.exp) maxAge = Math.max(0, c.exp - Math.floor(Date.now() / 1000)); } catch { /* keep default */ }
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; ${cookieFlags(req)}`);
}

export function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
}

export function sessionUser(req) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (!t) return null;
  try { return verifyToken(t); } catch { return null; }
}

// The request path as the file server will resolve it: decoded, slashes collapsed,
// "." and ".." resolved, lower-cased. So /%61dmin, //admin, /x/../admin and
// /ADMIN are all caught.
export function pagePath(req) {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch { return null; }
  if (p.includes('\0')) return null;
  return path.posix.normalize('/' + p.replace(/\\/g, '/')).toLowerCase();
}

const AREA = /^\/(admin|dashboard)(\/|\.html$|$)/;

export function pageGate() {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = pagePath(req);
    if (p == null) return res.status(400).end();
    const m = p.match(AREA);
    if (!m) return next();
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    const area = m[1];
    // The public demo is a sample seller dashboard with made-up data and no API
    // access. It never opens the admin panel.
    if (area === 'dashboard' && (parseCookies(req)[DEMO_COOKIE] === '1' || req.query.demo === '1')) return next();
    const u = sessionUser(req);
    const toLogin = () => res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
    if (!u) return toLogin();
    if (area === 'admin' && u.role !== 'SUPER_ADMIN') return res.redirect(302, '/dashboard/');
    if (area === 'dashboard' && u.role === 'SUPER_ADMIN') return res.redirect(302, '/admin/index');
    if (area === 'dashboard' && !u.business_id) return toLogin();
    next();
  };
}
