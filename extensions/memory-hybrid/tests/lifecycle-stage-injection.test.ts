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

  it("keeps low-quality high-recall memories in the index while pinning permanent entries", async () => {
    const ctx = buildRecallLifecycleContext(tmpDir, factsDb);
    const api = makeMockStageApi();
    const base = makeMinimalRecallResult().candidates[0];
    const recall = makeMinimalRecallResult({
      injectionFormat: "progressive_hybrid",
      candidates: [
        {
          ...base,
          entry: {
            ...base.entry,
            id: "low-quality-high-recall",
            text: "low quality high recall should be indexed",
            confidence: 0.2,
            importance: 0.2,
            recallCount: 99,
          },
        },
        {
          ...base,
          entry: {
            ...base.entry,
            id: "permanent-low-quality",
            text: "permanent low quality should remain pinned",
            decayClass: "permanent",
            confidence: 0.2,
            importance: 0.2,
            recallCount: 0,
          },
        },
      ],
    });

    const out = await runInjectionStage(recall, api as never, ctx, { prompt: "test" });

    expect(out?.prependContext).toContain("- [sqlite/preference] permanent low quality should remain pinned");
    expect(out?.prependContext).not.toContain("- [sqlite/preference] low quality high recall should be indexed");
    expect(out?.prependContext).toContain("1. [preference] low quality high recall should be indexed");
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
});
