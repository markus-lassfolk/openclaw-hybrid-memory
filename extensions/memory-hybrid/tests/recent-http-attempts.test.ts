import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatRecentHttpAttemptsForRateLimitLog,
  recordProviderHttpAttempt,
  resetRecentHttpAttemptsForTests,
} from "../services/recent-http-attempts.js";

describe("recent-http-attempts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRecentHttpAttemptsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports distinct 60s vs 180s counts without read-path pruning", () => {
    const t0 = new Date("2026-06-01T12:00:00.000Z").getTime();
    vi.setSystemTime(t0);
    recordProviderHttpAttempt({ operation: "chat", model: "m1" });
    vi.advanceTimersByTime(70_000);
    recordProviderHttpAttempt({ operation: "chat", model: "m1" });
    vi.advanceTimersByTime(70_000);
    recordProviderHttpAttempt({ operation: "embed", model: "m2" });
    const line = formatRecentHttpAttemptsForRateLimitLog();
    expect(line).toMatch(/last60s=1 attempt/);
    expect(line).toMatch(/last180s=3 attempt/);
  });

  it("second format call still sees full 180s slice after first call", () => {
    const t0 = new Date("2026-06-01T12:00:00.000Z").getTime();
    vi.setSystemTime(t0);
    recordProviderHttpAttempt({ operation: "a", model: "x" });
    vi.advanceTimersByTime(90_000);
    recordProviderHttpAttempt({ operation: "b", model: "x" });
    vi.advanceTimersByTime(30_000);
    expect(formatRecentHttpAttemptsForRateLimitLog()).toMatch(/last180s=2 attempt/);
    expect(formatRecentHttpAttemptsForRateLimitLog()).toMatch(/last180s=2 attempt/);
  });
});
