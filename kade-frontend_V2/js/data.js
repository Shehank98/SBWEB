/* Public constants for the served app.
 *
 * SECURITY: this file ships to every browser, so it must NOT contain any tenant
 * data. Each shop's stores, products, orders, payments, customers and emails are
 * fetched from the API, scoped to the signed-in business on the server - one shop
 * can never see another's data. Only the public pricing plans and small date
 * helpers live here (the landing page reads `plans`).
 */
(function () {
  var TODAY = new Date();
  function daysAgo(n) { var d = new Date(TODAY); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
  function daysAhead(n) { return daysAgo(-n); }

  var plans = [
    { id: 'starter',  name: 'Starter',  price: 1500, durationDays: 30, maxProducts: 100,  features: ['Up to 100 products', 'Up to 5 categories', '1 photo per product', 'Up to 2 variants per product', 'Order dashboard', 'Email order alerts'] },
    { id: 'business', name: 'Business', price: 2500, durationDays: 30, maxProducts: 500,  features: ['Up to 500 products', 'Up to 20 categories', 'Up to 5 photos per product', 'Up to 5 variants per product', 'Coupons and discounts', 'Sales reports'] },
    { id: 'pro',      name: 'Pro',      price: 5000, durationDays: 30, maxProducts: null, features: ['Unlimited products', 'Unlimited categories', 'Unlimited photos & variants', 'Staff accounts', 'Advanced reports', 'Priority support'] }
  ];

  // No tenant data here on purpose - the API is the only source for it.
  window.KadeData = {
    today: daysAgo(0),
    plans: plans,
    stores: {}, products: [], orders: [], sales7: [],
    businesses: [], payments: [], revenueMonths: [],
    daysAgo: daysAgo, daysAhead: daysAhead
  };
})();
