// Map DB rows to the exact JSON shapes the Sidadiya frontend already consumes
// (see kade-frontend/js/data.js). Keeping the contract identical means the
// frontend swaps `KadeData.*` for `fetch()` with no reshaping.

function iso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

export function storePublic(store, categories) {
  return {
    slug: store.slug,
    name: store.name,
    preset: store.preset,
    template: store.template || 'classic',
    status: store.status, // business status, injected by caller
    tagline: store.tagline || '',
    about: store.about || '',
    phone: store.phone || '',
    whatsapp: store.whatsapp || '',
    address: store.address || '',
    city: store.city || '',
    logo: store.logo_url || null,
    cover: store.cover_url || null,
    categories: categories || [],
    delivery: {
      fee: store.delivery_fee,
      freeAbove: store.delivery_free_above,
      pickup: store.pickup,
    },
    payments: { cod: store.pay_cod, bank: store.pay_bank, online: store.pay_online },
    bank: store.bank_details || '',
    bankAccount: store.bank_account || {},
    contact: { email: store.contact_email || '', phone: store.phone || '', address: store.address || '' },
    // The five compliance pages, linked from every storefront footer and the checkout.
    policies: POLICY_LINKS,
  };
}

const POLICY_LINKS = [
  { key: 'refund', title: 'Refund Policy' },
  { key: 'return', title: 'Return Policy' },
  { key: 'privacy', title: 'Privacy Policy' },
  { key: 'terms', title: 'Terms & Conditions' },
  { key: 'contact', title: 'Contact Details' },
];

export function product(row) {
  const out = {
    id: row.id,
    store: row.store_slug, // injected by join when needed
    name: row.name,
    category: row.category,
    price: row.price,
    stock: row.stock,
    lowAt: row.low_at,
    tone: row.tone,
    options: row.options || {},
    desc: row.description || '',
    image: row.image_url || (Array.isArray(row.images) && row.images[0]) || null,
    images: Array.isArray(row.images) && row.images.length ? row.images : (row.image_url ? [row.image_url] : []),
    variants: Array.isArray(row.variants) ? row.variants : [],
    status: row.status,
  };
  if (row.sale_price != null) out.sale = row.sale_price;
  if (row.review_count != null) { out.rating = Number(row.avg_rating); out.reviews = Number(row.review_count); }
  return out;
}

// Public review: first name + last initial only.
export function review(row) {
  const parts = String(row.customer_name || 'Buyer').trim().split(/\s+/);
  const who = parts[0] + (parts.length > 1 ? ' ' + parts[parts.length - 1][0].toUpperCase() + '.' : '');
  return { rating: row.rating, body: row.body || '', name: who, product: row.product_name, date: iso(row.created_at) };
}

// The buyer's view of their own order (status page).
export function buyerOrder(row, items, history, reviewedSet) {
  const reviewed = reviewedSet || new Set();
  return {
    code: row.code,
    date: iso(row.created_at),
    status: row.status,
    history: (history || []).map((h) => ({ status: h.status, at: h.created_at })),
    customer: row.customer_name,
    items: (items || []).map((i) => ({ productId: i.product_id, name: i.name, qty: i.qty, price: i.price, reviewed: i.product_id ? reviewed.has(i.product_id) : true })),
    subtotal: row.subtotal,
    discount: row.discount || 0,
    delivery: row.delivery_fee,
    total: row.total,
    payment: row.payment_method,
    paymentStatus: row.payment_status || null,
    method: row.delivery_method,
    address: row.address || '',
    city: row.city || '',
    district: row.district || '',
  };
}

export function order(row, items) {
  return {
    id: row.code,
    orderId: row.id,
    business: row.business_slug, // injected by join when needed
    date: iso(row.created_at),
    customer: row.customer_name,
    phone: row.phone,
    whatsapp: row.whatsapp || '',
    city: row.city || '',
    address: row.address || '',
    items: (items || []).map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
    subtotal: row.subtotal,
    discount: row.discount || 0,
    coupon: row.coupon_code || null,
    delivery: row.delivery_fee,
    total: row.total,
    status: row.status,
    payment: row.payment_method,
    paymentStatus: row.payment_status || null,
    paidOn: row.paid_on || null,
    refundNote: row.refund_note || null,
    note: row.note || '',
    statusUrl: row.public_token && row.business_slug ? `/store/order?s=${encodeURIComponent(row.business_slug)}&o=${encodeURIComponent(row.code)}&k=${row.public_token}` : undefined,
  };
}

export function coupon(row) {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    minOrder: row.min_order,
    expiresOn: iso(row.expires_on),
    usageLimit: row.usage_limit,
    used: row.used_count,
    status: row.status,
  };
}

export function businessAdmin(row) {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner_name || '',
    plan: row.plan_name || '',
    status: row.status,
    joined: iso(row.created_at),
    expiry: iso(row.expiry_date),
    orders: Number(row.order_count || 0),
    revenue: Number(row.revenue || 0),
    slug: row.slug || null,
  };
}

export function payment(row) {
  const out = {
    id: row.id,
    business: row.business_name,
    owner: row.owner_name || '',
    plan: row.plan_name || '',
    amount: row.amount,
    method: row.method,
    ref: row.reference || '',
    slip: row.slip_url || null,
    submitted: iso(row.submitted_at),
    status: row.status,
  };
  if (row.reason) out.reason = row.reason;
  return out;
}

export function plan(row) {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    durationDays: row.duration_days,
    maxProducts: row.max_products,
    maxImages: row.max_images,
    maxCategories: row.max_categories,
    maxVariants: row.max_variants,
    compareAtPrice: row.compare_at_price ?? null,
    tagline: row.tagline || '',
    flags: row.feature_flags || {},
    features: row.features || [],
  };
}

// Admin view of a plan: everything editable, including inactive plans.
export function planAdmin(row) {
  return { ...plan(row), status: row.status, sortOrder: row.sort_order, updatedAt: row.updated_at || null };
}
