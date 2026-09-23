// Server-rendered social link previews for storefronts and product pages.
// Social scrapers (WhatsApp, Facebook, Twitter) do not run the page's JavaScript,
// so we inject Open Graph / Twitter meta tags (store name, product name, image)
// into the HTML <head> before sending it. The page's own JS still renders the body.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/pool.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.join(__dirname, '..', '..', 'kade-frontend_V2', 'store');
const BASE = (config.publicBaseUrl || '').replace(/\/$/, '');
const DEFAULT_IMG = BASE + '/assets/logo.png';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fileCache = {};
function readPage(file) {
  if (!fileCache[file]) fileCache[file] = fs.readFileSync(path.join(STORE_DIR, file), 'utf8');
  return fileCache[file];
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function truncate(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function withMeta(file, og) {
  const t = esc(og.title);
  const d = esc(truncate(og.description, 200));
  const tags =
    `<title>${t}</title>\n` +
    `  <meta name="description" content="${d}">\n` +
    `  <meta property="og:type" content="${og.type || 'website'}">\n` +
    `  <meta property="og:site_name" content="Sidadiya">\n` +
    `  <meta property="og:title" content="${t}">\n` +
    `  <meta property="og:description" content="${d}">\n` +
    `  <meta property="og:url" content="${esc(og.url)}">\n` +
    `  <meta property="og:image" content="${esc(og.image)}">\n` +
    `  <meta name="twitter:card" content="summary_large_image">\n` +
    `  <meta name="twitter:title" content="${t}">\n` +
    `  <meta name="twitter:description" content="${d}">\n` +
    `  <meta name="twitter:image" content="${esc(og.image)}">`;
  // Drop the page's own <title>, then place our tags right after <head> so scrapers
  // read them first.
  return readPage(file).replace(/<title>[\s\S]*?<\/title>\s*/i, '').replace(/<head>/i, `<head>\n  ${tags}`);
}

export async function serveStorePage(req, res, next, slug) {
  try {
    if (!slug) return res.type('html').send(readPage('index.html'));
    const st = (
      await query(
        `SELECT s.name, s.tagline, s.about, s.logo_url FROM stores s
           JOIN businesses b ON b.id = s.business_id WHERE s.slug = $1`,
        [String(slug)]
      )
    ).rows[0];
    if (!st) return res.type('html').send(readPage('index.html'));
    res.type('html').send(
      withMeta('index.html', {
        title: `${st.name} | Sidadiya`,
        description: st.tagline || st.about || `Shop online at ${st.name}.`,
        url: `${BASE}/store/${encodeURIComponent(slug)}`,
        image: st.logo_url || DEFAULT_IMG,
        type: 'website',
      })
    );
  } catch (e) { next(e); }
}

export async function serveProductPage(req, res, next) {
  try {
    const slug = req.query.s;
    const pid = req.query.p;
    if (!slug || !pid || !UUID.test(String(pid))) return res.type('html').send(readPage('product.html'));
    const row = (
      await query(
        `SELECT p.name, p.description, p.price, p.sale_price, p.image_url, p.images,
                s.name AS store_name, s.logo_url
           FROM products p JOIN stores s ON s.business_id = p.business_id
          WHERE s.slug = $1 AND p.id = $2 AND p.status = 'ACTIVE'`,
        [String(slug), String(pid)]
      )
    ).rows[0];
    if (!row) return res.type('html').send(readPage('product.html'));
    const price = row.sale_price != null ? row.sale_price : row.price;
    const image = row.image_url || (Array.isArray(row.images) && row.images[0]) || row.logo_url || DEFAULT_IMG;
    res.type('html').send(
      withMeta('product.html', {
        title: `${row.name} - ${row.store_name} | Sidadiya`,
        description: row.description || `Rs. ${price} at ${row.store_name}.`,
        url: `${BASE}/store/product?s=${encodeURIComponent(slug)}&p=${encodeURIComponent(pid)}`,
        image,
        type: 'product',
      })
    );
  } catch (e) { next(e); }
}
