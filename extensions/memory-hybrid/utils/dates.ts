/**
 * Date parsing for facts (sourceDate, etc.).
 */

/** Parse sourceDate from ISO-8601 (YYYY-MM-DD) or Unix timestamp (seconds). Date strings are interpreted as UTC midnight. Returns null if invalid. */
export function parseSourceDate(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2})?/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    const ms = Date.UTC(parseInt(y!, 10), parseInt(m!, 10) - 1, parseInt(d!, 10));
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const n = parseInt(s, 10);
  return !isNaN(n) && n > 0 ? n : null;
}
