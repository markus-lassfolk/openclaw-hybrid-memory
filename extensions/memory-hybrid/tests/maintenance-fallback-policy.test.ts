import { describe, expect, it } from "vitest";
import { isExpensiveMaintenanceFallbackModel } from "../config/maintenance-fallback-policy.js";

describe("maintenance fallback policy (#1226)", () => {
  it("classifies cheap mini/nano/flash models as not expensive", () => {
    expect(isExpensiveMaintenanceFallbackModel("azure-foundry/gpt-4.1-mini")).toBe(false);
    expect(isExpensiveMaintenanceFallbackModel("openai/gpt-4o-mini")).toBe(false);
    expect(isExpensiveMaintenanceFallbackModel("azure-foundry/gpt-5.4-mini")).toBe(false);
    expect(isExpensiveMaintenanceFallbackModel("google/gemini-2.5-flash")).toBe(false);
    expect(isExpensiveMaintenanceFallbackModel("anthropic/claude-haiku-4-5-20251001")).toBe(false);
  });

  it("classifies Issue #1226 escalation models as expensive", () => {
    expect(isExpensiveMaintenanceFallbackModel("azure-foundry/o3")).toBe(true);
    expect(isExpensiveMaintenanceFallbackModel("azure-foundry/gpt-5.4")).toBe(true);
    expect(isExpensiveMaintenanceFallbackModel("azure-foundry/gpt-5.5")).toBe(true);
    expect(isExpensiveMaintenanceFallbackModel("openai-platform/gpt-4o")).toBe(true);
    expect(isExpensiveMaintenanceFallbackModel("minimax/MiniMax-M2.7")).toBe(true);
  });
});
