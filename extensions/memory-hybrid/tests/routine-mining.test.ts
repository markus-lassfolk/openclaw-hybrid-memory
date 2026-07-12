/**
 * Living-memory P4.3: routine mining. A topic recalled in the same weekly slot across ≥3 weeks
 * becomes a decayable `routine` fact; one-off patterns don't; re-runs are idempotent (entity slug
 * dedupe); the per-run cap holds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { insertRecallEvent } from "../services/recall-events.js";
import { findRoutineCandidates, runRoutineMining } from "../services/routine-miner.js";

let dir: string;
let db: FactsDB;
const WEEK = 7 * 86_400;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-routine-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Recall events for the same topic at the same UTC weekday+hour across `weeks` distinct weeks. */
function seedWeekly(query: string, weeks: number, baseSec: number): void {
  for (let w = 0; w < weeks; w++) {
    insertRecallEvent(db.getRawDb(), {
      occurredAtSec: baseSec + w * WEEK,
      query,
      factIds: [],
      hit: true,
      source: "tool",
    });
  }
}

describe("routine mining", () => {
  // A fixed Tuesday 09:00 UTC anchor keeps weekday/band math deterministic.
  const TUESDAY_9AM = Math.floor(Date.UTC(2026, 5, 2, 9, 0, 0) / 1000);

  it("detects a ≥3-week weekly pattern and ignores one-offs", () => {
    seedWeekly("weekly status report preparation", 4, TUESDAY_9AM);
    insertRecallEvent(db.getRawDb(), {
      occurredAtSec: TUESDAY_9AM + 3600,
      query: "one off question about llamas",
      factIds: [],
      hit: true,
      source: "tool",
    });

    const candidates = findRoutineCandidates(db.getRawDb(), { nowSec: TUESDAY_9AM + 5 * WEEK });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].topic).toContain("weekly status report");
    expect(candidates[0].dayOfWeek).toBe(2); // Tuesday
    expect(candidates[0].band).toBe("morning");
    expect(candidates[0].distinctWeeks).toBe(4);
  });

  it("buckets by the configured local timezone, not UTC", () => {
    // 09:00 UTC Tuesday = "morning" in UTC, but 04:00 Tuesday ("night") five hours west
    // (Etc/GMT+5 is a fixed UTC-5 offset — no DST, deterministic).
    seedWeekly("late check in before bed", 4, TUESDAY_9AM);

    const utcCandidates = findRoutineCandidates(db.getRawDb(), { nowSec: TUESDAY_9AM + 5 * WEEK });
    expect(utcCandidates[0]?.band).toBe("morning");

    const localCandidates = findRoutineCandidates(db.getRawDb(), {
      nowSec: TUESDAY_9AM + 5 * WEEK,
      timezone: "Etc/GMT+5",
    });
    expect(localCandidates).toHaveLength(1);
    expect(localCandidates[0].dayOfWeek).toBe(2); // still Tuesday at 04:00 local
    expect(localCandidates[0].band).toBe("night");
  });

  it("stores routine facts as decayable memories, idempotently, respecting the cap", () => {
    seedWeekly("weekly status report preparation", 4, TUESDAY_9AM);
    seedWeekly("sprint retro follow ups", 3, TUESDAY_9AM + 6 * 3600); // Tuesday afternoon
    seedWeekly("monthly budget spreadsheet checks", 3, TUESDAY_9AM + WEEK + 86_400); // Wednesdays

    const first = runRoutineMining(db, { maxPerRun: 2, nowSec: TUESDAY_9AM + 6 * WEEK });
    expect(first.candidates).toBe(3);
    expect(first.stored).toBe(2); // cap

    const second = runRoutineMining(db, { maxPerRun: 2, nowSec: TUESDAY_9AM + 6 * WEEK });
    expect(second.stored).toBe(1); // only the remaining one; existing slugs deduped

    const routines = db
      .getRawDb()
      .prepare("SELECT text, category, decay_class FROM facts WHERE category = 'routine'")
      .all() as Array<{ text: string; category: string; decay_class: string }>;
    expect(routines).toHaveLength(3);
    for (const r of routines) {
      expect(r.text).toMatch(/^Routine: on /);
      expect(r.decay_class).not.toBe("permanent"); // routines must be able to decay out
    }
  });
});
