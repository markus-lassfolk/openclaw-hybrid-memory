import { describe, expect, it, vi } from "vitest";
import { runConsolidate } from "../services/consolidation.js";
import { getCurrentCostFeature } from "../services/cost-context.js";
import type { MemoryEntry } from "../types/memory.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? `fact-${Math.random().toString(36).slice(2)}`,
    text: overrides.text ?? "Default fact text",
    category: overrides.category ?? "fact",
    importance: overrides.importance ?? 0.7,
    entity: overrides.entity ?? null,
    key: overrides.key ?? null,
    value: overrides.value ?? null,
    source: overrides.source ?? "test",
    createdAt: overrides.createdAt ?? Date.now(),
    decayClass: overrides.decayClass ?? "stable",
    expiresAt: overrides.expiresAt ?? null,
    lastConfirmedAt: overrides.lastConfirmedAt ?? Date.now(),
    confidence: overrides.confidence ?? 0.6,
    ...overrides,
  };
}

function makeFactsDb(entries: MemoryEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const mergedEntry = makeEntry({ id: "merged-fact", text: "Merged fact" });
  return {
    getFactsForConsolidation: vi.fn().mockReturnValue(entries),
    getById: vi.fn((id: string) => byId.get(id) ?? null),
    storeWithResult: vi.fn((_input, _options) => ({
      skipped: false,
      entry: mergedEntry,
      evictedFactId: null,
      newlyStored: true,
      embeddingStale: false,
    })),
    createLink: vi.fn(),
    delete: vi.fn(),
    setEmbeddingModel: vi.fn(),
  };
}

function makeEmbeddings(vectors: Record<string, number[]>) {
  return {
    embed: vi.fn(async (text: string) => vectors[text] ?? [1, 0]),
  };
}

describe("runConsolidate", () => {
  it("preserves key/value from the highest-confidence source fact", async () => {
    const entries = [
      makeEntry({ id: "a", text: "User uses Rust", key: "language", value: "Rust", confidence: 0.9 }),
      makeEntry({ id: "b", text: "User uses Go", key: "language", value: "Go", confidence: 0.6 }),
    ];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({
      "User uses Rust": [1, 0],
      "User uses Go": [1, 0],
      "Merged fact": [1, 0],
    });
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;

    await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(factsDb.storeWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ key: "language", value: "Rust" }),
      expect.objectContaining({ warnContext: "consolidation", suppressVectorFallbackWarning: true }),
    );
  });

  it("stores consolidated facts with derived-source controls", async () => {
    const entries = [makeEntry({ id: "a", text: "Fact A" }), makeEntry({ id: "b", text: "Fact B" })];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({
      "Fact A": [1, 0],
      "Fact B": [1, 0],
      "Merged fact": [1, 0],
    });
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;

    await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(factsDb.storeWithResult).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "consolidation",
        decayClass: "durable",
        tags: expect.arrayContaining(["consolidated"]),
      }),
      expect.objectContaining({ warnContext: "consolidation", suppressVectorFallbackWarning: true }),
    );
  });

  it("treats similarity at the threshold as a merge candidate", async () => {
    const v1 = [1, 0];
    const v2 = [0.9, Math.sqrt(1 - 0.9 ** 2)];
    const entries = [makeEntry({ id: "a", text: "Fact A" }), makeEntry({ id: "b", text: "Fact B" })];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({
      "Fact A": v1,
      "Fact B": v2,
      "Merged fact": v1,
    });
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;

    const result = await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(result.merged).toBe(1);
    expect(result.deleted).toBe(2);
  });

  it("does not delete source facts when the merged fact's embedding fails (#35)", async () => {
    const v1 = [1, 0];
    const v2 = [0.9, Math.sqrt(1 - 0.9 ** 2)];
    const entries = [makeEntry({ id: "a", text: "Fact A" }), makeEntry({ id: "b", text: "Fact B" })];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = {
      embed: vi.fn(async (text: string) => {
        if (text === "Merged fact") throw new Error("embedding provider unavailable");
        if (text === "Fact A") return v1;
        if (text === "Fact B") return v2;
        return [1, 0];
      }),
    };
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;

    const result = await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    // The merge WAS stored (storeWithResult succeeded before the embed attempt)...
    expect(factsDb.storeWithResult).toHaveBeenCalled();
    // ...but since it has no vector, the source facts must be preserved rather than deleted —
    // deleting them would trade two searchable facts for one unsearchable one.
    expect(factsDb.delete).not.toHaveBeenCalled();
    // vectorDb.store is never called for the merged fact's own (missing) vector — any prior
    // calls above are from the unrelated per-source-fact vector cache-fill in
    // loadReflectionDedupeCorpusVectors, not the merged-fact store this fix guards.
    expect(vectorDb.store).not.toHaveBeenCalledWith(expect.objectContaining({ text: "Merged fact" }));
    expect(result.merged).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.clustersFailed).toBe(1);
    expect(result.vectorFailures).toBe(1);
    expect(result.semanticOutcome).toBe("partial");
  });

  it("skips merging when LLM returns empty content", async () => {
    const entries = [makeEntry({ id: "a", text: "Fact A" }), makeEntry({ id: "b", text: "Fact B" })];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({ "Fact A": [1, 0], "Fact B": [1, 0] });
    const openai = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] }) } },
    } as never;

    const result = await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(result.merged).toBe(0);
    expect(factsDb.storeWithResult).not.toHaveBeenCalled();
  });

  it("LLM call is attributed to 'consolidation' feature", async () => {
    let capturedFeature: string | undefined;
    const entries = [makeEntry({ id: "a", text: "Fact A" }), makeEntry({ id: "b", text: "Fact B" })];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({ "Fact A": [1, 0], "Fact B": [1, 0] });
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            capturedFeature = getCurrentCostFeature();
            return { choices: [{ message: { content: "Merged fact" } }] };
          }),
        },
      },
    } as never;

    await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(capturedFeature).toBe("consolidation");
  });

  it("does not delete cluster facts when store dedupes to an existing row", async () => {
    const entries = [makeEntry({ id: "a", text: "Fact A" }), makeEntry({ id: "b", text: "Fact B" })];
    const factsDb = makeFactsDb(entries);
    factsDb.storeWithResult.mockReturnValueOnce({
      skipped: false,
      entry: makeEntry({ id: "existing-dedupe", text: "Merged fact" }),
      evictedFactId: null,
      newlyStored: false,
      embeddingStale: false,
    });
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({
      "Fact A": [1, 0],
      "Fact B": [1, 0],
      "Merged fact": [1, 0],
    });
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;

    const result = await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(result.merged).toBe(0);
    expect(result.deleted).toBe(0);
    expect(factsDb.delete).not.toHaveBeenCalled();
  });

  it("invokes onProgress once per cluster, in order, with a running merged count (silent-hang fix)", async () => {
    // Two independent clusters (a,b) and (c,d): the per-cluster LLM merge loop previously had no
    // way to report progress at all. onProgress must fire once per cluster processed, regardless
    // of how slow each cluster's LLM call is, so a CLI heartbeat can report "cluster=N/total".
    const entries = [
      makeEntry({ id: "a", text: "Fact A" }),
      makeEntry({ id: "b", text: "Fact B" }),
      makeEntry({ id: "c", text: "Fact C" }),
      makeEntry({ id: "d", text: "Fact D" }),
    ];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({
      "Fact A": [1, 0],
      "Fact B": [1, 0],
      "Fact C": [0, 1],
      "Fact D": [0, 1],
      "Merged fact": [1, 0],
    });
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;
    const onProgress = vi.fn();

    const result = await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model", onProgress },
      { info: () => undefined, warn: () => undefined },
    );

    expect(result.clustersFound).toBe(2);
    expect(result.merged).toBe(2);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { clusterIndex: 1, totalClusters: 2, merged: 1 },
      { clusterIndex: 2, totalClusters: 2, merged: 2 },
    ]);
  });
});

/**
 * Regression test (loop iteration 104): getFactsForConsolidation had no scope filtering at all,
 * and runConsolidate's clustering step ignored scope entirely — two similar facts belonging to
 * different tenants (scope+scopeTarget) could be clustered and LLM-merged together, with the
 * merged output always stored at global scope (leaking the private content of every source fact
 * to every tenant) while the original scoped facts were deleted.
 */
describe("runConsolidate scope isolation (loop iteration 104 regression)", () => {
  it("does not cluster/merge facts belonging to different tenants even when highly similar", async () => {
    const entries = [
      makeEntry({ id: "a", text: "Tenant A private fact", scope: "agent", scopeTarget: "tenant-a" }),
      makeEntry({ id: "b", text: "Tenant B private fact", scope: "agent", scopeTarget: "tenant-b" }),
    ];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({
      "Tenant A private fact": [1, 0],
      "Tenant B private fact": [1, 0],
      "Merged fact": [1, 0],
    });
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;

    const result = await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(result.clustersFound).toBe(0);
    expect(result.merged).toBe(0);
    expect(factsDb.storeWithResult).not.toHaveBeenCalled();
    expect(factsDb.delete).not.toHaveBeenCalled();
  });

  it("stamps the merged fact with the source cluster's scope instead of defaulting to global", async () => {
    const entries = [
      makeEntry({ id: "a", text: "Tenant A fact one", scope: "agent", scopeTarget: "tenant-a" }),
      makeEntry({ id: "b", text: "Tenant A fact two", scope: "agent", scopeTarget: "tenant-a" }),
    ];
    const factsDb = makeFactsDb(entries);
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined) };
    const embeddings = makeEmbeddings({
      "Tenant A fact one": [1, 0],
      "Tenant A fact two": [1, 0],
      "Merged fact": [1, 0],
    });
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;

    await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    expect(factsDb.storeWithResult).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "agent", scopeTarget: "tenant-a" }),
      expect.objectContaining({ warnContext: "consolidation" }),
    );
  });
});

describe("runConsolidate cleanup failure containment (regression)", () => {
  it("does not abort the whole run when factsDb.delete() throws during cleanup", async () => {
    const entries = [makeEntry({ id: "a", text: "Fact A" }), makeEntry({ id: "b", text: "Fact B" })];
    const factsDb = makeFactsDb(entries);
    factsDb.delete.mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const vectorDb = { store: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(true) };
    const embeddings = makeEmbeddings({
      "Fact A": [1, 0],
      "Fact B": [1, 0],
      "Merged fact": [1, 0],
    });
    const openai = {
      chat: {
        completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Merged fact" } }] }) },
      },
    } as never;

    const result = await runConsolidate(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai,
      { threshold: 0.9, includeStructured: true, dryRun: false, limit: 10, model: "test-model" },
      { info: () => undefined, warn: () => undefined },
    );

    // The merge itself (storeWithResult) already succeeded before cleanup ran.
    expect(factsDb.storeWithResult).toHaveBeenCalled();
    // Cleanup failure must not propagate out of runConsolidate, and must be accounted for
    // as a failed cluster (matching every other failure path in this function) rather than
    // silently counted as a clean merge.
    expect(result.merged).toBe(0);
    expect(result.clustersFailed).toBe(1);
    expect(result.semanticOutcome).toBe("partial");
  });
});
