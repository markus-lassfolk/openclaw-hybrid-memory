// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

import { runConfigViewForCli } from "../cli/cmd-config.js";
import type { HandlerContext } from "../cli/handlers.js";
import type { VerifyCliSink } from "../cli/types.js";

function makeCtx(overrides?: Partial<HandlerContext["cfg"]>): HandlerContext {
  const cfg = {
    mode: "minimal",
    verbosity: "normal",
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: false }, retrievalDirectives: { enabled: false } },
    credentials: { enabled: true },
    procedures: { enabled: true },
    memoryTiering: { enabled: true },
    graph: { enabled: true },
    autoClassify: { enabled: true },
    nightlyCycle: { enabled: false },
    passiveObserver: { enabled: false },
    reflection: { enabled: true },
    personaProposals: { enabled: false },
    selfCorrection: { enabled: true },
    selfExtension: { enabled: true },
    crystallization: { enabled: true },
    extraction: { extractionPasses: true },
    goalStewardship: { enabled: false },
    activeTask: { enabled: true, ledger: "markdown", filePath: "ACTIVE-TASKS.md" },
    frustrationDetection: { enabled: false },
    crossAgentLearning: { enabled: true },
    toolEffectiveness: { enabled: true },
    documents: { enabled: true },
    provenance: { enabled: true },
    workflowTracking: { enabled: false },
    verification: { enabled: false },
    aliases: { enabled: false },
    reranking: { enabled: false },
    contextualVariants: { enabled: false },
    errorReporting: { enabled: false },
    costTracking: { enabled: true },
    queryExpansion: { enabled: true },
    wal: { enabled: true },
    ambient: {
      enabled: true,
      multiQuery: false,
      topicShiftThreshold: 0.4,
      maxQueriesPerTrigger: 4,
      budgetTokens: 2000,
    },
    futureDateProtection: { enabled: true, maxFreezeDays: 365 },
    ...overrides,
  } as unknown as HandlerContext["cfg"];

  return {
    cfg,
    dataDir: ".",
    noEmoji: false,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as HandlerContext["logger"],
  };
}

describe("runConfigViewForCli JSON", () => {
  it("emits parseable summary JSON with contract and extended feature toggles", () => {
    const lines: string[] = [];
    runConfigViewForCli(makeCtx(), { log: (s) => lines.push(s), error: vi.fn() }, { format: "json" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.contract).toBe("openclaw.hybrid-mem.config-view.summary.v1");
    const features = parsed.features as Record<string, boolean>;
    expect(features.wal).toBe(true);
    expect(features.ambient).toBe(true);
    expect(features.futureDateProtection).toBe(true);
  });

  it("featuresOnly emits only the features object", () => {
    const lines: string[] = [];
    runConfigViewForCli(
      makeCtx(),
      { log: (s) => lines.push(s), error: vi.fn() },
      { format: "json", featuresOnly: true },
    );
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBeUndefined();
    expect(parsed.wal).toBe(true);
    expect(parsed.mode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regression: broad-config-view-missing-await (issue #1496)
// Verify that runConfigViewForCli can be safely awaited in async contexts and
// that errors thrown synchronously are propagated through an awaited call.
// ---------------------------------------------------------------------------
describe("runConfigViewForCli await-safety", () => {
  it("resolves when awaited (synchronous void return is await-compatible)", async () => {
    const lines: string[] = [];
    // await on a void-returning function is a no-op but must not throw or swallow output
    await runConfigViewForCli(makeCtx(), { log: (s) => lines.push(s), error: vi.fn() }, { format: "json" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(1);
  });

  it("synchronous error from runConfigViewForCli is caught when wrapped in try/catch with await", async () => {
    // Simulate what the CLI action handler does: await runConfigView(...) inside try/catch.
    // If the function throws synchronously, the error should surface via the awaited call.
    const throwingSink: VerifyCliSink = {
      log: () => {
        throw new Error("simulated-config-view-failure");
      },
      error: vi.fn(),
    };

    let caught: Error | undefined;
    try {
      await runConfigViewForCli(makeCtx(), throwingSink, { format: "json" });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toBe("simulated-config-view-failure");
  });
});
