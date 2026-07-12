// @ts-nocheck
/**
 * Regression tests for backends/facts-db/links.ts's incremental out_degree/in_degree
 * maintenance (#2085). Before this fix, out_degree/in_degree were only ever refreshed by the
 * periodic dream-cycle reconciler (refreshFactDegrees), so any fact linked since the last cycle
 * read as degree-0 on `facts` -- silently disabling the CTE hub-cap's denormalized fast path.
 * These tests assert the counters are kept live in lockstep with actual memory_links rows across
 * create / strengthen / decay-prune / retype sequences, using an independent COUNT(*) as ground
 * truth read through a second raw connection to the same file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrementFactDegreesForLink, isDegreeCountedLinkType } from "../backends/facts-db/links.js";
import { FactsDB } from "../backends/facts-db.js";

let tmpDir: string;
let dbPath: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "link-degree-counters-"));
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

/** Denormalized counters plus independently-computed COUNT(*) ground truth (countable link types only). */
function readDegrees(factId: string): {
  outDegree: number;
  inDegree: number;
  groundTruthOut: number;
  groundTruthIn: number;
} {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = raw.prepare("SELECT out_degree, in_degree FROM facts WHERE id = ?").get(factId) as
      | { out_degree: number; in_degree: number }
      | undefined;
    const groundTruthOut = (
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_links WHERE source_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')",
        )
        .get(factId) as { n: number }
    ).n;
    const groundTruthIn = (
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_links WHERE target_fact_id = ? AND link_type NOT IN ('CONTRADICTS', 'DERIVED_FROM')",
        )
        .get(factId) as { n: number }
    ).n;
    return { outDegree: row?.out_degree ?? 0, inDegree: row?.in_degree ?? 0, groundTruthOut, groundTruthIn };
  } finally {
    raw.close();
  }
}

describe("incremental degree counters (#2085)", () => {
  it("increments out_degree/in_degree on createLink and matches COUNT(*) ground truth", () => {
    const a = makeFact("A");
    const b = makeFact("B");
    const c = makeFact("C");

    factsDb.createLink(a.id, b.id, "RELATED_TO", 0.9);
    factsDb.createLink(a.id, c.id, "RELATED_TO", 0.9);

    const degreesA = readDegrees(a.id);
    expect(degreesA.outDegree).toBe(2);
    expect(degreesA.outDegree).toBe(degreesA.groundTruthOut);
    expect(degreesA.inDegree).toBe(0);

    const degreesB = readDegrees(b.id);
    expect(degreesB.inDegree).toBe(1);
    expect(degreesB.inDegree).toBe(degreesB.groundTruthIn);
  });

  it("increments only on the first strengthen of a pair, not on subsequent re-strengthens", () => {
    const a = makeFact("A");
    const b = makeFact("B");

    factsDb.createOrStrengthenRelatedLink(a.id, b.id, 0.1);
    factsDb.createOrStrengthenRelatedLink(a.id, b.id, 0.1);
    factsDb.createOrStrengthenRelatedLink(a.id, b.id, 0.1);

    // factIdA < factIdB is decided internally; whichever ends up "source" gets out_degree 1.
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    const degreesLo = readDegrees(lo.id);
    const degreesHi = readDegrees(hi.id);
    expect(degreesLo.outDegree).toBe(1);
    expect(degreesLo.outDegree).toBe(degreesLo.groundTruthOut);
    expect(degreesHi.inDegree).toBe(1);
    expect(degreesHi.inDegree).toBe(degreesHi.groundTruthIn);
  });

  it("increments via strengthenRelatedLinksBatch only on the insert branch, not on repeated pairs", () => {
    const a = makeFact("A");
    const b = makeFact("B");
    const c = makeFact("C");

    factsDb.strengthenRelatedLinksBatch([
      [a.id, b.id],
      [a.id, b.id], // repeat of the same pair — must strengthen, not re-insert/re-increment
      [a.id, c.id],
    ]);

    // Ground truth per-fact, regardless of which id sorted as source/target internally.
    for (const f of [a, b, c]) {
      const d = readDegrees(f.id);
      expect(d.outDegree).toBe(d.groundTruthOut);
      expect(d.inDegree).toBe(d.groundTruthIn);
    }

    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const totalEdges = (
        raw.prepare("SELECT COUNT(*) AS n FROM memory_links WHERE link_type = 'RELATED_TO'").get() as { n: number }
      ).n;
      // Exactly 2 distinct edges (a-b batched twice collapses to one, plus a-c).
      expect(totalEdges).toBe(2);
      const sumOutDegree = (raw.prepare("SELECT COALESCE(SUM(out_degree), 0) AS n FROM facts").get() as { n: number })
        .n;
      expect(sumOutDegree).toBe(totalEdges);
    } finally {
      raw.close();
    }
  });

  it("excludes CONTRADICTS and DERIVED_FROM from degree counting", () => {
    const a = makeFact("A");
    const b = makeFact("B");

    factsDb.createLink(a.id, b.id, "CONTRADICTS", 1.0);

    const degreesA = readDegrees(a.id);
    const degreesB = readDegrees(b.id);
    expect(degreesA.outDegree).toBe(0);
    expect(degreesA.groundTruthOut).toBe(0); // ground truth query also excludes CONTRADICTS
    expect(degreesB.inDegree).toBe(0);

    // A raw COUNT(*) with no link-type filter WOULD see the row -- confirming it exists and is
    // genuinely excluded by type, not silently missing from memory_links entirely.
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const total = (
        raw.prepare("SELECT COUNT(*) AS n FROM memory_links WHERE source_fact_id = ?").get(a.id) as {
          n: number;
        }
      ).n;
      expect(total).toBe(1);
    } finally {
      raw.close();
    }
  });

  it("decrements (floored at 0) when decayLinkStrengths prunes a weak RELATED_TO edge", () => {
    const a = makeFact("A");
    const b = makeFact("B");
    factsDb.createOrStrengthenRelatedLink(a.id, b.id, 0.01);

    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    expect(readDegrees(lo.id).outDegree).toBe(1);

    // Advance past decayLinkStrengths' sub-hour no-op guard (deltaSec < 3600 is skipped) so the
    // already-below-floor strength actually gets evaluated and pruned.
    const result = factsDb.decayLinkStrengths({
      halfLifeDays: 1,
      floor: 0.5,
      nowSec: Math.floor(Date.now() / 1000) + 4_000,
    });
    expect(result.pruned).toBe(1);

    const degreesLo = readDegrees(lo.id);
    const degreesHi = readDegrees(hi.id);
    expect(degreesLo.outDegree).toBe(0);
    expect(degreesLo.outDegree).toBe(degreesLo.groundTruthOut);
    expect(degreesHi.inDegree).toBe(0);
    expect(degreesHi.inDegree).toBe(degreesHi.groundTruthIn);
  });

  it("never decrements below 0 when called on a fact whose counter is already 0 (out-of-sync legacy data)", () => {
    const raw = new DatabaseSync(":memory:");
    try {
      raw.exec(
        "CREATE TABLE facts (id TEXT PRIMARY KEY, out_degree INTEGER NOT NULL DEFAULT 0, in_degree INTEGER NOT NULL DEFAULT 0)",
      );
      raw.prepare("INSERT INTO facts (id) VALUES (?), (?)").run("a", "b");

      decrementFactDegreesForLink(raw, "a", "b", "RELATED_TO");
      decrementFactDegreesForLink(raw, "a", "b", "RELATED_TO");

      const a = raw.prepare("SELECT out_degree FROM facts WHERE id = 'a'").get() as { out_degree: number };
      const b = raw.prepare("SELECT in_degree FROM facts WHERE id = 'b'").get() as { in_degree: number };
      expect(a.out_degree).toBe(0);
      expect(b.in_degree).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("isDegreeCountedLinkType excludes exactly CONTRADICTS and DERIVED_FROM", () => {
    expect(isDegreeCountedLinkType("RELATED_TO")).toBe(true);
    expect(isDegreeCountedLinkType("SUPERSEDES")).toBe(true);
    expect(isDegreeCountedLinkType("PART_OF")).toBe(true);
    expect(isDegreeCountedLinkType("CONTRADICTS")).toBe(false);
    expect(isDegreeCountedLinkType("DERIVED_FROM")).toBe(false);
  });

  it("adjusts counters when updateLink retypes across the countable/excluded boundary", () => {
    const a = makeFact("A");
    const b = makeFact("B");
    const linkId = factsDb.createLink(a.id, b.id, "RELATED_TO", 1.0);

    expect(readDegrees(a.id).outDegree).toBe(1);
    expect(readDegrees(b.id).inDegree).toBe(1);

    // RELATED_TO -> CONTRADICTS: countable -> excluded, must decrement.
    factsDb.updateLink(linkId, { linkType: "CONTRADICTS" });
    expect(readDegrees(a.id).outDegree).toBe(0);
    expect(readDegrees(b.id).inDegree).toBe(0);

    // CONTRADICTS -> RELATED_TO: excluded -> countable, must increment.
    factsDb.updateLink(linkId, { linkType: "RELATED_TO" });
    expect(readDegrees(a.id).outDegree).toBe(1);
    expect(readDegrees(b.id).inDegree).toBe(1);
  });

  it("does not double-count when updateLink changes strength only (no type change)", () => {
    const a = makeFact("A");
    const b = makeFact("B");
    const linkId = factsDb.createLink(a.id, b.id, "RELATED_TO", 0.5);

    factsDb.updateLink(linkId, { strength: 0.9 });
    factsDb.updateLink(linkId, { strength: 0.2 });

    expect(readDegrees(a.id).outDegree).toBe(1);
    expect(readDegrees(b.id).inDegree).toBe(1);
  });
});
