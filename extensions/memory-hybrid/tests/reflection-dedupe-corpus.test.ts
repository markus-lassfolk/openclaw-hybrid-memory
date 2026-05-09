import { describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import type { MemoryEntry } from "../types/memory.js";

const { loadReflectionDedupeCorpusVectors } = _testing;

function makeFact(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000001",
    text: overrides.text ?? "A reflection pattern long enough to embed for testing.",
    category: overrides.category ?? "pattern",
    importance: overrides.importance ?? 0.7,
    entity: overrides.entity ?? null,
    key: overrides.key ?? null,
    value: overrides.value ?? null,
    source: overrides.source ?? "reflection",
    createdAt: overrides.createdAt ?? 1,
    decayClass: overrides.decayClass ?? "permanent",
    expiresAt: overrides.expiresAt ?? null,
    lastConfirmedAt: overrides.lastConfirmedAt ?? 1,
    confidence: overrides.confidence ?? 0.8,
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn<(msg: string) => void>() };
}

describe("loadReflectionDedupeCorpusVectors", () => {
  it("reuses Lance vectors when embeddingModel is missing but dimensions match", async () => {
    const facts = [makeFact({ id: "fact-a", embeddingModel: null })];
    const embeddings = {
      modelName: "text-embedding-3-large",
      embed: vi.fn<(_: string) => Promise<number[]>>().mockResolvedValue([0, 1]),
    };
    const vectorDb = {
      getVectorDim: () => 2,
      getVectorsByFactIds: vi.fn().mockResolvedValue(new Map([["fact-a", [3, 4]]])),
      store: vi.fn(),
    };
    const logger = makeLogger();
    const markEmbeddingModel = vi.fn<(_: string, __: string) => void>();

    const vectors = await loadReflectionDedupeCorpusVectors(
      facts,
      embeddings,
      vectorDb as never,
      logger,
      "memory-hybrid: reflection",
      "test-dedupe",
      markEmbeddingModel,
    );

    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(vectorDb.store).not.toHaveBeenCalled();
    expect(markEmbeddingModel).toHaveBeenCalledWith("fact-a", "text-embedding-3-large");
    expect(vectors[0]?.[0]).toBeCloseTo(0.6);
    expect(vectors[0]?.[1]).toBeCloseTo(0.8);
    expect(logger.info.mock.calls.some(([msg]) => msg.includes("model-ok 0, missing 1"))).toBe(true);
  });

  it("persists API-hydrated dedupe vectors back to Lance with the original fact id", async () => {
    const facts = [makeFact({ id: "fact-b", text: "Needs API hydration", embeddingModel: "old-model" })];
    const embeddings = {
      modelName: "text-embedding-3-large",
      embed: vi.fn<(_: string) => Promise<number[]>>().mockResolvedValue([0, 5]),
    };
    const vectorDb = {
      getVectorDim: () => 2,
      getVectorsByFactIds: vi.fn().mockResolvedValue(new Map()),
      store: vi.fn().mockResolvedValue("fact-b"),
    };
    const logger = makeLogger();
    const markEmbeddingModel = vi.fn<(_: string, __: string) => void>();

    const vectors = await loadReflectionDedupeCorpusVectors(
      facts,
      embeddings,
      vectorDb as never,
      logger,
      "memory-hybrid: reflection",
      "test-dedupe",
      markEmbeddingModel,
    );

    expect(embeddings.embed).toHaveBeenCalledWith("Needs API hydration");
    expect(vectorDb.store).toHaveBeenCalledWith({
      text: "Needs API hydration",
      vector: [0, 5],
      importance: 0.7,
      category: "pattern",
      id: "fact-b",
    });
    expect(markEmbeddingModel).toHaveBeenCalledWith("fact-b", "text-embedding-3-large");
    expect(vectors[0]).toEqual([0, 1]);
    expect(logger.info.mock.calls.some(([msg]) => msg.includes("API 1, persisted 1"))).toBe(true);
  });

  it("logs and continues when persisting a hydrated vector fails", async () => {
    const facts = [makeFact({ id: "fact-c", text: "Hydrate but persist fails" })];
    const embeddings = {
      modelName: "text-embedding-3-large",
      embed: vi.fn<(_: string) => Promise<number[]>>().mockResolvedValue([1, 0]),
    };
    const vectorDb = {
      getVectorDim: () => 2,
      getVectorsByFactIds: vi.fn().mockResolvedValue(new Map()),
      store: vi.fn().mockRejectedValue(new Error("lance write unavailable")),
    };
    const logger = makeLogger();

    const vectors = await loadReflectionDedupeCorpusVectors(
      facts,
      embeddings,
      vectorDb as never,
      logger,
      "memory-hybrid: reflection",
      "test-dedupe",
    );

    expect(vectors[0]).toEqual([1, 0]);
    expect(
      logger.info.mock.calls.some(([msg]) => msg.includes("failed to persist hydrated vector for fact fact-c")),
    ).toBe(true);
    expect(logger.info.mock.calls.some(([msg]) => msg.includes("persistFailures 1"))).toBe(true);
  });

  it("logs per-batch progress with processed and remaining counts", async () => {
    const facts = Array.from({ length: 25 }, (_, i) => makeFact({ id: `fact-${i}`, text: `Fact ${i}` }));
    const embeddings = {
      modelName: "text-embedding-3-large",
      embed: vi.fn<(_: string) => Promise<number[]>>().mockResolvedValue([1, 0]),
    };
    const vectorDb = {
      getVectorDim: () => 2,
      getVectorsByFactIds: vi.fn().mockResolvedValue(new Map()),
      store: vi.fn().mockResolvedValue("ok"),
    };
    const logger = makeLogger();

    await loadReflectionDedupeCorpusVectors(
      facts,
      embeddings,
      vectorDb as never,
      logger,
      "memory-hybrid: reflection",
      "test-dedupe",
    );

    const messages = logger.info.mock.calls.map(([msg]) => msg);
    expect(messages.some((msg) => msg.includes("20/25 processed, 5 remaining"))).toBe(true);
    expect(messages.some((msg) => msg.includes("25/25 processed, 0 remaining"))).toBe(true);
  });
});
