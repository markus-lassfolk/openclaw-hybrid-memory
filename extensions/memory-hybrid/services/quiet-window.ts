/**
 * Timezone-safe quiet-window helpers (Issue #1904).
 *
 * Uses Intl wall-clock parts only — no manual UTC offset math (avoids DST bugs).
 */
import type { WorkerLeasesConfig } from "../config/types/maintenance.js";

export function parseHmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number.parseInt(m[1]!, 10);
  const min = Number.parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function localMinutesInTimeZone(at: Date, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(at);
    let hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const minute = Number.parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    if (hour === 24) hour = 0;
    return hour * 60 + minute;
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

const WEEKDAY_SHORT_UTC0 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Local weekday (0=Sunday..6=Saturday, matching `Date#getUTCDay`) and hour-of-day in `timeZone`.
 * Used by behavioral time-of-day mining (routine-miner) where bucketing in UTC instead of the
 * user's local time silently mislabels "late at night" for anyone outside UTC.
 */
export function localWeekdayAndHourInTimeZone(at: Date, timeZone: string): { weekday: number; hour: number } {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      weekday: "short",
      hour: "2-digit",
      hour12: false,
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(at);
    const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
    let hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    if (hour === 24) hour = 0;
    const weekday = WEEKDAY_SHORT_UTC0.indexOf(weekdayStr);
    return { weekday: weekday >= 0 ? weekday : at.getUTCDay(), hour };
  } catch {
    return { weekday: at.getUTCDay(), hour: at.getUTCHours() };
  }
}

/** Returns true when wall-clock time in `qw.tz` is inside [start, end). */
export function isInQuietWindowAt(qw: NonNullable<WorkerLeasesConfig["quietWindow"]>, at: Date): boolean {
  if (!qw.enabled) return false;
  const startMin = parseHmToMinutes(qw.start);
  const endMin = parseHmToMinutes(qw.end);
  if (startMin == null || endMin == null) return false;

  const current = localMinutesInTimeZone(at, qw.tz || "UTC");
  if (startMin <= endMin) {
    return current >= startMin && current < endMin;
  }
  return current >= startMin || current < endMin;
}

/**
 * Epoch seconds when the quiet window ends after `at`.
 * Scans forward minute-by-minute using the same TZ logic as `isInQuietWindowAt`.
 */
export function quietWindowEndEpochSecAt(qw: NonNullable<WorkerLeasesConfig["quietWindow"]>, at: Date): number | null {
  if (!qw.enabled || !isInQuietWindowAt(qw, at)) return null;

  const startMs = at.getTime();
  for (let offsetMin = 1; offsetMin <= 25 * 60; offsetMin++) {
    const candidate = new Date(startMs + offsetMin * 60_000);
    if (!isInQuietWindowAt(qw, candidate)) {
      return Math.floor(candidate.getTime() / 1000);
    }
  }
  return null;
}
