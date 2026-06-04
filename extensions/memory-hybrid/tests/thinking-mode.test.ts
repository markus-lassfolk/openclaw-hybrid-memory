import { describe, expect, it } from "vitest";
import {
  resolveDistillThinkingMode,
  resolveMiniMaxThinkingMode,
  resolveReinforcementThinkingMode,
  resolveReflectionThinkingMode,
  resolveSelfCorrectionThinkingMode,
} from "../config/thinking-mode.js";
import type { HybridMemoryConfig } from "../config/types/index.js";

const baseCfg = {
  llm: { minimax: { thinking: "adaptive" as const } },
} as HybridMemoryConfig;

describe("resolveMiniMaxThinkingMode", () => {
  it("returns override when set", () => {
    expect(resolveMiniMaxThinkingMode(baseCfg, "disabled")).toBe("disabled");
  });

  it("reads llm.minimax.thinking", () => {
    expect(resolveMiniMaxThinkingMode(baseCfg)).toBe("adaptive");
  });

  it("defaults to disabled", () => {
    expect(resolveMiniMaxThinkingMode(undefined)).toBe("disabled");
  });
});

describe("per-task thinking resolvers", () => {
  it("selfCorrection.thinking overrides global", () => {
    expect(
      resolveSelfCorrectionThinkingMode({
        ...baseCfg,
        selfCorrection: {
          semanticDedup: true,
          semanticDedupThreshold: 0.9,
          toolsSection: "x",
          applyToolsByDefault: true,
          autoRewriteTools: false,
          analyzeViaSpawn: false,
          spawnThreshold: 15,
          spawnModel: "",
          thinking: "disabled",
        },
      }),
    ).toBe("disabled");
  });

  it("falls back to llm.minimax.thinking when task unset", () => {
    expect(
      resolveReinforcementThinkingMode({
        ...baseCfg,
        reinforcement: {
          enabled: true,
          passiveBoost: 0.1,
          activeBoost: 0.05,
          maxConfidence: 1,
          similarityThreshold: 0.85,
        },
      }),
    ).toBe("adaptive");
  });

  it("distill.thinking is honored", () => {
    expect(
      resolveDistillThinkingMode({
        ...baseCfg,
        distill: { thinking: "disabled" },
      }),
    ).toBe("disabled");
  });

  it("reflection.thinking is honored", () => {
    expect(
      resolveReflectionThinkingMode({
        ...baseCfg,
        reflection: { enabled: true, defaultWindow: 14, minObservations: 2, thinking: "disabled" },
      }),
    ).toBe("disabled");
  });
});
