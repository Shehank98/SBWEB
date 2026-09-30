// Cache busting for the static frontend. Every HTML page is sent with its local
// script and stylesheet URLs tagged "?v=<version>", so after a deploy browsers
// fetch the new JS and CSS instead of pairing a new page with an old cached
// app.js (which left pages stuck on "Loading…" when a new helper was missing).
// Version = the deployed git commit on Railway, else the server start time.
import fs from 'fs';
import path from 'path';

export const ASSET_VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || '').slice(0, 10) || Date.now().toString(36);

const ASSET_RE = /((?:src|href)=["'])((?:\.\.\/|\.\/|\/)*(?:js|css)\/[^"'?#]+\.(?:js|css))(["'])/g;
export const versionAssets = (html) => html.replace(ASSET_RE, `$1$2?v=${ASSET_VERSION}$3`);

// Resolve a request path to an HTML file inside the frontend folder (clean URLs:
// /dashboard/orders -> dashboard/orders.html, /admin/ -> admin/index.html).
export function htmlFileFor(root, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0')) return null;
  const candidates = p.endsWith('/') ? [p + 'index.html'] : path.extname(p) ? (p.endsWith('.html') ? [p] : []) : [p + '.html', p + '/index.html'];
  for (const c of candidates) {
    const full = path.join(root, c);
    if (!full.startsWith(root + path.sep)) continue; // no escaping the folder
    try { if (fs.statSync(full).isFile()) return full; } catch { /* next */ }
  }
  return null;
}

// Cached by file + modified time, so edits show up without a restart.
const cache = new Map();
export function readVersioned(full) {
  const mtime = fs.statSync(full).mtimeMs;
  const hit = cache.get(full);
  if (hit && hit.mtime === mtime) return hit.html;
  const html = versionAssets(fs.readFileSync(full, 'utf8'));
  cache.set(full, { mtime, html });
  return html;
}

export function sendVersioned(res, full) {
  if (!res.get('Cache-Control')) res.set('Cache-Control', 'no-cache');
  res.type('html').send(readVersioned(full));
}
