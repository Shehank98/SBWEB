// Versioned SQL migrations.
//
// schema.sql is the frozen baseline (idempotent CREATE ... IF NOT EXISTS) that every
// existing database already has. Every change after it lives in
// src/db/migrations/NNN_name.sql and is applied exactly once, in filename order,
// inside a transaction, and recorded in schema_migrations. A Postgres advisory lock
// stops two app instances booting at the same time from racing each other.
//
// Run manually:  npm run db:migrate      (also runs automatically on server boot)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 482913; // arbitrary constant shared by every instance of this app

export function migrationFiles() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
}

export async function runMigrations(log = console.log) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const file of migrationFiles()) {
      const id = file.replace(/\.sql$/, '');
      if (done.has(id)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${e.message}`);
      }
      applied.push(id);
      log(`[db] migration applied: ${id}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

// CLI entrypoint: node src/db/migrate.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then((a) => { console.log(`[db] ${a.length} migration(s) applied.`); return pool.end(); })
    .catch((e) => { console.error('[db]', e.message); process.exit(1); });
}
