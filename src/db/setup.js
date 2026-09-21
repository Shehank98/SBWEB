// Creates all tables. Idempotent (uses IF NOT EXISTS). Run: npm run db:setup
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] schema applied.');
  await pool.end();
}

main().catch((err) => {
  console.error('[db] setup failed:', err);
  process.exit(1);
});
