import { describe, expect, it, vi } from "vitest";
import { createMemoryCorpusSupplement } from "../services/memory-corpus-supplement.js";
import type { MemoryEntry } from "../types/memory.js";

const FACT_ID = "a1b2c3d4-e5f6-0000-0000-000000000001";

function makeFact(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: FACT_ID,
    text: "TypeScript is a typed superset of JavaScript",
    category: "technical",
    importance: 0.8,
    entity: "TypeScript",
    key: "description",
    value: "typed superset",
    source: "conversation",
    createdAt: 1717200000,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 1717200000,
    confidence: 0.9,
    ...overrides,
  };
}

function makeSearchResult(entry: MemoryEntry, score = 0.85) {
  return { entry, score, backend: "sqlite" as const };
}

describe("memory-corpus-supplement", () => {
  describe("search", () => {
    it("returns formatted results from factsDb.search", async () => {
      const fact = makeFact();
      const factsDb = {
        search: vi.fn(() => [makeSearchResult(fact)]),
        getById: vi.fn(() => fact),
      } as any;

      const supplement = createMemoryCorpusSupplement({ factsDb });
      const results = await supplement.search({ query: "TypeScript" });

      expect(results).toHaveLength(1);
      expect(results[0].corpus).toBe("hybrid-memory");
      expect(results[0].path).toContain("hybrid-memory/facts/");
      expect(results[0].title).toBe("TypeScript / description");
      expect(results[0].content).toBe(fact.text);
      expect(results[0].score).toBe(0.85);
      expect(results[0].id).toBe(FACT_ID);
    });

    it("returns empty array for empty query", async () => {
      const factsDb = { search: vi.fn(), getById: vi.fn() } as any;
      const supplement = createMemoryCorpusSupplement({ factsDb });
      const results = await supplement.search({ query: "" });

      expect(results).toEqual([]);
      expect(factsDb.search).not.toHaveBeenCalled();
    });

    it("limits results to maxResults", async () => {
      const factsDb = {
        search: vi.fn(() => []),
        getById: vi.fn(),
      } as any;

      const supplement = createMemoryCorpusSupplement({ factsDb });
      await supplement.search({ query: "test", maxResults: 5 });

      expect(factsDb.search).toHaveBeenCalledWith("test", 5, expect.any(Object));
    });

    it("caps maxResults at 50", async () => {
      const factsDb = {
        search: vi.fn(() => []),
        getById: vi.fn(),
      } as any;

      const supplement = createMemoryCorpusSupplement({ factsDb });
      await supplement.search({ query: "test", maxResults: 200 });

      expect(factsDb.search).toHaveBeenCalledWith("test", 50, expect.any(Object));
    });
  });

  describe("get", () => {
    it("returns formatted result for a direct fact ID", async () => {
      const fact = makeFact();
      const factsDb = {
        search: vi.fn(),
        getById: vi.fn(() => fact),
        findByIdPrefixScoped: vi.fn(() => null),
      } as any;

      const supplement = createMemoryCorpusSupplement({ factsDb });
      const result = await supplement.get({ lookup: FACT_ID });

      expect(result).not.toBeNull();
      expect(result!.corpus).toBe("hybrid-memory");
      expect(result!.title).toBe("TypeScript / description");
      expect(result!.content).toContain("TypeScript is a typed superset");
      expect(result!.content).toContain("Entity: TypeScript");
      expect(result!.id).toBe(FACT_ID);
    });

    it("extracts fact ID from virtual path", async () => {
      const fact = makeFact();
      const factsDb = {
        search: vi.fn(),
        getById: vi.fn(() => fact),
        findByIdPrefixScoped: vi.fn(() => null),
      } as any;

      const supplement = createMemoryCorpusSupplement({ factsDb });
      await supplement.get({ lookup: `hybrid-memory/facts/technical/${FACT_ID}` });

      expect(factsDb.getById).toHaveBeenCalledWith(FACT_ID, expect.any(Object));
    });

    it("returns null for empty lookup", async () => {
      const factsDb = { search: vi.fn(), getById: vi.fn() } as any;
      const supplement = createMemoryCorpusSupplement({ factsDb });

      const result = await supplement.get({ lookup: "" });
      expect(result).toBeNull();
    });

    it("returns null when fact not found", async () => {
      const factsDb = {
        search: vi.fn(),
        getById: vi.fn(() => null),
        findByIdPrefixScoped: vi.fn(() => null),
      } as any;

      const supplement = createMemoryCorpusSupplement({ factsDb });
      const result = await supplement.get({ lookup: "deadbeef-0000-0000-0000-000000000000" });

      expect(result).toBeNull();
    });
  });
});
