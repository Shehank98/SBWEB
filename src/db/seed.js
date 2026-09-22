// Seeds the database to mirror kade-frontend/js/data.js so the frontend and API
// show the same demo data. Safe to re-run: it clears tenant tables first.
// Run: npm run db:seed
import { pool, withTransaction } from './pool.js';
import { hashPassword } from '../utils/auth.js';
import { config } from '../config.js';

const OWNER_PASSWORD = 'demo12345';

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function daysAhead(n) { return daysAgo(-n); }

const plans = [
  { id: 'starter', name: 'Starter', price: 1500, duration_days: 30, max_products: 100, max_images: 3, features: ['Up to 100 products', 'Up to 3 photos per product', 'Your own store link', 'Order dashboard', 'Email order alerts'], sort_order: 1 },
  { id: 'business', name: 'Business', price: 2500, duration_days: 30, max_products: 500, max_images: 5, features: ['Up to 500 products', 'Up to 5 photos per product', 'Store colour presets', 'Coupons and discounts', 'Sales reports'], sort_order: 2 },
  { id: 'pro', name: 'Pro', price: 5000, duration_days: 30, max_products: null, max_images: 8, features: ['Unlimited products', 'Up to 8 photos per product', 'Priority support', 'Staff accounts', 'Advanced reports'], sort_order: 3 },
];

// Store detail for the four fully-described shops.
const storeDetail = {
  'abc-fashion': { preset: 'orchid', tagline: 'Beautiful clothing for everyone', about: 'Family-run fashion shop in Galle. New arrivals every week.', phone: '077 123 4567', whatsapp: '94771234567', address: '12 Main Street, Galle', city: 'Galle', categories: ['Shirts', 'Dresses', 'Kurtas', 'Jackets', 'Accessories', 'Shoes'], delivery: { fee: 350, freeAbove: 10000, pickup: true }, payments: { cod: true, bank: true, online: false }, bank: 'Commercial Bank, ABC Fashion, 1234567890' },
  'nimal-bakery': { preset: 'cinnamon', tagline: 'Fresh cakes from Galle, baked to order', about: 'Order a day ahead for birthday and wedding cakes.', phone: '071 555 0101', whatsapp: '94715550101', address: 'Hikkaduwa Road, Galle', city: 'Galle', categories: ['Cakes', 'Cupcakes', 'Short eats'], delivery: { fee: 300, freeAbove: 6000, pickup: true }, payments: { cod: true, bank: true, online: false }, bank: 'BOC, Nimal Bakery, 0098765432' },
  'kandy-mobile': { preset: 'sapphire', tagline: 'Phones and accessories, islandwide delivery', about: 'Genuine accessories with a 6 month warranty.', phone: '081 222 3344', whatsapp: '94812223344', address: 'Peradeniya Road, Kandy', city: 'Kandy', categories: ['Cases', 'Charging', 'Audio'], delivery: { fee: 400, freeAbove: 15000, pickup: false }, payments: { cod: true, bank: true, online: false }, bank: 'Sampath Bank, Kandy Mobile, 5544332211' },
  'old-books': { preset: 'ink', tagline: 'Second-hand books', about: '', phone: '', whatsapp: '', address: '', city: 'Colombo', categories: [], delivery: { fee: 350, freeAbove: 0, pickup: true }, payments: { cod: true, bank: false, online: false }, bank: '' },
};

// The 10 businesses from data.js (order preserved).
const businesses = [
  { name: 'ABC Fashion', owner: 'Kasun Perera', plan: 'business', status: 'ACTIVE', joined: daysAgo(48), expiry: daysAhead(12), slug: 'abc-fashion', type: 'Fashion and clothing', district: 'Galle' },
  { name: "Nimal's Bakery", owner: 'Nimal Jayasuriya', plan: 'starter', status: 'ACTIVE', joined: daysAgo(90), expiry: daysAhead(21), slug: 'nimal-bakery', type: 'Food and bakery', district: 'Galle' },
  { name: 'Kandy Mobile', owner: 'Ruwan Bandara', plan: 'pro', status: 'EXPIRING', joined: daysAgo(130), expiry: daysAhead(3), slug: 'kandy-mobile', type: 'Electronics and mobile', district: 'Kandy' },
  { name: 'Green Leaf Organics', owner: 'Sanduni Herath', plan: 'business', status: 'PENDING_APPROVAL', joined: daysAgo(1), expiry: null, slug: 'green-leaf', type: 'Home and garden', district: 'Colombo' },
  { name: 'Lanka Handloom', owner: 'Chamara Wickrama', plan: 'starter', status: 'PENDING_APPROVAL', joined: daysAgo(2), expiry: null, slug: 'lanka-handloom', type: 'Fashion and clothing', district: 'Kandy' },
  { name: 'Old Books Corner', owner: 'Mahesh Kumar', plan: 'starter', status: 'SUSPENDED', joined: daysAgo(200), expiry: daysAgo(9), slug: 'old-books', type: 'Books and stationery', district: 'Colombo' },
  { name: 'Ceylon Spice Box', owner: 'Ishara Gunasekara', plan: 'business', status: 'GRACE_PERIOD', joined: daysAgo(75), expiry: daysAgo(2), slug: 'ceylon-spice', type: 'Food and bakery', district: 'Colombo' },
  { name: 'Pet Palace', owner: 'Dilini Jayawardena', plan: 'starter', status: 'PENDING_PAYMENT', joined: daysAgo(3), expiry: null, slug: 'pet-palace', type: 'Other', district: 'Gampaha' },
  { name: 'Coastal Cakes', owner: 'Thilini Rajapaksa', plan: 'business', status: 'ACTIVE', joined: daysAgo(61), expiry: daysAhead(29), slug: 'coastal-cakes', type: 'Food and bakery', district: 'Galle' },
  { name: 'Fit Gear LK', owner: 'Pradeep Senanayake', plan: 'pro', status: 'ACTIVE', joined: daysAgo(150), expiry: daysAhead(17), slug: 'fit-gear', type: 'Other', district: 'Colombo' },
];

const products = [
  { store: 'abc-fashion', name: 'Linen Shirt', category: 'Shirts', price: 3800, stock: 24, lowAt: 5, tone: 'a', options: { Size: ['S', 'M', 'L', 'XL'], Colour: ['White', 'Sand'] }, desc: 'Breathable linen shirt with a relaxed fit. Machine washable.' },
  { store: 'abc-fashion', name: 'Summer Dress', category: 'Dresses', price: 5600, sale: 4500, stock: 5, lowAt: 5, tone: 'e', options: { Size: ['S', 'M', 'L'], Colour: ['Floral', 'Navy'] }, desc: 'Lightweight cotton dress, knee length, with side pockets.' },
  { store: 'abc-fashion', name: 'Cotton Kurta', category: 'Kurtas', price: 5200, stock: 14, lowAt: 5, tone: 'c', options: { Size: ['M', 'L', 'XL'] }, desc: 'Hand-finished cotton kurta for daily and festive wear.' },
  { store: 'abc-fashion', name: 'Denim Jacket', category: 'Jackets', price: 8900, stock: 3, lowAt: 5, tone: 'b', options: { Size: ['M', 'L'] }, desc: 'Classic mid-wash denim jacket. Comes with two front pockets.' },
  { store: 'abc-fashion', name: 'Canvas Tote', category: 'Accessories', price: 2200, stock: 0, lowAt: 5, tone: 'f', options: {}, desc: 'Sturdy canvas tote, fits an A4 folder and a laptop.' },
  { store: 'abc-fashion', name: 'Silk Scarf', category: 'Accessories', price: 1800, stock: 32, lowAt: 5, tone: 'e', options: { Colour: ['Rose', 'Teal', 'Gold'] }, desc: 'Soft printed scarf, 90 x 90 cm.' },
  { store: 'abc-fashion', name: 'Leather Sandals', category: 'Shoes', price: 6400, stock: 9, lowAt: 5, tone: 'c', options: { Size: ['38', '39', '40', '41', '42'] }, desc: 'Hand-stitched leather sandals with a cushioned sole.' },
  { store: 'abc-fashion', name: 'Batik Sarong', category: 'Dresses', price: 3200, sale: 2900, stock: 18, lowAt: 5, tone: 'd', options: { Colour: ['Indigo', 'Maroon'] }, desc: 'Locally made batik sarong, 2 metres, colour-fast.' },
  { store: 'nimal-bakery', name: 'Chocolate Cake 1kg', category: 'Cakes', price: 4200, stock: 6, lowAt: 2, tone: 'c', options: { Message: ['No message', 'Happy Birthday'] }, desc: 'Moist chocolate cake with ganache. Order a day ahead.' },
  { store: 'nimal-bakery', name: 'Butter Cake 500g', category: 'Cakes', price: 2400, stock: 10, lowAt: 2, tone: 'a', options: {}, desc: 'Traditional butter cake, baked fresh each morning.' },
  { store: 'nimal-bakery', name: 'Vanilla Cupcakes (6)', category: 'Cupcakes', price: 1500, stock: 20, lowAt: 4, tone: 'f', options: {}, desc: 'Box of six vanilla cupcakes with butter icing.' },
  { store: 'nimal-bakery', name: 'Kimbula Banis (10)', category: 'Short eats', price: 600, stock: 30, lowAt: 5, tone: 'd', options: {}, desc: 'Pack of ten sweet crocodile-shaped buns.' },
  { store: 'kandy-mobile', name: 'Silicone Phone Case', category: 'Cases', price: 1200, stock: 40, lowAt: 8, tone: 'b', options: { Model: ['Galaxy A15', 'Galaxy A35', 'Redmi 13'] }, desc: 'Soft-touch case with raised edges.' },
  { store: 'kandy-mobile', name: '33W Fast Charger', category: 'Charging', price: 3500, stock: 12, lowAt: 5, tone: 'a', options: {}, desc: 'USB-C fast charger with cable, 6 month warranty.' },
  { store: 'kandy-mobile', name: 'Wireless Earbuds', category: 'Audio', price: 6800, sale: 5900, stock: 7, lowAt: 5, tone: 'f', options: { Colour: ['Black', 'White'] }, desc: 'Bluetooth 5.3 earbuds with a charging case.' },
  { store: 'kandy-mobile', name: 'Screen Guard', category: 'Cases', price: 900, stock: 60, lowAt: 10, tone: 'c', options: { Model: ['Galaxy A15', 'Galaxy A35', 'Redmi 13'] }, desc: 'Tempered glass, easy-fit frame included.' },
];

function order(n, days, customer, phone, city, items, status, pay, note) {
  const sub = items.reduce((s, i) => s + i.price * i.qty, 0);
  const fee = sub >= 10000 ? 0 : 350;
  return { code: 'ORD-' + n, store: 'abc-fashion', date: daysAgo(days), customer, phone, city, items, subtotal: sub, delivery: fee, total: sub + fee, status, payment: pay, note: note || '' };
}
const orders = [
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
  order(10441, 6, 'Nadeesha Perera', '072 505 6060', 'Hambantota', [{ name: 'Batik Sarong (Maroon)', qty: 2, price: 2900 }, { name: 'Silk Scarf (Gold)', qty: 1, price: 1800 }], 'DELIVERED', 'Bank transfer'),
];

// Payments from data.js (business referenced by name).
const payments = [
  { business: 'Green Leaf Organics', plan: 'business', amount: 2500, method: 'Bank transfer', ref: 'TXN 88231045', submitted: daysAgo(1), status: 'PENDING' },
  { business: 'Lanka Handloom', plan: 'starter', amount: 1500, method: 'Bank transfer', ref: 'TXN 88229771', submitted: daysAgo(2), status: 'PENDING' },
  { business: 'Ceylon Spice Box', plan: 'business', amount: 2500, method: 'Bank transfer', ref: 'TXN 88198320', submitted: daysAgo(0), status: 'PENDING' },
  { business: 'Kandy Mobile', plan: 'pro', amount: 5000, method: 'Bank transfer', ref: 'TXN 88110452', submitted: daysAgo(30), status: 'APPROVED' },
  { business: 'ABC Fashion', plan: 'business', amount: 2500, method: 'Bank transfer', ref: 'TXN 88015512', submitted: daysAgo(48), status: 'APPROVED' },
  { business: 'Pet Palace', plan: 'starter', amount: 1500, method: 'Bank transfer', ref: 'TXN 87990001', submitted: daysAgo(3), status: 'REJECTED', reason: 'Amount does not match the plan.' },
];

export async function seed() {
  await withTransaction(async (c) => {
    // Clear (order matters for FKs).
    await c.query(`TRUNCATE notifications, order_status_history, order_items, orders, coupons, products, categories,
                   payments, subscriptions, stores, users, businesses RESTART IDENTITY CASCADE`);

    // Plans (upsert).
    for (const p of plans) {
      await c.query(
        `INSERT INTO plans (id,name,price,duration_days,max_products,max_images,features,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price,
           duration_days=EXCLUDED.duration_days, max_products=EXCLUDED.max_products,
           max_images=EXCLUDED.max_images, features=EXCLUDED.features, sort_order=EXCLUDED.sort_order`,
        [p.id, p.name, p.price, p.duration_days, p.max_products, p.max_images, JSON.stringify(p.features), p.sort_order]
      );
    }

    // Platform admin.
    await c.query(
      `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'SUPER_ADMIN')`,
      [config.admin.name, config.admin.email.toLowerCase(), await hashPassword(config.admin.password)]
    );

    const bizId = {}; // slug -> uuid
    const ownerHash = await hashPassword(OWNER_PASSWORD);

    for (const b of businesses) {
      const d = storeDetail[b.slug] || { preset: 'orchid', tagline: '', about: '', phone: '', whatsapp: '', address: '', city: '', categories: [], delivery: { fee: 350, freeAbove: 0, pickup: true }, payments: { cod: true, bank: true, online: false }, bank: '' };
      const email = `${b.slug}@kade.lk`;
      const biz = (
        await c.query(
          `INSERT INTO businesses (name,type,phone,whatsapp,email,address,city,district,status,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [b.name, b.type, d.phone || null, d.whatsapp || null, email, d.address || null, d.city || null, b.district, b.status, b.joined]
        )
      ).rows[0];
      bizId[b.slug] = biz.id;

      await c.query(
        `INSERT INTO users (business_id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'BUSINESS_OWNER')`,
        [biz.id, b.owner, email, ownerHash]
      );

      await c.query(
        `INSERT INTO stores (business_id,slug,name,tagline,about,preset,phone,whatsapp,address,city,
           delivery_fee,delivery_free_above,pickup,pay_cod,pay_bank,pay_online,bank_details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [biz.id, b.slug, b.name, d.tagline || null, d.about || null, d.preset, d.phone || null, d.whatsapp || null,
         d.address || null, d.city || null, d.delivery.fee, d.delivery.freeAbove, d.delivery.pickup,
         d.payments.cod, d.payments.bank, d.payments.online, d.bank || null]
      );

      for (let i = 0; i < d.categories.length; i++) {
        await c.query(`INSERT INTO categories (business_id,name,sort_order) VALUES ($1,$2,$3)`, [biz.id, d.categories[i], i]);
      }

      // Subscription: status derived from business status.
      const subStatus = ['PENDING_PAYMENT', 'PENDING_APPROVAL'].includes(b.status)
        ? (b.status === 'PENDING_PAYMENT' ? 'PENDING_PAYMENT' : 'PENDING_APPROVAL')
        : b.status;
      await c.query(
        `INSERT INTO subscriptions (business_id,plan_id,status,start_date,expiry_date,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [biz.id, b.plan, subStatus, b.expiry ? b.joined : null, b.expiry, b.joined]
      );
    }

    // Sample photos (self-contained SVGs served by the app at /img/products).
    const PRODUCT_IMG = {
      'Linen Shirt': 'linen-shirt', 'Summer Dress': 'summer-dress', 'Cotton Kurta': 'cotton-kurta',
      'Denim Jacket': 'denim-jacket', 'Canvas Tote': 'canvas-tote', 'Silk Scarf': 'silk-scarf',
      'Leather Sandals': 'leather-sandals', 'Batik Sarong': 'batik-sarong',
      'Chocolate Cake 1kg': 'chocolate-cake', 'Butter Cake 500g': 'butter-cake',
      'Vanilla Cupcakes (6)': 'vanilla-cupcakes', 'Kimbula Banis (10)': 'kimbula-banis',
      'Silicone Phone Case': 'silicone-phone-case', '33W Fast Charger': 'fast-charger',
      'Wireless Earbuds': 'wireless-earbuds', 'Screen Guard': 'screen-guard',
    };

    // Products.
    for (const p of products) {
      const image = PRODUCT_IMG[p.name] ? `/img/products/${PRODUCT_IMG[p.name]}.svg` : null;
      const images = image ? [image] : [];
      await c.query(
        `INSERT INTO products (business_id,category,name,description,price,sale_price,stock,low_at,options,tone,image_url,images)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [bizId[p.store], p.category, p.name, p.desc, p.price, p.sale ?? null, p.stock, p.lowAt, JSON.stringify(p.options || {}), p.tone, image, JSON.stringify(images)]
      );
    }

    // Orders for abc-fashion.
    for (const o of orders) {
      const created = (
        await c.query(
          `INSERT INTO orders (business_id,code,customer_name,phone,city,subtotal,delivery_fee,total,status,payment_method,note,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [bizId[o.store], o.code, o.customer, o.phone, o.city, o.subtotal, o.delivery, o.total, o.status, o.payment, o.note, o.date]
        )
      ).rows[0];
      for (const it of o.items) {
        await c.query(`INSERT INTO order_items (order_id,name,qty,price) VALUES ($1,$2,$3,$4)`, [created.id, it.name, it.qty, it.price]);
      }
      await c.query(`INSERT INTO order_status_history (order_id,status,created_at) VALUES ($1,$2,$3)`, [created.id, o.status, o.date]);
    }

    // Demo coupons for ABC Fashion (a Business-plan store).
    const demoCoupons = [
      { code: 'WELCOME10', type: 'percent', value: 10, min_order: 0, usage_limit: null, expires_on: null, used_count: 12 },
      { code: 'SHIP500', type: 'fixed', value: 500, min_order: 5000, usage_limit: 100, expires_on: daysAhead(20), used_count: 8 },
    ];
    for (const dc of demoCoupons) {
      await c.query(
        `INSERT INTO coupons (business_id, code, type, value, min_order, usage_limit, expires_on, used_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [bizId['abc-fashion'], dc.code, dc.type, dc.value, dc.min_order, dc.usage_limit, dc.expires_on, dc.used_count]
      );
    }

    // Payments.
    for (const p of payments) {
      const slug = businesses.find((b) => b.name === p.business)?.slug;
      if (!slug) continue;
      const subId = (await c.query('SELECT id FROM subscriptions WHERE business_id=$1 ORDER BY created_at DESC LIMIT 1', [bizId[slug]])).rows[0]?.id;
      await c.query(
        `INSERT INTO payments (business_id,subscription_id,plan_id,amount,method,reference,status,reason,submitted_at,reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [bizId[slug], subId, p.plan, p.amount, p.method, p.ref, p.status, p.reason || null, p.submitted, p.status !== 'PENDING' ? p.submitted : null]
      );
    }
  });

  console.log('[db] seed complete.');
  console.log(`      Admin login : ${config.admin.email} / ${config.admin.password}`);
  console.log(`      Owner login : abc-fashion@kade.lk / ${OWNER_PASSWORD}  (and <slug>@kade.lk for the others)`);
}

// Run as a CLI: `npm run db:seed`
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/db/seed.js')) {
  seed().then(() => pool.end()).catch((err) => {
    console.error('[db] seed failed:', err);
    process.exit(1);
  });
}
