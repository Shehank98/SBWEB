# Sidadiya — multi-tenant commerce platform

A single deployable service: one Node.js app that serves both the **storefront
frontend** (`kade-frontend/`) and the **REST API**. Node.js + Express +
PostgreSQL, with JWT auth, strict per-business data isolation, a notifications
outbox for Google Apps Script, Firebase-ready image uploads, and a daily
subscription-lifecycle job.

It implements the MVP scope: **registration → admin approval → subscription &
payment → business dashboard → products → storefront → orders → email
automation → expiry automation.**

The whole app runs from the repo root (no subfolders), so it deploys as **one
Railway service** with no Root Directory setting to configure.

---

## 1. Quick start (local)

```bash
cp .env.example .env          # then edit DATABASE_URL + JWT_SECRET
npm install
npm run db:setup              # create the tables
npm run db:seed               # load demo data that matches the frontend
npm start                     # whole platform on http://localhost:4000
```

Then open **http://localhost:4000** — the landing page, storefront, dashboard
and admin panel are all served there, and they call the API at the same origin
(so there is no CORS to configure).

Seeded logins (printed by the seed):

| Role  | Email                 | Password    |
| ----- | --------------------- | ----------- |
| Admin | `admin@sidadiya.lk`       | `admin12345`|
| Owner | `abc-fashion@sidadiya.lk` | `demo12345` |

Every seeded store has an owner at `<slug>@sidadiya.lk` / `demo12345`
(`nimal-bakery@sidadiya.lk`, `kandy-mobile@sidadiya.lk`, …).

Health check: `GET /api/health`.

---

## 2. Architecture

```
Browser (kade-frontend)
        │  fetch() + Bearer token
        ▼
Express REST API  ──►  PostgreSQL   (all tenant data, business_id-scoped)
        │
        ├──►  Firebase Storage      (product photos, payment slips)   [optional]
        │
        └──►  notifications table   ◄── Google Apps Script polls, sends email
```

Source layout (repo root):

```
kade-frontend_V2/        static site (the current UI), served by the same Node app
kade-frontend/           the original UI (kept for reference)
src/
  server.js              app bootstrap + route mounting + static frontend
  config.js              env -> typed config
  db/
    schema.sql           all tables (business_id on every tenant table)
    setup.js             applies schema.sql (idempotent)
    seed.js              demo data mirroring kade-frontend/js/data.js
    pool.js              pg pool + withTransaction()
  middleware/
    auth.js              authenticate / requireRole / requireBusiness
    error.js             central error + 404 handling
  routes/
    auth.js              register, login, me
    plans.js             public plans
    admin.js             businesses, approvals, payments  (SUPER_ADMIN)
    products.js          owner product CRUD               (BUSINESS_OWNER)
    dashboard.js         overview, orders, subscription, store settings
    store.js             public storefront + checkout
    notifications.js     outbox API for Apps Script
  services/
    subscription.js      activate / extend / daily lifecycle
    notifications.js     outbox writer + email templates
    uploads.js           local or Firebase file storage
    serialize.js         DB rows -> the exact JSON the frontend consumes
  jobs/
    subscriptions.js     cron entrypoint (npm run job:subscriptions)
```

### Multi-tenant security

Every business-owned table has a `business_id`. Owner/staff routes derive the
tenant **only from the JWT** (`req.user.business_id`) — never from the request
body or query. So the catalogue query is always:

```sql
SELECT * FROM products WHERE business_id = $1   -- $1 comes from the token
```

This is verified by tests: an owner deleting another store's product gets `404`,
and a checkout that sends a fake `price` is re-priced from the database.

---

## 3. API reference

Auth: send `Authorization: Bearer <token>` from `POST /api/auth/login`.

### Public

| Method | Path                              | Purpose                              |
| ------ | --------------------------------- | ------------------------------------ |
| GET    | `/api/plans`                      | Pricing table / registration plans   |
| POST   | `/api/auth/register`              | Register (multipart, optional slip)  |
| POST   | `/api/auth/login`                 | Returns `{ token, user }`            |
| GET    | `/api/store/:slug`                | Store profile + products             |
| GET    | `/api/store/:slug/product/:id`    | One product                          |
| POST   | `/api/store/:slug/orders`         | Place an order (re-priced server-side)|

### Owner dashboard (BUSINESS_OWNER)

| Method | Path                                   | Purpose                         |
| ------ | -------------------------------------- | ------------------------------- |
| GET    | `/api/products`                        | Own catalogue + plan usage      |
| POST   | `/api/products`                        | Add product (multipart image)   |
| PUT    | `/api/products/:id`                    | Edit product                    |
| DELETE | `/api/products/:id`                    | Delete product                  |
| GET    | `/api/dashboard/overview`              | Sales today, counts, 7-day chart|
| GET    | `/api/dashboard/reports`               | Analytics (Business/Pro plans)  |
| GET    | `/api/dashboard/orders`                | Orders list                     |
| PUT    | `/api/dashboard/orders/:code/status`   | Change order status             |
| GET    | `/api/dashboard/subscription`          | Plan, dates, payment history    |
| POST   | `/api/dashboard/subscription/renew`    | Submit renewal slip             |
| GET    | `/api/dashboard/store`                 | Store settings                  |
| PUT    | `/api/dashboard/store`                 | Update store settings           |

### Admin (SUPER_ADMIN)

| Method | Path                                       | Purpose                    |
| ------ | ------------------------------------------ | -------------------------- |
| GET    | `/api/admin/stats`                         | Platform overview          |
| GET    | `/api/admin/businesses?status=`            | Businesses table           |
| POST   | `/api/admin/businesses/:id/approve`        | Approve + activate         |
| POST   | `/api/admin/businesses/:id/reject`         | Reject (reason required)   |
| POST   | `/api/admin/businesses/:id/suspend`        | Suspend                    |
| POST   | `/api/admin/businesses/:id/reactivate`     | Reactivate                 |
| POST   | `/api/admin/businesses/:id/extend`         | Extend by `{ days }`       |
| POST   | `/api/admin/businesses/:id/slug`           | Change store link `{ slug }`|
| GET    | `/api/admin/payments?status=`              | Payments queue             |
| POST   | `/api/admin/payments/:id/approve`          | Approve a payment/renewal  |
| POST   | `/api/admin/payments/:id/reject`           | Reject a payment           |

### Notifications outbox (worker, `x-notify-token` header)

| Method | Path                            | Purpose                       |
| ------ | ------------------------------- | ----------------------------- |
| GET    | `/api/notifications/pending`    | Emails waiting to be sent     |
| POST   | `/api/notifications/:id/sent`   | Mark sent                     |
| POST   | `/api/notifications/:id/failed` | Mark failed (retry later)     |

---

## 4. Subscription lifecycle

Statuses on the business: `PENDING_PAYMENT → PENDING_APPROVAL → ACTIVE →
EXPIRING → GRACE_PERIOD → SUSPENDED` (and `CANCELLED`). A suspended store keeps
all its products, orders and settings — the storefront just shows a
"temporarily unavailable" page until the owner renews.

Run the daily job (see `src/services/subscription.js` for the thresholds:
`EXPIRING` within 7 days, `GRACE_PERIOD` for 5 days after expiry, then
`SUSPENDED`):

```bash
npm run job:subscriptions
```

It also queues reminder emails at 7, 3 and 1 days before expiry, and a
suspension email when a store lapses.

---

## 5. Deploying on Railway (single service)

Because the app lives at the repo root, Railway builds it with no Root Directory
setting — it finds `package.json` and runs `npm start`.

1. **New Project → Deploy from GitHub repo** (leave Root Directory blank).
2. Add a **PostgreSQL** plugin — Railway injects `DATABASE_URL` automatically.
3. Set variables: `JWT_SECRET`, `DATABASE_SSL=true`,
   `PUBLIC_BASE_URL=<your Railway URL>`, and the `ADMIN_*` values.
   (`CORS_ORIGIN` can stay `*`; the frontend is same-origin so it isn't needed.)
4. First deploy runs `npm start` and serves the whole platform at your Railway
   URL. Then, once, from the Railway shell: `npm run db:setup`
   (and `npm run db:seed` for the demo data).
5. Optional: the jobs run in-process by default. To use Railway **Cron** instead,
   see section 8.3 (and set `ENABLE_SCHEDULER=false`).

## 6. Firebase Storage (product photos & slips)

Default `UPLOAD_DRIVER=local` writes to `./uploads` — zero setup, good for dev.
For production:

```bash
npm install firebase-admin          # only needed for the firebase driver
```

Set `UPLOAD_DRIVER=firebase`, `FIREBASE_STORAGE_BUCKET=your-project.appspot.com`,
and `FIREBASE_SERVICE_ACCOUNT=<service-account JSON on one line>`. Uploaded files
return a public URL that is stored in Postgres (`products.image_url`,
`payments.slip_url`) — images never live in the database itself.

## 7. Google Apps Script (email automation)

The API only writes rows to `notifications`. A time-driven Apps Script trigger
sends the mail, so the API never blocks on SMTP:

```javascript
const API   = 'https://your-api.up.railway.app';
const TOKEN = 'your NOTIFY_TOKEN';

function sendPendingEmails() {
  const res = UrlFetchApp.fetch(API + '/api/notifications/pending', {
    headers: { 'x-notify-token': TOKEN }
  });
  const { notifications } = JSON.parse(res.getContentText());
  notifications.forEach(n => {
    try {
      MailApp.sendEmail({ to: n.recipient, subject: n.subject, body: n.message });
      UrlFetchApp.fetch(`${API}/api/notifications/${n.id}/sent`, {
        method: 'post', headers: { 'x-notify-token': TOKEN }
      });
    } catch (e) {
      UrlFetchApp.fetch(`${API}/api/notifications/${n.id}/failed`, {
        method: 'post', headers: { 'x-notify-token': TOKEN }
      });
    }
  });
}
```

This is a minimal sketch; use the full script in `apps-script/Code.gs` (styled emails,
quota guard, Sheet sync). Add a trigger to run `sendPendingEmails` every 2 minutes. Set `NOTIFY_TOKEN` in
the backend env (falls back to `JWT_SECRET` if unset).

---

## 8. V3 upgrade: configuration checklist

V3 adds free trials, card payments through OnePay, seller verification, policy
pages, visit tracking, weekly summaries and courier tracking. Everything below is
**additive**: existing shops, orders and data keep working.

### 8.1 Database migrations

Schema changes live in `src/db/migrations/NNN_*.sql`. They run **automatically at
boot** (in order, once each, recorded in `schema_migrations`, behind a Postgres
advisory lock so two instances never race). To run them by hand:

```bash
npm run db:migrate
```

| File | Adds |
| --- | --- |
| `001_plans_trial.sql` | Plan prices (Starter 999 / Business 1,399 / Pro 2,000), compare-at price, feature flags, trial columns, `platform_settings`, `job_runs` |
| `002_storefront_reviews.sql` | `orders.public_token` (buyer order-status link), `product_reviews` |
| `003_policies_compliance.sql` | `store_policies` (back-filled for every existing shop), store contact + return/refund days, `orders.terms_accepted_at` |
| `004_verification.sql` | Seller verification status + `verification_documents` |
| `005_onepay_transactions.sql` | `gateway_transactions` (one row per OnePay checkout) |
| `006_seller_gateways.sql` | `store_gateways` (encrypted seller keys), order `payment_status`, `paid_on`, refund note |
| `007_tracking_weekly.sql` | `store_visits`, `seller_digests`, order attribution + courier tracking, weekly-summary preference |
| `008_receipts_tracking.sql` | `orders.receipt_token` + `receipt_expires_at` (30-day digital receipt, back-filled for old orders), `receipt_shared_at`, `waybill_printed_at`, status-history index, `traffic_sources` plan flag (Pro only) |
| `009_visitor_sessions.sql` | Index for "one visit per browser session" |
| `010_store_reviews_toggle.sql` | `stores.reviews_enabled` (admin switches customer reviews on per store; off by default) |

### 8.2 New environment variables

| Variable | Required | What it does |
| --- | --- | --- |
| `FRONTEND_DIR` | No (default `kade-frontend_V3`) | Which UI folder is served. `kade-frontend_V2` rolls the UI back **but** V2 checkout does not send `acceptTerms`, so V2 checkout will fail against this API. Use only as an emergency rollback of the seller/admin UI. |
| `ENABLE_SCHEDULER` | No (default on) | In-process scheduler for the daily and weekly jobs. Set `false` if you use Railway Cron instead (both together is safe: each period is claimed once in `job_runs`). |
| `ONEPAY_APP_ID` | For platform card payments | Sidadiya's own OnePay App ID (plan subscriptions). |
| `ONEPAY_HASH_SALT` | For platform card payments | Sidadiya's OnePay hash salt. Never shown to browsers. |
| `ONEPAY_MODE` | No (default `sandbox`) | `live` or `sandbox`. |
| `ONEPAY_APP_TOKEN` | Only if OnePay requires it | Sent as the `Authorization` header when set (see open questions). |
| `ONEPAY_SANDBOX_API_BASE` | No | API host for sandbox mode, if OnePay gives you a separate one. Default: `https://api.onepay.lk`. |
| `ONEPAY_API_BASE` | No (tests only) | Overrides the API host for every mode (the test suite points it at a local mock). Leave unset in production. |
| `GATEWAY_ENC_KEY` | **Yes, before any seller saves OnePay keys** | 32 random bytes (base64 or hex) used for AES-256-GCM encryption of seller gateway credentials. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. If unset, a key is derived from `JWT_SECRET` (with a warning); changing `JWT_SECRET` later would then make saved seller keys unreadable. **Never change it once sellers have saved keys.** |
| `APPS_SCRIPT_URL` | Recommended | The Apps Script web app URL (`.../exec`). The API pings it right after queueing an email so it is sent within seconds; without it emails go out on the 1 minute trigger. |
| `NOTIFY_TOKEN` | Yes | Shared secret for the Apps Script (outbox + Sheet exports). Falls back to `JWT_SECRET`. |
| `PUBLIC_BASE_URL` | Yes | Absolute site URL. Used in emails **and in the OnePay callback/redirect URLs**, so it must be the public https domain. |
| `UPLOAD_DRIVER`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_SERVICE_ACCOUNT` | For production | Unchanged, but now also used for **private** verification documents (see 8.4). |

### 8.3 Cron jobs

| Job | When | Command | Railway Cron schedule (UTC) |
| --- | --- | --- | --- |
| Daily: subscription lifecycle, trial reminders (3 days / 1 day), trial expiry, cancel stale unpaid card checkouts | 07:00 Sri Lanka time | `npm run job:subscriptions` | `30 1 * * *` |
| Weekly: seller summary email | Monday 08:00 Sri Lanka time | `npm run job:weekly` | `30 2 * * 1` |

With the in-process scheduler on (default), you don't need Railway Cron. Jobs are
idempotent per period: a rerun on the same day/week does nothing.

### 8.4 Firebase Storage rules

`storage.rules` in the repo root. Deploy with `firebase deploy --only storage`,
or paste it into *Firebase console → Storage → Rules*.

- Seller verification documents are saved under `private/shops/<shopId>/verification/`
  and are **never public**. Admins open them through 5-minute V4 signed URLs
  generated by the backend.
- Everything else (product photos, logos, covers, slips) stays publicly readable.
- Nobody writes from the browser; the backend uses the Admin SDK.
- With `UPLOAD_DRIVER=local`, private files go to `./uploads-private` (gitignored)
  and are served only through `/api/files/private` with an HMAC-signed, expiring link.

### 8.5 OnePay URLs

Set these in the OnePay merchant dashboard (Sidadiya's own app **and** tell every
seller; sellers also see them in *Store settings → Card payments*):

| | URL |
| --- | --- |
| Callback (webhook) | `https://<your-domain>/api/onepay/callback` |
| Redirect / return | `https://<your-domain>/api/onepay/return` |

One callback endpoint serves both platform subscriptions and seller orders; it is
routed by `additional_data`. The callback is unsigned, so the server never trusts
it: it always re-checks with `POST /v3/transaction/status/` and marks a payment
paid only when status is true **and** amount and currency match. Repeated callbacks
are harmless (row lock + idempotent settle).

**Open questions for OnePay** (the docs site was not reachable while building, so
these follow the spec we were given and are written defensively):

1. Exact field names in the checkout-link and transaction-status responses (the
   code searches for them by name, e.g. `gateway.redirect_url`, `ipg_transaction_id`).
2. Is there a separate sandbox API host? (`ONEPAY_SANDBOX_API_BASE`)
3. Is an app token / `Authorization` header required? (`ONEPAY_APP_TOKEN`)
4. Is the hash compared as lowercase hex? (we send lowercase)
5. Does the status response always include currency? (if missing, amount alone is
   checked and a warning is logged)
6. Is a SaaS subscription merchant category approved for Sidadiya's own account?

### 8.6 Tests

```bash
node test/onepay-mock.js &          # fake OnePay API on :4455
ONEPAY_API_BASE=http://localhost:4455 ONEPAY_APP_ID=test-app ONEPAY_HASH_SALT=test-salt \
  ENABLE_SCHEDULER=false npm start &
npm test
```

### 8.7 Buyer and seller pages added later

| URL | What it is |
| --- | --- |
| `/track/<order code>?k=<token>` | Public order tracking timeline (token = `orders.public_token`) |
| `/receipt/<token>` | Digital receipt; the API returns 410 after `receipt_expires_at` (30 days) |
| `/dashboard/waybill?codes=A,B` | Print-ready A6 waybills (QR codes generated server side with the `qrcode` package) |

OnePay platform keys can also be saved in **Admin > Settings > Payment settings**
(encrypted with `GATEWAY_ENC_KEY`, used before the `ONEPAY_*` env vars). No new
environment variables were added for these features.

### 8.8 Apps Script

See `apps-script/README.md`: paste the new `Code.gs`, save (and *Deploy → New
version* if deployed as a web app), optionally set `SHEETS_SYNC_ID` and run
`installSyncTrigger` for the hourly Shops / Payments / Shipments sheet.

---

## 9. What's next

The schema and routes are shaped so these slot in without a redesign: product
variants table, coupons, delivery zones, analytics pages, staff accounts,
customer accounts, reviews, custom domains, and online payments (PayHere /
LankaQR) replacing manual slip verification.

### 8.9 Maintenance mode and the "shop is closed" page

- **Maintenance mode**: Admin > Settings > Maintenance. Switch it on (with an optional message and "Back by" time) and every store, dashboard and checkout shows an animated "shop is closed" page (HTTP 503). Admins, `/login`, `/admin/*`, OnePay callbacks and the email outbox keep working. Visitors' pages check every 20 seconds and reopen by themselves when you switch it off. Admin pages show a yellow reminder while it is on.
- **Offline or server down**: `sw.js` (a small service worker) shows the same page, in "offline" or "server down" style, when a page cannot load: no internet, or Railway answering 502/503/504. It caches only that one page, never your other pages or data. It works for anyone who has opened Sidadiya at least once on that browser; a first-time visitor during an outage still sees Railway's own error page.
- Inside an open page, a failed request shows a small "The shop is closed for a moment" note at the bottom, which clears itself when the connection is back.
- Preview: `/closed?preview=maintenance`, `/closed?preview=down`, `/closed?preview=offline`.

### 8.10 Store setup progress

- One weighted score (`src/services/setup.js`, `GET /api/dashboard/setup`) is shared by the welcome screen (`/dashboard/setup`), the dashboard card and Store settings.
- Weights: store information 15, logo 10, category 10, first product 20, delivery 15, payment method 15 (essential, 85 in total: the store is "ready to accept orders" when all are done), cover photo 5, social links 5, business verification 5 (recommended). Optional extras (3+ categories, both COD and bank transfer, OnePay, weekly email) are shown but weigh 0, so they never lower the score.
- Migration `011_store_setup.sql` adds `delivery_set_at` and `payments_set_at`: the defaults (Rs. 350, cash on delivery) only count once the seller confirms them. Shops that existed before are treated as confirmed.
- New sign-ups land on `/dashboard/setup?welcome=1`. "Continue setup" always opens the next unfinished step.

### 8.11 Refunds and restocking

- Marking an order refunded records the refund amount (full by default, or partial up to the order total) with a note. Migration `012_refunds_restock.sql` adds `refund_amount` and `restocked_at`; older refunded orders count as full refunds.
- Reports, the dashboard and the weekly email show net revenue: cancelled orders count 0 and refunds are deducted (a partial refund keeps the rest). Reports also show gross sales, refunds and the number of refunded orders. Fully refunded and cancelled orders do not count as sales, items sold or customer insights.
- When cancelling or refunding, the seller must answer "Put the items back in stock?". Stock is returned at most once per order (also for failed card payments).

### 8.12 Buyer notice

- Admin > Settings > Buyer notice: a popup buyers see when they open any store, saying the shop (not Sidadiya) is responsible for its products, delivery, returns and refunds. The admin edits the title, message (`{shop}` becomes the shop's name) and button, and switches it on or off for all stores.
- On by default with that text. After "I understand" it stays hidden on the buyer's device for 30 days, or until the admin changes the text. `?notice=1` on a store link shows it again for checking.

### 8.13 Page protection

- Admin (`/admin/*`) and seller dashboard (`/dashboard/*`) pages are only sent to a signed-in user with the right role. Login and sign-up set an `HttpOnly`, `SameSite=Lax` (and `Secure` on https) cookie holding the same signed token as the API; logout clears it. Without it, the server redirects to `/login?next=...`, and after login the user returns to the page they asked for.
- Sellers who open an admin address go to their dashboard; admins who open a seller address go to the admin panel. Encoded, upper-case, `..` and double-slash variants of the addresses are covered.
- Browsers signed in before this change are moved through automatically (the login page sets the cookie from the saved login once).
- The public demo (`/dashboard/index?demo=1`) still opens the sample seller dashboard without a login, never the admin panel. Internal `.md` notes in the frontend folder are no longer served.
- The API was already protected by the Bearer token on every admin and seller request; this adds the same protection to the pages themselves.
