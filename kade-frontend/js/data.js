/* Mock data for the Kade prototype. Replace each block with a fetch() to your API.
   Every record that belongs to a business carries `business` / `store`, so the same shapes
   work when the backend filters by the logged-in business_id. */
(function () {
  var TODAY = new Date();
  function daysAgo(n) { var d = new Date(TODAY); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
  function daysAhead(n) { return daysAgo(-n); }

  var plans = [
    { id: 'starter',  name: 'Starter',  price: 1500, durationDays: 30, maxProducts: 100,  features: ['Up to 100 products', 'Your own store link', 'Order dashboard', 'Email order alerts'] },
    { id: 'business', name: 'Business', price: 2500, durationDays: 30, maxProducts: 500,  features: ['Up to 500 products', 'Store colour presets', 'Coupons and discounts', 'Sales reports'] },
    { id: 'pro',      name: 'Pro',      price: 5000, durationDays: 30, maxProducts: null, features: ['Unlimited products', 'Priority support', 'Staff accounts', 'Advanced reports'] }
  ];

  var stores = {
    'abc-fashion': { slug: 'abc-fashion', name: 'ABC Fashion', preset: 'orchid', status: 'ACTIVE', tagline: 'Beautiful clothing for everyone', about: 'Family-run fashion shop in Galle. New arrivals every week.', phone: '077 123 4567', whatsapp: '94771234567', address: '12 Main Street, Galle', city: 'Galle',
      categories: ['Shirts', 'Dresses', 'Kurtas', 'Jackets', 'Accessories', 'Shoes'], delivery: { fee: 350, freeAbove: 10000, pickup: true }, payments: { cod: true, bank: true, online: false }, bank: 'Commercial Bank, ABC Fashion, 1234567890' },
    'nimal-bakery': { slug: 'nimal-bakery', name: "Nimal's Bakery", preset: 'cinnamon', status: 'ACTIVE', tagline: 'Fresh cakes from Galle, baked to order', about: 'Order a day ahead for birthday and wedding cakes.', phone: '071 555 0101', whatsapp: '94715550101', address: 'Hikkaduwa Road, Galle', city: 'Galle',
      categories: ['Cakes', 'Cupcakes', 'Short eats'], delivery: { fee: 300, freeAbove: 6000, pickup: true }, payments: { cod: true, bank: true, online: false }, bank: 'BOC, Nimal Bakery, 0098765432' },
    'kandy-mobile': { slug: 'kandy-mobile', name: 'Kandy Mobile', preset: 'sapphire', status: 'ACTIVE', tagline: 'Phones and accessories, islandwide delivery', about: 'Genuine accessories with a 6 month warranty.', phone: '081 222 3344', whatsapp: '94812223344', address: 'Peradeniya Road, Kandy', city: 'Kandy',
      categories: ['Cases', 'Charging', 'Audio'], delivery: { fee: 400, freeAbove: 15000, pickup: false }, payments: { cod: true, bank: true, online: false }, bank: 'Sampath Bank, Kandy Mobile, 5544332211' },
    'old-books': { slug: 'old-books', name: 'Old Books Corner', preset: 'ink', status: 'SUSPENDED', tagline: 'Second-hand books', about: '', phone: '', whatsapp: '', address: '', city: 'Colombo', categories: [], delivery: { fee: 350, freeAbove: 0, pickup: true }, payments: { cod: true, bank: false, online: false }, bank: '' }
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
    { id: 'p201', store: 'nimal-bakery', name: 'Chocolate Cake 1kg', category: 'Cakes', price: 4200, stock: 6, lowAt: 2, tone: 'c', options: { Message: ['No message', 'Happy Birthday'] }, desc: 'Moist chocolate cake with ganache. Order a day ahead.' },
    { id: 'p202', store: 'nimal-bakery', name: 'Butter Cake 500g', category: 'Cakes', price: 2400, stock: 10, lowAt: 2, tone: 'a', options: {}, desc: 'Traditional butter cake, baked fresh each morning.' },
    { id: 'p203', store: 'nimal-bakery', name: 'Vanilla Cupcakes (6)', category: 'Cupcakes', price: 1500, stock: 20, lowAt: 4, tone: 'f', options: {}, desc: 'Box of six vanilla cupcakes with butter icing.' },
    { id: 'p204', store: 'nimal-bakery', name: 'Kimbula Banis (10)', category: 'Short eats', price: 600, stock: 30, lowAt: 5, tone: 'd', options: {}, desc: 'Pack of ten sweet crocodile-shaped buns.' },
    { id: 'p301', store: 'kandy-mobile', name: 'Silicone Phone Case', category: 'Cases', price: 1200, stock: 40, lowAt: 8, tone: 'b', options: { Model: ['Galaxy A15', 'Galaxy A35', 'Redmi 13'] }, desc: 'Soft-touch case with raised edges.' },
    { id: 'p302', store: 'kandy-mobile', name: '33W Fast Charger', category: 'Charging', price: 3500, stock: 12, lowAt: 5, tone: 'a', options: {}, desc: 'USB-C fast charger with cable, 6 month warranty.' },
    { id: 'p303', store: 'kandy-mobile', name: 'Wireless Earbuds', category: 'Audio', price: 6800, sale: 5900, stock: 7, lowAt: 5, tone: 'f', options: { Colour: ['Black', 'White'] }, desc: 'Bluetooth 5.3 earbuds with a charging case.' },
    { id: 'p304', store: 'kandy-mobile', name: 'Screen Guard', category: 'Cases', price: 900, stock: 60, lowAt: 10, tone: 'c', options: { Model: ['Galaxy A15', 'Galaxy A35', 'Redmi 13'] }, desc: 'Tempered glass, easy-fit frame included.' }
  ];

  /* Sample product photos (self-contained SVGs under /img/products, served at the site root).
     Attached by name so every page that renders a product shows a real image. */
  var PRODUCT_IMG = {
    'Linen Shirt': 'linen-shirt', 'Summer Dress': 'summer-dress', 'Cotton Kurta': 'cotton-kurta',
    'Denim Jacket': 'denim-jacket', 'Canvas Tote': 'canvas-tote', 'Silk Scarf': 'silk-scarf',
    'Leather Sandals': 'leather-sandals', 'Batik Sarong': 'batik-sarong',
    'Chocolate Cake 1kg': 'chocolate-cake', 'Butter Cake 500g': 'butter-cake',
    'Vanilla Cupcakes (6)': 'vanilla-cupcakes', 'Kimbula Banis (10)': 'kimbula-banis',
    'Silicone Phone Case': 'silicone-phone-case', '33W Fast Charger': 'fast-charger',
    'Wireless Earbuds': 'wireless-earbuds', 'Screen Guard': 'screen-guard'
  };
  products.forEach(function (p) { if (PRODUCT_IMG[p.name]) p.image = '/img/products/' + PRODUCT_IMG[p.name] + '.svg'; });

  /* Orders for ABC Fashion (the demo business the dashboard signs in as) */
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

  /* Last 7 days of sales for ABC Fashion, oldest first. */
  var sales7 = [12400, 18500, 9600, 22100, 15300, 27800, 18500].map(function (v, i) { return { date: daysAgo(6 - i), value: v }; });

  /* Platform admin */
  var businesses = [
    { id: 'b1', name: 'ABC Fashion', owner: 'Kasun Perera', plan: 'Business', status: 'ACTIVE', joined: daysAgo(48), expiry: daysAhead(12), orders: 214, revenue: 1284500, slug: 'abc-fashion' },
    { id: 'b2', name: "Nimal's Bakery", owner: 'Nimal Jayasuriya', plan: 'Starter', status: 'ACTIVE', joined: daysAgo(90), expiry: daysAhead(21), orders: 96, revenue: 402300, slug: 'nimal-bakery' },
    { id: 'b3', name: 'Kandy Mobile', owner: 'Ruwan Bandara', plan: 'Pro', status: 'EXPIRING', joined: daysAgo(130), expiry: daysAhead(3), orders: 388, revenue: 3120800, slug: 'kandy-mobile' },
    { id: 'b4', name: 'Green Leaf Organics', owner: 'Sanduni Herath', plan: 'Business', status: 'PENDING_APPROVAL', joined: daysAgo(1), expiry: null, orders: 0, revenue: 0, slug: 'green-leaf' },
    { id: 'b5', name: 'Lanka Handloom', owner: 'Chamara Wickrama', plan: 'Starter', status: 'PENDING_APPROVAL', joined: daysAgo(2), expiry: null, orders: 0, revenue: 0, slug: 'lanka-handloom' },
    { id: 'b6', name: 'Old Books Corner', owner: 'Mahesh Kumar', plan: 'Starter', status: 'SUSPENDED', joined: daysAgo(200), expiry: daysAgo(9), orders: 41, revenue: 88400, slug: 'old-books' },
    { id: 'b7', name: 'Ceylon Spice Box', owner: 'Ishara Gunasekara', plan: 'Business', status: 'GRACE_PERIOD', joined: daysAgo(75), expiry: daysAgo(2), orders: 152, revenue: 690200, slug: 'ceylon-spice' },
    { id: 'b8', name: 'Pet Palace', owner: 'Dilini Jayawardena', plan: 'Starter', status: 'PENDING_PAYMENT', joined: daysAgo(3), expiry: null, orders: 0, revenue: 0, slug: 'pet-palace' },
    { id: 'b9', name: 'Coastal Cakes', owner: 'Thilini Rajapaksa', plan: 'Business', status: 'ACTIVE', joined: daysAgo(61), expiry: daysAhead(29), orders: 121, revenue: 512000, slug: 'coastal-cakes' },
    { id: 'b10', name: 'Fit Gear LK', owner: 'Pradeep Senanayake', plan: 'Pro', status: 'ACTIVE', joined: daysAgo(150), expiry: daysAhead(17), orders: 447, revenue: 2891000, slug: 'fit-gear' }
  ];
  var payments = [
    { id: 'pay1', business: 'Green Leaf Organics', owner: 'Sanduni Herath', plan: 'Business', amount: 2500, method: 'Bank transfer', ref: 'TXN 88231045', submitted: daysAgo(1), status: 'PENDING' },
    { id: 'pay2', business: 'Lanka Handloom', owner: 'Chamara Wickrama', plan: 'Starter', amount: 1500, method: 'Bank transfer', ref: 'TXN 88229771', submitted: daysAgo(2), status: 'PENDING' },
    { id: 'pay3', business: 'Ceylon Spice Box', owner: 'Ishara Gunasekara', plan: 'Business', amount: 2500, method: 'Bank transfer', ref: 'TXN 88198320', submitted: daysAgo(0), status: 'PENDING' },
    { id: 'pay4', business: 'Kandy Mobile', owner: 'Ruwan Bandara', plan: 'Pro', amount: 5000, method: 'Bank transfer', ref: 'TXN 88110452', submitted: daysAgo(30), status: 'APPROVED' },
    { id: 'pay5', business: 'ABC Fashion', owner: 'Kasun Perera', plan: 'Business', amount: 2500, method: 'Bank transfer', ref: 'TXN 88015512', submitted: daysAgo(48), status: 'APPROVED' },
    { id: 'pay6', business: 'Pet Palace', owner: 'Dilini Jayawardena', plan: 'Starter', amount: 1500, method: 'Bank transfer', ref: 'TXN 87990001', submitted: daysAgo(3), status: 'REJECTED', reason: 'Amount does not match the plan.' }
  ];
  var revenueMonths = [ { label: 'Apr', value: 9000 }, { label: 'May', value: 12500 }, { label: 'Jun', value: 15000 }, { label: 'Jul', value: 17500 }, { label: 'Aug', value: 20000 }, { label: 'Sep', value: 22500 } ];

  window.KadeData = { today: daysAgo(0), plans: plans, stores: stores, products: products, orders: orders, sales7: sales7, businesses: businesses, payments: payments, revenueMonths: revenueMonths, daysAgo: daysAgo, daysAhead: daysAhead };
})();
