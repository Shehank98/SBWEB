# Connecting the frontend to the backend

The whole platform runs as **one service**: the Node app at the repo root serves
`kade-frontend/` **and** the API. So when you run `npm start` (or deploy to
Railway) and open the site, the pages talk to the API at the **same origin**
automatically — no configuration needed.

## 1. API base (usually nothing to do)

`js/api.js` enables the API whenever the page is served over http/https, using a
relative `/api` path. You only touch `js/config.js` if the frontend is hosted
**separately** from the API:

```js
window.KADE_API_BASE = 'https://your-api.up.railway.app';  // only for split hosting
```

Opening the files directly from disk (`file://`) with no base keeps the offline
mock-data prototype. Set `window.KADE_API_DISABLED = true` to force mock mode.
Pages that aren't wired yet check `KadeApi.enabled` and fall back to mock data.

## 2. What is already wired

- **`login.html`** — authenticates via `KadeApi.login()`, stores the JWT, and
  routes to the admin panel or owner dashboard based on the returned role.
- **`register.html`** — submits the full application (with the payment slip)
  via `KadeApi.register()`.
- **`js/api.js`** — a complete client with a method for **every** endpoint
  (see the table in `backend/README.md`).

Add `<script src="../js/config.js"></script>` and
`<script src="../js/api.js"></script>` (adjust the `../` per folder depth) above
each page's inline script before wiring it.

## 3. The swap recipe for the data pages

Each remaining page reads `KadeData.*` synchronously. The change is mechanical:
replace the read with an `await KadeApi.*()` call and render inside an async
function. The field names already match, so the render code barely changes.

### Storefront — `store/index.html`

```js
// before (mock):
var list = D.products.filter(function (p) { return p.store === s.slug; });

// after (API): wrap the page body in an async init
(async function () {
  var K = Kade, slug = K.slug();
  var data = await KadeApi.getStore(slug);
  if (!data.available) { /* store.js already renders the suspended page */ }
  var s = data.store;                 // same shape as D.stores[slug]
  var list = data.products;           // same shape as D.products (filtered to this store)
  // ...the rest of the existing render() code is unchanged...
})();
```

`store/product.html` → `KadeApi.getStoreProduct(slug, id)`.
`store/cart.html` checkout → `KadeApi.placeOrder(slug, { customer, phone, city,
address, payment, delivery, note, items: [{ pid, qty, variant }] })`. The server
re-prices every line, so you no longer compute totals on the client.

### Owner dashboard

| Page                     | Replace `KadeData` read with            |
| ------------------------ | --------------------------------------- |
| `dashboard/index.html`   | `await KadeApi.overview()`              |
| `dashboard/orders.html`  | `await KadeApi.myOrders()` + `KadeApi.setOrderStatus(code, status)` |
| `dashboard/products.html`| `await KadeApi.myProducts()` + `createProduct` / `updateProduct` / `deleteProduct` |
| `dashboard/subscription.html` | `await KadeApi.subscription()` + `KadeApi.renew(fields, slipFile)` |
| `dashboard/settings.html`| `await KadeApi.myStore()` + `KadeApi.updateStore(store)` |

The dashboard no longer hard-codes ABC Fashion — the token identifies the
business, so `KadeApi.myProducts()` returns exactly that owner's data.

### Admin panel

| Page                    | Replace `KadeData` read with             |
| ----------------------- | ---------------------------------------- |
| `admin/index.html`      | `await KadeApi.adminStats()`             |
| `admin/businesses.html` | `await KadeApi.adminBusinesses(status)` + approve/reject/suspend/reactivate/extend |
| `admin/payments.html`   | `await KadeApi.adminPayments(status)` + approve/reject |

## 4. Auth guard for protected pages

At the top of every dashboard/admin page, redirect to login when there's no
session:

```js
if (KadeApi.enabled && !KadeApi.token()) location.href = '../login.html';
```

And wire the "Log out" link to `KadeApi.logout()`.

## 5. Images

Product photos and payment slips now come back as URLs (`product.image`,
`payment.slip`). Swap the `K.ph()` placeholder tile for an `<img src="...">`
when `product.image` is set.
