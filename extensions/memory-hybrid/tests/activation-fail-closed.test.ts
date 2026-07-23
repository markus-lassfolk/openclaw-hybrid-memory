/**
 * Fail-closed tool results when Phase B activation fails (#2181 residual).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  beginActivation,
  markActivationFailed,
  resetActivationStateForTests,
  shouldReturnInitializingToolResult,
  isActivationFailed,
} from "../setup/hybrid-memory-activation.js";
import {
  buildActivationFailedToolSafeResult,
  buildInitializingToolSafeResult,
} from "../setup/register-tools.js";

describe("activation fail-closed (#2181)", () => {
  beforeEach(() => {
    resetActivationStateForTests();
  });
  afterEach(() => {
    resetActivationStateForTests();
  });

  it("marks failed activation and never reports initializing", () => {
    beginActivation({ generation: 7, donorGeneration: 6 });
    expect(shouldReturnInitializingToolResult(7)).toBe(true);
    markActivationFailed(7, new Error("init-databases blew up"));
    expect(shouldReturnInitializingToolResult(7)).toBe(false);
    expect(isActivationFailed(7)).toBe(true);

    const failed = buildActivationFailedToolSafeResult("memory_recall", 7, "init-databases blew up");
    expect(failed.details.initializing).toBe(false);
    expect(failed.details.activationFailed).toBe(true);
    expect(failed.details.activationPhase).toBe("failed");
    expect(String(failed.content[0]?.text)).toContain("activation failed");

    const init = buildInitializingToolSafeResult("memory_recall", 7);
    expect(init.details.initializing).toBe(true);
  });
});
