import { describe, expect, it, vi } from "vitest";
import { runScopedFtsVectorFallback } from "../services/retrieval-scoped-fallback.js";
import type { MemoryEntry, SearchResult } from "../types/memory.js";

function makeEntry(id: string, tier: MemoryEntry["tier"] = "warm"): MemoryEntry {
  return {
    id,
    text: `fact ${id}`,
    category: "general",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "test",
    createdAt: 1,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 0,
    confidence: 1,
    tier,
    scope: "global",
  };
}

function makeResult(id: string, backend: SearchResult["backend"] = "sqlite", tier: MemoryEntry["tier"] = "warm") {
  return { entry: makeEntry(id, tier), score: 0.8, backend };
}

describe("runScopedFtsVectorFallback", () => {
  it("merges scoped FTS and vector hits with seed results", async () => {
    const factsDb = {
      search: vi.fn(() => [makeResult("fts-1")]),
      getById: vi.fn((id: string) => makeEntry(id)),
    };
    const vectorDb = {
      search: vi.fn(async () => [makeResult("vec-1", "lancedb")]),
    };

    const results = await runScopedFtsVectorFallback({
      query: "deployment notes",
      limit: 5,
      queryVector: [0.1, 0.2],
      factsDb: factsDb as never,
      vectorDb: vectorDb as never,
      recallOpts: { tierFilter: "warm", scopeFilter: undefined },
      scopeFilter: undefined,
      warmTierOnly: false,
      seedResults: [makeResult("seed-1")],
    });

    expect(results.map((r) => r.entry.id).sort()).toEqual(["fts-1", "seed-1", "vec-1"].sort());
    expect(factsDb.search).toHaveBeenCalled();
    expect(vectorDb.search).toHaveBeenCalled();
  });

  it("excludes cold-tier vector hits when warmTierOnly is true", async () => {
    const factsDb = {
      search: vi.fn(() => [makeResult("fts-warm", "sqlite", "warm")]),
      getById: vi.fn((id: string) => makeEntry(id, id.includes("cold") ? "cold" : "warm")),
    };
    const vectorDb = {
      search: vi.fn(async () => [
        makeResult("vec-cold", "lancedb", "cold"),
        makeResult("vec-warm", "lancedb", "warm"),
      ]),
    };

    const results = await runScopedFtsVectorFallback({
      query: "notes",
      limit: 5,
      queryVector: [0.1, 0.2],
      factsDb: factsDb as never,
      vectorDb: vectorDb as never,
      recallOpts: { tierFilter: "warm", scopeFilter: undefined },
      scopeFilter: undefined,
      warmTierOnly: true,
    });

    expect(results.every((r) => r.entry.id !== "vec-cold")).toBe(true);
    expect(results.some((r) => r.entry.id === "vec-warm")).toBe(true);
  });
});
