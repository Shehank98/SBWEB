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
    categories: categories || [],
    delivery: {
      fee: store.delivery_fee,
      freeAbove: store.delivery_free_above,
      pickup: store.pickup,
    },
    payments: { cod: store.pay_cod, bank: store.pay_bank, online: store.pay_online },
    bank: store.bank_details || '',
  };
}

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
  return out;
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
    note: row.note || '',
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
    features: row.features || [],
  };
}
