/**
 * Regression test for plugin-service startup guard: when a service instance has
 * already been superseded by a newer registration (rapid hot-reload), startup must
 * short-circuit before touching donor DB handles that may be closing.
 */

import { describe, expect, it } from "vitest";
import {
  getHybridMemoryRegistrationState,
  resetHybridMemoryRegistrationStateForTests,
} from "../setup/hybrid-memory-generation-state.js";
import { shouldSkipPluginServiceStartForSupersededGeneration } from "../setup/plugin-service.js";

describe("plugin-service supersession guard", () => {
  it("skips startup when boot generation is older than current registration generation", () => {
    resetHybridMemoryRegistrationStateForTests();
    getHybridMemoryRegistrationState().registrationGenerationRef.value = 2;
    expect(shouldSkipPluginServiceStartForSupersededGeneration(1)).toBe(true);
  });

  it("does not skip startup when boot generation matches current registration generation", () => {
    resetHybridMemoryRegistrationStateForTests();
    getHybridMemoryRegistrationState().registrationGenerationRef.value = 5;
    expect(shouldSkipPluginServiceStartForSupersededGeneration(5)).toBe(false);
  });

  it("does not skip startup when no boot generation was captured", () => {
    resetHybridMemoryRegistrationStateForTests();
    getHybridMemoryRegistrationState().registrationGenerationRef.value = 5;
    expect(shouldSkipPluginServiceStartForSupersededGeneration(undefined)).toBe(false);
  });
});
