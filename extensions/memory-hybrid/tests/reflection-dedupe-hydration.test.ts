import { describe, expect, it } from "vitest";
import {
  computeDedupeCorpusFingerprint,
  dedupeHydrationStateKey,
  reflectionLexicalNearDuplicateAgainstFact,
  resolveReflectionDedupeHydration,
} from "../services/reflection-dedupe-hydration.js";
import { loadReflectionDedupeCorpusVectors } from "../services/reflection.js";
import type { MemoryEntry } from "../types/memory.js";

describe("resolveReflectionDedupeHydration", () => {
  it("applies defaults when partial is null", () => {
    const r = resolveReflectionDedupeHydration(null);
    expect(r.maxEmbedsPerRun).toBeGreaterThan(0);
    expect(r.minIntervalMsBetweenEmbeds).toBeGreaterThan(0);
  });

  it("honors maxEmbedsPerRun 0 as unlimited", () => {
    const r = resolveReflectionDedupeHydration({ maxEmbedsPerRun: 0 });
    expect(r.maxEmbedsPerRun).toBe(0);
  });
});

describe("computeDedupeCorpusFingerprint", () => {
  it("changes when id set changes", () => {
    const a = computeDedupeCorpusFingerprint(["b", "a"], "m1");
    const b = computeDedupeCorpusFingerprint(["a", "b", "c"], "m1");
    expect(a).not.toBe(b);
  });

  it("is stable for same sorted ids and model", () => {
    const fp1 = computeDedupeCorpusFingerprint(["x", "y"], "m");
    const fp2 = computeDedupeCorpusFingerprint(["x", "y"], "m");
    expect(fp1).toBe(fp2);
  });
});

describe("reflectionLexicalNearDuplicateAgainstFact", () => {
  it("detects normalized equality", () => {
    expect(reflectionLexicalNearDuplicateAgainstFact("User prefers TypeScript", "user  prefers   typescript")).toBe(
      true,
    );
  });

  it("detects high token overlap when threshold is relaxed", () => {
    const a = "The user consistently values small focused functions under twenty lines";
    const b = "User values small focused functions under twenty lines for readability";
    expect(reflectionLexicalNearDuplicateAgainstFact(a, b, 0.65)).toBe(true);
  });

  it("returns false for unrelated short strings", () => {
    expect(reflectionLexicalNearDuplicateAgainstFact("alpha beta gamma delta", "one two three four five")).toBe(false);
  });
});

describe("loadReflectionDedupeCorpusVectors checkpoint semantics", () => {
  function fact(id: string, text = `text ${id}`): MemoryEntry {
    return {
      id,
      text,
      category: "pattern",
      timestamp: 1,
      confidence: 1,
      source: "test",
      embedding: null,
      embeddingModel: null,
      expiresAt: null,
      supersededAt: null,
      metadata: {},
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      decayClass: "normal",
      sourceSession: null,
      scope: "global",
      createdAt: 1,
      lastConfirmedAt: 1,
    } as MemoryEntry;
  }

  function factsDbStub() {
    const state = new Map<string, string>();
    return {
      getMaintenanceState: (key: string) => state.get(key) ?? null,
      setMaintenanceState: (key: string, value: string) => state.set(key, value),
      state,
    };
  }

  function vectorDbStub(overrides: Record<string, unknown> = {}) {
    return {
      getVectorDim: () => 3,
      isMemoriesVectorSchemaValid: () => true,
      isLanceDbAvailable: () => true,
      getVectorsByFactIds: async () => new Map<string, number[]>(),
      ...overrides,
    };
  }

  it("clears stale failed row markers when Lance already has the vector", async () => {
    const factsDb = factsDbStub();
    const id1 = "00000000-0000-4000-8000-000000000001";
    const stateKey = dedupeHydrationStateKey("pattern");
    const fp = computeDedupeCorpusFingerprint([id1], "m");
    factsDb.state.set(
      stateKey,
      JSON.stringify({
        v: 1,
        fp,
        model: "m",
        nextNeedIdx: 0,
        failed: { [id1]: { attempts: 2, nextRetryAt: 0 } },
        updatedAt: 1,
      }),
    );

    const hydratedFact = fact(id1, "already hydrated");
    hydratedFact.embeddingModel = "m";

    const res = await loadReflectionDedupeCorpusVectors(
      [hydratedFact],
      {
        modelName: "m",
        embed: async () => {
          throw new Error("should not embed");
        },
      } as never,
      vectorDbStub({ getVectorsByFactIds: async () => new Map([[id1, [1, 0, 0]]]) }) as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        hydrationPolicy: {
          maxEmbedsPerRun: 10,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    const cp = JSON.parse(factsDb.state.get(stateKey) ?? "{}");
    expect(res.hydration.complete).toBe(true);
    expect(cp.failed).toBeUndefined();
    expect(cp.doneIds ?? []).toEqual([]);
  });

  it("rehydrates a row when a stale doneId exists but Lance no longer has the vector", async () => {
    const factsDb = factsDbStub();
    const id1 = "00000000-0000-4000-8000-000000000001";
    const stateKey = dedupeHydrationStateKey("pattern");
    const fp = computeDedupeCorpusFingerprint([id1], "m");
    factsDb.state.set(
      stateKey,
      JSON.stringify({
        v: 1,
        fp,
        model: "m",
        nextNeedIdx: 1,
        doneIds: [id1],
        updatedAt: 1,
      }),
    );
    let embedCalls = 0;

    await loadReflectionDedupeCorpusVectors(
      [fact(id1, "lost vector")],
      {
        modelName: "m",
        embed: async () => {
          embedCalls++;
          return [1, 0, 0];
        },
      } as never,
      vectorDbStub({
        getVectorsByFactIds: async () => new Map<string, number[]>(),
        store: async (entry: { id: string }) => entry.id,
      }) as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        hydrationPolicy: {
          maxEmbedsPerRun: 10,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    expect(embedCalls).toBe(1);
  });

  it("counts failed embed attempts toward maxEmbedsPerRun", async () => {
    const factsDb = factsDbStub();
    let calls = 0;
    const embeddings = {
      modelName: "m",
      embed: async () => {
        calls++;
        throw new Error("permanent embed failure");
      },
    };

    const res = await loadReflectionDedupeCorpusVectors(
      [fact("00000000-0000-4000-8000-000000000001"), fact("00000000-0000-4000-8000-000000000002")],
      embeddings as never,
      vectorDbStub() as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        hydrationPolicy: {
          maxEmbedsPerRun: 1,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    expect(calls).toBe(1);
    expect(res.hydration.apiEmbedsThisRun).toBe(1);
    expect(res.hydration.deferredDueToCap).toBe(true);
  });

  it("uses doneIds rather than positional checkpoint when need-embed rows shift", async () => {
    const factsDb = factsDbStub();
    const id1 = "00000000-0000-4000-8000-000000000001";
    const id2 = "00000000-0000-4000-8000-000000000002";
    const id3 = "00000000-0000-4000-8000-000000000003";
    const rows = [fact(id1), fact(id2), fact(id3)];
    let storedVectors = new Map<string, number[]>();
    const embeddings = {
      modelName: "m",
      embed: async (text: string) => (text.includes(id1) ? [1, 0, 0] : text.includes(id2) ? [0, 1, 0] : [0, 0, 1]),
    };

    await loadReflectionDedupeCorpusVectors(
      rows,
      embeddings as never,
      vectorDbStub({
        store: async (entry: { id: string; vector: number[] }) => {
          storedVectors.set(entry.id.toLowerCase(), entry.vector);
          return entry.id;
        },
      }) as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        hydrationPolicy: {
          maxEmbedsPerRun: 1,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    const firstCp = JSON.parse(factsDb.state.get(dedupeHydrationStateKey("pattern")) ?? "{}");
    expect(firstCp.doneIds).toEqual([id1]);

    const second = await loadReflectionDedupeCorpusVectors(
      rows,
      embeddings as never,
      vectorDbStub({
        getVectorsByFactIds: async () => new Map([[id1, storedVectors.get(id1)!]]),
        store: async (entry: { id: string; vector: number[] }) => {
          storedVectors.set(entry.id.toLowerCase(), entry.vector);
          return entry.id;
        },
      }) as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        hydrationPolicy: {
          maxEmbedsPerRun: 10,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    const secondCp = JSON.parse(factsDb.state.get(dedupeHydrationStateKey("pattern")) ?? "{}");
    expect(second.hydration.complete).toBe(true);
    expect(secondCp.doneIds).toEqual([id1, id2, id3]);
    expect(storedVectors.has(id2)).toBe(true);
    expect(storedVectors.has(id3)).toBe(true);
  });

  it("does not persist hydration checkpoint during dry-run-style corpus loads", async () => {
    const factsDb = factsDbStub();
    const embeddings = { modelName: "m", embed: async () => [1, 0, 0] };

    await loadReflectionDedupeCorpusVectors(
      [fact("00000000-0000-4000-8000-000000000001")],
      embeddings as never,
      vectorDbStub() as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        persistCheckpoint: false,
        hydrationPolicy: {
          maxEmbedsPerRun: 10,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    expect(factsDb.state.has(dedupeHydrationStateKey("pattern"))).toBe(false);
  });

  it("persists hydrated checkpoint vectors before advancing the checkpoint", async () => {
    const factsDb = factsDbStub();
    const stored: Array<{ id: string; vector: number[] }> = [];
    const embeddings = { modelName: "m", embed: async () => [1, 0, 0] };

    const res = await loadReflectionDedupeCorpusVectors(
      [fact("00000000-0000-4000-8000-000000000001"), fact("00000000-0000-4000-8000-000000000002")],
      embeddings as never,
      vectorDbStub({
        store: async (entry: { id: string; vector: number[] }) => {
          stored.push(entry);
          return entry.id;
        },
      }) as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        hydrationPolicy: {
          maxEmbedsPerRun: 10,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    const cp = JSON.parse(factsDb.state.get(dedupeHydrationStateKey("pattern")) ?? "{}");
    expect(res.hydration.complete).toBe(true);
    expect(cp.nextNeedIdx).toBe(2);
    expect(stored.map((s) => s.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("does not advance checkpoint past a vector persistence failure", async () => {
    const factsDb = factsDbStub();
    let stores = 0;
    const embeddings = { modelName: "m", embed: async () => [1, 0, 0] };

    const res = await loadReflectionDedupeCorpusVectors(
      [fact("00000000-0000-4000-8000-000000000001"), fact("00000000-0000-4000-8000-000000000002")],
      embeddings as never,
      vectorDbStub({
        store: async () => {
          stores++;
          if (stores === 2) throw new Error("store failed");
          return "ok";
        },
      }) as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        hydrationPolicy: {
          maxEmbedsPerRun: 10,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    const cp = JSON.parse(factsDb.state.get(dedupeHydrationStateKey("pattern")) ?? "{}");
    expect(res.hydration.complete).toBe(false);
    expect(cp.nextNeedIdx).toBe(2);
    expect(Object.keys(cp.failed)).toEqual(["00000000-0000-4000-8000-000000000002"]);
  });

  it("quarantines a non-rate-limit embed error while continuing later rows", async () => {
    const factsDb = factsDbStub();
    let calls = 0;
    const embeddings = {
      modelName: "m",
      embed: async () => {
        calls++;
        if (calls === 2) throw new Error("boom");
        return [1, 0, 0];
      },
    };

    const res = await loadReflectionDedupeCorpusVectors(
      [
        fact("00000000-0000-4000-8000-000000000001"),
        fact("00000000-0000-4000-8000-000000000002"),
        fact("00000000-0000-4000-8000-000000000003"),
      ],
      embeddings as never,
      vectorDbStub() as never,
      { info: () => undefined, warn: () => undefined },
      "test",
      "test-op",
      {
        checkpoint: { factsDb: factsDb as never, kind: "pattern" },
        hydrationPolicy: {
          maxEmbedsPerRun: 10,
          minIntervalMsBetweenEmbeds: 0,
          maxConsecutive429BeforeDefer: 1,
          baseBackoffMsAfter429: 500,
        },
      },
    );

    const cp = JSON.parse(factsDb.state.get(dedupeHydrationStateKey("pattern")) ?? "{}");
    expect(res.hydration.complete).toBe(false);
    expect(cp.nextNeedIdx).toBe(3);
    expect(Object.keys(cp.failed)).toEqual(["00000000-0000-4000-8000-000000000002"]);
    expect(calls).toBe(3);
  });
});
