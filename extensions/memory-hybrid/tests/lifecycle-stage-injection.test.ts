/**
 * runInjectionStage production wiring (recall → prependContext).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { runInjectionStage } from "../lifecycle/stage-injection.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  buildRecallLifecycleContext,
  makeMinimalRecallResult,
  makeMockStageApi,
} from "./helpers/lifecycle-recall-harness.js";

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

describe("runInjectionStage", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-stage-injection-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vi.mocked(capturePluginError).mockClear();
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wraps injected memories in recalled-context tags", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const api = makeMockStageApi();
    const recall = makeMinimalRecallResult();

    const out = await runInjectionStage(recall, api as never, ctx, { prompt: "test" });

    expect(out?.prependContext).toContain("<recalled-context>");
    expect(out?.prependContext).toContain("</recalled-context>");
    expect(out?.prependContext).toContain("User prefers concise answers");
  });

  it("returns undefined when there are no candidates and no fixed blocks", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const api = makeMockStageApi();
    const recall = makeMinimalRecallResult({ candidates: [] });

    const out = await runInjectionStage(recall, api as never, ctx, { prompt: "test" });

    expect(out).toBeUndefined();
  });

  it("does not capture plugin errors when hebbian strengthening runs after db close", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb, {
      graph: { enabled: true, strengthenOnRecall: true },
    });
    (factsDb as FactsDB & { isOpen: () => boolean }).isOpen = () => false;
    const api = makeMockStageApi();
    const recall = makeMinimalRecallResult({
      candidates: [
        makeMinimalRecallResult().candidates[0],
        {
          ...makeMinimalRecallResult().candidates[0],
          entry: { ...makeMinimalRecallResult().candidates[0].entry, id: "fact-2" },
        },
      ],
    });

    await runInjectionStage(recall, api as never, ctx, { prompt: "test" });
    await new Promise((r) => setImmediate(r));

    expect(capturePluginError).not.toHaveBeenCalled();
  });

  it("refreshes only pinned facts that were actually injected in progressive_hybrid mode", async () => {
    const short = factsDb.store({
      text: "Short pinned fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const oversized = factsDb.store({
      text: "oversized ".repeat(80),
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    for (let i = 0; i < 3; i++) {
      factsDb.refreshAccessedFacts([short.id, oversized.id]);
    }

    const shortEntry = factsDb.getById(short.id);
    const oversizedEntry = factsDb.getById(oversized.id);
    expect(shortEntry).toBeDefined();
    expect(oversizedEntry).toBeDefined();

    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const api = makeMockStageApi();
    const recall = makeMinimalRecallResult({
      injectionFormat: "progressive_hybrid",
      maxTokens: 40,
      indexCap: 80,
      pinnedRecallThreshold: 3,
      candidates: [
        { entry: shortEntry!, score: 0.9, backend: "sqlite" },
        { entry: oversizedEntry!, score: 0.8, backend: "sqlite" },
      ],
    });

    await runInjectionStage(recall, api as never, ctx, { prompt: "test" });

    expect(factsDb.getById(short.id)?.recallCount).toBe((shortEntry?.recallCount ?? 0) + 1);
    expect(factsDb.getById(oversized.id)?.recallCount).toBe(oversizedEntry?.recallCount ?? 0);
  });
});
