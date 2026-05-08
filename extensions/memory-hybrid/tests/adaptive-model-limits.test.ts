import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  adaptiveFailureShrinkRatios,
  getEffectiveModelLimits,
  loadAdaptiveModelLimits,
  recordAdaptiveFailure,
  recordAdaptiveSuccess,
  saveAdaptiveModelLimits,
} from "../services/adaptive-model-limits.js";

describe("adaptive-model-limits", () => {
  it("adaptiveFailureShrinkRatios matches recordAdaptiveFailure output scaling", () => {
    expect(adaptiveFailureShrinkRatios("timeout")).toEqual({ batch: 0.75, out: 0.75 });
    expect(adaptiveFailureShrinkRatios("context_length")).toEqual({ batch: 0.6, out: 0.6 });
    expect(adaptiveFailureShrinkRatios("rate_limit").batch).toBe(0.85);
    expect(adaptiveFailureShrinkRatios("rate_limit").out).toBe(0.95);
  });

  it("uses catalog limits when no state exists", () => {
    const state = loadAdaptiveModelLimits("/no/such/file.json");
    const eff = getEffectiveModelLimits({
      state,
      model: "openai/gpt-4.1-mini",
      catalogBatchTokenLimit: 100_000,
      catalogMaxOutputTokens: 8_000,
    });
    expect(eff.source).toBe("catalog");
    expect(eff.batchTokenLimit).toBe(100_000);
    expect(eff.maxOutputTokens).toBe(8_000);
  });

  it("shrinks on failures and grows slowly on success", () => {
    const dir = mkdtempSync(join(tmpdir(), "hybrid-mem-adaptive-"));
    const path = join(dir, "state.json");
    const state = loadAdaptiveModelLimits(path);

    const model = "google/gemini-3.1-pro-preview";
    const catalogBatchTokenLimit = 200_000;
    const catalogMaxOutputTokens = 16_000;

    recordAdaptiveFailure({
      state,
      model,
      kind: "timeout",
      catalogBatchTokenLimit,
      catalogMaxOutputTokens,
      usedBatchTokenLimit: catalogBatchTokenLimit,
      usedMaxOutputTokens: catalogMaxOutputTokens,
    });
    const afterFail = getEffectiveModelLimits({
      state,
      model,
      catalogBatchTokenLimit,
      catalogMaxOutputTokens,
    });
    expect(afterFail.source).toBe("adaptive");
    expect(afterFail.batchTokenLimit).toBeLessThan(catalogBatchTokenLimit);

    recordAdaptiveSuccess({
      state,
      model,
      catalogBatchTokenLimit,
      catalogMaxOutputTokens,
      usedBatchTokenLimit: afterFail.batchTokenLimit,
      usedMaxOutputTokens: afterFail.maxOutputTokens,
    });
    const afterOk = getEffectiveModelLimits({
      state,
      model,
      catalogBatchTokenLimit,
      catalogMaxOutputTokens,
    });
    expect(afterOk.batchTokenLimit).toBeGreaterThanOrEqual(afterFail.batchTokenLimit);
    expect(afterOk.batchTokenLimit).toBeLessThanOrEqual(catalogBatchTokenLimit);

    saveAdaptiveModelLimits(path, state);
    const disk = JSON.parse(readFileSync(path, "utf-8")) as { version: number; models: Record<string, unknown> };
    expect(disk.version).toBe(1);
    expect(Object.keys(disk.models)).toContain(model);
  });
});
