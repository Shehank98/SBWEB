import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

// Pluggable file storage. Default "local" driver writes to ./uploads and returns a
// public URL — zero setup. Set UPLOAD_DRIVER=firebase to push to Firebase Storage
// instead (product photos, payment slips) and store the returned URL in Postgres.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

let firebaseBucket = null;

async function getFirebaseBucket() {
  if (firebaseBucket) return firebaseBucket;
  // Lazy import so the dependency is optional unless the driver is actually used.
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps.length) {
    const creds = config.firebase.serviceAccount
      ? JSON.parse(config.firebase.serviceAccount)
      : undefined;
    admin.initializeApp({
      credential: creds ? admin.credential.cert(creds) : admin.credential.applicationDefault(),
      storageBucket: config.firebase.bucket,
    });
  }
  firebaseBucket = admin.storage().bucket();
  return firebaseBucket;
}

/**
 * @param {{buffer: Buffer, originalname: string, mimetype: string}} file  (from multer memoryStorage)
 * @param {string} folder  logical folder, e.g. `products/<slug>` or `slips`
 * @returns {Promise<string>} public URL
 */
export async function saveUpload(file, folder = 'misc') {
  const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const key = `${folder}/${safeName}`;

  if (config.uploadDriver === 'firebase') {
    const bucket = await getFirebaseBucket();
    const blob = bucket.file(key);
    await blob.save(file.buffer, { contentType: file.mimetype, resumable: false });
    await blob.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/${key}`;
  }

  // local driver
  const dest = path.join(UPLOAD_DIR, folder);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, safeName), file.buffer);
  return `${config.publicBaseUrl}/uploads/${key}`;
}

export { UPLOAD_DIR };
