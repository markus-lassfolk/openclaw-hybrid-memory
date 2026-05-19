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
});
