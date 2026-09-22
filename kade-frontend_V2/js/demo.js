/* Demo sandbox data + banner.
 *
 * Loaded only on the owner dashboard pages, AFTER js/data.js and BEFORE js/app.js.
 * When the tab is in demo mode (see js/config.js - the ?demo=1 link sets a
 * sessionStorage flag and disables the API), this fills KadeData with a sample
 * shop on the Pro plan so every feature is unlocked, and shows a banner explaining
 * that nothing is saved. In normal mode this file does nothing at all.
 *
 * This is fictional sample data for the public demo - never real tenant data. The
 * real dashboard always reads a signed-in shop's own data from the API.
 */
(function () {
  function demoOn() { try { return sessionStorage.getItem('kade-demo') === '1'; } catch (e) { return false; } }
  if (!demoOn()) return;

  var D = window.KadeData;
  if (!D) return;
  var daysAgo = D.daysAgo, daysAhead = D.daysAhead;

  var stores = {
    'abc-fashion': { slug: 'abc-fashion', name: 'ABC Fashion', preset: 'orchid', status: 'ACTIVE', tagline: 'Beautiful clothing for everyone', about: 'Family-run fashion shop in Galle. New arrivals every week.', phone: '077 123 4567', whatsapp: '94771234567', address: '12 Main Street, Galle', city: 'Galle',
      categories: ['Shirts', 'Dresses', 'Kurtas', 'Jackets', 'Accessories', 'Shoes'], delivery: { fee: 350, freeAbove: 10000, pickup: true }, payments: { cod: true, bank: true, online: false }, bank: 'Commercial Bank, ABC Fashion, 1234567890' }
  };

  var products = [
    { id: 'p101', store: 'abc-fashion', name: 'Linen Shirt', category: 'Shirts', price: 3800, stock: 24, lowAt: 5, tone: 'a', options: { Size: ['S', 'M', 'L', 'XL'], Colour: ['White', 'Sand'] }, desc: 'Breathable linen shirt with a relaxed fit. Machine washable.' },
    { id: 'p102', store: 'abc-fashion', name: 'Summer Dress', category: 'Dresses', price: 5600, sale: 4500, stock: 5, lowAt: 5, tone: 'e', options: { Size: ['S', 'M', 'L'], Colour: ['Floral', 'Navy'] }, desc: 'Lightweight cotton dress, knee length, with side pockets.' },
    { id: 'p103', store: 'abc-fashion', name: 'Cotton Kurta', category: 'Kurtas', price: 5200, stock: 14, lowAt: 5, tone: 'c', options: { Size: ['M', 'L', 'XL'] }, desc: 'Hand-finished cotton kurta for daily and festive wear.' },
    { id: 'p104', store: 'abc-fashion', name: 'Denim Jacket', category: 'Jackets', price: 8900, stock: 3, lowAt: 5, tone: 'b', options: { Size: ['M', 'L'] }, desc: 'Classic mid-wash denim jacket. Comes with two front pockets.' },
    { id: 'p105', store: 'abc-fashion', name: 'Canvas Tote', category: 'Accessories', price: 2200, stock: 0, lowAt: 5, tone: 'f', options: {}, desc: 'Sturdy canvas tote, fits an A4 folder and a laptop.' },
    { id: 'p106', store: 'abc-fashion', name: 'Silk Scarf', category: 'Accessories', price: 1800, stock: 32, lowAt: 5, tone: 'e', options: { Colour: ['Rose', 'Teal', 'Gold'] }, desc: 'Soft printed scarf, 90 x 90 cm.' },
    { id: 'p107', store: 'abc-fashion', name: 'Leather Sandals', category: 'Shoes', price: 6400, stock: 9, lowAt: 5, tone: 'c', options: { Size: ['38', '39', '40', '41', '42'] }, desc: 'Hand-stitched leather sandals with a cushioned sole.' },
    { id: 'p108', store: 'abc-fashion', name: 'Batik Sarong', category: 'Dresses', price: 3200, sale: 2900, stock: 18, lowAt: 5, tone: 'd', options: { Colour: ['Indigo', 'Maroon'] }, desc: 'Locally made batik sarong, 2 metres, colour-fast.' },
    // A product with priced variants (each size has its own price and stock).
    {
      id: 'p109', store: 'abc-fashion', name: 'Party Frock', category: 'Dresses', tone: 'e', options: {},
      desc: 'Flowing party frock, fully lined, with a back zip. Choose the age size.',
      price: 2800, stock: 15, lowAt: 2,
      variants: [
        { label: 'Age 2-3', price: 2800, sale: null, stock: 6, lowAt: 2 },
        { label: 'Age 4-5', price: 3200, sale: null, stock: 4, lowAt: 2 },
        { label: 'Age 6-7', price: 3600, sale: 2999, stock: 0, lowAt: 2 },
        { label: 'Age 8-9', price: 3900, sale: null, stock: 5, lowAt: 2 }
      ]
    }
  ];
  var PRODUCT_IMG = {
    'Linen Shirt': 'linen-shirt', 'Summer Dress': 'summer-dress', 'Cotton Kurta': 'cotton-kurta',
    'Denim Jacket': 'denim-jacket', 'Canvas Tote': 'canvas-tote', 'Silk Scarf': 'silk-scarf',
    'Leather Sandals': 'leather-sandals', 'Batik Sarong': 'batik-sarong'
  };
  products.forEach(function (p) { if (PRODUCT_IMG[p.name]) { p.image = '/img/products/' + PRODUCT_IMG[p.name] + '.svg'; p.images = [p.image]; } });

  function order(n, days, customer, phone, city, items, status, pay, note) {
    var sub = items.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
    var fee = sub >= 10000 ? 0 : 350;
    return { id: 'ORD-' + n, business: 'abc-fashion', date: daysAgo(days), customer: customer, phone: phone, city: city, address: '', items: items, subtotal: sub, delivery: fee, total: sub + fee, status: status, payment: pay, note: note || '' };
  }
  var orders = [
    order(10452, 0, 'Nimal Perera', '077 111 2233', 'Galle', [{ name: 'Linen Shirt (L, White)', qty: 2, price: 3800 }, { name: 'Silk Scarf (Rose)', qty: 1, price: 1800 }], 'PENDING', 'Cash on delivery', 'Please call before delivery.'),
    order(10451, 0, 'Ayesha Fernando', '076 222 3344', 'Colombo', [{ name: 'Denim Jacket (M)', qty: 1, price: 8900 }, { name: 'Leather Sandals (40)', qty: 1, price: 6400 }], 'PENDING', 'Bank transfer'),
    order(10450, 1, 'Kasun Silva', '071 333 4455', 'Matara', [{ name: 'Cotton Kurta (L)', qty: 1, price: 5200 }], 'CONFIRMED', 'Cash on delivery'),
    order(10449, 1, 'Dilini Jayawardena', '070 444 5566', 'Kandy', [{ name: 'Summer Dress (S, Floral)', qty: 2, price: 4500 }], 'PROCESSING', 'Bank transfer'),
    order(10448, 2, 'Ruwan Bandara', '077 555 6677', 'Galle', [{ name: 'Batik Sarong (Indigo)', qty: 3, price: 2900 }], 'READY_TO_SHIP', 'Cash on delivery'),
    order(10447, 2, 'Sanduni Herath', '072 666 7788', 'Negombo', [{ name: 'Linen Shirt (M, Sand)', qty: 1, price: 3800 }, { name: 'Cotton Kurta (M)', qty: 1, price: 5200 }], 'SHIPPED', 'Bank transfer'),
    order(10446, 3, 'Chamara Wickrama', '075 777 8899', 'Kurunegala', [{ name: 'Leather Sandals (41)', qty: 1, price: 6400 }], 'DELIVERED', 'Cash on delivery'),
    order(10445, 3, 'Ishara Gunasekara', '077 888 9900', 'Galle', [{ name: 'Silk Scarf (Teal)', qty: 2, price: 1800 }], 'DELIVERED', 'Cash on delivery'),
    order(10444, 4, 'Mahesh Kumar', '078 999 0011', 'Jaffna', [{ name: 'Denim Jacket (L)', qty: 1, price: 8900 }, { name: 'Linen Shirt (XL, White)', qty: 2, price: 3800 }], 'DELIVERED', 'Bank transfer'),
    order(10443, 5, 'Thilini Rajapaksa', '071 010 2020', 'Colombo', [{ name: 'Canvas Tote', qty: 1, price: 2200 }], 'CANCELLED', 'Cash on delivery', 'Customer changed her mind.'),
    order(10442, 6, 'Pradeep Senanayake', '076 303 4040', 'Galle', [{ name: 'Summer Dress (M, Navy)', qty: 1, price: 4500 }], 'DELIVERED', 'Cash on delivery'),
    order(10441, 6, 'Nadeesha Perera', '072 505 6060', 'Hambantota', [{ name: 'Batik Sarong (Maroon)', qty: 2, price: 2900 }, { name: 'Silk Scarf (Gold)', qty: 1, price: 1800 }], 'DELIVERED', 'Bank transfer')
  ];
  // Make the sandbox feel real so the Pro panels have something to show: a few
  // repeat customers (for "top customers" and "repeat rate") and some coupon usage.
  orders[3].customer = 'Ayesha Fernando';   // second order from 10451's customer
  orders[10].customer = 'Nimal Perera';     // second order from 10452's customer
  orders[11].customer = 'Kasun Silva';      // second order from 10450's customer
  [[1, 'WELCOME10', 1530], [4, 'SHIP500', 500], [8, 'WELCOME10', 1650]].forEach(function (x) {
    orders[x[0]].coupon = x[1]; orders[x[0]].discount = x[2];
  });

  var sales7 = [12400, 18500, 9600, 22100, 15300, 27800, 18500].map(function (v, i) { return { date: daysAgo(6 - i), value: v }; });

  // The demo shop signs in on the Pro plan, so reports, coupons and staff are all unlocked.
  var businesses = [
    { id: 'b1', name: 'ABC Fashion', owner: 'Kasun Perera', plan: 'Pro', status: 'ACTIVE', joined: daysAgo(48), expiry: daysAhead(17), orders: 214, revenue: 1284500, slug: 'abc-fashion' }
  ];
  var revenueMonths = [ { label: 'Apr', value: 9000 }, { label: 'May', value: 12500 }, { label: 'Jun', value: 15000 }, { label: 'Jul', value: 17500 }, { label: 'Aug', value: 20000 }, { label: 'Sep', value: 22500 } ];

  window.KadeData = Object.assign(D, {
    stores: stores, products: products, orders: orders, sales7: sales7,
    businesses: businesses, payments: [], revenueMonths: revenueMonths,
  });

  /* ---- Banner: a fixed strip telling visitors this is a sandbox ---- */
  function exitDemo() {
    try { sessionStorage.removeItem('kade-demo'); } catch (e) {}
    location.href = '../index';
  }
  function injectBanner() {
    if (document.querySelector('.demo-bar')) return;
    document.body.classList.add('has-demo');
    var bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<span class="demo-bar__msg"><b>Demo</b>: a sample Pro dashboard. Explore freely; changes are not saved.</span>' +
      '<span class="demo-bar__cta"><a class="kd-btn kd-btn--accent kd-btn--sm" href="../register">Open my shop</a>' +
      '<button type="button" class="kd-btn kd-btn--ghost kd-btn--sm demo-bar__exit">Exit demo</button></span>';
    document.body.insertBefore(bar, document.body.firstChild);
    bar.querySelector('.demo-bar__exit').addEventListener('click', exitDemo);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectBanner);
  else injectBanner();
})();
