import { describe, it, expect } from "vitest";
import { estimateCost, getModelPricing, MODEL_PRICING, getModeCostEstimates } from "../services/model-pricing.js";

describe("getModelPricing", () => {
  it("returns pricing for known OpenAI models", () => {
    const p = getModelPricing("openai/gpt-4.1-nano");
    expect(p).not.toBeNull();
    expect(p!.inputPer1M).toBe(0.1);
    expect(p!.outputPer1M).toBe(0.4);
  });

  it("returns pricing for known Google models", () => {
    const p = getModelPricing("google/gemini-2.0-flash-lite");
    expect(p).not.toBeNull();
    expect(p!.inputPer1M).toBe(0.075);
    expect(p!.outputPer1M).toBe(0.3);
  });

  it("returns pricing for known Anthropic models", () => {
    const p = getModelPricing("anthropic/claude-sonnet-4-6");
    expect(p).not.toBeNull();
    expect(p!.inputPer1M).toBe(3.0);
    expect(p!.outputPer1M).toBe(15.0);
  });

  it("returns null for unknown model", () => {
    expect(getModelPricing("unknown/some-model-v9")).toBeNull();
    expect(getModelPricing("")).toBeNull();
  });

  it("returns $0 for ollama/* models (local inference, no API cost)", () => {
    const p = getModelPricing("ollama/qwen3:8b");
    expect(p).not.toBeNull();
    expect(p!.inputPer1M).toBe(0);
    expect(p!.outputPer1M).toBe(0);
  });

  it("returns $0 for any ollama/* model regardless of model name", () => {
    expect(getModelPricing("ollama/llama3:8b")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(getModelPricing("ollama/mistral:7b")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(getModelPricing("OLLAMA/Qwen3:8b")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it("matches case-insensitively", () => {
    const p = getModelPricing("OpenAI/GPT-4.1-NANO");
    expect(p).not.toBeNull();
  });
});

describe("estimateCost", () => {
  it("correctly calculates cost for known model", () => {
    // gpt-4.1-nano: input=$0.10/1M, output=$0.40/1M
    // 1M input + 1M output = $0.10 + $0.40 = $0.50
    const cost = estimateCost("openai/gpt-4.1-nano", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.5, 6);
  });

  it("calculates fractional tokens correctly", () => {
    // gpt-4o: input=$2.50/1M, output=$10.00/1M
    // 100k input + 10k output = $0.25 + $0.10 = $0.35
    const cost = estimateCost("openai/gpt-4o", 100_000, 10_000);
    expect(cost).toBeCloseTo(0.35, 6);
  });

  it("returns null for unknown model", () => {
    expect(estimateCost("unknown/model", 1000, 200)).toBeNull();
  });

  it("returns 0 cost for ollama models regardless of token counts", () => {
    expect(estimateCost("ollama/qwen3:8b", 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCost("ollama/llama3:8b", 100_000, 50_000)).toBe(0);
  });

  it("handles zero tokens", () => {
    const cost = estimateCost("openai/gpt-4.1-nano", 0, 0);
    expect(cost).toBe(0);
  });

  it("handles very small token counts", () => {
    // 100 input + 50 output with nano model
    const cost = estimateCost("openai/gpt-4.1-nano", 100, 50);
    const expected = (100 / 1_000_000) * 0.1 + (50 / 1_000_000) * 0.4;
    expect(cost).toBeCloseTo(expected, 10);
  });
});

describe("MODEL_PRICING", () => {
  it("contains pricing entries", () => {
    expect(typeof MODEL_PRICING).toBe("object");
    expect(Object.keys(MODEL_PRICING).length).toBeGreaterThan(0);
  });

  it("includes all expected providers", () => {
    const keys = Object.keys(MODEL_PRICING);
    expect(keys.some((k) => k.startsWith("openai/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("google/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("anthropic/"))).toBe(true);
  });
});

describe("getModeCostEstimates()", () => {
  it("returns an array of 4 mode estimates", () => {
    const estimates = getModeCostEstimates();
    expect(estimates).toHaveLength(4);
  });

  it("covers all four config modes", () => {
    const modes = getModeCostEstimates().map((e) => e.mode);
    expect(modes).toContain("local");
    expect(modes).toContain("minimal");
    expect(modes).toContain("enhanced");
    expect(modes).toContain("complete");
  });

  it("has non-negative monthlyLow for all modes", () => {
    for (const e of getModeCostEstimates()) {
      expect(e.monthlyLow).toBeGreaterThanOrEqual(0);
    }
  });

  it("has monthlyHigh >= monthlyLow for all modes", () => {
    for (const e of getModeCostEstimates()) {
      expect(e.monthlyHigh).toBeGreaterThanOrEqual(e.monthlyLow);
    }
  });

  it("modes are ordered by cost (local cheapest, complete most expensive)", () => {
    const estimates = getModeCostEstimates();
    const local = estimates.find((e) => e.mode === "local")!;
    const complete = estimates.find((e) => e.mode === "complete")!;
    expect(complete.monthlyHigh).toBeGreaterThan(local.monthlyHigh);
  });

  it("each mode has a non-empty description and features list", () => {
    for (const e of getModeCostEstimates()) {
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.features.length).toBeGreaterThan(0);
    }
  });

  it("complete mode includes all enhanced mode features", () => {
    const estimates = getModeCostEstimates();
    const enhanced = estimates.find((e) => e.mode === "enhanced")!;
    const complete = estimates.find((e) => e.mode === "complete")!;
    for (const feature of enhanced.features) {
      expect(complete.features).toContain(feature);
    }
  });
});
