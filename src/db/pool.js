import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// Railway/most managed Postgres require SSL; local usually does not.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error', err);
});

export function query(text, params) {
  return pool.query(text, params);
}

// Run a set of statements inside one transaction. The callback receives a client.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
