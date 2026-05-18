/**
 * Cross-cutting regression tests for open GitHub issues where coverage was missing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRIEVAL_CONFIG, buildExplicitSemanticQueryVector } from "../services/retrieval-orchestrator.js";

describe("retrieval-orchestrator dynamic import (#1478/#1475)", () => {
  afterEach(() => {
    vi.doUnmock("../services/error-reporter.js");
    vi.resetModules();
  });

  it("does not leave error-reporter dynamic import rejection unhandled (#1478)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    vi.doMock("../services/error-reporter.js", () => {
      throw new Error("simulated load failure");
    });

    try {
      await buildExplicitSemanticQueryVector({
        query: "test query",
        cfg: {
          llm: undefined,
          embedding: {
            provider: "openai",
            apiKey: "sk-test-key-long-enough",
            model: "text-embedding-3-small",
            dimensions: 3,
            batchSize: 1,
          },
          reflection: { enabled: false, defaultWindow: 7, minObservations: 1 },
          retrieval: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
          queryExpansion: {
            enabled: false,
            mode: "always",
            maxVariants: 4,
            cacheSize: 50,
            timeoutMs: 5000,
            skipForInteractiveTurns: true,
          },
        },
        embeddings: {
          embed: vi.fn(async () => [1, 0, 0]),
          embedBatch: vi.fn(async () => [[1, 0, 0]]),
          dimensions: 3,
          modelName: "test-embed",
        },
        openai: null as never,
        pendingLLMWarnings: { add: vi.fn(), drain: vi.fn(() => []) },
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await vi.dynamicImportSettled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
