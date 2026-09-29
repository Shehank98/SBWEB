// Encryption at rest for sellers' payment gateway credentials (AES-256-GCM).
//
// Key: GATEWAY_ENC_KEY = 32 random bytes, base64 or hex
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// If it is not set, a key is derived from JWT_SECRET so development works, with a
// loud warning: set a dedicated key in production. NEVER change the key once sellers
// have saved credentials (they would need to re-enter them).
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { config } from '../config.js';

let key = null;
function getKey() {
  if (key) return key;
  const raw = process.env.GATEWAY_ENC_KEY || '';
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error('GATEWAY_ENC_KEY must be 32 bytes (base64 or hex).');
    key = buf;
  } else {
    console.warn('[secrets] GATEWAY_ENC_KEY is not set; deriving a key from JWT_SECRET. Set GATEWAY_ENC_KEY before going live.');
    key = createHash('sha256').update('sidadiya-gateway-credentials:' + config.jwtSecret).digest();
  }
  return key;
}

export function encryptJson(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptJson(s) {
  if (!s) return null;
  const [v, iv, tag, ct] = String(s).split(':');
  if (v !== 'v1') throw new Error('Unknown credential format');
  const d = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
}

export function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  return s.length <= 4 ? '••••' : '••••' + s.slice(-4);
}
