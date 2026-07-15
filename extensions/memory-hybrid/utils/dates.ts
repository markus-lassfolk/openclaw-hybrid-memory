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
const MS_PER_DAY = 86_400_000;

/** Normalize a date/time string for UTC parsing (append Z when no zone is present). */
function normalizeIsoForParse(trimmed: string): string {
  if (!trimmed.includes("T")) {
    return `${trimmed.replace(" ", "T")}Z`;
  }
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}Z`;
}

/**
 * Date.UTC(year, monthIndex, day), but returns null instead of silently normalizing an
 * out-of-range component (e.g. Date.UTC(2026, 1, 30) rolls "Feb 30" into March 2 rather than
 * erroring). Mirrors the rollover check already used by date-detector.ts's relative/absolute date
 * parsers; callers here (parseTimestamp/parseSourceDate/parseCompactDateDigits) previously had no
 * such guard, so a malformed-but-date-shaped string -- including LLM tool-call input like
 * memory_recall's `asOf` param -- was silently accepted as a different, valid-looking date instead
 * of being rejected (#2067-followup).
 */
function dateUtcMsOrNull(year: number, monthIndex: number, day: number): number | null {
  const ms = Date.UTC(year, monthIndex, day);
  if (Number.isNaN(ms)) return null;
  const check = new Date(ms);
  if (check.getUTCMonth() !== monthIndex || check.getUTCDate() !== day) return null;
  return ms;
}

/** True when value looks like legacy non-ISO TEXT still needing backfill. */
export function isLegacyTextTimestamp(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("T") && isIsoUtcTimestamp(trimmed)) return false;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return true;
  if (!trimmed.includes("T")) return true;
  return !isIsoUtcTimestamp(trimmed);
}

/** Current time as Unix epoch seconds. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Current time as ISO 8601 UTC (e.g. 2026-06-05T12:34:56.789Z). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Format epoch seconds as ISO 8601 UTC.
 *
 * Self-corrects a value that is actually epoch milliseconds (>= EPOCH_MS_THRESHOLD), mirroring
 * the same guard already used by parseTimestamp/parseTimestampMs. Without this, a caller that
 * accidentally stores milliseconds in a "seconds" column (e.g. facts.superseded_at) silently
 * produces a garbage far-future date instead of an error (#2129).
 */
export function formatTimestampUtc(sec: number): string {
  if (!Number.isFinite(sec)) {
    throw new Error(`Invalid epoch seconds: ${sec}`);
  }
  const ms = sec >= EPOCH_MS_THRESHOLD ? sec : sec * 1000;
  return new Date(ms).toISOString();
}

/** Format epoch seconds as UTC calendar date YYYY-MM-DD. Self-corrects ms-vs-seconds; see formatTimestampUtc. */
export function formatDateUtc(sec: number): string {
  if (!Number.isFinite(sec)) {
    throw new Error(`Invalid epoch seconds: ${sec}`);
  }
  const ms = sec >= EPOCH_MS_THRESHOLD ? sec : sec * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Format epoch milliseconds as ISO 8601 UTC (preserves sub-second precision). */
export function formatTimestampUtcFromMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid epoch milliseconds: ${ms}`);
  }
  return new Date(ms).toISOString();
}

/** ISO UTC timestamp for a cutoff N whole days before reference (default: now). */
export function cutoffIsoDaysAgo(days: number, referenceMs = Date.now()): string {
  return formatTimestampUtcFromMs(referenceMs - days * MS_PER_DAY);
}

/** ISO UTC timestamp N whole days after reference (default: now). */
export function addDaysUtcIso(days: number, referenceMs = Date.now()): string {
  return formatTimestampUtcFromMs(referenceMs + days * MS_PER_DAY);
}

/** ISO UTC timestamp for a cutoff N whole hours before reference (default: now). */
export function cutoffIsoHoursAgo(hours: number, referenceMs = Date.now()): string {
  return formatTimestampUtcFromMs(referenceMs - hours * 3_600_000);
}

/** Compact UTC run id segment (e.g. `20260602T061400Z`) for artifact paths. */
export function formatCompactRunIdUtc(referenceMs = Date.now()): string {
  return formatTimestampUtcFromMs(referenceMs)
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** Filesystem-safe run id slug from ISO UTC (e.g. `2026-06-05T12-34-56`). */
export function formatRunIdSlug(referenceMs = Date.now()): string {
  return formatTimestampUtcFromMs(referenceMs).replace(/[:.]/g, "-").slice(0, 19);
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

  const compactDateSec = parseCompactDateDigits(trimmed);
  if (compactDateSec != null) return compactDateSec;

  if (isNumericEpochString(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric >= EPOCH_MS_THRESHOLD ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }
  }

  const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoDateOnly) {
    const [, y, m, d] = isoDateOnly;
    const ms = dateUtcMsOrNull(Number.parseInt(y!, 10), Number.parseInt(m!, 10) - 1, Number.parseInt(d!, 10));
    return ms == null ? null : Math.floor(ms / 1000);
  }

  const normalized = normalizeIsoForParse(trimmed);
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

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const compactDateSec = parseCompactDateDigits(trimmed);
    if (compactDateSec != null) return compactDateSec * 1000;

    if (isNumericEpochString(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric >= EPOCH_MS_THRESHOLD ? Math.floor(numeric) : Math.floor(numeric * 1000);
      }
    }

    const normalized = normalizeIsoForParse(trimmed);
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
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
  const compact = parseCompactDateDigits(s);
  if (compact != null) return compact;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2})?/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    const ms = dateUtcMsOrNull(Number.parseInt(y!, 10), Number.parseInt(m!, 10) - 1, Number.parseInt(d!, 10));
    return ms == null ? null : Math.floor(ms / 1000);
  }
  const n = Number.parseInt(s, 10);
  return !Number.isNaN(n) && n > 0 ? n : null;
}

/** Normalize an input timestamp to ISO 8601 UTC for TEXT column storage. */
export function normalizeToIsoUtc(value: unknown, fallbackSec?: number): string {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return formatTimestampUtc(fallbackSec ?? nowSec());
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isIsoUtcTimestamp(trimmed)) {
      return trimmed;
    }
    const sec = parseTimestamp(trimmed);
    if (sec != null) {
      return formatTimestampUtc(sec);
    }
  } else {
    const sec = parseTimestamp(value);
    if (sec != null) {
      return formatTimestampUtc(sec);
    }
  }

  if (fallbackSec != null) {
    return formatTimestampUtc(fallbackSec);
  }
  throw new Error(`Invalid timestamp: ${String(value)}`);
}

/** True when a stored TEXT value is already strict ISO UTC (contains T and ends with Z/z). */
export function isIsoUtcTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && /[zZ]$/.test(value);
}

function isNumericEpochString(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value);
}

function parseCompactDateDigits(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const ms = dateUtcMsOrNull(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10) - 1,
    Number.parseInt(match[3], 10),
  );
  return ms == null ? null : Math.floor(ms / 1000);
}
