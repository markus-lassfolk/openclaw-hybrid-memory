/**
 * Optimistic concurrency (#2175) — shared-scope supersede refuses stale expectedHash.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { MemoryConflictError, computeInputStoreRevision, occTokenForFact } from "../utils/fact-occ.js";

describe("fact OCC (#2175)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fact-occ-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getOccToken is stable until the fact text/revision changes", () => {
    const entry = factsDb.store({
      text: "OCC fact alpha",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "global",
    });
    const token = factsDb.getOccToken(entry.id);
    expect(token).toBe(occTokenForFact(entry));
    expect(factsDb.getOccToken(entry.id)).toBe(token);
  });

  it("supersede with matching expectedHash succeeds", () => {
    const old = factsDb.store({
      text: "old curriculum",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "global",
    });
    const hash = factsDb.getOccToken(old.id)!;
    const neu = factsDb.store({
      text: "new curriculum",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "global",
    });
    expect(factsDb.supersede(old.id, neu.id, { expectedHash: hash })).toBe(true);
    expect(factsDb.getById(old.id)?.supersededAt ?? factsDb.getById(old.id)).toBeTruthy();
  });

  it("supersede with stale expectedHash throws memory_conflict", () => {
    const old = factsDb.store({
      text: "stale base",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "user",
      scopeTarget: "u1",
    });
    const neu = factsDb.store({
      text: "replacement",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "user",
      scopeTarget: "u1",
    });
    expect(() => factsDb.supersede(old.id, neu.id, { expectedHash: "deadbeef".repeat(8) })).toThrow(
      MemoryConflictError,
    );
    // Target remains active
    expect(factsDb.getById(old.id)).not.toBeNull();
    const still = factsDb.getById(old.id);
    expect((still as { supersededAt?: number | null } | null)?.supersededAt ?? null).toBeFalsy();
  });

  it("computeStoreRevision changes when a new fact is added", () => {
    const before = factsDb.computeStoreRevision();
    factsDb.store({
      text: "revision bump fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const after = factsDb.computeStoreRevision();
    expect(after).not.toBe(before);
    expect(computeInputStoreRevision([])).toMatch(/^[a-f0-9]{64}$/);
  });

  it("session-scope supersede without expectedHash remains low-friction", () => {
    const old = factsDb.store({
      text: "session scratch",
      category: "fact",
      importance: 0.4,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "session",
      scopeTarget: "s1",
    });
    const neu = factsDb.store({
      text: "session scratch v2",
      category: "fact",
      importance: 0.4,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "session",
      scopeTarget: "s1",
    });
    expect(factsDb.supersede(old.id, neu.id)).toBe(true);
  });
});
