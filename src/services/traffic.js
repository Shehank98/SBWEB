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

// ---- "Where visitors came from" (Pro): fixed buckets, counts and percentages ----
export const BUCKETS = [
  ['direct', 'Direct'], ['whatsapp', 'WhatsApp'], ['facebook', 'Facebook'], ['instagram', 'Instagram'],
  ['google', 'Google'], ['tiktok', 'TikTok'], ['other', 'Other'],
];
const NAMED = new Set(BUCKETS.map(([k]) => k).filter((k) => k !== 'other'));
export const bucketOf = (source) => (!source || source === 'unknown' ? 'direct' : NAMED.has(source) ? source : 'other');

// Visitors (one per browser session) and orders per bucket between two instants.
export async function trafficBuckets(businessId, from, to) {
  const visits = (await query(
    `SELECT source, COUNT(DISTINCT COALESCE(session_id, id::text)) n FROM store_visits
      WHERE business_id = $1 AND visited_at >= $2 AND visited_at < $3 GROUP BY source`,
    [businessId, from, to]
  )).rows;
  const orders = (await query(
    `SELECT source, COUNT(*) n FROM orders
      WHERE business_id = $1 AND created_at >= $2 AND created_at < $3 AND status <> 'CANCELLED' GROUP BY source`,
    [businessId, from, to]
  )).rows;
  const agg = Object.fromEntries(BUCKETS.map(([k, label]) => [k, { key: k, label, visitors: 0, orders: 0 }]));
  for (const v of visits) agg[bucketOf(v.source)].visitors += Number(v.n);
  for (const o of orders) agg[bucketOf(o.source)].orders += Number(o.n);
  const total = Object.values(agg).reduce((n, b) => n + b.visitors, 0);
  const buckets = Object.values(agg)
    .map((b) => ({ ...b, pct: total ? Math.round((b.visitors / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.visitors - a.visitors || b.orders - a.orders || BUCKETS.findIndex(([k]) => k === a.key) - BUCKETS.findIndex(([k]) => k === b.key));
  return { total, orders: Object.values(agg).reduce((n, b) => n + b.orders, 0), buckets };
}
