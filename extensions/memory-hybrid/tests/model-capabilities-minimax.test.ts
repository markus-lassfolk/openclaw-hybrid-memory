import { describe, expect, it } from "vitest";
import {
  getDistillBatchTokenLimit,
  getDistillMaxOutputTokens,
  getMaintenanceMaxOutputTokens,
  isMiniMaxM3Model,
  isMiniMaxModel,
  requiresMaxCompletionTokens,
} from "../services/model-capabilities.js";

describe("MiniMax model capabilities catalog", () => {
  it("assigns operational M3 caps (520k ctx, 131k out, 32k maintenance, 250k batch)", () => {
    expect(getDistillMaxOutputTokens("minimax/MiniMax-M3")).toBe(131_072);
    expect(getDistillMaxOutputTokens("MiniMax-M3")).toBe(131_072);
    expect(getMaintenanceMaxOutputTokens("MiniMax-M3")).toBe(32_768);
    expect(getMaintenanceMaxOutputTokens("minimax/MiniMax-M3")).toBe(32_768);
    expect(getDistillBatchTokenLimit("MiniMax-M3")).toBe(250_000);
    expect(getDistillBatchTokenLimit("minimax/MiniMax-M3")).toBe(250_000);
    expect(isMiniMaxM3Model("minimax/MiniMax-M3")).toBe(true);
    expect(requiresMaxCompletionTokens("minimax/MiniMax-M3")).toBe(true);
  });

  it("assigns operational M2.x caps (258k ctx, 131k out, 16k maintenance, 150k batch)", () => {
    expect(getDistillMaxOutputTokens("minimax/MiniMax-M2.7-highspeed")).toBe(131_072);
    expect(getDistillMaxOutputTokens("MiniMax-M2.7")).toBe(131_072);
    expect(getMaintenanceMaxOutputTokens("MiniMax-M2.7")).toBe(16_384);
    expect(getMaintenanceMaxOutputTokens("minimax/MiniMax-M2.7-highspeed")).toBe(16_384);
    expect(getDistillBatchTokenLimit("MiniMax-M2.5")).toBe(150_000);
    expect(getDistillBatchTokenLimit("minimax/MiniMax-M2.7")).toBe(150_000);
    expect(isMiniMaxModel("minimax/MiniMax-M2.7")).toBe(true);
    expect(isMiniMaxM3Model("minimax/MiniMax-M2.7")).toBe(false);
  });

  it("does not treat unknown models as MiniMax", () => {
    expect(isMiniMaxModel("gpt-4o")).toBe(false);
    expect(getDistillMaxOutputTokens("gpt-4o")).toBe(16_384);
    expect(getMaintenanceMaxOutputTokens("gpt-4o")).toBe(16_384);
  });
});
