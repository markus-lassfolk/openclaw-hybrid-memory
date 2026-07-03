import { describe, expect, it } from "vitest";
import { analyzeStorageSyncFromIds } from "../services/storage-sync-diagnostics.js";

describe("storage-sync-diagnostics", () => {
  it("detects structural drift when row counts differ but ID sets align", () => {
    const baseIds = Array.from(
      { length: 100 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const lanceIdList = [...baseIds, ...baseIds.slice(0, 30)];
    const snapshot = analyzeStorageSyncFromIds({
      sqliteActiveFacts: 100,
      lanceRowCount: 130,
      lanceIdList,
      canonicalEmbeddings: 100,
      vectorOrphans: [],
      sqliteOrphans: [],
    });
    expect(snapshot.hasIdSetDrift).toBe(false);
    expect(snapshot.hasStructuralDrift).toBe(true);
    expect(snapshot.duplicateIdExtraRows).toBeGreaterThan(0);
  });

  it("detects ID-set drift from orphan vectors", () => {
    const snapshot = analyzeStorageSyncFromIds({
      sqliteActiveFacts: 2,
      lanceRowCount: 3,
      lanceIdList: ["a", "b", "orphan"],
      canonicalEmbeddings: 2,
      vectorOrphans: ["orphan"],
      sqliteOrphans: [],
    });
    expect(snapshot.hasIdSetDrift).toBe(true);
    expect(snapshot.hasStructuralDrift).toBe(false);
  });

  it("reports aligned storage when all metrics match", () => {
    const snapshot = analyzeStorageSyncFromIds({
      sqliteActiveFacts: 5,
      lanceRowCount: 5,
      lanceIdList: ["a", "b", "c", "d", "e"],
      canonicalEmbeddings: 5,
      vectorOrphans: [],
      sqliteOrphans: [],
    });
    expect(snapshot.hasRowCountDrift).toBe(false);
    expect(snapshot.hasStructuralDrift).toBe(false);
    expect(snapshot.hasIdSetDrift).toBe(false);
  });
});
