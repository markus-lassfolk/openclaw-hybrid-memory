// @ts-nocheck
/**
 * Regression test for backends/facts-db/links.ts's expandGraphWithCTE hub-degree-cap SQL (#2085).
 *
 * The CASE condition guarding the denormalized-vs-live-COUNT(*) choice used to read
 * `facts.out_degree IS NOT NULL AND facts.in_degree IS NOT NULL`. Both columns are
 * `NOT NULL DEFAULT 0`, so that condition was always true and the live `COUNT(*)` fallback below
 * it was dead code: a fact whose counters hadn't been reconciled yet (fresh since the last
 * dream-cycle `refreshFactDegrees()` pass, or migrated from a pre-#2085 install where nothing
 * incremented them incrementally) always read as degree-0 and silently bypassed the hub cap no
 * matter how many real edges it actually had. The fix changed the condition to
 * `(out_degree + in_degree) > 0`, so a zeroed-but-actually-connected node correctly falls through
 * to a live COUNT(*) instead of being trusted at face value.
 *
 * This test drives expandGraphWithCTE directly (not the higher-level expandGraph, which is
 * covered by the mocked-CTE tests in graph-retrieval-cte-hub-penalty.test.ts) against a real
 * FactsDB, deliberately zeroing out_degree/in_degree on the hub fact via a raw connection after
 * creating its links -- simulating exactly the "counters not yet reconciled" state the fix
 * targets -- and asserts the hub cap still holds via the COUNT(*) fallback.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

let tmpDir: string;
let dbPath: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cte-hub-fresh-"));
  dbPath = join(tmpDir, "facts.db");
  factsDb = new FactsDB(dbPath);
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeFact(text: string) {
  return factsDb.store({
    text,
    category: "fact",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
  });
}

/** Simulate a not-yet-reconciled fact: zero its denormalized counters without touching memory_links. */
function zeroOutDenormalizedCounters(factId: string): void {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.prepare("UPDATE facts SET out_degree = 0, in_degree = 0 WHERE id = ?").run(factId);
  } finally {
    raw.close();
  }
}

describe("expandGraphWithCTE hub-cap fresh-hub fallback (#2085)", () => {
  it("still caps traversal through a hub whose denormalized counters read 0 despite real edges", () => {
    const seed = makeFact("seed");
    const hub = makeFact("hub");
    const leaf = makeFact("leaf-under-cap"); // weakest edge from hub, would be entered first if uncapped
    const filler1 = makeFact("filler-1");
    const filler2 = makeFact("filler-2");

    factsDb.createLink(seed.id, hub.id, "RELATED_TO", 0.9);
    factsDb.createLink(hub.id, leaf.id, "RELATED_TO", 0.9);
    factsDb.createLink(hub.id, filler1.id, "RELATED_TO", 0.9);
    factsDb.createLink(hub.id, filler2.id, "RELATED_TO", 0.9);

    // hub now genuinely has out_degree 3 (leaf, filler1, filler2) + in_degree 1 (seed) = 4,
    // exceeding a cap of 2 -- but wipe the denormalized counters to simulate un-reconciled state.
    // Under the pre-fix `IS NOT NULL` condition (always true for NOT NULL DEFAULT 0 columns), the
    // stale 0 would be trusted at face value (0 <= 2), the hub would be entered, and every one of
    // its neighbors would then be reachable too. The fix falls through to a live COUNT(*) instead.
    zeroOutDenormalizedCounters(hub.id);

    const capped = factsDb.expandGraphWithCTE([seed.id], 2, { hubDegreeCap: 2 });
    const cappedIds = capped.map((r) => r.factId).sort();

    // The hub cap must still trip via the live COUNT(*) fallback: the hub's real degree (4)
    // exceeds the cap, so entering the hub itself is blocked -- only the seed is reachable.
    expect(cappedIds).toEqual([seed.id]);
    expect(cappedIds).not.toContain(hub.id);
    expect(cappedIds).not.toContain(leaf.id);
    expect(cappedIds).not.toContain(filler1.id);
    expect(cappedIds).not.toContain(filler2.id);
  });

  it("allows traversal through the same hub when hubDegreeCap is raised above its real degree", () => {
    const seed = makeFact("seed");
    const hub = makeFact("hub");
    const leaf = makeFact("leaf");

    factsDb.createLink(seed.id, hub.id, "RELATED_TO", 0.9);
    factsDb.createLink(hub.id, leaf.id, "RELATED_TO", 0.9);
    zeroOutDenormalizedCounters(hub.id);

    const expanded = factsDb.expandGraphWithCTE([seed.id], 2, { hubDegreeCap: 10 });
    const ids = expanded.map((r) => r.factId).sort();
    expect(ids).toEqual([hub.id, leaf.id, seed.id].sort());
  });

  it("gives the same capping result via the reconciled denormalized path as the live fallback gives", () => {
    const seed = makeFact("seed");
    const hub = makeFact("hub");
    const leaf = makeFact("leaf");
    const filler = makeFact("filler");

    factsDb.createLink(seed.id, hub.id, "RELATED_TO", 0.9);
    factsDb.createLink(hub.id, leaf.id, "RELATED_TO", 0.9);
    factsDb.createLink(hub.id, filler.id, "RELATED_TO", 0.9);

    // Do NOT zero here -- incremental maintenance (#2085) already keeps counters live, so this is
    // the normal steady-state path. refreshFactDegrees is a reconciler, not the only writer.
    // hub's real degree is 3 (2 out to leaf/filler, 1 in from seed), exceeding a cap of 2 -- the
    // denormalized fast path must agree with the fallback and still block entry into the hub.
    factsDb.refreshFactDegrees();

    const capped = factsDb.expandGraphWithCTE([seed.id], 2, { hubDegreeCap: 2 });
    const cappedIds = capped.map((r) => r.factId).sort();
    expect(cappedIds).toEqual([seed.id]);
    expect(cappedIds).not.toContain(hub.id);
  });
});
