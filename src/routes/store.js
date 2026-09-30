import { Router } from 'express';
import multer from 'multer';
import { savePrivate, SLIP_TYPES } from '../services/uploads.js';
import { clip } from '../utils/text.js';
import { publicBuyerNotice } from '../services/buyerNotice.js';
import { query, withTransaction } from '../db/pool.js';
import { wrap, badRequest, notFound, HttpError } from '../utils/http.js';
import { orderCode } from '../utils/slug.js';
import * as S from '../services/serialize.js';
import { queueNotification, templates } from '../services/notifications.js';
import { trackPath, receiptPath } from '../services/orderLinks.js';
import { saveBuyerReviews } from '../services/reviews.js';
import { evalCoupon } from '../services/coupons.js';
import { LIVE_STATUSES } from '../services/plan.js';
import { POLICY_KINDS, TITLES, loadPolicies } from '../services/policies.js';
import { cardAvailability, shopOnePayCreds } from '../services/gateways.js';
import { createCheckout, toE164, splitName } from '../services/onepay.js';
import { returnUrl, settleFailure } from '../services/cardPayments.js';
import { classify, recordVisit } from '../services/traffic.js';
import { config } from '../config.js';

const OWN_HOST = (() => { try { return new URL(config.publicBaseUrl).hostname.replace(/^www\./, ''); } catch { return null; } })();
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|preview|curl|wget|headless/i;
// Tiny per-IP limiter for the visit beacon (best effort, in memory).
const beaconHits = new Map();
function beaconAllowed(ip) {
  const now = Date.now(), w = 60000;
  if (beaconHits.size > 20000) beaconHits.clear();
  const r = beaconHits.get(ip) || { c: 0, t: now };
  if (now - r.t > w) { r.c = 0; r.t = now; }
  r.c += 1; beaconHits.set(ip, r);
  return r.c <= 60;
}
import { randomBytes } from 'crypto';

export const storeRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Statuses in which the storefront is visible to customers (includes TRIAL; a
// TRIAL_EXPIRED shop is locked for buyers until the seller pays).
const LIVE = LIVE_STATUSES;

async function loadStore(slug) {
  const row = (
    await query(
      `SELECT st.*, b.status AS business_status, b.id AS biz_id, b.name AS biz_name, b.email AS biz_email, b.verification_status, b.facebook, b.instagram
         FROM stores st JOIN businesses b ON b.id = st.business_id
        WHERE st.slug = $1`,
      [slug]
    )
  ).rows[0];
  if (!row) throw notFound('Store not found.');
  return row;
}

// GET /api/store/:slug — store profile + products. Suspended stores return 200 with
// status so the frontend can show its "temporarily unavailable" page.
storeRouter.get(
  '/:slug',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    const cats = (await query('SELECT name FROM categories WHERE business_id=$1 ORDER BY sort_order, name', [st.biz_id])).rows.map((r) => r.name);
    const store = S.storePublic(st, cats);
    store.status = st.business_status;
    // Shown as the "Verified Sri Lankan Business" seal on the store header and product pages.
    store.verified = st.verification_status === 'VERIFIED';

    if (!LIVE.has(st.business_status)) {
      return res.json({ store, products: [], available: false });
    }
    const products = (
      await query(
        `SELECT p.*, $2::text AS store_slug, r.avg_rating, r.review_count
           FROM products p
           LEFT JOIN (SELECT product_id, ROUND(AVG(rating)::numeric, 1) avg_rating, COUNT(*) review_count
                        FROM product_reviews WHERE business_id = $1 AND status = 'PUBLISHED' GROUP BY product_id) r
             ON r.product_id = p.id
          WHERE p.business_id=$1 AND p.status='ACTIVE' ORDER BY p.created_at DESC`,
        [st.biz_id, st.slug]
      )
    ).rows.map(S.product);
    // Ratings and reviews show only where a Sidadiya admin has enabled reviews.
    store.reviewsEnabled = !!st.reviews_enabled;
    if (st.reviews_enabled) Object.assign(store, await storeRatings(st.biz_id));
    else { store.rating = { avg: null, count: 0 }; store.latestReviews = []; products.forEach((p) => { delete p.rating; delete p.reviews; }); }
    // Card payments show at checkout only when the shop's gateway is on AND compliant.
    store.payments.card = (await cardAvailability(st.biz_id)).available;
    store.returnDays = st.return_days;
    // Platform notice for buyers (admin-controlled; null when switched off).
    store.notice = await publicBuyerNotice();
    res.json({ store, products, available: true });
  })
);

// Store-level rating summary + the latest few reviews for the "What buyers say" strip.
async function storeRatings(businessId) {
  const agg = (await query(
    `SELECT ROUND(AVG(rating)::numeric, 1) avg, COUNT(*) n FROM product_reviews WHERE business_id = $1 AND status = 'PUBLISHED'`,
    [businessId]
  )).rows[0];
  const latest = (await query(
    `SELECT rating, body, customer_name, product_name, created_at FROM product_reviews
      WHERE business_id = $1 AND status = 'PUBLISHED' AND COALESCE(body, '') <> '' ORDER BY created_at DESC LIMIT 6`,
    [businessId]
  )).rows.map(S.review);
  return { rating: { avg: agg.avg != null ? Number(agg.avg) : null, count: Number(agg.n) }, latestReviews: latest };
}

// POST /api/store/:slug/visit — storefront page-view beacon for traffic sources.
// Body: { page, referrer, utm_source, utm_medium, utm_campaign, sid }. Always 204.
storeRouter.post(
  '/:slug/visit',
  wrap(async (req, res) => {
    res.status(204).end();
    try {
      if (BOT_UA.test(req.get('user-agent') || '') || !beaconAllowed(req.ip || '')) return;
      const st = (await query('SELECT business_id FROM stores WHERE slug = $1', [req.params.slug])).rows[0];
      if (!st) return;
      const b = req.body || {};
      const c = classify({ referrer: b.referrer, utmSource: b.utm_source, utmMedium: b.utm_medium, utmCampaign: b.utm_campaign, ownHost: OWN_HOST });
      if (!c) return; // internal navigation, not a new visit
      const page = ['home', 'product', 'cart', 'order', 'policy'].includes(b.page) ? b.page : 'home';
      const sessionId = /^[a-z0-9]{8,40}$/i.test(String(b.sid || '')) ? String(b.sid) : null;
      // One visit per browser session: only the first page view (the landing)
      // is recorded, so a reload or a second external link does not double count.
      if (sessionId && (await query('SELECT 1 FROM store_visits WHERE business_id = $1 AND session_id = $2 LIMIT 1', [st.business_id, sessionId])).rowCount) return;
      await recordVisit(st.business_id, { ...c, page, sessionId });
    } catch (e) { console.warn('[visit]', e.message); }
  })
);

// GET /api/store/:slug/product/:id/reviews — published reviews for one product.
storeRouter.get(
  '/:slug/product/:id/reviews',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    if (!LIVE.has(st.business_status) || !UUID_RE.test(req.params.id)) throw notFound('Product not found.');
    if (!st.reviews_enabled) return res.json({ reviews: [] });
    const { rows } = await query(
      `SELECT rating, body, customer_name, product_name, created_at FROM product_reviews
        WHERE business_id = $1 AND product_id = $2 AND status = 'PUBLISHED' ORDER BY created_at DESC LIMIT 50`,
      [st.biz_id, req.params.id]
    );
    res.json({ reviews: rows.map(S.review) });
  })
);

// ---- Buyer order status page (no account: the private token from the order link) ----
async function loadBuyerOrder(req) {
  const st = await loadStore(req.params.slug);
  const token = String(req.query.k || (req.body && req.body.k) || '');
  if (!/^[a-f0-9]{16,64}$/.test(token)) throw notFound('Order not found.');
  const order = (await query('SELECT * FROM orders WHERE business_id = $1 AND code = $2 AND public_token = $3', [st.biz_id, req.params.code, token])).rows[0];
  if (!order) throw notFound('Order not found.');
  return { st, order };
}

// GET /api/store/:slug/orders/:code?k=<token>
storeRouter.get(
  '/:slug/orders/:code',
  wrap(async (req, res) => {
    const { st, order } = await loadBuyerOrder(req);
    const items = (await query('SELECT oi.*, COALESCE(pr.image_url, pr.images->>0) AS image FROM order_items oi LEFT JOIN products pr ON pr.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id', [order.id])).rows;
    const history = (await query('SELECT status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at', [order.id])).rows;
    const reviewed = new Set((await query('SELECT product_id FROM product_reviews WHERE order_id = $1', [order.id])).rows.map((r) => r.product_id));
    res.json({ order: S.buyerOrder(order, items, history, reviewed), store: { name: st.name, slug: st.slug, phone: st.phone || '', whatsapp: st.whatsapp || '' } });
  })
);

// POST /api/store/:slug/orders/:code/slip?k=<token>  (multipart, field "slip")
// The buyer's bank transfer slip. Stored privately; only the shop can open it.
const slipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
storeRouter.post(
  '/:slug/orders/:code/slip',
  (req, res, next) => slipUpload.single('slip')(req, res, (err) => next(err && err.code === 'LIMIT_FILE_SIZE' ? badRequest('The slip must be 8 MB or smaller.') : err)),
  wrap(async (req, res) => {
    const { st, order } = await loadBuyerOrder(req);
    if (!/bank/i.test(String(order.payment_method || ''))) throw badRequest('This order is not paid by bank transfer.');
    if (order.payment_status === 'PAID') throw badRequest('The shop has already confirmed your payment.');
    if (['CANCELLED', 'REFUNDED'].includes(order.status)) throw badRequest('This order is cancelled.');
    if (!req.file) throw badRequest('Choose a photo or PDF of your payment slip.');
    if (!SLIP_TYPES.has(req.file.mimetype)) throw badRequest('Upload a photo (JPG, PNG, WEBP) or a PDF of your slip.');
    const key = await savePrivate(req.file, st.biz_id, `${order.code}-slip`, 'slips');
    const name = clip(String(req.file.originalname || 'payment-slip').replace(/[\r\n]/g, ' '), 120);
    await query(
      `UPDATE orders SET slip_key = $2, slip_name = $3, slip_type = $4, slip_uploaded_at = now(), slip_note = NULL, payment_status = 'SLIP_UPLOADED' WHERE id = $1`,
      [order.id, key, name, req.file.mimetype]
    );
    await query(`INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, 'Payment slip uploaded by the buyer')`, [order.id, order.status]);
    res.status(201).json({ ok: true, paymentStatus: 'SLIP_UPLOADED' });
  })
);

// POST /api/store/:slug/orders/:code/reviews?k=<token>  { reviews: [{ productId, rating, body }] }
// Only for delivered orders; one review per product per order (later posts are ignored).
storeRouter.post(
  '/:slug/orders/:code/reviews',
  wrap(async (req, res) => {
    const { st, order } = await loadBuyerOrder(req);
    const saved = await saveBuyerReviews(st.biz_id, order, req.body && req.body.reviews);
    res.status(201).json({ ok: true, saved });
  })
);

// GET /api/store/:slug/policies/:kind — refund | privacy | return | terms | contact.
// Always readable (even while a store is paused) so payment reviewers can check them.
storeRouter.get(
  '/:slug/policies/:kind',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    const kind = req.params.kind;
    const store = { name: st.name, slug: st.slug, preset: st.preset, logo: st.logo_url || null };
    if (kind === 'contact') {
      const { ctx } = await loadPolicies(st.biz_id);
      return res.json({ store, key: 'contact', title: TITLES.contact, contact: { businessName: ctx.name, email: ctx.email, phone: ctx.phone, whatsapp: st.whatsapp || '', address: st.address || '', city: st.city || '' } });
    }
    if (!POLICY_KINDS.includes(kind)) throw notFound('Policy not found.');
    const { policies } = await loadPolicies(st.biz_id);
    const p = policies[kind];
    res.json({ store, key: kind, title: p.title, content: p.content, updatedAt: p.updatedAt });
  })
);

// GET /api/store/:slug/product/:id — single product (for the product page + SEO tags).
storeRouter.get(
  '/:slug/product/:id',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    if (!LIVE.has(st.business_status)) throw notFound('Store is unavailable.');
    const p = (await query('SELECT *, $3::text AS store_slug FROM products WHERE id=$1 AND business_id=$2', [req.params.id, st.biz_id, st.slug])).rows[0];
    if (!p) throw notFound('Product not found.');
    res.json({ product: S.product(p) });
  })
);

// POST /api/store/:slug/coupon — validate a coupon code against a subtotal.
storeRouter.post(
  '/:slug/coupon',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    if (!LIVE.has(st.business_status)) throw badRequest('This store is not available right now.');
    const subtotal = Math.max(0, Math.floor(Number(req.body && req.body.subtotal) || 0));
    const result = await evalCoupon(null, st.biz_id, req.body && req.body.code, subtotal);
    res.json(result.valid
      ? { valid: true, code: result.code, discount: result.discount, message: result.message }
      : { valid: false, discount: 0, message: result.message });
  })
);

// POST /api/store/:slug/orders — customer checkout. No auth. Prices are re-read from
// the DB (never trusted from the client) and snapshotted onto the order.
storeRouter.post(
  '/:slug/orders',
  wrap(async (req, res) => {
    const st = await loadStore(req.params.slug);
    if (!LIVE.has(st.business_status)) throw badRequest('This store is not accepting orders right now.');

    const body = req.body || {};
    const { customer, phone } = body;
    if (!customer || !phone) throw badRequest('Name and phone are required.');
    // Checkout requires agreeing to the shop's Terms & Conditions.
    if (body.acceptTerms !== true) throw badRequest('Please agree to the Terms & Conditions to place your order.');
    // Address is always required, regardless of delivery, pickup or payment method.
    if (!body.address || !String(body.address).trim()) throw badRequest('An address is required.');
    if (!Array.isArray(body.items) || !body.items.length) throw badRequest('Your cart is empty.');

    // Re-price each line from the catalogue. Prices are never trusted from the client.
    const lines = [];
    let subtotal = 0;
    for (const it of body.items) {
      const p = (await query('SELECT * FROM products WHERE id=$1 AND business_id=$2', [it.pid, st.biz_id])).rows[0];
      if (!p) throw badRequest('One of the products is no longer available.');
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      const variants = Array.isArray(p.variants) ? p.variants : [];
      let price, label = it.variant || '';
      if (variants.length) {
        // Priced variant: the label must match one of the product's variants.
        const v = variants.find((x) => x.label === it.variant);
        if (!v) throw badRequest(`Please choose an option for ${p.name}.`);
        price = v.sale != null ? v.sale : v.price;
        label = v.label;
      } else {
        // Simple product: any label is just the chosen options, shown for reference.
        price = p.sale_price != null ? p.sale_price : p.price;
      }
      const suffix = label ? ` (${label})` : '';
      lines.push({ product_id: p.id, name: p.name + suffix, qty, price, variantLabel: variants.length ? label : null, image: p.image_url || (Array.isArray(p.images) && p.images[0]) || null });
      subtotal += price * qty;
    }

    const fee = st.delivery_free_above && subtotal >= st.delivery_free_above ? 0 : st.delivery_fee;

    // Card payment (the shop's own OnePay account): only when the shop has it switched
    // on and compliant. The order is created PENDING-payment, then the buyer is sent
    // to OnePay; the webhook / return page verify and mark it PAID.
    const card = body.paymentMethod === 'card';
    const bankTransfer = body.paymentMethod === 'bank' || /bank transfer/i.test(String(body.payment || ''));
    let cardCreds = null;
    if (card) {
      const av = await cardAvailability(st.biz_id);
      if (!av.available) throw badRequest('Card payments are not available at this store right now. Please choose another payment method.');
      cardCreds = await shopOnePayCreds(st.biz_id);
      if (!toE164(phone)) throw badRequest('Enter a Sri Lankan mobile number to pay by card.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(body.email || ''))) throw badRequest('Enter your email address to pay by card. OnePay sends your receipt there.');
    }

    // First-touch attribution captured by the storefront (source of the visit that led here).
    const at = body.attribution || {};
    const attr = classify({ referrer: at.referrer, utmSource: at.utm_source, utmMedium: at.utm_medium, utmCampaign: at.utm_campaign, ownHost: OWN_HOST }) || { source: 'direct' };

    const order = await withTransaction(async (client) => {
      // Apply a coupon if one was sent and is valid (re-checked server-side).
      let discount = 0;
      let couponCode = null;
      if (body.coupon) {
        const cp = await evalCoupon(client, st.biz_id, body.coupon, subtotal);
        if (cp.valid) { discount = cp.discount; couponCode = cp.code; }
      }
      const total = Math.max(0, subtotal - discount) + fee;

      // Retry a couple of times on the (rare) order-code collision.
      let created = null;
      for (let attempt = 0; attempt < 5 && !created; attempt++) {
        try {
          created = (
            await client.query(
              `INSERT INTO orders (business_id, code, customer_name, phone, whatsapp, address, city, district,
                                   delivery_method, payment_method, subtotal, delivery_fee, total, note, coupon_code, discount, customer_email, terms_accepted_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now()) RETURNING *`,
              [st.biz_id, orderCode(), customer, phone, body.whatsapp || null, body.address || null,
               body.city || null, body.district || null, body.delivery || 'Delivery',
               card ? 'Card payment' : (body.payment || 'Cash on delivery'), subtotal, fee, total, body.note || null, couponCode, discount, body.email || null]
            )
          ).rows[0];
        } catch (e) {
          if (e.code !== '23505') throw e; // not a code collision -> rethrow
        }
      }
      if (!created) throw badRequest('Could not place the order, please try again.');

      if (couponCode) await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE business_id=$1 AND code=$2', [st.biz_id, couponCode]);

      for (const l of lines) {
        await client.query(
          'INSERT INTO order_items (order_id, product_id, name, qty, price) VALUES ($1,$2,$3,$4,$5)',
          [created.id, l.product_id, l.name, l.qty, l.price]
        );
        if (l.variantLabel) {
          // Decrement the chosen variant's stock, then re-derive the product total.
          const cur = (await client.query('SELECT variants FROM products WHERE id=$1', [l.product_id])).rows[0];
          const vs = (Array.isArray(cur.variants) ? cur.variants : []).map((v) =>
            v.label === l.variantLabel ? { ...v, stock: Math.max(0, Number(v.stock) - l.qty) } : v
          );
          const total = vs.reduce((n, v) => n + Number(v.stock || 0), 0);
          await client.query('UPDATE products SET variants=$2, stock=$3 WHERE id=$1', [l.product_id, JSON.stringify(vs), total]);
        } else {
          // Simple product: decrement the single stock, floored at zero.
          await client.query('UPDATE products SET stock = GREATEST(stock - $2, 0) WHERE id=$1', [l.product_id, l.qty]);
        }
      }
      await client.query('INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)', [created.id, 'PENDING']);
      await client.query('UPDATE orders SET source=$2, medium=$3, campaign=$4 WHERE id=$1', [created.id, attr.source, attr.medium, attr.campaign]);
      // Bank transfer: the buyer adds the slip next (checkout uploads it right after this).
      if (bankTransfer && !card) await client.query(`UPDATE orders SET payment_status='AWAITING_SLIP' WHERE id=$1`, [created.id]);
      if (card) {
        await client.query(`UPDATE orders SET payment_status='PENDING' WHERE id=$1`, [created.id]);
        created.gatewayTx = (await client.query(
          `INSERT INTO gateway_transactions (kind, business_id, order_id, reference, amount, mode) VALUES ('ORDER',$1,$2,$3,$4,$5) RETURNING *`,
          [st.biz_id, created.id, `${created.code}-${randomBytes(3).toString('hex').toUpperCase()}`, created.total, cardCreds.mode]
        )).rows[0];
      }

      // Notify the store owner of the new order. The customer is not emailed at
      // placement: they receive a branded email only when the shop confirms the
      // order and again when it ships (see the order-status handler).
      // The seller is told once: now for cash / bank transfer, and for card orders
      // when the payment is verified (ORDER_PAID), so an abandoned card checkout
      // never emails anyone.
      if (!card) await queueNotification(
        { businessId: st.biz_id, recipient: st.biz_email, ...templates.newOrder({ name: st.biz_name }, created) },
        client
      );
      // Buyer email with the order summary, digital receipt and tracking link, sent
      // on behalf of the shop. Card orders get theirs once the payment is verified.
      if (!card && created.customer_email) {
        const shop = { name: st.name || st.biz_name, slug: st.slug, phone: st.phone, whatsapp: st.whatsapp, address: st.address, email: st.contact_email || st.biz_email };
        await queueNotification(
          { businessId: st.biz_id, recipient: created.customer_email, dedupeKey: `ORDER_PLACED:${created.id}`, ...templates.orderPlaced(shop, created, lines) },
          client
        );
      }
      return created;
    });

    let payment = null;
    if (card) {
      const tx = order.gatewayTx;
      try {
        const name = splitName(customer);
        const out = await createCheckout(cardCreds, {
          amount: order.total,
          reference: tx.reference,
          customer: { firstName: name.first, lastName: name.last, phone, email: body.email },
          redirectUrl: returnUrl(tx.reference),
          additionalData: { k: 'order', shop_id: st.biz_id, order_id: order.id, tx: tx.id },
        });
        await query('UPDATE gateway_transactions SET ipg_transaction_id=$2, raw_create=$3, updated_at=now() WHERE id=$1', [tx.id, out.ipgTransactionId, JSON.stringify(out.raw)]);
        payment = { provider: 'onepay', redirectUrl: out.redirectUrl };
      } catch (e) {
        console.error('[onepay] shop checkout failed:', st.slug, e.message);
        // Could not reach OnePay: cancel this order and return its stock.
        await settleFailure(tx.id, 'Could not start the card payment');
        throw new HttpError(502, 'We could not open the card payment page. Nothing was charged. Please try again or choose another payment method.');
      }
    }

    res.status(201).json({
      order: S.order(order, lines),
      code: order.code,
      payment,
      // Private link to the buyer's order status page (tracking, reviews).
      token: order.public_token,
      statusUrl: trackPath(order),
      trackUrl: trackPath(order),
      receiptUrl: receiptPath(order),
    });
  })
);
