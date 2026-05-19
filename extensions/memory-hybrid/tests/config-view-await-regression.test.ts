/**
 * Regression tests for broad-config-view-missing-await (issue #1496).
 *
 * These tests exercise the actual CLI registration path via
 * registerManageCorrectionsAndPipeline to ensure that an async
 * runConfigView is properly awaited in the `config` and `features`
 * action handlers — something the unit tests in config-view-json.test.ts
 * cannot verify because they call runConfigViewForCli directly.
 */

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageCorrectionsAndPipeline } from "../cli/commands/manage/register-corrections-and-pipeline.js";
import type { VerifyCliSink } from "../cli/types.js";

const origArgv = process.argv.slice();

type ConfigViewFn = (
  sink: VerifyCliSink,
  opts?: { format?: "text" | "json"; featuresOnly?: boolean },
) => void | Promise<void>;

function makeBindings(runConfigView: ConfigViewFn): ManageBindings {
  return {
    runConfigView,
    // The remaining bindings are only accessed inside other command closures
    // that are not invoked during config/features command tests.
    factsDb: {},
    cfg: {},
    listCommands: () => [],
    runFindDuplicates: vi.fn(),
    runConsolidate: vi.fn(),
    runReflection: vi.fn(),
    reflectionConfig: {
      enabled: false,
      defaultWindow: 7,
      minObservations: 3,
      model: "test-model",
    },
    runReflectionRules: vi.fn(),
    runReflectionMeta: vi.fn(),
    runReflectIdentity: vi.fn(),
    runClassify: vi.fn(),
    runEntityEnrichment: vi.fn(),
    runSelfCorrectionExtract: vi.fn(),
    runSelfCorrectionRun: vi.fn(),
    runDreamCycle: vi.fn(),
    runContinuousVerification: vi.fn(),
    runExtractImplicitFeedback: vi.fn(),
    runCrossAgentLearning: vi.fn(),
    runToolEffectiveness: vi.fn(),
    pruneCostLog: vi.fn(),
    runCostReport: vi.fn(),
    runAnalyzeFeedbackPhrases: vi.fn(),
    ctx: {},
    runStore: vi.fn(),
    runConfigMode: vi.fn(),
    runConfigSet: vi.fn(),
    runConfigSetHelp: vi.fn(),
    runBackfill: vi.fn(),
    runIngestFiles: vi.fn(),
    runExport: vi.fn(),
    runBuildLanguageKeywords: vi.fn(),
    merge: vi.fn(),
    mergeResults: vi.fn(),
    BACKFILL_DECAY_MARKER: ".backfill-decay-done",
  } as unknown as ManageBindings;
}

function buildMem() {
  const mem = new Command("hybrid-mem");
  // use a non-standalone argv so withExit re-throws instead of calling process.exit
  process.argv = ["node", "/usr/bin/vitest"];
  return mem;
}

afterEach(() => {
  process.argv = origArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// `config` command
// ---------------------------------------------------------------------------
describe("registerManageCorrectionsAndPipeline — config command await regression", () => {
  it("awaits a Promise-returning runConfigView and resolves successfully", async () => {
    let called = false;
    const bindings = makeBindings(async () => {
      called = true;
    });
    const mem = buildMem();
    registerManageCorrectionsAndPipeline(mem, bindings);

    await mem.parseAsync(["config", "--json"], { from: "user" });

    expect(called).toBe(true);
  });

  it("propagates async rejection from runConfigView through the config action", async () => {
    const bindings = makeBindings(() => Promise.reject(new Error("async-config-view-failure")));
    const mem = buildMem();
    registerManageCorrectionsAndPipeline(mem, bindings);

    // In non-standalone mode withExit re-throws, so parseAsync should reject
    await expect(mem.parseAsync(["config", "--json"], { from: "user" })).rejects.toThrow("async-config-view-failure");
  });
});

// ---------------------------------------------------------------------------
// `features` command
// ---------------------------------------------------------------------------
describe("registerManageCorrectionsAndPipeline — features command await regression", () => {
  it("awaits a Promise-returning runConfigView and resolves successfully", async () => {
    let called = false;
    const bindings = makeBindings(async () => {
      called = true;
    });
    const mem = buildMem();
    registerManageCorrectionsAndPipeline(mem, bindings);

    await mem.parseAsync(["features"], { from: "user" });

    expect(called).toBe(true);
  });

  it("propagates async rejection from runConfigView through the features action", async () => {
    const bindings = makeBindings(() => Promise.reject(new Error("async-features-view-failure")));
    const mem = buildMem();
    registerManageCorrectionsAndPipeline(mem, bindings);

    await expect(mem.parseAsync(["features"], { from: "user" })).rejects.toThrow("async-features-view-failure");
  });
});
