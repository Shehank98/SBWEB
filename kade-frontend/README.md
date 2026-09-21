# Kade frontend prototype

Plain HTML, CSS and JavaScript. No build step. It uses mock data, so it runs without a server, but pages read
`?s=` query strings and `localStorage`, so serve it over HTTP:

> **Backend is now available.** The real multi-tenant API (Express + PostgreSQL, JWT auth, subscriptions,
> Firebase uploads, Apps Script email outbox) lives in [`../backend/`](../backend/README.md).
> `login.html` and `register.html` are already wired to it, and `js/api.js` has a client method for every
> endpoint. To connect the rest, set `window.KADE_API_BASE` in `js/config.js` and follow
> [`../FRONTEND-INTEGRATION.md`](../FRONTEND-INTEGRATION.md). Leave the base empty to keep running on mock data.

    cd kade-frontend
    python3 -m http.server 8000     # then open http://localhost:8000

## Pages

| Area | Files | What it does |
| --- | --- | --- |
| Public | `index.html`, `register.html`, `login.html` | Landing with plans, 3-step registration with validation, log in (any email containing "admin" opens the admin panel) |
| Storefront | `store/index.html`, `product.html`, `cart.html` | Mobile-first store, search, categories, variants, cart, checkout, WhatsApp order and share links, suspended-store page |
| Owner dashboard | `dashboard/index.html`, `orders`, `products`, `subscription`, `settings` | Sales chart, order workflow, product add/edit/delete, renewal with slip upload, store colours, payments and delivery |
| Admin | `admin/index.html`, `businesses`, `payments` | Approve, reject, suspend, extend, reactivate; verify payment slips |

Try `store/index.html?s=abc-fashion`, `?s=nimal-bakery`, `?s=kandy-mobile`, and `?s=old-books` (suspended).

## Files

- `css/tokens.css`: generated from the Kade design system `tokens.json` (colours for light and dark, type, spacing, radius, shadows, five storefront presets).
- `css/kade.css`: components (from the design system) plus page layouts.
- `js/data.js`: all mock data. Every business-owned record carries `business` or `store`, so each block maps to one API call filtered by the logged-in `business_id`.
- `js/app.js`: formatting, status badges, toast, confirm dialog, cart, app shell, bar chart.
- `js/store.js`: storefront header and footer, and the suspended / not-found pages.
- `js/theme.js`: applies the saved light or dark theme before first paint.

## Replacing the mock parts

- `KadeData.*` reads become `fetch('/api/...')`. Never send `business_id` from the browser; derive it from the session on the server.
- Storefront URL: pages read the slug from `?s=` or from a path like `/store/abc-fashion`. On Express, serve `store/index.html` for `/store/:slug` and `store/product.html` for `/store/:slug/product/:id` (then change the product link builder `K.sUrl` in `js/store.js`).
- Cart lives in `localStorage` per store. Orders placed on the demo storefront are saved in `localStorage` under `kade-new-orders` and show up in the demo dashboard.
- Status changes, product edits and approvals only last until the page reloads. Wire each to `PUT /api/...`.
- "Email queued" toasts stand for a row in your `notifications` table that Apps Script picks up.
- `K.host` in `js/app.js` is the placeholder domain `kade.lk`.
- Product photos are placeholders (initials on a tinted tile). Swap the `K.ph()` output for an `<img>` with the Firebase Storage URL.

## Accessibility and design rules already applied

Text pairs meet WCAG AA in both themes, controls are at least 44px on touch screens, focus rings are visible, status is always word plus shape, forms have labels and inline errors, dialogs use `<dialog>`, charts have keyboard hover and a "View as table" option, and motion respects `prefers-reduced-motion`.

## Not built yet

Customer accounts, coupons, reviews, staff accounts, analytics pages, custom domains, real payments, image upload to storage, and Sinhala/Tamil translations (fonts are ready).
