/**
 * Future-date detection for decay freeze protection (#144).
 *
 * Extracts the latest future date from a text string using regex-based
 * matching. No heavy NLP dependencies — only built-in Date arithmetic.
 *
 * Supported formats:
 *   - ISO:          "2026-03-20", "2026-03-20T14:00:00"
 *   - Month-day:    "March 20", "Mar 20th", "20 March"
 *   - Relative:     "tomorrow", "next week", "next Tuesday", "next month"
 *   - Offset:       "in 3 days", "in 2 weeks", "in 1 month", "in 6 months"
 *
 * Deliberately skipped (vague, non-actionable):
 *   "soon", "eventually", "later", "someday", "sometime", "at some point"
 */

import type { FutureDateProtectionConfig } from "../config.js";

export type { FutureDateProtectionConfig };

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Try all date patterns against `text`. Return all candidate epoch-second
 * timestamps that are in the future relative to `nowMs`.
 */
function extractCandidates(text: string, nowMs: number): number[] {
  const results: number[] = [];
  const now = new Date(nowMs);
  const todayMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // -------------------------------------------------------------------------
  // 1. ISO date: "2026-03-20" or "2026-03-20T14:00:00"
  // -------------------------------------------------------------------------
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2})?)?/g;
  let m: RegExpExecArray | null;
  while ((m = isoRe.exec(text)) !== null) {
    const y = parseInt(m[1]!, 10);
    const mo = parseInt(m[2]!, 10) - 1;
    const d = parseInt(m[3]!, 10);
    const ts = Date.UTC(y, mo, d);
    if (!isNaN(ts) && ts > todayMidnightMs) results.push(Math.floor(ts / 1000));
  }

  // -------------------------------------------------------------------------
  // 2. Month-name day: "March 20", "Mar 20th", "20 March", "20th March"
  // -------------------------------------------------------------------------
  const monthNames = Object.keys(MONTH_MAP)
    .filter((k) => k.length > 3 || ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].includes(k))
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  const mdRe = new RegExp(
    `\\b(?:(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames}))\\b`,
    "gi"
  );
  while ((m = mdRe.exec(text)) !== null) {
    let monthStr: string;
    let dayNum: number;
    if (m[1] !== undefined && m[2] !== undefined) {
      // "March 20"
      monthStr = m[1].toLowerCase();
      dayNum = parseInt(m[2], 10);
    } else {
      // "20 March"
      monthStr = m[4]!.toLowerCase();
      dayNum = parseInt(m[3]!, 10);
    }
    const moIdx = MONTH_MAP[monthStr];
    if (moIdx === undefined) continue;

    // Try current year first, then next year
    for (const yearOffset of [0, 1]) {
      const y = now.getUTCFullYear() + yearOffset;
      const ts = Date.UTC(y, moIdx, dayNum);
      if (!isNaN(ts) && ts > todayMidnightMs) {
        results.push(Math.floor(ts / 1000));
        break; // take the first future occurrence
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. "tomorrow"
  // -------------------------------------------------------------------------
  if (/\btomorrow\b/i.test(text)) {
    const ts = todayMidnightMs + 86400 * 1000;
    results.push(Math.floor(ts / 1000));
  }

  // -------------------------------------------------------------------------
  // 4. "next <weekday>": "next Tuesday", "next Monday"
  // -------------------------------------------------------------------------
  const nextWdRe = /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/gi;
  while ((m = nextWdRe.exec(text)) !== null) {
    const targetWd = WEEKDAY_MAP[m[1]!.toLowerCase()];
    if (targetWd === undefined) continue;
    const currentWd = now.getUTCDay();
    let daysAhead = targetWd - currentWd;
    if (daysAhead <= 0) daysAhead += 7; // always at least 1 day ahead
    // "next" implies the week after the upcoming one when the day would otherwise be <7 days away
    if (daysAhead < 7) daysAhead += 7;
    const ts = todayMidnightMs + daysAhead * 86400 * 1000;
    results.push(Math.floor(ts / 1000));
  }

  // -------------------------------------------------------------------------
  // 5. "next week" → ~7 days, "next month" → ~30 days, "next year" → ~365 days
  // -------------------------------------------------------------------------
  if (/\bnext\s+week\b/i.test(text)) {
    results.push(Math.floor((todayMidnightMs + 7 * 86400 * 1000) / 1000));
  }
  if (/\bnext\s+month\b/i.test(text)) {
    results.push(Math.floor((todayMidnightMs + 30 * 86400 * 1000) / 1000));
  }
  if (/\bnext\s+year\b/i.test(text)) {
    results.push(Math.floor((todayMidnightMs + 365 * 86400 * 1000) / 1000));
  }

  // -------------------------------------------------------------------------
  // 6. "in N days/weeks/months": "in 3 days", "in 2 weeks", "in 1 month"
  // -------------------------------------------------------------------------
  const inOffsetRe = /\bin\s+(\d+)\s+(day|days|week|weeks|month|months)\b/gi;
  while ((m = inOffsetRe.exec(text)) !== null) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    let daysAhead = 0;
    if (unit === "day" || unit === "days") daysAhead = n;
    else if (unit === "week" || unit === "weeks") daysAhead = n * 7;
    else if (unit === "month" || unit === "months") daysAhead = n * 30;
    if (daysAhead > 0) {
      results.push(Math.floor((todayMidnightMs + daysAhead * 86400 * 1000) / 1000));
    }
  }

  return results;
}

/**
 * Detect the latest future date in `text`.
 *
 * @param text         - The fact text to scan.
 * @param cfg          - Future-date protection config.
 * @param nowMs        - Current time in milliseconds (defaults to Date.now()). Override in tests.
 * @returns Epoch seconds of the freeze-until timestamp, or null if none found / not applicable.
 */
export function detectFutureDate(
  text: string,
  cfg: Pick<FutureDateProtectionConfig, "enabled" | "maxFreezeDays">,
  nowMs: number = Date.now()
): number | null {
  if (!cfg.enabled) return null;

  const candidates = extractCandidates(text, nowMs);
  if (candidates.length === 0) return null;

  // Take the latest future date
  const latest = Math.max(...candidates);

  // Enforce maxFreezeDays cap
  if (cfg.maxFreezeDays > 0) {
    const maxFreezeMs = nowMs + cfg.maxFreezeDays * 86400 * 1000;
    const maxFreezeSec = Math.floor(maxFreezeMs / 1000);
    return Math.min(latest, maxFreezeSec);
  }

  return latest;
}
