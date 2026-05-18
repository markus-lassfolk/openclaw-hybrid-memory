/**
 * buildPostCompactionRecallSnippet (#957) — recall after compaction.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { buildPostCompactionRecallSnippet } from "../services/post-compaction-recall.js";
import * as recallPipeline from "../services/recall-pipeline.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  buildRecallLifecycleContext,
  makeMockStageApi,
} from "./helpers/lifecycle-recall-harness.js";

vi.mock("../services/recall-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/recall-pipeline.js")>();
  return { ...actual, runRecallPipelineQuery: vi.fn() };
});

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

describe("buildPostCompactionRecallSnippet", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "post-compaction-recall-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockReset();
    vi.mocked(capturePluginError).mockClear();
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when prompt is shorter than 5 characters", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const api = makeMockStageApi();
    const out = await buildPostCompactionRecallSnippet(ctx, api as never, "hi");
    expect(out).toBeNull();
    expect(recallPipeline.runRecallPipelineQuery).not.toHaveBeenCalled();
  });

  it("returns recalled-context block when pipeline returns candidates", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockResolvedValue([
      {
        entry: {
          id: "pc-1",
          text: "Post compaction memory hit",
          category: "fact",
          importance: 0.7,
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
        score: 0.9,
        backend: "sqlite",
      },
    ]);
    const api = makeMockStageApi();

    const out = await buildPostCompactionRecallSnippet(
      ctx,
      api as never,
      "what were we working on before compaction",
    );

    expect(out).toContain("post-compaction recall");
    expect(out).toContain("<recalled-context>");
    expect(out).toContain("Post compaction memory hit");
  });

  it("returns null when pipeline throws (non-fatal)", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockRejectedValue(new Error("embed down"));
    const api = makeMockStageApi();

    const out = await buildPostCompactionRecallSnippet(ctx, api as never, "resume after compaction please");

    expect(out).toBeNull();
    expect(capturePluginError).toHaveBeenCalled();
  });

  it("returns null when pipeline returns no candidates", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    vi.mocked(recallPipeline.runRecallPipelineQuery).mockResolvedValue([]);
    const api = makeMockStageApi();

    const out = await buildPostCompactionRecallSnippet(ctx, api as never, "empty recall after compaction");

    expect(out).toBeNull();
  });
});
