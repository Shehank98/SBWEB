import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
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
export async function saveUpload(file, folder = 'misc') {
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
