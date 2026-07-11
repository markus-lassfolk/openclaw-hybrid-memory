// @ts-nocheck
/**
 * Regression test (#2074-followup) for backends/facts-db/search.ts's searchFacts()/lookupFacts():
 *
 * Both functions read `(row.confidence as number) || 1.0` directly from the raw row to weight
 * their composite ranking score, independently of rowToMemoryEntry()'s own confidence mapping.
 * When row-mapper.ts's falsy-zero bug was fixed (confidence: 0 now correctly reported on the
 * returned MemoryEntry), these two sites were left with the exact same bug, creating a *new*
 * inconsistency: a fact explicitly stored with confidence 0 now reports `entry.confidence === 0`
 * (correct) while still scoring as if confidence were 1.0 (stale) -- the returned entry and its
 * own ranking score disagree about how much the fact should be trusted. Fixed by switching both
 * sites to `??`, matching row-mapper.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "search-confidence-zero-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("search score confidence=0 consistency (#2074-followup)", () => {
  it("searchFacts scores a confidence=0 fact lower than the same fact at confidence=1", () => {
    const fact = factsDb.store({
      text: "Quixotic marmalade beacon lighthouse keeper",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const beforeResults = factsDb.search("Quixotic marmalade beacon", 5);
    expect(beforeResults.length).toBe(1);
    expect(beforeResults[0].entry.confidence).toBe(1.0);
    const scoreAtFullConfidence = beforeResults[0].score;

    factsDb.getRawDb().prepare("UPDATE facts SET confidence = 0 WHERE id = ?").run(fact.id);

    const afterResults = factsDb.search("Quixotic marmalade beacon", 5);
    expect(afterResults.length).toBe(1);
    expect(afterResults[0].entry.confidence).toBe(0);
    const scoreAtZeroConfidence = afterResults[0].score;

    // Same fact, same text/freshness/bm25 -- only confidence changed. The composite score must
    // reflect that drop, not silently keep scoring as if confidence were still 1.0.
    expect(scoreAtZeroConfidence).toBeLessThan(scoreAtFullConfidence);
  });

  it("lookupFacts (entity/key) scores a confidence=0 fact lower than at confidence=1", () => {
    const fact = factsDb.store({
      text: "Zanzibar cinnamon export ledger",
      category: "fact",
      importance: 0.5,
      entity: "ZanzibarLedger",
      key: "export-total",
      value: "42",
      source: "conversation",
    });

    const before = factsDb.lookup("ZanzibarLedger", "export-total");
    expect(before.length).toBe(1);
    expect(before[0].entry.confidence).toBe(1.0);
    const scoreAtFullConfidence = before[0].score;

    factsDb.getRawDb().prepare("UPDATE facts SET confidence = 0 WHERE id = ?").run(fact.id);

    const after = factsDb.lookup("ZanzibarLedger", "export-total");
    expect(after.length).toBe(1);
    expect(after[0].entry.confidence).toBe(0);
    const scoreAtZeroConfidence = after[0].score;

    expect(scoreAtZeroConfidence).toBeLessThan(scoreAtFullConfidence);
  });
});
