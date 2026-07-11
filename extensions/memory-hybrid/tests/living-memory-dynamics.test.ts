/**
 * Living-memory P1: the strengthen/decay loop.
 *  - Link decay: unused RELATED_TO links weaken exponentially and prune below the floor; typed
 *    links never decay; runs compose (re-anchoring) so cadence doesn't change the curve.
 *  - Half-life confidence decay: continuous per-content-type curve replaces the 75% cliff; recall
 *    extends half-life; null-half-life categories never time-decay; pinned exempt.
 *  - Second-chance eviction: important/recalled facts get exactly ONE TTL/2 reprieve at expiry.
 *  - Confidence rises with use: refreshAccessedFacts closes 5% of the gap to 0.95, never above.
 *  - Co-activation: recall_events co-occurrence counts feed the composite-score boost.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { countCoRecalls, insertRecallEvent } from "../services/recall-events.js";

let dir: string;
let db: FactsDB;
const DAY = 86_400;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-living-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function storeFact(text: string, over: Record<string, unknown> = {}): string {
  return db.store({
    text,
    entity: null,
    key: null,
    value: null,
    category: "fact",
    importance: 0.5,
    source: "test",
    tags: [],
    ...over,
  } as never).id;
}

function raw() {
  return db.getRawDb();
}

describe("link decay (use it or lose it)", () => {
  it("halves an untouched RELATED_TO link per half-life and composes across runs", () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    db.createLink(a, b, "RELATED_TO", 0.8);
    const now = Math.floor(Date.now() / 1000);

    // One 30-day step...
    let r = db.decayLinkStrengths({ halfLifeDays: 30, floor: 0.05, nowSec: now + 30 * DAY });
    expect(r.decayed).toBe(1);
    const strengthAfter30 = (raw().prepare("SELECT strength FROM memory_links").get() as { strength: number }).strength;
    expect(strengthAfter30).toBeCloseTo(0.4, 5);

    // ...then two 15-day steps must land at the same place as one more 30-day step (0.2).
    r = db.decayLinkStrengths({ halfLifeDays: 30, floor: 0.05, nowSec: now + 45 * DAY });
    r = db.decayLinkStrengths({ halfLifeDays: 30, floor: 0.05, nowSec: now + 60 * DAY });
    const strengthAfter60 = (raw().prepare("SELECT strength FROM memory_links").get() as { strength: number }).strength;
    expect(strengthAfter60).toBeCloseTo(0.2, 5);
  });

  it("prunes below the floor and never touches typed links", () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    const c = storeFact("fact c");
    db.createLink(a, b, "RELATED_TO", 0.1);
    db.createLink(a, c, "PART_OF", 0.1);
    const now = Math.floor(Date.now() / 1000);

    const r = db.decayLinkStrengths({ halfLifeDays: 30, floor: 0.05, nowSec: now + 90 * DAY });

    expect(r.pruned).toBe(1);
    const remaining = raw().prepare("SELECT link_type, strength FROM memory_links").all() as Array<{
      link_type: string;
      strength: number;
    }>;
    expect(remaining).toEqual([{ link_type: "PART_OF", strength: 0.1 }]);
  });

  it("strengthening re-anchors the decay clock", () => {
    const a = storeFact("fact a");
    const b = storeFact("fact b");
    // Create through the Hebbian path (pair-order-normalized) so the later strengthen hits the
    // SAME row — createLink stores endpoints unsorted and would race a duplicate edge here.
    db.strengthenRelatedLinksBatch([[a, b]], 0.5);
    const now = Math.floor(Date.now() / 1000);
    // 29 days pass, then the pair is co-recalled (strengthen +0.1 stamps the anchor)...
    raw()
      .prepare("UPDATE memory_links SET strength_updated_at = ? WHERE link_type = 'RELATED_TO'")
      .run(now - 29 * DAY);
    db.strengthenRelatedLinksBatch([[a, b]]);
    // ...so a decay run "now" sees a fresh anchor and leaves the link alone (sub-hour delta).
    const r = db.decayLinkStrengths({ halfLifeDays: 30, floor: 0.05, nowSec: now });
    expect(r.decayed).toBe(0);
    const strength = (raw().prepare("SELECT strength FROM memory_links").get() as { strength: number }).strength;
    expect(strength).toBeCloseTo(0.6, 5);
  });
});

describe("half-life confidence decay (the curve, not the cliff)", () => {
  it("decays `fact` (60d half-life) continuously and composes across runs", () => {
    const id = storeFact("a plain fact", { confidence: 0.8 });
    const now = Math.floor(Date.now() / 1000);
    raw().prepare("UPDATE facts SET expires_at = NULL WHERE id = ?").run(id); // isolate from TTL

    db.decayConfidenceHalfLifeWithDetails(now + 60 * DAY);
    const c1 = (raw().prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number })
      .confidence;
    expect(c1).toBeCloseTo(0.4, 2);

    db.decayConfidenceHalfLifeWithDetails(now + 120 * DAY);
    const c2 = (raw().prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number })
      .confidence;
    expect(c2).toBeCloseTo(0.2, 2);
  });

  it("null-half-life categories (decision/preference) never time-decay; pinned facts exempt", () => {
    const decision = storeFact("we decided X", { category: "decision", confidence: 0.9 });
    const pinnedFact = storeFact("pinned plain fact", { confidence: 0.9 });
    raw()
      .prepare("UPDATE facts SET pinned_at = ?, pinned_reason = 'test' WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), pinnedFact);
    const now = Math.floor(Date.now() / 1000);

    db.decayConfidenceHalfLifeWithDetails(now + 365 * DAY);

    const conf = (id: string) =>
      (raw().prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number }).confidence;
    expect(conf(decision)).toBeCloseTo(0.9);
    expect(conf(pinnedFact)).toBeCloseTo(0.9);
  });

  it("recall extends the half-life (strengthens-when-recalled curve)", () => {
    const now = Math.floor(Date.now() / 1000);
    const recalled = storeFact("frequently used fact", { confidence: 0.8 });
    const ignored = storeFact("never used fact", { confidence: 0.8 });
    raw().prepare("UPDATE facts SET expires_at = NULL").run();
    // 10 recalls, freshly accessed → accessFactor near max (3×) → far slower decay.
    raw()
      .prepare("UPDATE facts SET recall_count = 10, last_accessed = ? WHERE id = ?")
      .run(now + 59 * DAY, recalled);

    db.decayConfidenceHalfLifeWithDetails(now + 60 * DAY);

    const conf = (id: string) =>
      (raw().prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number }).confidence;
    expect(conf(ignored)).toBeCloseTo(0.4, 2);
    // accessFactor ≈ 1.99 → half-life ≈ 119d → 0.8 × 0.5^(60/119) ≈ 0.565 (vs 0.4 unrecalled).
    expect(conf(recalled)).toBeCloseTo(0.565, 2);
    expect(conf(recalled)).toBeGreaterThan(conf(ignored) + 0.1);
  });

  it("floor-deletes below 0.1 and reports the ids for vector cleanup", () => {
    const id = storeFact("nearly gone", { confidence: 0.11 });
    raw().prepare("UPDATE facts SET expires_at = NULL WHERE id = ?").run(id);
    const now = Math.floor(Date.now() / 1000);

    const r = db.decayConfidenceHalfLifeWithDetails(now + 120 * DAY);

    expect(r.deletedFactIds).toContain(id);
    expect(raw().prepare("SELECT 1 FROM facts WHERE id = ?").get(id)).toBeUndefined();
  });
});

describe("second-chance eviction", () => {
  it("grants ONE TTL/2 reprieve to important facts, then deletes on the next expiry", () => {
    const important = storeFact("important but expired", { importance: 0.9 });
    const mundane = storeFact("mundane and expired", { importance: 0.3 });
    const now = Math.floor(Date.now() / 1000);
    raw()
      .prepare("UPDATE facts SET expires_at = ? WHERE id IN (?, ?)")
      .run(now - 60, important, mundane);

    const first = db.pruneExpiredWithDetails(now);
    expect(first.secondChances).toBe(1);
    expect(first.deletedFactIds).toEqual([mundane]);
    const row = raw()
      .prepare("SELECT expires_at, decay_second_chance_at, confidence FROM facts WHERE id = ?")
      .get(important) as { expires_at: number; decay_second_chance_at: number; confidence: number };
    expect(row.expires_at).toBeGreaterThan(now);
    expect(row.decay_second_chance_at).toBe(now);

    // Force-expire again: the reprieve is once-only.
    raw()
      .prepare("UPDATE facts SET expires_at = ? WHERE id = ?")
      .run(now - 1, important);
    const second = db.pruneExpiredWithDetails(now);
    expect(second.secondChances).toBe(0);
    expect(second.deletedFactIds).toEqual([important]);
  });

  it("secondChance:false restores pure TTL deletion", () => {
    const important = storeFact("important but expired", { importance: 0.9 });
    const now = Math.floor(Date.now() / 1000);
    raw()
      .prepare("UPDATE facts SET expires_at = ? WHERE id = ?")
      .run(now - 60, important);
    const r = db.pruneExpiredWithDetails(now, { secondChance: false });
    expect(r.deletedFactIds).toEqual([important]);
  });
});

describe("confidence rises with use", () => {
  it("each recall closes 5% of the gap to 0.95 and never exceeds it (1.0 stays untouched)", () => {
    const used = storeFact("used fact", { confidence: 0.5 });
    const certain = storeFact("verified-grade fact", { confidence: 1.0 });

    db.refreshAccessedFacts([used, certain]);
    const conf = (id: string) =>
      (raw().prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number }).confidence;
    expect(conf(used)).toBeCloseTo(0.5 + 0.45 * 0.05, 5);
    expect(conf(certain)).toBe(1.0);

    for (let i = 0; i < 200; i++) db.refreshAccessedFacts([used]);
    expect(conf(used)).toBeLessThanOrEqual(0.95);
    expect(conf(used)).toBeGreaterThan(0.9);
  });
});

describe("co-activation from recall history", () => {
  it("counts events where candidates were recalled TOGETHER", () => {
    const rawDb = raw();
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS recall_events (
        id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, session_key TEXT, agent_id TEXT,
        query TEXT, fact_ids TEXT NOT NULL DEFAULT '[]', hit INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'backfill', scores TEXT
      )
    `);
    const now = Math.floor(Date.now() / 1000);
    insertRecallEvent(rawDb, { occurredAtSec: now - 100, factIds: ["a", "b"], hit: true, source: "tool" });
    insertRecallEvent(rawDb, { occurredAtSec: now - 90, factIds: ["a", "b", "c"], hit: true, source: "tool" });
    insertRecallEvent(rawDb, { occurredAtSec: now - 80, factIds: ["a"], hit: true, source: "tool" }); // solo — no pair
    insertRecallEvent(rawDb, { occurredAtSec: now - 70, factIds: ["x", "y"], hit: true, source: "tool" }); // not candidates

    const counts = countCoRecalls(rawDb, ["a", "b", "z"]);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(2);
    expect(counts.get("z")).toBeUndefined();
  });
});
