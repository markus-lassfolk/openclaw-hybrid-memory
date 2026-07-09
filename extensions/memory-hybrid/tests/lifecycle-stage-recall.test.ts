/**
 * runRecallStage production wiring (before_agent_start recall path).
 * Requires Node >= 22.16 (node:sqlite).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runRecallStage } from "../lifecycle/stage-recall.js";
import { runRecall } from "../lifecycle/stage-recall/run-recall.js";
import { capturePluginError } from "../services/error-reporter.js";
import { INTERACTIVE_RECALL_STAGE_TIMEOUT_MS } from "../services/retrieval-mode-policy.js";
import * as recallPipeline from "../services/recall-pipeline.js";
import { estimateTokens } from "../utils/text.js";
import {
  buildRecallLifecycleContext,
  makeMockStageApi,
  makeRecallSessionState,
  seedSessionRecallQueueDepth,
} from "./helpers/lifecycle-recall-harness.js";

vi.mock("../services/recall-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/recall-pipeline.js")>();
  return {
    ...actual,
    runRecallPipelineQuery: vi.fn(),
  };
});

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

describe("runRecallStage", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-stage-recall-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockReset();
    vi.mocked(capturePluginError).mockClear();
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("injects fixed blocks for short prompts without running recall pipeline", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      memoryTiering: { enabled: true, hotMaxTokens: 500 },
    });
    vi.spyOn(factsDb, "getHotFacts").mockReturnValue([
      {
        entry: {
          id: "hot-short",
          text: "Active blocker: finish deploy checklist before merge",
          category: "project",
          importance: 0.9,
          entity: null,
          key: null,
          value: null,
          source: "conversation",
          createdAt: 1,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 1,
          scope: "global",
        },
        score: 1,
        backend: "sqlite",
      },
    ]);
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();

    const result = await runRecallStage({ prompt: "hi" }, api as never, ctx, sessionState);

    expect(result?.kind).toBe("empty");
    if (result?.kind === "empty") {
      expect(result.prependContext).toContain("short prompt");
      expect(result.prependContext).toContain("Active blocker");
      expect(result.prependContext).toContain("recalled data only");
    }
    expect(recallPipeline.runRecallPipelineQuery).not.toHaveBeenCalled();
    expect(ctx.recallInFlightRef.value).toBe(0);
  });

  it("uses FTS-only degraded path when recall queue depth exceeds threshold", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const searchSpy = vi.spyOn(factsDb, "search").mockReturnValue([
      {
        entry: {
          id: "f1",
          text: "cached fact",
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "conversation",
          createdAt: 1,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 1,
          scope: "global",
        },
        score: 1,
        backend: "sqlite" as const,
      },
    ]);
    const sessionState = makeRecallSessionState();
    seedSessionRecallQueueDepth(sessionState, 1);
    const api = makeMockStageApi();

    const result = await runRecallStage(
      { prompt: "what did we decide about deployment?" },
      api as never,
      ctx,
      sessionState,
    );

    expect(result?.kind).toBe("degraded");
    if (result?.kind === "degraded") {
      expect(result.prependContext).toContain("recall degraded: queue");
      expect(result.prependContext).toContain("<recalled-context>");
    }
    expect(searchSpy).toHaveBeenCalled();
    expect(recallPipeline.runRecallPipelineQuery).not.toHaveBeenCalled();
    expect(ctx.recallInFlightRef.value).toBe(0);
  });

  it("decrements recallInFlightRef when pipeline throws", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockRejectedValue(new Error("embed failed"));
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();

    await expect(
      runRecallStage({ prompt: "find credentials for github api" }, api as never, ctx, sessionState),
    ).rejects.toThrow("embed failed");
    expect(ctx.recallInFlightRef.value).toBe(0);
  });

  it("does not leak recallInFlightRef when setup code before the pipeline call throws", async () => {
    const timingModule = await import("../services/recall-timing.js");
    const timingSpy = vi.spyOn(timingModule, "createRecallTimingLogger").mockImplementation(() => {
      throw new Error("timing setup boom");
    });
    try {
      const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
      const sessionState = makeRecallSessionState();
      const api = makeMockStageApi();

      await expect(
        runRecallStage({ prompt: "find credentials for github api" }, api as never, ctx, sessionState),
      ).rejects.toThrow("timing setup boom");
      expect(ctx.recallInFlightRef.value).toBe(0);
      expect(sessionState.recallInFlightBySession.size).toBe(0);
    } finally {
      timingSpy.mockRestore();
    }
  });

  it("surfaces DB-close errors when recall generation is still current", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockRejectedValue(
      new Error("The database connection is not open"),
    );
    factsDb.permanentClose();
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();

    await expect(
      runRecallStage({ prompt: "find credentials for github api" }, api as never, ctx, sessionState),
    ).rejects.toThrow("The database connection is not open");
    expect(ctx.recallInFlightRef.value).toBe(0);
  });

  it("suppresses DB-close errors after registration supersession", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    ctx.registrationGeneration = 1;
    ctx.currentRegistrationGenerationRef = { value: 2 };
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockRejectedValue(
      new Error("The database connection is not open"),
    );
    factsDb.permanentClose();
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();

    const result = await runRecallStage({ prompt: "find credentials for github api" }, api as never, ctx, sessionState);

    expect(result).toEqual({ kind: "empty", prependContext: undefined });
    expect(ctx.recallInFlightRef.value).toBe(0);
  });

  it("returns degraded FTS+HOT fallback when stage wall-clock timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
      vi.mocked(recallPipeline.runRecallPipelineQuery).mockImplementation((_q, _l, _d, _h, opts) => {
        return new Promise((resolve) => {
          const onAbort = () => resolve([]);
          if (opts?.stageSignal?.aborted) {
            onAbort();
            return;
          }
          opts?.stageSignal?.addEventListener("abort", onAbort, { once: true });
        });
      });
      const sessionState = makeRecallSessionState();
      const api = makeMockStageApi();

      const pending = runRecallStage({ prompt: "long running recall query here" }, api as never, ctx, sessionState);
      await vi.advanceTimersByTimeAsync(INTERACTIVE_RECALL_STAGE_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result?.kind).toBe("degraded");
      if (result?.kind === "degraded") {
        expect(result.prependContext).toContain("recall degraded: timeout");
      }
      expect(ctx.recallInFlightRef.value).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves instead of hanging when the timeout-fallback degraded recall itself throws (loop iteration 111 regression)", async () => {
    vi.useFakeTimers();
    try {
      const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
      // auditStore.append is called unconditionally inside buildDegradedFtsHotRecallStage's
      // synchronous (no-await) body, so throwing here reliably faults the timeout-fallback path
      // without racing the main (hung) recall path, which already passed its own auditStore call
      // point long before the pipeline mock below ever settles.
      ctx.auditStore = {
        append: vi.fn(() => {
          throw new Error("simulated auditStore.append failure");
        }),
      } as unknown as typeof ctx.auditStore;
      vi.mocked(recallPipeline.runRecallPipelineQuery).mockImplementation((_q, _l, _d, _h, opts) => {
        return new Promise((resolve) => {
          const onAbort = () => resolve([]);
          if (opts?.stageSignal?.aborted) {
            onAbort();
            return;
          }
          opts?.stageSignal?.addEventListener("abort", onAbort, { once: true });
        });
      });
      const sessionState = makeRecallSessionState();
      const api = makeMockStageApi();

      const pending = runRecallStage({ prompt: "long running recall query here" }, api as never, ctx, sessionState);
      await vi.advanceTimersByTimeAsync(INTERACTIVE_RECALL_STAGE_TIMEOUT_MS + 1);
      const result = await pending;

      expect(result).toEqual({ kind: "empty", prependContext: undefined });
      expect(capturePluginError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("simulated auditStore.append failure") }),
        expect.objectContaining({ operation: "recall-timeout-fallback", subsystem: "stage-recall" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns empty (not timeout null) when registration is superseded before timeout fires", async () => {
    vi.useFakeTimers();
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    ctx.registrationGeneration = 1;
    ctx.currentRegistrationGenerationRef = { value: 1 };
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockImplementation((_q, _l, _d, _h, opts) => {
      return new Promise((resolve) => {
        const onAbort = () => resolve([]);
        if (opts?.stageSignal?.aborted) {
          onAbort();
          return;
        }
        opts?.stageSignal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();

    const pending = runRecallStage({ prompt: "long running recall query here" }, api as never, ctx, sessionState);
    ctx.currentRegistrationGenerationRef.value = 2;
    await vi.advanceTimersByTimeAsync(INTERACTIVE_RECALL_STAGE_TIMEOUT_MS + 1);
    const result = await pending;

    expect(result).toEqual({ kind: "empty", prependContext: undefined });
  });

  it("invokes recall pipeline and returns full result for normal prompts", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const pipelineHit = {
      entry: {
        id: "pipe-1",
        text: "pipeline hit",
        category: "fact" as const,
        importance: 0.8,
        entity: null,
        key: null,
        value: null,
        source: "conversation",
        createdAt: 1,
        decayClass: "stable" as const,
        expiresAt: null,
        lastConfirmedAt: 0,
        confidence: 1,
        scope: "global" as const,
      },
      score: 0.95,
      backend: "sqlite" as const,
    };
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockResolvedValue([pipelineHit]);
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();

    const result = await runRecallStage(
      { prompt: "search pipeline integration path" },
      api as never,
      ctx,
      sessionState,
    );

    expect(recallPipeline.runRecallPipelineQuery).toHaveBeenCalled();
    expect(vi.mocked(recallPipeline.runRecallPipelineQuery).mock.calls[0]?.[4]).toMatchObject({
      stageSignal: expect.any(AbortSignal),
    });
    expect(result?.kind).toBe("full");
    if (result?.kind === "full") {
      expect(result.result.candidates.some((c) => c.entry.id === "pipe-1")).toBe(true);
    }
    expect(ctx.recallInFlightRef.value).toBe(0);
  });

  it("caps hot fixed block tokens and keeps recall budget available", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      memoryTiering: { enabled: true, hotMaxTokens: 2000 },
      autoRecall: {
        hotMaxTokens: 40,
        narrativeMaxTokens: 200,
        procedureMaxTokens: 200,
        activeTaskMaxTokens: 0,
        staleWarningMaxTokens: 0,
      },
    });
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockResolvedValue([
      {
        entry: {
          id: "pipe-hot-cap",
          text: "pipeline hit",
          category: "fact",
          importance: 0.8,
          entity: null,
          key: null,
          value: null,
          source: "conversation",
          createdAt: 1,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 1,
          scope: "global",
        },
        score: 0.95,
        backend: "sqlite",
      },
    ]);
    vi.spyOn(factsDb, "getHotFacts").mockReturnValue([
      {
        entry: {
          id: "hot-1",
          text: "<think>internal chain</think> deployment api key rotates weekly with strict rollback checks ".repeat(
            8,
          ),
          category: "project",
          importance: 0.9,
          entity: null,
          key: null,
          value: null,
          source: "conversation",
          createdAt: 1,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 1,
          scope: "global",
        },
        score: 1,
        backend: "sqlite",
      },
    ]);

    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();
    const result = await runRecallStage({ prompt: "deployment plan context" }, api as never, ctx, sessionState);

    expect(result?.kind).toBe("full");
    if (result?.kind === "full") {
      expect(result.result.maxTokens).toBeGreaterThan(0);
      expect(estimateTokens(result.result.hotBlock)).toBeLessThanOrEqual(40);
      expect(result.result.hotBlock).not.toContain("<think>");
    }
  });

  it("logs fixed-block consumers when recall budget is exhausted", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      memoryTiering: { enabled: true, hotMaxTokens: 2000 },
      autoRecall: {
        maxTokens: 4,
        hotMaxTokens: 4,
        narrativeMaxTokens: 0,
        procedureMaxTokens: 0,
      },
    });
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockResolvedValue([
      {
        entry: {
          id: "pipe-exhausted",
          text: "pipeline hit",
          category: "fact",
          importance: 0.8,
          entity: null,
          key: null,
          value: null,
          source: "conversation",
          createdAt: 1,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 1,
          scope: "global",
        },
        score: 0.95,
        backend: "sqlite",
      },
    ]);
    vi.spyOn(factsDb, "getHotFacts").mockReturnValue([
      {
        entry: {
          id: "hot-2",
          text: "critical deploy context ".repeat(80),
          category: "project",
          importance: 0.9,
          entity: null,
          key: null,
          value: null,
          source: "conversation",
          createdAt: 1,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 1,
          scope: "global",
        },
        score: 1,
        backend: "sqlite",
      },
    ]);

    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();
    const result = await runRecallStage({ prompt: "deploy now with context" }, api as never, ctx, sessionState);

    expect(result?.kind).toBe("full");
    if (result?.kind === "full") {
      expect(result.result.maxTokens).toBeLessThanOrEqual(4);
      expect(estimateTokens(result.result.hotBlock)).toBeLessThanOrEqual(4);
      if (result.result.hotBlock.length > 0) {
        expect(result.result.hotBlock).toContain("hot");
      }
    }
    if (result?.kind === "full" && result.result.maxTokens <= 1) {
      expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("consumers:"));
    }
  });

  it("skips ambient queries but keeps main pipeline candidates when stage abort fires after main recall", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      autoRecall: {
        ambient: { enabled: true, multiQuery: true },
        entityLookup: { enabled: false },
      },
      retrieval: { strategies: ["fts", "semantic"] },
    });
    const mainCandidate = {
      entry: {
        id: "main-pipeline-hit",
        text: "Main pipeline recalled fact",
        category: "fact",
        importance: 0.8,
        entity: null,
        key: null,
        value: null,
        source: "conversation",
        createdAt: 1,
        decayClass: "stable" as const,
        expiresAt: null,
        lastConfirmedAt: 0,
        confidence: 1,
        scope: "global" as const,
      },
      score: 0.92,
      backend: "sqlite" as const,
    };
    const controller = new AbortController();
    let pipelineCalls = 0;
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockImplementation(async () => {
      pipelineCalls += 1;
      if (pipelineCalls === 1) {
        controller.abort();
        return [mainCandidate];
      }
      throw new Error("ambient query should not run after stage abort");
    });

    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();
    const result = await runRecall(
      { prompt: "deployment plan with enough context" },
      api as never,
      ctx,
      sessionState,
      controller.signal,
    );

    expect(result?.kind).toBe("full");
    if (result?.kind === "full") {
      expect(result.result.candidates.map((c) => c.entry.id)).toEqual(["main-pipeline-hit"]);
    }
    expect(pipelineCalls).toBe(1);
  });

  it("excludes structural-tier facts from entity lookup when memory tiering is enabled", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      memoryTiering: { enabled: true, hotMaxTokens: 0 },
      autoRecall: {
        entityLookup: { enabled: true, entities: ["Acme"], maxFactsPerEntity: 5 },
      },
    });
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockResolvedValue([]);
    vi.spyOn(factsDb, "lookup").mockReturnValue([
      {
        entry: {
          id: "structural-entity-fact",
          text: "Schema metadata for Acme",
          category: "fact",
          importance: 0.5,
          entity: "Acme",
          key: null,
          value: null,
          source: "conversation",
          createdAt: 1,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 1,
          scope: "global",
          tier: "structural",
        },
        score: 0.9,
        backend: "sqlite",
      },
      {
        entry: {
          id: "warm-entity-fact",
          text: "Acme prefers email updates",
          category: "preference",
          importance: 0.7,
          entity: "Acme",
          key: null,
          value: null,
          source: "conversation",
          createdAt: 1,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 1,
          scope: "global",
          tier: "warm",
        },
        score: 0.85,
        backend: "sqlite",
      },
    ]);

    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();
    const result = await runRecallStage({ prompt: "Tell me about Acme preferences" }, api as never, ctx, sessionState);

    expect(result?.kind).toBe("full");
    if (result?.kind === "full") {
      expect(result.result.candidates.map((c) => c.entry.id)).toEqual(["warm-entity-fact"]);
    }
  });
});
