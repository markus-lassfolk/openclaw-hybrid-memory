/**
 * Routine mining (living-memory P4.3): "learns my routines not as programmed behavior, but as a
 * consequence of our interactions."
 *
 * Mines recall_events for recurring (day-of-week, hour-band, topic) patterns: a topic recalled on
 * ≥3 occasions spread across ≥3 distinct weeks in the same weekly slot becomes a `routine` fact
 * ("around Tuesday mornings, recurring focus: …"). Routine facts are ordinary decayable memories
 * (decayClass normal) — a routine that stops recurring stops being reinforced and decays out
 * naturally, which is exactly the critique's ask. Deterministic (no LLM): the topic label is the
 * normalized query head; dedupe by entity=routine:<slug> keeps re-runs idempotent.
 */
import type { DatabaseSync } from "node:sqlite";
import { localWeekdayAndHourInTimeZone } from "./quiet-window.js";

const HOUR_BANDS = ["night", "morning", "afternoon", "evening"] as const; // 0-6, 6-12, 12-18, 18-24
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface RoutineCandidate {
  dayOfWeek: number;
  band: (typeof HOUR_BANDS)[number];
  topic: string;
  slug: string;
  occasions: number;
  distinctWeeks: number;
}

function normalizeTopic(query: string): string | null {
  const words = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6);
  if (words.length < 2) return null;
  return words.join(" ");
}

/** Deterministic candidate detection over recall_events (last `sinceDays`). */
export function findRoutineCandidates(
  db: DatabaseSync,
  opts?: { sinceDays?: number; minOccasions?: number; minWeeks?: number; nowSec?: number; timezone?: string },
): RoutineCandidate[] {
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - (opts?.sinceDays ?? 42) * 86_400;
  const minOccasions = opts?.minOccasions ?? 3;
  const minWeeks = opts?.minWeeks ?? 3;
  const timezone = opts?.timezone ?? "UTC";

  const rows = db
    .prepare(
      `SELECT occurred_at, query FROM recall_events
        WHERE occurred_at >= ? AND query IS NOT NULL AND length(query) > 5
        ORDER BY occurred_at DESC LIMIT 5000`,
    )
    .all(sinceSec) as Array<{ occurred_at: number; query: string }>;

  // (dow, band, topic) → set of ISO-ish week indices + occasion count.
  const buckets = new Map<string, { weeks: Set<number>; occasions: number; sample: RoutineCandidate }>();
  for (const row of rows) {
    const topic = normalizeTopic(row.query);
    if (!topic) continue;
    // Bucketed in `timezone` (default UTC), not necessarily the server's local time — a "night"
    // routine should mean the user's local late-night, not 00:00-06:00 UTC.
    const { weekday: dayOfWeek, hour } = localWeekdayAndHourInTimeZone(new Date(row.occurred_at * 1000), timezone);
    const band = HOUR_BANDS[Math.floor(hour / 6)];
    const week = Math.floor(row.occurred_at / (7 * 86_400));
    const key = `${dayOfWeek}\u0000${band}\u0000${topic}`;
    const bucket = buckets.get(key) ?? {
      weeks: new Set<number>(),
      occasions: 0,
      sample: {
        dayOfWeek,
        band,
        topic,
        slug: `${DOW_NAMES[dayOfWeek].toLowerCase()}-${band}-${topic.replace(/\s+/g, "-").slice(0, 48)}`,
        occasions: 0,
        distinctWeeks: 0,
      },
    };
    bucket.weeks.add(week);
    bucket.occasions++;
    buckets.set(key, bucket);
  }

  const out: RoutineCandidate[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.occasions >= minOccasions && bucket.weeks.size >= minWeeks) {
      out.push({ ...bucket.sample, occasions: bucket.occasions, distinctWeeks: bucket.weeks.size });
    }
  }
  out.sort((a, b) => b.occasions - a.occasions);
  return out;
}

export interface RoutineMinerFactsDb {
  store(entry: {
    text: string;
    category: string;
    importance: number;
    entity: string | null;
    key: string | null;
    value: string | null;
    source: string;
    tags: string[];
  }): { id: string };
  getRawDb(): DatabaseSync;
}

/** Mine + store up to `maxPerRun` routine facts (entity-keyed dedupe keeps re-runs idempotent). */
export function runRoutineMining(
  factsDb: RoutineMinerFactsDb,
  opts?: { maxPerRun?: number; sinceDays?: number; nowSec?: number; timezone?: string },
): { candidates: number; stored: number } {
  const db = factsDb.getRawDb();
  const candidates = findRoutineCandidates(db, opts);
  const maxPerRun = opts?.maxPerRun ?? 2;
  let stored = 0;
  for (const c of candidates) {
    if (stored >= maxPerRun) break;
    const entity = `routine:${c.slug}`;
    const exists = db.prepare("SELECT 1 FROM facts WHERE entity = ? AND superseded_at IS NULL LIMIT 1").get(entity);
    if (exists) continue;
    factsDb.store({
      text: `Routine: on ${DOW_NAMES[c.dayOfWeek]} ${c.band}s, a recurring focus is "${c.topic}" (seen ${c.occasions}× across ${c.distinctWeeks} weeks)`,
      category: "routine",
      importance: 0.6,
      entity,
      key: "cadence",
      value: `${DOW_NAMES[c.dayOfWeek].toLowerCase()}-${c.band}`,
      source: "routine-mining",
      tags: ["routine", "needs-review"],
    });
    stored++;
  }
  return { candidates: candidates.length, stored };
}
