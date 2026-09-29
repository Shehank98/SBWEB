// Storefront traffic sources: classify a visit, record it, and summarise sources.
import { query } from '../db/pool.js';

const KNOWN = [
  [/(^|\.)(facebook|fb)\.com$|(^|\.)fb\.me$|^l\.facebook\.com$|^m\.facebook\.com$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp'],
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)(bing\.com|duckduckgo\.com|yahoo\.com)$/, 'search'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'x'],
];
const clean = (v, n = 60) => (v == null ? null : String(v).trim().toLowerCase().replace(/[^\w.\-+ ]/g, '').slice(0, n) || null);

// utm_source wins; else the referrer host; else "direct". Visits referred by our own
// site (moving between pages of the store) are not new visits: returns null.
export function classify({ referrer, utmSource, utmMedium, utmCampaign, ownHost }) {
  let host = null;
  try { host = referrer ? new URL(referrer).hostname.toLowerCase().replace(/^www\./, '') : null; } catch { host = null; }
  const utm = clean(utmSource);
  if (!utm && host && ownHost && (host === ownHost || host.endsWith('.' + ownHost))) return null;
  let source = utm;
  if (!source && host) source = (KNOWN.find(([re]) => re.test(host)) || [])[1] || host;
  if (source) for (const [re, name] of KNOWN) if (re.test(source) || source === name) { source = name; break; }
  if (source && /^(fb|facebook\.com|ig)$/.test(source)) source = source === 'ig' ? 'instagram' : 'facebook';
  return { source: source || 'direct', medium: clean(utmMedium), campaign: clean(utmCampaign, 80), referrerHost: host };
}

export async function recordVisit(businessId, v) {
  await query(
    `INSERT INTO store_visits (business_id, page, source, medium, campaign, referrer_host, session_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [businessId, v.page, v.source, v.medium, v.campaign, v.referrerHost, v.sessionId]
  );
}

// Visits, sessions and orders by source between two instants.
export async function trafficSources(businessId, from, to, limit = 6) {
  const visits = (await query(
    `SELECT source, COUNT(*) visits, COUNT(DISTINCT session_id) sessions FROM store_visits
      WHERE business_id = $1 AND visited_at >= $2 AND visited_at < $3 GROUP BY source ORDER BY COUNT(DISTINCT session_id) DESC, COUNT(*) DESC LIMIT $4`,
    [businessId, from, to, limit]
  )).rows;
  const orders = (await query(
    `SELECT COALESCE(source, 'unknown') source, COUNT(*) n FROM orders
      WHERE business_id = $1 AND created_at >= $2 AND created_at < $3 AND status <> 'CANCELLED' GROUP BY 1`,
    [businessId, from, to]
  )).rows;
  const byOrders = Object.fromEntries(orders.map((o) => [o.source, Number(o.n)]));
  return visits.map((v) => ({ source: v.source, visits: Number(v.visits), sessions: Number(v.sessions), orders: byOrders[v.source] || 0 }));
}
