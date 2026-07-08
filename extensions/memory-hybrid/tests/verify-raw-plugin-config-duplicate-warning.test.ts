// @ts-nocheck — VerifyRunState is a large interface; only the fields ensureRawPluginConfigOnState
// actually reads are provided, matching the pattern used elsewhere in this test suite for
// partial-mock CLI state objects.
/**
 * Regression test (loop iteration 72): ensureRawPluginConfigOnState()'s memoization guard checked
 * `state.rawPluginConfig !== undefined` — but on a parse failure, `rawPluginConfig` is set to
 * `undefined` (the same value it starts as), so the guard never actually remembered "already
 * attempted and failed". Every call site (llm-models.ts and embeddings.ts both call this during
 * the same `verify` run) would re-read the config file and re-push the same warning to
 * `state.warnings`, producing duplicate entries in the summary for a single real problem.
 */

import { describe, expect, it } from "vitest";
import { ensureRawPluginConfigOnState } from "../cli/verify/plugin-config-credentials.js";

describe("ensureRawPluginConfigOnState (loop iteration 72 regression)", () => {
  it("does not push a duplicate warning when called more than once after a parse failure", () => {
    const state = {
      defaultConfigPath: "/nonexistent/path/that/does/not/exist/openclaw.json",
      openclawConfigRead: { exists: true, error: undefined },
      warnings: [] as string[],
    };

    ensureRawPluginConfigOnState(state);
    ensureRawPluginConfigOnState(state);
    ensureRawPluginConfigOnState(state);

    const matching = state.warnings.filter((w) => w.includes("could not be interpreted for plugin settings"));
    expect(matching.length).toBe(1);
  });

  it("still resolves rawPluginConfig normally on success (single call, no warning)", () => {
    // A missing file always errors, so this asserts the SUCCESS path just doesn't warn when
    // openclawConfigRead itself reports the config as absent/broken (short-circuits the warning).
    const state = {
      defaultConfigPath: "/nonexistent/path/that/does/not/exist/openclaw.json",
      openclawConfigRead: { exists: false, error: undefined },
      warnings: [] as string[],
    };

    ensureRawPluginConfigOnState(state);
    ensureRawPluginConfigOnState(state);

    expect(state.warnings.length).toBe(0);
    expect(state.rawPluginConfigAttempted).toBe(true);
  });
});
