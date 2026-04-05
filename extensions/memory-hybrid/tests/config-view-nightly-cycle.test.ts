// @ts-nocheck
import { getEnv, setEnv } from "../utils/env-manager.js";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runConfigViewForCli } from "../cli/cmd-config.js";
import type { HandlerContext } from "../cli/handlers.js";

function makeCtx(enabled: boolean): HandlerContext {
  const cfg = {
    mode: "complete",
    verbosity: "normal",
    autoCapture: true,
    autoRecall: { enabled: true, entityLookup: { enabled: true }, retrievalDirectives: { enabled: true } },
    credentials: { enabled: true },
    procedures: { enabled: true },
    memoryTiering: { enabled: true },
    graph: { enabled: true },
    autoClassify: { enabled: true },
    nightlyCycle: { enabled },
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

describe("runConfigViewForCli nightlyCycle output", () => {
  beforeEach(() => {
    setEnv("OPENCLAW_CONFIG", "/tmp/test-openclaw-missing.json");
  });

  afterEach(() => {
    setEnv("OPENCLAW_CONFIG", undefined);
    try {
      fs.unlinkSync("/tmp/test-openclaw.json");
    } catch {
      // Ignore if file doesn't exist
    }
  });

  it("shows on when nightlyCycle.enabled is true", () => {
    const logs: string[] = [];
    runConfigViewForCli(makeCtx(true), { log: (line) => logs.push(line) });

    expect(logs.some((l) => l.includes("Nightly dream cycle: on"))).toBe(true);
  });

  it("shows off when nightlyCycle.enabled is false", () => {
    const logs: string[] = [];
    runConfigViewForCli(makeCtx(false), { log: (line) => logs.push(line) });

    expect(logs.some((l) => l.includes("Nightly dream cycle: off"))).toBe(true);
  });

  it("shows goal stewardship and active task ledger line", () => {
    const logs: string[] = [];
    runConfigViewForCli(makeCtx(true), { log: (line) => logs.push(line) });

    expect(logs.some((l) => l.includes("Goal stewardship:"))).toBe(true);
    expect(logs.some((l) => l.includes("ledger: markdown"))).toBe(true);
  });
});
