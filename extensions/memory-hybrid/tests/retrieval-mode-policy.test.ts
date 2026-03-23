import { describe, expect, it } from "vitest";
import {
  RETRIEVAL_MODE,
  resolveInteractiveRecallBudgetTokens,
  resolveOrchestratorBudgetTokens,
  shouldSkipHydeForMode,
} from "../services/retrieval-mode-policy.js";

describe("retrieval-mode-policy", () => {
  it("caps interactive recall budget to min(autoRecall.maxTokens, retrieval.ambientBudgetTokens)", () => {
    const cfg = {
      autoRecall: { maxTokens: 800 },
      retrieval: { ambientBudgetTokens: 600 },
    } as unknown as import("../config.js").HybridMemoryConfig;

    expect(resolveInteractiveRecallBudgetTokens(cfg)).toBe(600);
  });

  it("clamps interactive orchestrator budget overrides to ambient budget", () => {
    const retrievalCfg = {
      ambientBudgetTokens: 700,
      explicitBudgetTokens: 4000,
    } as unknown as import("../config.js").RetrievalConfig;

    expect(resolveOrchestratorBudgetTokens(RETRIEVAL_MODE.INTERACTIVE_RECALL, retrievalCfg, 2500)).toBe(700);
  });

  it("skips HyDE only for interactive recall mode when skipForInteractiveTurns=true", () => {
    expect(shouldSkipHydeForMode(RETRIEVAL_MODE.INTERACTIVE_RECALL, true)).toBe(true);
    expect(shouldSkipHydeForMode(RETRIEVAL_MODE.EXPLICIT_DEEP, true)).toBe(false);
  });
});
