// Weekly seller summary: every Monday morning (Sri Lanka time) each seller gets last
// week's revenue, orders, top products and traffic sources. The digest is stored in
// seller_digests first (channel-neutral), then delivered by email; WhatsApp/SMS can
// later read the same rows and record their own delivery status.
import { query } from '../db/pool.js';
import { queueNotification, templates } from './notifications.js';
import { trafficSources } from './traffic.js';
import { slNow } from '../utils/time.js';

const DAY = 86400000;
const SL = 5.5 * 3600 * 1000;

// Previous Monday 00:00 to this Monday 00:00, Sri Lanka time, as real instants.
export function lastWeekRange(now = new Date()) {
  const t = slNow(now);
  const dow = t.getUTCDay() || 7; // Mon=1..Sun=7
  const thisMondaySl = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - (dow - 1) * DAY;
  const to = new Date(thisMondaySl - SL);
  const from = new Date(to.getTime() - 7 * DAY);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from, to, startDate: iso(thisMondaySl - 7 * DAY), endDate: iso(thisMondaySl - DAY) };
}

async function weekNumbers(businessId, from, to) {
  const t = (await query(
    // Net of refunds (partial refunds keep the rest), like the Reports page.
    `SELECT COALESCE(SUM(CASE WHEN status = 'REFUNDED' THEN GREATEST(total - COALESCE(refund_amount, total), 0) ELSE total END),0) revenue,
            COUNT(*) FILTER (WHERE status <> 'REFUNDED' OR COALESCE(refund_amount, total) < total) orders
       FROM orders
      WHERE business_id=$1 AND created_at >= $2 AND created_at < $3 AND status <> 'CANCELLED'`,
    [businessId, from, to]
  )).rows[0];
  return { revenue: Number(t.revenue), orders: Number(t.orders) };
}

export async function buildDigest(businessId, range) {
  const cur = await weekNumbers(businessId, range.from, range.to);
  const prev = await weekNumbers(businessId, new Date(range.from.getTime() - 7 * DAY), range.from);
  const top = (await query(
    `SELECT split_part(oi.name, ' (', 1) AS name, SUM(oi.qty) units, SUM(oi.qty * oi.price) revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.business_id=$1 AND o.created_at >= $2 AND o.created_at < $3 AND o.status NOT IN ('CANCELLED','REFUNDED')
      GROUP BY 1 ORDER BY units DESC, revenue DESC LIMIT 5`,
    [businessId, range.from, range.to]
  )).rows.map((r) => ({ name: r.name, units: Number(r.units), revenue: Number(r.revenue) }));
  const sources = await trafficSources(businessId, range.from, range.to, 5);
  const visits = Number((await query(
    'SELECT COUNT(DISTINCT session_id) n FROM store_visits WHERE business_id=$1 AND visited_at >= $2 AND visited_at < $3',
    [businessId, range.from, range.to]
  )).rows[0].n);
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  return {
    periodStart: range.startDate, periodEnd: range.endDate,
    revenue: cur.revenue, orders: cur.orders, avgOrder: cur.orders ? Math.round(cur.revenue / cur.orders) : 0,
    revenueChangePct: pct(cur.revenue, prev.revenue), ordersChangePct: pct(cur.orders, prev.orders),
    visitors: visits, topProducts: top, trafficSources: sources,
  };
}

// The weekly job. Returns a summary for the job log.
export async function runWeeklySummary(now = new Date()) {
  const range = lastWeekRange(now);
  const shops = (await query(
    `SELECT b.id, b.name, b.email, s.slug, s.name store_name, s.digest_channels,
            COALESCE((pl.feature_flags->>'traffic_sources')::boolean, false) AS traffic_ok
       FROM businesses b JOIN stores s ON s.business_id = b.id
       LEFT JOIN LATERAL (SELECT plan_id FROM subscriptions WHERE business_id = b.id ORDER BY created_at DESC LIMIT 1) sub ON true
       LEFT JOIN plans pl ON pl.id = sub.plan_id
      WHERE b.status IN ('ACTIVE','EXPIRING','GRACE_PERIOD','TRIAL')
        AND s.weekly_summary_enabled
        AND COALESCE((pl.feature_flags->>'weekly_summary')::boolean, true)`
  )).rows;
  let sent = 0;
  for (const s of shops) {
    const digest = await buildDigest(s.id, range);
    // Visitor sources are a Pro feature: other plans get a teaser, not the data.
    if (!s.traffic_ok) { digest.trafficSources = []; digest.trafficLocked = true; }
    const channels = s.digest_channels || { email: true };
    const deliveries = { email: channels.email === false ? 'SKIPPED' : 'QUEUED', whatsapp: channels.whatsapp ? 'NOT_BUILT' : 'SKIPPED', sms: channels.sms ? 'NOT_BUILT' : 'SKIPPED' };
    const ins = await query(
      `INSERT INTO seller_digests (business_id, period_start, period_end, payload, deliveries) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (business_id, period_start) DO NOTHING RETURNING id`,
      [s.id, range.startDate, range.endDate, JSON.stringify(digest), JSON.stringify(deliveries)]
    );
    if (!ins.rowCount || deliveries.email !== 'QUEUED') continue;
    const row = await queueNotification({
      businessId: s.id, recipient: s.email, dedupeKey: `WEEKLY:${s.id}:${range.startDate}`,
      ...templates.weeklySummary({ name: s.store_name || s.name, slug: s.slug }, digest),
    });
    if (row) sent += 1;
  }
  return { weeklyShops: shops.length, weeklyEmails: sent, week: range.startDate };
}
