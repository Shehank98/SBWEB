# Kade — multi-tenant commerce platform

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
| Admin | `admin@kade.lk`       | `admin12345`|
| Owner | `abc-fashion@kade.lk` | `demo12345` |

Every seeded store has an owner at `<slug>@kade.lk` / `demo12345`
(`nimal-bakery@kade.lk`, `kandy-mobile@kade.lk`, …).

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
kade-frontend/           static site, served by the same Node app
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
5. Optional: add a **Cron** service (same repo) with schedule `0 1 * * *`
   running `npm run job:subscriptions` for the subscription lifecycle.

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

Add a trigger to run `sendPendingEmails` every 5 minutes. Set `NOTIFY_TOKEN` in
the backend env (falls back to `JWT_SECRET` if unset).

---

## 8. What's next (v2/v3)

The schema and routes are shaped so these slot in without a redesign: product
variants table, coupons, delivery zones, analytics pages, staff accounts,
customer accounts, reviews, custom domains, and online payments (PayHere /
LankaQR) replacing manual slip verification.
