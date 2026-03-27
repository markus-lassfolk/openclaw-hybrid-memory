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
  return {
    getFactsForConsolidation: vi.fn().mockReturnValue(entries),
    getById: vi.fn((id: string) => byId.get(id) ?? null),
    store: vi.fn().mockReturnValue({ id: "merged-fact" }),
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

    expect(factsDb.store).toHaveBeenCalledWith(expect.objectContaining({ key: "language", value: "Rust" }));
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

    expect(factsDb.store).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "consolidation",
        decayClass: "durable",
        tags: expect.arrayContaining(["consolidated"]),
      }),
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
    expect(factsDb.store).not.toHaveBeenCalled();
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
});
