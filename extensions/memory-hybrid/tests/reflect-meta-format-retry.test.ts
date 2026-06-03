import { describe, expect, it, vi } from "vitest";
import { runReflectionMeta } from "../services/reflection.js";
import type { MemoryEntry } from "../types/memory.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "fact-1",
    text: overrides.text ?? "User prefers TypeScript over JavaScript for type safety",
    category: overrides.category ?? "preference",
    importance: overrides.importance ?? 0.7,
    entity: overrides.entity ?? null,
    key: overrides.key ?? null,
    value: overrides.value ?? null,
    source: overrides.source ?? "test",
    createdAt: overrides.createdAt ?? Date.now(),
    decayClass: overrides.decayClass ?? "stable",
    expiresAt: overrides.expiresAt ?? null,
    lastConfirmedAt: overrides.lastConfirmedAt ?? Date.now(),
    confidence: overrides.confidence ?? 0.7,
    tags: overrides.tags,
    supersededAt: overrides.supersededAt ?? null,
    scope: overrides.scope ?? "global",
    scopeTarget: overrides.scopeTarget ?? null,
  };
}

const metaText =
  "User consistently prefers functional composition with strong emphasis on explicit types and small focused modules";

const patternEntries = [
  makeEntry({
    id: "p1",
    category: "pattern",
    text: "User consistently prefers functional composition over object-oriented patterns",
  }),
  makeEntry({
    id: "p2",
    category: "pattern",
    text: "User values type safety and always enables TypeScript strict mode in projects",
  }),
  makeEntry({
    id: "p3",
    category: "pattern",
    text: "User prefers small focused functions under twenty lines with clear single responsibility",
  }),
];

describe("runReflectionMeta format retry (#1801)", () => {
  it("retries with fallback model when primary returns invalid_response_format", async () => {
    let callIndex = 0;
    const responses = ["Some prose without META lines or JSON", JSON.stringify({ metas: [metaText], noAction: false })];
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      storeWithResult: vi.fn((storeArgs: { text: string }) => ({
        skipped: false as const,
        evictedFactId: null,
        embeddingStale: false,
        newlyStored: true,
        preMergeText: null,
        entry: makeEntry({ id: "meta-1", category: "pattern", text: storeArgs.text, tags: ["meta"] }),
      })),
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = {
      store: async () => undefined,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async (body: { response_format?: { type: string } }) => {
            expect(body.response_format).toEqual({ type: "json_object" });
            return { choices: [{ message: { content: responses[callIndex++] ?? "" } }] };
          },
        },
      },
    };
    const logger = { info: () => undefined, warn: vi.fn() };

    const res = await runReflectionMeta(
      factsDb as never,
      vectorDb as never,
      embeddings as never,
      openai as never,
      { dryRun: false, model: "primary-model", fallbackModels: ["fallback-model"] },
      logger,
    );

    expect(callIndex).toBe(2);
    expect(res.metaStored).toBe(1);
    expect(res.diagnostics?.status).toBe("ok");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid_response_format"));
  });

  it("throws when primary and fallback both return invalid_response_format", async () => {
    let callIndex = 0;
    const responses = ["Still no JSON or META lines", "Also invalid prose"];
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
      setEmbeddingModel: () => undefined,
    };
    const vectorDb = {
      store: async () => undefined,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: responses[callIndex++] ?? "" } }],
          }),
        },
      },
    };
    await expect(
      runReflectionMeta(
        factsDb as never,
        vectorDb as never,
        embeddings as never,
        openai as never,
        { dryRun: false, model: "primary-model", fallbackModels: ["fallback-model"] },
        { info: () => undefined, warn: () => undefined },
      ),
    ).rejects.toThrow("failure_type=invalid_response_format");
  });

  it("rethrows LLM API failures instead of returning zero silently", async () => {
    const factsDb = {
      getByCategory: (cat: string) => (cat === "pattern" ? patternEntries : []),
    };
    const vectorDb = {
      store: async () => undefined,
      getVectorDim: () => 2,
      getVectorsByFactIds: async () => new Map(),
    };
    const embeddings = { embed: async () => [1, 0], modelName: "test-model" };
    const openai = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("provider unavailable");
          },
        },
      },
    };
    await expect(
      runReflectionMeta(
        factsDb as never,
        vectorDb as never,
        embeddings as never,
        openai as never,
        { dryRun: false, model: "primary-model" },
        { info: () => undefined, warn: () => undefined },
      ),
    ).rejects.toThrow("provider unavailable");
  });
});
