import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GATEWAY_BEFORE_AGENT_START_BUDGET_MS,
  beforeAgentStartRemainingMs,
  markBeforeAgentStartTurn,
  resolveBeforeAgentStartStageTimeoutMs,
  runOptionalBeforeAgentStartStage,
  shouldSkipOptionalBeforeAgentStartStage,
} from "../services/before-agent-start-budget.js";

describe("before-agent-start-budget (#1979)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps recall stage timeout to remaining gateway budget", () => {
    const ref = { value: Date.now() };
    markBeforeAgentStartTurn(ref);
    vi.advanceTimersByTime(GATEWAY_BEFORE_AGENT_START_BUDGET_MS - 3000);
    const capped = resolveBeforeAgentStartStageTimeoutMs(ref, 120_000);
    expect(capped).toBeLessThanOrEqual(2500);
    expect(capped).toBeGreaterThan(0);
  });

  it("skips optional stages when budget is nearly exhausted", () => {
    const ref = { value: Date.now() };
    markBeforeAgentStartTurn(ref);
    vi.advanceTimersByTime(GATEWAY_BEFORE_AGENT_START_BUDGET_MS - 100);
    expect(beforeAgentStartRemainingMs(ref)).toBeLessThan(200);
    expect(shouldSkipOptionalBeforeAgentStartStage(ref)).toBe(true);
  });

  it("runOptionalBeforeAgentStartStage skips fn when budget exhausted (#1979)", async () => {
    const ref = { value: Date.now() };
    markBeforeAgentStartTurn(ref);
    vi.advanceTimersByTime(GATEWAY_BEFORE_AGENT_START_BUDGET_MS - 50);
    let ran = false;
    const out = await runOptionalBeforeAgentStartStage(ref, "test-stage", undefined, async () => {
      ran = true;
      return "ok";
    });
    expect(out).toBeUndefined();
    expect(ran).toBe(false);
  });

  it("protected goal/active-task stages still run when optional budget is exhausted", async () => {
    const ref = { value: Date.now() };
    markBeforeAgentStartTurn(ref);
    vi.advanceTimersByTime(GATEWAY_BEFORE_AGENT_START_BUDGET_MS - 300);
    expect(shouldSkipOptionalBeforeAgentStartStage(ref, "goal-context")).toBe(false);
    expect(shouldSkipOptionalBeforeAgentStartStage(ref, "active-task-injection")).toBe(false);
    expect(shouldSkipOptionalBeforeAgentStartStage(ref, "memory-nudge")).toBe(true);
  });

  it("runOptionalBeforeAgentStartStage times out long stages when timeoutMs is set", async () => {
    vi.useRealTimers();
    const ref = { value: Date.now() };
    markBeforeAgentStartTurn(ref);
    const out = await runOptionalBeforeAgentStartStage(
      ref,
      "slow-stage",
      undefined,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return "late";
      },
      { timeoutMs: 50 },
    );
    expect(out == null).toBe(true);
    vi.useFakeTimers();
  });
});
