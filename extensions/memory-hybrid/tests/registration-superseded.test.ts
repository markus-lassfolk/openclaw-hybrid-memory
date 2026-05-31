import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHybridMemoryRegistrationState,
  resetHybridMemoryRegistrationStateForTests,
} from "../setup/hybrid-memory-generation-state.js";
import {
  isDbClosedError,
  isRecallContextSuperseded,
  isRegistrationSuperseded,
  shouldSuppressStaleLifecycleError,
  suppressStaleLifecycleDbError,
} from "../utils/registration-superseded.js";

describe("registration-superseded", () => {
  afterEach(() => {
    resetHybridMemoryRegistrationStateForTests();
  });

  it("isDbClosedError matches plugin SQLite message", () => {
    expect(isDbClosedError(new Error("The database connection is not open"))).toBe(true);
    expect(isDbClosedError("connection is not open")).toBe(true);
    expect(isDbClosedError(new Error("ENOENT"))).toBe(false);
  });

  it("isRegistrationSuperseded is false when generation matches", () => {
    const state = getHybridMemoryRegistrationState();
    state.registrationGenerationRef.value = 3;
    expect(isRegistrationSuperseded(3)).toBe(false);
  });

  it("isRegistrationSuperseded is true after generation bump", () => {
    const state = getHybridMemoryRegistrationState();
    state.registrationGenerationRef.value = 4;
    expect(isRegistrationSuperseded(3)).toBe(true);
  });

  it("isRecallContextSuperseded uses owner and live ref", () => {
    const ref = getHybridMemoryRegistrationState().registrationGenerationRef;
    ref.value = 2;
    expect(
      isRecallContextSuperseded({
        registrationGeneration: 1,
        currentRegistrationGenerationRef: ref,
      }),
    ).toBe(true);
    expect(
      isRecallContextSuperseded({
        registrationGeneration: 2,
        currentRegistrationGenerationRef: ref,
      }),
    ).toBe(false);
  });

  it("shouldSuppressStaleLifecycleError requires both superseded and db closed", () => {
    const ref = getHybridMemoryRegistrationState().registrationGenerationRef;
    ref.value = 5;
    const ctx = { registrationGeneration: 4, currentRegistrationGenerationRef: ref };
    expect(shouldSuppressStaleLifecycleError(ctx, new Error("The database connection is not open"))).toBe(true);
    expect(shouldSuppressStaleLifecycleError(ctx, new Error("timeout"))).toBe(false);
    ref.value = 4;
    expect(shouldSuppressStaleLifecycleError(ctx, new Error("The database connection is not open"))).toBe(false);
  });

  it("suppressStaleLifecycleDbError logs debug once", () => {
    const ref = getHybridMemoryRegistrationState().registrationGenerationRef;
    ref.value = 10;
    const debug = vi.fn();
    const ctx = { registrationGeneration: 9, currentRegistrationGenerationRef: ref };
    const err = new Error("The database connection is not open");
    expect(suppressStaleLifecycleDbError(ctx, err, { debug }, "skipped")).toBe(true);
    expect(debug).toHaveBeenCalledWith("skipped");
    expect(suppressStaleLifecycleDbError(ctx, new Error("other"), { debug }, "skipped")).toBe(false);
  });
});
