import { query } from '../db/pool.js';
import { cardAvailability } from './gateways.js';

// Store setup progress. One weighted score shared by the welcome screen, the
// dashboard card and Store settings, so every screen shows the same number.
// Important steps weigh more (a first product counts for more than Instagram),
// and optional extras (card payments, weekly email) never lower the score.
//
//   Essential (85%): the store can take orders once all of these are done.
//   Recommended (15%): makes the store look complete and trustworthy.
//   Optional (0%): nice to have; shown, but never counted against the seller.
const ITEMS = [
  { key: 'info', level: 'essential', area: 'info', weight: 15, label: 'Store information', tip: 'Add your shop description, phone or WhatsApp, and address so buyers can reach you.', href: 'settings#info' },
  { key: 'logo', level: 'essential', area: 'appearance', weight: 10, label: 'Store logo', tip: 'Add your logo so buyers recognise your shop.', href: 'settings#appearance' },
  { key: 'category', level: 'essential', area: 'categories', weight: 10, label: 'Product category', tip: 'Create a category so buyers can browse your products.', href: 'settings#categories' },
  { key: 'product', level: 'essential', area: 'products', weight: 20, label: 'First product', tip: 'Add your first product with a photo and price.', href: 'products?new=1' },
  { key: 'delivery', level: 'essential', area: 'delivery', weight: 15, label: 'Delivery settings', tip: 'Check your delivery fee and pickup option.', href: 'settings#delivery' },
  { key: 'payment', level: 'essential', area: 'payments', weight: 15, label: 'Payment method', tip: 'Choose how buyers pay you: cash on delivery or bank transfer.', href: 'settings#payments' },
  { key: 'cover', level: 'recommended', area: 'appearance', weight: 5, label: 'Store cover photo', tip: 'Add a cover photo to make your store look more professional.', href: 'settings#appearance' },
  { key: 'social', level: 'recommended', area: 'info', weight: 5, label: 'Social media', tip: 'Link your Facebook or Instagram page so buyers can follow you.', href: 'settings#info' },
  { key: 'verification', level: 'recommended', area: 'verification', weight: 5, label: 'Business verification', tip: 'Get the Verified Sri Lankan Business badge to build trust.', href: 'settings#verification' },
  { key: 'moreCategories', level: 'optional', area: 'categories', weight: 0, label: '3 or more categories', tip: 'More categories make a bigger store easier to browse.', href: 'settings#categories' },
  { key: 'bothPayments', level: 'optional', area: 'payments', weight: 0, label: 'Cash on delivery and bank transfer', tip: 'Offer both so every buyer can pay the way they like.', href: 'settings#payments' },
  { key: 'card', level: 'optional', area: 'card', weight: 0, label: 'Card payments with OnePay', tip: 'Accept cards through your own OnePay account.', href: 'settings#card' },
  { key: 'weekly', level: 'optional', area: 'notifications', weight: 0, label: 'Weekly sales summary', tip: 'Get last week\'s sales in your email every Monday.', href: 'settings#notifications' },
];
export const SETUP_WEIGHTS = Object.fromEntries(ITEMS.map((i) => [i.key, i.weight]));

const filled = (v) => !!String(v || '').trim();

export async function storeSetup(businessId) {
  const [st, biz, counts, card] = await Promise.all([
    query('SELECT * FROM stores WHERE business_id = $1', [businessId]).then((r) => r.rows[0] || {}),
    query('SELECT facebook, instagram, verification_status FROM businesses WHERE id = $1', [businessId]).then((r) => r.rows[0] || {}),
    query(`SELECT (SELECT COUNT(*) FROM categories WHERE business_id = $1)::int AS cats,
                  (SELECT COUNT(*) FROM products WHERE business_id = $1)::int AS products`, [businessId]).then((r) => r.rows[0]),
    cardAvailability(businessId).catch(() => ({ available: false })),
  ]);
  const bank = st.bank_account || {};
  const bankReady = !!st.pay_bank && filled(bank.bankName) && filled(bank.accountNo);
  const done = {
    info: filled(st.name) && (filled(st.about) || filled(st.tagline)) && (filled(st.phone) || filled(st.whatsapp)) && filled(st.address),
    logo: filled(st.logo_url),
    category: counts.cats >= 1,
    product: counts.products >= 1,
    delivery: !!st.delivery_set_at,
    payment: !!st.payments_set_at && (!!st.pay_cod || bankReady),
    cover: filled(st.cover_url),
    social: filled(biz.facebook) || filled(biz.instagram),
    verification: ['PENDING', 'VERIFIED'].includes(biz.verification_status),
    moreCategories: counts.cats >= 3,
    bothPayments: !!st.pay_cod && bankReady,
    card: !!card.available,
    weekly: st.weekly_summary_enabled !== false,
  };
  const items = ITEMS.map((i) => ({ ...i, done: !!done[i.key] }));
  const percent = items.reduce((n, i) => n + (i.done ? i.weight : 0), 0);
  const essential = items.filter((i) => i.level === 'essential');
  const weighted = items.filter((i) => i.weight > 0);
  // Next step: the first unfinished essential, then recommended, then optional.
  const next = items.find((i) => !i.done && i.level === 'essential') || items.find((i) => !i.done && i.level === 'recommended') || items.find((i) => !i.done) || null;
  // Per-area status for the Store settings cards (weighted steps only).
  const areas = {};
  for (const i of weighted) {
    const a = areas[i.area] || (areas[i.area] = { total: 0, done: 0 });
    a.total += i.weight; if (i.done) a.done += i.weight;
  }
  for (const k of Object.keys(areas)) {
    const a = areas[k];
    a.percent = Math.round((a.done / a.total) * 100);
    a.status = a.percent === 100 ? 'complete' : a.percent === 0 ? 'todo' : 'partial';
  }
  return {
    percent,
    ready: essential.every((i) => i.done),            // can take orders
    complete: percent === 100,                        // every weighted step done
    stepsDone: weighted.filter((i) => i.done).length,
    stepsTotal: weighted.length,
    next: next && { key: next.key, label: next.label, tip: next.tip, href: next.href, level: next.level },
    items: items.map(({ key, level, area, weight, label, tip, href, done: d }) => ({ key, level, area, weight, label, tip, href, done: d })),
    areas,
    slug: st.slug,
  };
}
