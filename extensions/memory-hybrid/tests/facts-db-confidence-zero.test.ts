// @ts-nocheck
/**
 * Regression test (#2067-followup) for backends/facts-db/row-mapper.ts's rowToMemoryEntry():
 *
 * `confidence: (row.confidence as number) || 1.0` used `||`, which silently coerces a
 * legitimate `confidence: 0` (e.g. a caller explicitly storing a fact with zero confidence, or a
 * fact whose confidence was driven all the way down) into `1.0` (full confidence) on every read
 * -- the exact same falsy-zero pitfall `??` exists to avoid, and the one every sibling field in
 * this mapper (extractionConfidence, etc.) already uses `??` for. Fixed by switching to `??`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "confidence-zero-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("confidence=0 round-trip (#2067-followup)", () => {
  it("preserves an explicit confidence of 0 instead of coercing it to 1.0", () => {
    const stored = factsDb.store({
      text: "Zero-confidence fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      confidence: 0,
    });

    expect(stored.confidence).toBe(0);

    const reread = factsDb.getById(stored.id);
    expect(reread?.confidence).toBe(0);
  });

  it("still defaults confidence to 1.0 when omitted", () => {
    const stored = factsDb.store({
      text: "Default-confidence fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    expect(stored.confidence).toBe(1.0);
  });
});
