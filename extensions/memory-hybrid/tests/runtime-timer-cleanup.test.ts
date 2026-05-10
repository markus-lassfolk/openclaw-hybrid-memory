import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeTimers, createTimers } from "../api/plugin-runtime.js";

describe("clearRuntimeTimers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears all interval/timeout refs and prevents queued callbacks from firing", async () => {
    const timers = createTimers();
    let fired = 0;

    timers.pruneTimer.value = setInterval(() => {
      fired += 1;
    }, 100);
    timers.classifyTimer.value = setInterval(() => {
      fired += 1;
    }, 100);
    timers.classifyStartupTimeout.value = setTimeout(() => {
      fired += 1;
    }, 100);
    timers.proposalsPruneTimer.value = setInterval(() => {
      fired += 1;
    }, 100);
    timers.languageKeywordsTimer.value = setInterval(() => {
      fired += 1;
    }, 100);
    timers.languageKeywordsStartupTimeout.value = setTimeout(() => {
      fired += 1;
    }, 100);
    timers.postUpgradeTimeout.value = setTimeout(() => {
      fired += 1;
    }, 100);
    timers.passiveObserverTimer.value = setInterval(() => {
      fired += 1;
    }, 100);
    timers.watchdogTimer.value = setInterval(() => {
      fired += 1;
    }, 100);

    clearRuntimeTimers(timers);
    await vi.advanceTimersByTimeAsync(160);

    expect(fired).toBe(0);
    expect(timers.pruneTimer.value).toBeNull();
    expect(timers.classifyTimer.value).toBeNull();
    expect(timers.classifyStartupTimeout.value).toBeNull();
    expect(timers.proposalsPruneTimer.value).toBeNull();
    expect(timers.languageKeywordsTimer.value).toBeNull();
    expect(timers.languageKeywordsStartupTimeout.value).toBeNull();
    expect(timers.postUpgradeTimeout.value).toBeNull();
    expect(timers.passiveObserverTimer.value).toBeNull();
    expect(timers.watchdogTimer.value).toBeNull();
  });

  it("is safe when all timer refs are already null", () => {
    const timers = createTimers();
    expect(() => clearRuntimeTimers(timers)).not.toThrow();
  });
});
