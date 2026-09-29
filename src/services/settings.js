import { query } from '../db/pool.js';

// Admin-editable platform settings (platform_settings key/value table).
// Reads are cached briefly; a write clears the cache on this instance, and other
// instances pick the change up within CACHE_MS.
const CACHE_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

async function loadAll() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const { rows } = await query('SELECT key, value FROM platform_settings');
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cachedAt = Date.now();
  return cache;
}

export async function getSetting(key, fallback = null) {
  const all = await loadAll();
  return all[key] === undefined ? fallback : all[key];
}

export async function getSettings(keys) {
  const all = await loadAll();
  const out = {};
  for (const k of keys) out[k] = all[k] === undefined ? null : all[k];
  return out;
}

export async function setSetting(key, value, userId = null, client = null) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId]
  );
  cache = null;
}

export function clearSettingsCache() { cache = null; }

export async function trialDays() {
  const n = Number(await getSetting('trial_days', 14));
  return Number.isFinite(n) && n > 0 && n <= 90 ? Math.round(n) : 14;
}
