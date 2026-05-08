// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

import { runConfigViewForCli } from "../cli/cmd-config.js";
import type { HandlerContext } from "../cli/handlers.js";

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
