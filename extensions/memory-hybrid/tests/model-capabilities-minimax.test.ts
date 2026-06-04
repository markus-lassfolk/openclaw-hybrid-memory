import { describe, expect, it } from "vitest";
import {
  getDistillBatchTokenLimit,
  getDistillMaxOutputTokens,
  isMiniMaxM3Model,
  isMiniMaxModel,
  requiresMaxCompletionTokens,
} from "../services/model-capabilities.js";

describe("MiniMax model capabilities catalog", () => {
  it("assigns 1M context / 131k output / 700k batch to MiniMax-M3", () => {
    expect(getDistillMaxOutputTokens("minimax/MiniMax-M3")).toBe(131_072);
    expect(getDistillBatchTokenLimit("MiniMax-M3")).toBe(700_000);
    expect(isMiniMaxM3Model("minimax/MiniMax-M3")).toBe(true);
    expect(requiresMaxCompletionTokens("minimax/MiniMax-M3")).toBe(true);
  });

  it("assigns 204.8k context / 128k output / 160k batch to MiniMax M2.x", () => {
    expect(getDistillMaxOutputTokens("minimax/MiniMax-M2.7-highspeed")).toBe(128_000);
    expect(getDistillBatchTokenLimit("MiniMax-M2.5")).toBe(160_000);
    expect(isMiniMaxModel("minimax/MiniMax-M2.7")).toBe(true);
    expect(isMiniMaxM3Model("minimax/MiniMax-M2.7")).toBe(false);
  });

  it("does not treat unknown models as MiniMax", () => {
    expect(isMiniMaxModel("gpt-4o")).toBe(false);
    expect(getDistillMaxOutputTokens("gpt-4o")).toBe(16_384);
  });
});
