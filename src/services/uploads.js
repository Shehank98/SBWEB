import fs from 'fs';
import path from 'path';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { badRequest } from '../utils/http.js';

// Allowed upload types. Raster images only for photos/logos: never SVG or HTML,
// which can carry scripts and would run as stored XSS when served from our origin.
// Payment slips may also be PDFs.
export const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const SLIP_TYPES = new Set([...IMAGE_TYPES, 'application/pdf']);

// Pluggable file storage. Default "local" driver writes to ./uploads and returns a
// public URL — zero setup. Set UPLOAD_DRIVER=firebase to push to Firebase Storage
// instead (product photos, payment slips) and store the returned URL in Postgres.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

let firebaseBucket = null;

async function getFirebaseBucket() {
  if (firebaseBucket) return firebaseBucket;
  // Lazy import so the dependency is optional unless the driver is actually used.
  // firebase-admin v12+ exposes its API through modular subpaths — the old
  // namespaced default (admin.apps / admin.credential / admin.storage) is undefined.
  const { getApps, initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getStorage } = await import('firebase-admin/storage');
  if (!config.firebase.bucket) {
    throw new Error('FIREBASE_STORAGE_BUCKET is not set');
  }
  if (!getApps().length) {
    const creds = config.firebase.serviceAccount
      ? JSON.parse(config.firebase.serviceAccount)
      : undefined;
    initializeApp({
      credential: creds ? cert(creds) : applicationDefault(),
      storageBucket: config.firebase.bucket,
    });
  }
  firebaseBucket = getStorage().bucket();
  return firebaseBucket;
}

/**
 * @param {{buffer: Buffer, originalname: string, mimetype: string}} file  (from multer memoryStorage)
 * @param {string} folder  logical folder, e.g. `products/<slug>` or `slips`
 * @returns {Promise<string>} public URL
 */
export async function saveUpload(file, folder = 'misc', opts = {}) {
  const allow = opts.allow || IMAGE_TYPES;
  if (!file || !file.buffer) throw badRequest('No file was uploaded.');
  if (!allow.has(file.mimetype)) {
    throw badRequest(allow.has('application/pdf')
      ? 'Please upload a JPG, PNG, WEBP, GIF or PDF file.'
      : 'Please upload a JPG, PNG, WEBP or GIF image.');
  }
  const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const key = `${folder}/${safeName}`;

  if (config.uploadDriver === 'firebase') {
    const bucket = await getFirebaseBucket();
    const blob = bucket.file(key);
    // Use a Firebase download token instead of makePublic(): the token grants read
    // access and works even when the bucket has "uniform bucket-level access" on
    // (the default for new buckets), where object ACLs / makePublic() would fail.
    const token = randomUUID();
    await blob.save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(key)}?alt=media&token=${token}`;
  }

  // local driver
  const dest = path.join(UPLOAD_DIR, folder);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, safeName), file.buffer);
  return `${config.publicBaseUrl}/uploads/${key}`;
}

export { UPLOAD_DIR };

// ---------------------------------------------------------------------------------
// PRIVATE files (seller verification documents). Never publicly readable:
//  - firebase: saved under private/shops/<businessId>/... with NO download token, so
//    the only way to read them is a short-lived V4 signed URL made by the backend
//    (Firebase Storage rules in storage.rules deny all client access to private/).
//  - local: saved to ./uploads-private, which is never served statically; read back
//    through /api/files/private?key=..&exp=..&sig=.. with an HMAC signature that
//    expires (the same idea as a signed URL).
// ---------------------------------------------------------------------------------
const PRIVATE_DIR = path.join(__dirname, '..', '..', 'uploads-private');
export const DOC_TYPES = SLIP_TYPES; // JPG/PNG/WEBP/GIF or PDF

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

export async function savePrivate(file, businessId, name) {
  if (!file || !file.buffer) throw badRequest('No file was uploaded.');
  if (!DOC_TYPES.has(file.mimetype)) throw badRequest('Please upload a JPG, PNG, WEBP or PDF file.');
  if (!/^[0-9a-f-]{36}$/i.test(String(businessId))) throw badRequest('Invalid shop.');
  const key = `private/shops/${businessId}/verification/${name}-${Date.now()}.${EXT[file.mimetype]}`;
  if (config.uploadDriver === 'firebase') {
    const bucket = await getFirebaseBucket();
    // No firebaseStorageDownloadTokens metadata and no ACL change: the object stays
    // private (works with uniform bucket-level access, where per-object ACLs fail).
    await bucket.file(key).save(file.buffer, { contentType: file.mimetype, resumable: false });
  } else {
    const dest = path.join(PRIVATE_DIR, path.dirname(key));
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(PRIVATE_DIR, key), file.buffer);
  }
  return key;
}

function hmac(key, exp) {
  return createHmac('sha256', config.jwtSecret).update(`${key}\n${exp}`).digest('base64url');
}

// A URL that works for `ttlSeconds` (default 5 minutes) and then stops working.
export async function signedPrivateUrl(key, ttlSeconds = 300) {
  const expires = Date.now() + ttlSeconds * 1000;
  if (config.uploadDriver === 'firebase') {
    const bucket = await getFirebaseBucket();
    const [url] = await bucket.file(key).getSignedUrl({ version: 'v4', action: 'read', expires });
    return url;
  }
  return `/api/files/private?key=${encodeURIComponent(key)}&exp=${expires}&sig=${hmac(key, expires)}`;
}

// Resolves a local signed request to a file path, or null if invalid/expired.
export function verifyPrivateRequest(key, exp, sig) {
  const e = Number(exp);
  if (!key || !sig || !Number.isFinite(e) || e < Date.now()) return null;
  if (!/^private\/shops\/[0-9a-f-]{36}\/verification\/[\w.-]+$/i.test(key)) return null;
  const want = Buffer.from(hmac(key, e));
  const got = Buffer.from(String(sig));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const full = path.join(PRIVATE_DIR, key);
  return full.startsWith(PRIVATE_DIR + path.sep) && fs.existsSync(full) ? full : null;
}
