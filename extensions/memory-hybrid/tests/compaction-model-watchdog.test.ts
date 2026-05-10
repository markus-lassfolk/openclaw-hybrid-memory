import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPACTION_MODEL,
  buildCompactionModelWatchdogWarning,
  isCompactionModelTooStrong,
  resolveCompactionModelSelection,
} from "../utils/compaction-model-watchdog.js";

describe("compaction-model-watchdog", () => {
  it("resolves to default mini model when compaction model is unset", () => {
    const selection = resolveCompactionModelSelection({
      agents: { defaults: { model: { primary: "azure-foundry/gpt-5.5" } } },
    });
    expect(selection.model).toBe(DEFAULT_COMPACTION_MODEL);
    expect(selection.reason).toContain("default mini");
    expect(selection.inherited).toBe(false);
  });

  it("keeps explicit compaction model when configured", () => {
    const selection = resolveCompactionModelSelection({
      agents: {
        defaults: {
          model: { primary: "azure-foundry/gpt-5.5" },
          compaction: { model: "openai/gpt-4.1-mini" },
        },
      },
    });
    expect(selection.model).toBe("openai/gpt-4.1-mini");
    expect(selection.reason).toContain("explicitly set");
    expect(selection.inherited).toBe(false);
  });

  it("supports watchdog inheritance mode for existing configs", () => {
    const selection = resolveCompactionModelSelection(
      {
        agents: { defaults: { model: { primary: "azure-foundry/gpt-5.5" } } },
      },
      { fallbackPolicy: "inherit-agent-primary" },
    );
    expect(selection.model).toBe("azure-foundry/gpt-5.5");
    expect(selection.reason).toContain("inherited");
    expect(selection.inherited).toBe(true);
  });

  it("does not flag MiniMax M2.7 as too strong", () => {
    expect(isCompactionModelTooStrong("minimax/MiniMax-M2.7")).toBe(false);
    expect(isCompactionModelTooStrong("minimax/MiniMax-M2.7-highspeed")).toBe(false);
    expect(isCompactionModelTooStrong("MiniMax-M2.7")).toBe(false);
  });

  it("flags GPT-5.5 as too strong for compaction", () => {
    expect(isCompactionModelTooStrong("azure-foundry/gpt-5.5")).toBe(true);
  });

  it("does not flag mini or nano models", () => {
    expect(isCompactionModelTooStrong("openai/gpt-4.1-mini")).toBe(false);
    expect(isCompactionModelTooStrong("openai/gpt-4.1-nano")).toBe(false);
    expect(isCompactionModelTooStrong("openai/gpt-5-mini")).toBe(false);
  });

  it("formats a contextual watchdog warning for stronger-than-mini routing", () => {
    const selection = resolveCompactionModelSelection(
      {
        agents: { defaults: { model: { primary: "azure-foundry/gpt-5.5" } } },
      },
      { fallbackPolicy: "inherit-agent-primary" },
    );
    const warning = buildCompactionModelWatchdogWarning(selection, { context: "before_compaction" });
    expect(warning).toContain("before_compaction: compaction routing uses a stronger-than-mini model");
    expect(warning).toContain("provider=azure-foundry, model=azure-foundry/gpt-5.5");
    expect(warning).toContain(DEFAULT_COMPACTION_MODEL);
  });

  it("returns null warning for MiniMax M2.7", () => {
    const selection = resolveCompactionModelSelection({
      agents: { defaults: { compaction: { model: "minimax/MiniMax-M2.7" } } },
    });
    expect(buildCompactionModelWatchdogWarning(selection, { context: "after_compaction" })).toBeNull();
  });

  it("flags explicit high-tier claude sonnet/opus models", () => {
    expect(isCompactionModelTooStrong("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isCompactionModelTooStrong("anthropic/claude-opus-4-1")).toBe(true);
  });

  it("flags o3/o3-pro models", () => {
    expect(isCompactionModelTooStrong("openai/o3")).toBe(true);
    expect(isCompactionModelTooStrong("azure-foundry/o3-pro")).toBe(true);
  });

  it("flags unknown non-mini/non-nano/non-MiniMax models", () => {
    expect(isCompactionModelTooStrong("custom-provider/smart-default")).toBe(true);
  });
});
