import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GATEWAY_BEFORE_AGENT_START_BUDGET_MS,
  beforeAgentStartRemainingMs,
  markBeforeAgentStartTurn,
  resolveBeforeAgentStartStageTimeoutMs,
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
});
