import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pool.js';
import { authenticate, requireBusiness, requirePermission } from '../middleware/auth.js';
import { wrap, badRequest, notFound, forbidden } from '../utils/http.js';
import { saveUpload } from '../services/uploads.js';
import * as S from '../services/serialize.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
export const productsRouter = Router();

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
      usage: { count: rows.length, maxProducts: plan ? plan.max_products : null, plan: plan ? plan.name : null },
    });
  })
);

function parseProductBody(b) {
  const name = (b.name || '').trim();
  if (!name) throw badRequest('Give the product a name.');
  const price = Number(b.price);
  if (!(price > 0)) throw badRequest('Enter a price above zero.');
  let sale = b.sale === '' || b.sale == null ? null : Number(b.sale);
  if (sale != null && (!(sale > 0) || sale >= price)) throw badRequest('The sale price must be lower than the price.');
  const stock = Number(b.stock);
  if (!(stock >= 0) || Math.floor(stock) !== stock) throw badRequest('Enter a whole number for stock.');

  let options = {};
  if (b.options) {
    try { options = typeof b.options === 'string' ? JSON.parse(b.options) : b.options; }
    catch { throw badRequest('Options are not valid.'); }
  }
  return {
    name,
    category: b.category || null,
    price,
    sale,
    stock,
    low_at: Number(b.lowAt) || 0,
    options,
    description: (b.desc || b.description || '').trim(),
    tone: b.tone || ['a', 'b', 'c', 'd', 'e', 'f'][Math.floor(Math.random() * 6)],
  };
}

// POST /api/products  (multipart: fields + optional image)
productsRouter.post(
  '/',
  upload.single('image'),
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

    let imageUrl = null;
    if (req.file) {
      const store = (await query('SELECT slug FROM stores WHERE business_id = $1', [bid])).rows[0];
      imageUrl = await saveUpload(req.file, `products/${store ? store.slug : bid}`);
    }

    const { rows } = await query(
      `INSERT INTO products (business_id, category, name, description, price, sale_price, stock, low_at, options, tone, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [bid, p.category, p.name, p.description, p.price, p.sale, p.stock, p.low_at, JSON.stringify(p.options), p.tone, imageUrl]
    );
    res.status(201).json({ product: S.product(rows[0]) });
  })
);

// PUT /api/products/:id
productsRouter.put(
  '/:id',
  upload.single('image'),
  wrap(async (req, res) => {
    const bid = tenantId(req);
    const existing = (await query('SELECT * FROM products WHERE id = $1 AND business_id = $2', [req.params.id, bid])).rows[0];
    if (!existing) throw notFound('Product not found.');
    const p = parseProductBody(req.body);

    let imageUrl = existing.image_url;
    if (req.file) {
      const store = (await query('SELECT slug FROM stores WHERE business_id = $1', [bid])).rows[0];
      imageUrl = await saveUpload(req.file, `products/${store ? store.slug : bid}`);
    }

    const { rows } = await query(
      `UPDATE products SET category=$3, name=$4, description=$5, price=$6, sale_price=$7, stock=$8, low_at=$9,
              options=$10, tone=$11, image_url=$12, updated_at=now()
        WHERE id=$1 AND business_id=$2 RETURNING *`,
      [req.params.id, bid, p.category, p.name, p.description, p.price, p.sale, p.stock, p.low_at, JSON.stringify(p.options), p.tone, imageUrl]
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
