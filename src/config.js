import 'dotenv/config';

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).toLowerCase() === 'true' || v === '1';
}

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: bool(process.env.DATABASE_SSL, false),
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@sidadiya.lk',
    password: process.env.ADMIN_PASSWORD || 'admin12345',
    name: process.env.ADMIN_NAME || 'Platform Admin',
  },
  uploadDriver: process.env.UPLOAD_DRIVER || 'local',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`,
  firebase: {
    bucket: process.env.FIREBASE_STORAGE_BUCKET,
    serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,
  },
};

if (!config.databaseUrl) {
  console.warn('[config] DATABASE_URL is not set — the API will fail to connect to Postgres.');
}
