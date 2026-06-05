import { describe, expect, it, vi } from "vitest";
import {
  createPublicArtifactsProvider,
  registerPublicArtifactsBestEffort,
} from "../services/public-artifacts-provider.js";
import type { MemoryEntry } from "../types/memory.js";

function makeFact(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "aabb0011-0000-0000-0000-000000000001",
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

describe("public-artifacts-provider", () => {
  describe("createPublicArtifactsProvider", () => {
    it("returns all facts as artifacts", async () => {
      const facts = [makeFact(), makeFact({ id: "aabb0022", entity: "React" })];
      const factsDb = { getAll: vi.fn(() => facts) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts();

      expect(artifacts).toHaveLength(2);
      expect(artifacts[0].id).toBe("aabb0011-0000-0000-0000-000000000001");
      expect(artifacts[0].kind).toBe("fact");
      expect(artifacts[0].title).toBe("TypeScript / description");
      expect(artifacts[0].content).toBe("TypeScript is a typed superset of JavaScript");
    });

    it("classifies dream-cycle sources as dream-report", async () => {
      const dreamFact = makeFact({ source: "dream-cycle:run-001" });
      const factsDb = { getAll: vi.fn(() => [dreamFact]) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts();

      expect(artifacts[0].kind).toBe("dream-report");
    });

    it("classifies behavioral patterns", async () => {
      const patternFact = makeFact({
        category: "meta",
        entity: "behavioral-pattern",
        source: "analysis",
      });
      const factsDb = { getAll: vi.fn(() => [patternFact]) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts();

      expect(artifacts[0].kind).toBe("pattern");
    });

    it("respects limit", async () => {
      const facts = Array.from({ length: 10 }, (_, i) => makeFact({ id: `fact-${String(i).padStart(4, "0")}` }));
      const factsDb = { getAll: vi.fn(() => facts) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts({ limit: 3 });

      expect(artifacts).toHaveLength(3);
    });

    it("filters by since timestamp", async () => {
      const oldFact = makeFact({ createdAt: 1600000000, lastAccessed: 1600000000 });
      const newFact = makeFact({
        id: "aabb0022",
        createdAt: 1717300000,
        lastAccessed: 1717300000,
      });
      const factsDb = { getAll: vi.fn(() => [oldFact, newFact]) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const since = new Date(1717250000 * 1000).toISOString();
      const artifacts = await provider.listArtifacts({ since });

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].id).toBe("aabb0022");
    });

    it("includes metadata fields", async () => {
      const fact = makeFact({ tags: ["tag1", "tag2"] });
      const factsDb = { getAll: vi.fn(() => [fact]) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts();

      expect(artifacts[0].metadata).toEqual(
        expect.objectContaining({
          category: "technical",
          confidence: "0.9",
          source: "conversation",
          entity: "TypeScript",
          key: "description",
          tags: "tag1,tag2",
        }),
      );
    });

    it("returns empty array on error", async () => {
      const factsDb = {
        getAll: vi.fn(() => {
          throw new Error("db failure");
        }),
      } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts();

      expect(artifacts).toEqual([]);
    });

    it("excludes internal dream-ingester sentinel facts", async () => {
      const sentinel = makeFact({
        id: "sentinel-001",
        entity: "system",
        key: "dream-ingested-run:run-001",
        text: "Dream cycle run run-001 findings ingested",
        tags: ["dream-ingester-sentinel"],
      });
      const factsDb = { getAll: vi.fn(() => [makeFact(), sentinel]) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts();

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].id).toBe("aabb0011-0000-0000-0000-000000000001");
    });

    it("excludes credential facts", async () => {
      const cred = makeFact({
        id: "cred-001",
        category: "credential",
        entity: "Credentials",
        text: "secret",
      });
      const factsDb = { getAll: vi.fn(() => [makeFact(), cred]) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts();

      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].id).toBe("aabb0011-0000-0000-0000-000000000001");
    });

    it("sorts by most recent first", async () => {
      const older = makeFact({ id: "older", lastAccessed: 1717100000 });
      const newer = makeFact({ id: "newer", lastAccessed: 1717300000 });
      const factsDb = { getAll: vi.fn(() => [older, newer]) } as any;

      const provider = createPublicArtifactsProvider(factsDb);
      const artifacts = await provider.listArtifacts();

      expect(artifacts[0].id).toBe("newer");
      expect(artifacts[1].id).toBe("older");
    });
  });

  describe("registerPublicArtifactsBestEffort", () => {
    it("returns false when registerMemoryCapability is unavailable", () => {
      const api = { logger: { debug: vi.fn() } } as any;
      const factsDb = {} as any;

      const result = registerPublicArtifactsBestEffort(api, factsDb);

      expect(result).toBe(false);
    });

    it("registers successfully and returns true", () => {
      const api = {
        registerMemoryCapability: vi.fn(),
        logger: { info: vi.fn() },
      } as any;
      const factsDb = { getAll: vi.fn(() => []) } as any;

      const result = registerPublicArtifactsBestEffort(api, factsDb);

      expect(result).toBe(true);
      expect(api.registerMemoryCapability).toHaveBeenCalledWith(
        expect.objectContaining({ publicArtifacts: expect.any(Object) }),
      );
    });

    it("catches errors and returns false", () => {
      const api = {
        registerMemoryCapability: vi.fn(() => {
          throw new Error("slot taken");
        }),
        logger: { warn: vi.fn() },
      } as any;
      const factsDb = { getAll: vi.fn(() => []) } as any;

      const result = registerPublicArtifactsBestEffort(api, factsDb);

      expect(result).toBe(false);
    });
  });
});
