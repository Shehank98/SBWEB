// Sri Lanka time helpers (Asia/Colombo is UTC+05:30 all year, no DST).
export const SL_OFFSET_MS = 5.5 * 3600 * 1000; // Asia/Colombo is UTC+05:30 all year (no DST)

// "Wall clock" in Sri Lanka as a Date whose UTC fields read as local SL time.
export function slNow(now = new Date()) { return new Date(now.getTime() + SL_OFFSET_MS); }
export function slDate(now = new Date()) { return slNow(now).toISOString().slice(0, 10); }

// ISO-8601 week id for the SL date, e.g. "2026-W40".
export function slIsoWeek(now = new Date()) {
  const d = slNow(now);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

