/**
 * Canonical timestamp parsing and formatting for hybrid memory.
 *
 * Policy:
 * - Internal hot paths (facts, decay, TTL): epoch seconds
 * - Serialized TEXT columns, API, logs: ISO 8601 UTC with Z
 * - Calendar-day semantics: YYYY-MM-DD UTC
 */

/** Threshold distinguishing epoch seconds from milliseconds (valid until ~2286). */
const EPOCH_MS_THRESHOLD = 10_000_000_000;

/** Current time as Unix epoch seconds. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Current time as ISO 8601 UTC (e.g. 2026-06-05T12:34:56.789Z). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Format epoch seconds as ISO 8601 UTC. */
export function formatTimestampUtc(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** Format epoch seconds as UTC calendar date YYYY-MM-DD. */
export function formatDateUtc(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/**
 * Parse a timestamp from any legacy or canonical shape into epoch seconds.
 * Returns null when the value cannot be parsed.
 */
export function parseTimestamp(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value >= EPOCH_MS_THRESHOLD ? Math.floor(value / 1000) : Math.floor(value);
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric >= EPOCH_MS_THRESHOLD ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }

  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoDateOnly) {
    const [, y, m, d] = isoDateOnly;
    const ms = Date.UTC(Number.parseInt(y!, 10), Number.parseInt(m!, 10) - 1, Number.parseInt(d!, 10));
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  const normalized = trimmed.includes("T") ? trimmed : `${trimmed.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Parse a timestamp into epoch milliseconds (for WAL, cron guards, file mtimes).
 * Returns null when the value cannot be parsed.
 */
export function parseTimestampMs(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value >= EPOCH_MS_THRESHOLD ? Math.floor(value) : Math.floor(value * 1000);
  }

  const sec = parseTimestamp(value);
  return sec == null ? null : sec * 1000;
}

/**
 * Parse sourceDate from ISO-8601 (YYYY-MM-DD) or Unix timestamp (seconds).
 * Date strings without time are interpreted as UTC midnight.
 * Returns null if invalid.
 */
export function parseSourceDate(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2})?/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    const ms = Date.UTC(Number.parseInt(y!, 10), Number.parseInt(m!, 10) - 1, Number.parseInt(d!, 10));
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const n = Number.parseInt(s, 10);
  return !Number.isNaN(n) && n > 0 ? n : null;
}

/** Normalize an input timestamp to ISO 8601 UTC for TEXT column storage. */
export function normalizeToIsoUtc(value: unknown, fallbackSec?: number): string {
  const sec = parseTimestamp(value) ?? fallbackSec ?? nowSec();
  return formatTimestampUtc(sec);
}

/** True when a stored TEXT value is already strict ISO UTC (contains T and ends with Z). */
export function isIsoUtcTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && value.endsWith("Z");
}
