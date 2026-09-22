import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool.js';
import { authenticate, requireBusiness, requirePermission } from '../middleware/auth.js';
import { wrap, badRequest, notFound, forbidden } from '../utils/http.js';
import { saveUpload } from '../services/uploads.js';
import { currentPlan, cap } from '../services/plan.js';
import * as S from '../services/serialize.js';

// Hard ceiling on files accepted per request (multer needs a finite bound even when
// the plan is "unlimited"). The real per-product limit is the plan's max_images.
const MAX_UPLOAD_FILES = 30;
const DEFAULT_MAX_IMAGES = 5;
const DEFAULT_MAX_VARIANTS = 5;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: MAX_UPLOAD_FILES } });
export const productsRouter = Router();

// Per-product caps from the plan; NULL means unlimited (Infinity).
async function imageLimit(bid) {
  const plan = await currentPlan(bid);
  return plan ? cap(plan.max_images) : DEFAULT_MAX_IMAGES;
}
async function variantLimit(bid) {
  const plan = await currentPlan(bid);
  return plan ? cap(plan.max_variants) : DEFAULT_MAX_VARIANTS;
}

// Save every uploaded file and return their public URLs, in upload order.
async function saveFiles(files, bid) {
  if (!files || !files.length) return [];
  const store = (await query('SELECT slug FROM stores WHERE business_id = $1', [bid])).rows[0];
  const folder = `products/${store ? store.slug : bid}`;
  const urls = [];
  for (const file of files) urls.push(await saveUpload(file, folder));
  return urls;
}

// Existing image URLs the client asked to keep, filtered to ones that really
// belong to this product (never trust arbitrary URLs from the body).
function keptImages(body, existingImages) {
  let keep = [];
  if (body.keepImages) {
    try { keep = typeof body.keepImages === 'string' ? JSON.parse(body.keepImages) : body.keepImages; }
    catch { keep = []; }
  }
  if (!Array.isArray(keep)) keep = [];
  const allowed = new Set(existingImages || []);
  return keep.filter((u) => allowed.has(u));
}

productsRouter.use(authenticate, requireBusiness, requirePermission('products'));

// The business_id ALWAYS comes from the token, never the request body — this is the
// line that keeps one tenant from touching another's catalogue.
function tenantId(req) {
  return req.user.business_id;
}

// GET /api/products  — the owner's own catalogue, with plan usage.
productsRouter.get(
  '/',
  wrap(async (req, res) => {
    const bid = tenantId(req);
    const { rows } = await query(
      `SELECT * FROM products WHERE business_id = $1 ORDER BY created_at DESC`,
      [bid]
    );
    const plan = (
      await query(
        `SELECT pl.* FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
          WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
        [bid]
      )
    ).rows[0];
    res.json({
      products: rows.map(S.product),
      usage: {
        count: rows.length,
        maxProducts: plan ? plan.max_products : null,
        // NULL = unlimited; the frontend treats null as "no cap".
        maxImages: plan ? plan.max_images : DEFAULT_MAX_IMAGES,
        maxVariants: plan ? plan.max_variants : DEFAULT_MAX_VARIANTS,
        plan: plan ? plan.name : null,
      },
    });
  })
);

// Parse and validate the optional priced-variants list.
function parseVariants(raw) {
  let v = [];
  if (raw) {
    try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { throw badRequest('Variants are not valid.'); }
  }
  if (!Array.isArray(v)) throw badRequest('Variants are not valid.');
  return v.map((x, i) => {
    const label = (x.label || '').trim();
    if (!label) throw badRequest(`Give variant ${i + 1} a name (like "500g" or "Large").`);
    const price = Number(x.price);
    if (!(price > 0)) throw badRequest(`Enter a price above zero for "${label}".`);
    let sale = x.sale === '' || x.sale == null ? null : Number(x.sale);
    if (sale != null && (!(sale > 0) || sale >= price)) throw badRequest(`The sale price for "${label}" must be lower than its price.`);
    const stock = Number(x.stock);
    if (!(stock >= 0) || Math.floor(stock) !== stock) throw badRequest(`Enter a whole number of stock for "${label}".`);
    return { label, price, sale, stock, lowAt: Number(x.lowAt) || 0 };
  });
}

function parseProductBody(b) {
  const name = (b.name || '').trim();
  if (!name) throw badRequest('Give the product a name.');
  const variants = parseVariants(b.variants);

  let options = {};
  if (b.options) {
    try { options = typeof b.options === 'string' ? JSON.parse(b.options) : b.options; }
    catch { throw badRequest('Options are not valid.'); }
  }
  const out = {
    name,
    category: b.category || null,
    options,
    description: (b.desc || b.description || '').trim(),
    tone: b.tone || ['a', 'b', 'c', 'd', 'e', 'f'][Math.floor(Math.random() * 6)],
    variants,
  };

  if (variants.length) {
    // Derive product-level price/stock from the variants so listings, low-stock
    // counts and reports keep working. Listing price is the cheapest "from" price.
    out.price = Math.min(...variants.map((v) => v.price));
    out.sale = null;
    out.stock = variants.reduce((n, v) => n + v.stock, 0);
    out.low_at = Math.max(0, ...variants.map((v) => v.lowAt));
  } else {
    const price = Number(b.price);
    if (!(price > 0)) throw badRequest('Enter a price above zero.');
    let sale = b.sale === '' || b.sale == null ? null : Number(b.sale);
    if (sale != null && (!(sale > 0) || sale >= price)) throw badRequest('The sale price must be lower than the price.');
    const stock = Number(b.stock);
    if (!(stock >= 0) || Math.floor(stock) !== stock) throw badRequest('Enter a whole number for stock.');
    out.price = price;
    out.sale = sale;
    out.stock = stock;
    out.low_at = Number(b.lowAt) || 0;
  }
  return out;
}

// POST /api/products  (multipart: fields + optional images[])
productsRouter.post(
  '/',
  upload.array('images', MAX_UPLOAD_FILES),
  wrap(async (req, res) => {
    const bid = tenantId(req);
    const p = parseProductBody(req.body);

    // Enforce the plan's product cap.
    const plan = (
      await query(
        `SELECT pl.max_products FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
          WHERE s.business_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
        [bid]
      )
    ).rows[0];
    if (plan && plan.max_products != null) {
      const count = (await query('SELECT COUNT(*) c FROM products WHERE business_id = $1', [bid])).rows[0].c;
      if (Number(count) >= plan.max_products) {
        throw forbidden(`Your plan allows up to ${plan.max_products} products. Upgrade to add more.`);
      }
    }

    // Enforce the plan's variant cap.
    const vLimit = await variantLimit(bid);
    if (p.variants.length > vLimit) {
      throw forbidden(`Your plan allows up to ${vLimit} variant${vLimit === 1 ? '' : 's'} per product. Upgrade to add more.`);
    }
    // Enforce the plan's photo cap, then save and store the gallery (first = cover).
    const limit = await imageLimit(bid);
    if ((req.files || []).length > limit) {
      throw forbidden(`Your plan allows up to ${limit} photo${limit === 1 ? '' : 's'} per product. Upgrade to add more.`);
    }
    const images = await saveFiles(req.files, bid);
    const imageUrl = images[0] || null;

    const { rows } = await query(
      `INSERT INTO products (business_id, category, name, description, price, sale_price, stock, low_at, options, tone, image_url, images, variants)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [bid, p.category, p.name, p.description, p.price, p.sale, p.stock, p.low_at, JSON.stringify(p.options), p.tone, imageUrl, JSON.stringify(images), JSON.stringify(p.variants)]
    );
    res.status(201).json({ product: S.product(rows[0]) });
  })
);

// PUT /api/products/:id  (multipart: fields + kept existing images + optional new images[])
productsRouter.put(
  '/:id',
  upload.array('images', MAX_UPLOAD_FILES),
  wrap(async (req, res) => {
    const bid = tenantId(req);
    const existing = (await query('SELECT * FROM products WHERE id = $1 AND business_id = $2', [req.params.id, bid])).rows[0];
    if (!existing) throw notFound('Product not found.');
    const p = parseProductBody(req.body);

    // Rebuild the gallery: the existing photos the owner chose to keep (in order),
    // followed by any newly uploaded ones. First entry is the cover.
    const existingImages = Array.isArray(existing.images) && existing.images.length
      ? existing.images
      : (existing.image_url ? [existing.image_url] : []);
    // When the client sends no keepImages field at all (older form), keep what's there.
    const keep = req.body.keepImages == null ? existingImages : keptImages(req.body, existingImages);
    const uploaded = await saveFiles(req.files, bid);
    const images = keep.concat(uploaded);

    const vLimit = await variantLimit(bid);
    if (p.variants.length > vLimit) {
      throw forbidden(`Your plan allows up to ${vLimit} variant${vLimit === 1 ? '' : 's'} per product. Upgrade to add more.`);
    }
    const limit = await imageLimit(bid);
    if (images.length > limit) {
      throw forbidden(`Your plan allows up to ${limit} photo${limit === 1 ? '' : 's'} per product. Upgrade to add more.`);
    }
    const imageUrl = images[0] || null;

    const { rows } = await query(
      `UPDATE products SET category=$3, name=$4, description=$5, price=$6, sale_price=$7, stock=$8, low_at=$9,
              options=$10, tone=$11, image_url=$12, images=$13, variants=$14, updated_at=now()
        WHERE id=$1 AND business_id=$2 RETURNING *`,
      [req.params.id, bid, p.category, p.name, p.description, p.price, p.sale, p.stock, p.low_at, JSON.stringify(p.options), p.tone, imageUrl, JSON.stringify(images), JSON.stringify(p.variants)]
    );
    res.json({ product: S.product(rows[0]) });
  })
);

// DELETE /api/products/:id
productsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const bid = tenantId(req);
    const r = await query('DELETE FROM products WHERE id = $1 AND business_id = $2', [req.params.id, bid]);
    if (!r.rowCount) throw notFound('Product not found.');
    res.json({ ok: true });
  })
);
