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
import { INTERACTIVE_RECALL_STAGE_TIMEOUT_MS } from "../services/retrieval-mode-policy.js";
import * as recallPipeline from "../services/recall-pipeline.js";
import {
  buildRecallLifecycleContext,
  makeMockStageApi,
  makeRecallSessionState,
} from "./helpers/lifecycle-recall-harness.js";

vi.mock("../services/recall-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/recall-pipeline.js")>();
  return {
    ...actual,
    runRecallPipelineQuery: vi.fn(),
  };
});

describe("runRecallStage", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-stage-recall-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockReset();
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("returns empty when prompt is shorter than 5 characters", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();

    const result = await runRecallStage({ prompt: "hi" }, api as never, ctx, sessionState);

    expect(result).toEqual({ kind: "empty", prependContext: undefined });
    expect(recallPipeline.runRecallPipelineQuery).not.toHaveBeenCalled();
    expect(ctx.recallInFlightRef.value).toBe(0);
  });

  it("uses FTS-only degraded path when recall queue depth exceeds threshold", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    ctx.recallInFlightRef.value = 1;
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
    expect(ctx.recallInFlightRef.value).toBe(1);
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

  it("returns null when stage wall-clock timeout fires", async () => {
    vi.useFakeTimers();
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockImplementation(() => new Promise(() => undefined));
    const sessionState = makeRecallSessionState();
    const api = makeMockStageApi();

    const pending = runRecallStage({ prompt: "long running recall query here" }, api as never, ctx, sessionState);
    await vi.advanceTimersByTimeAsync(INTERACTIVE_RECALL_STAGE_TIMEOUT_MS + 1);
    const result = await pending;

    expect(result).toBeNull();
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
    expect(result?.kind).toBe("full");
    if (result?.kind === "full") {
      expect(result.result.candidates.some((c) => c.entry.id === "pipe-1")).toBe(true);
    }
    expect(ctx.recallInFlightRef.value).toBe(0);
  });
});
