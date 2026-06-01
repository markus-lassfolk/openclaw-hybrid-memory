import { describe, expect, it } from "vitest";

import { capDelayMsByDeadline, computeAdaptivePressureDelayMs } from "../services/adaptive-catch-up-pacing.js";

describe("computeAdaptivePressureDelayMs", () => {
  const maxAdaptiveDelayMs = 5_000;
  const backoffMinDelayMs = 50;

  it("caps backoff without Retry-After at adaptive max delay", () => {
    expect(
      computeAdaptivePressureDelayMs({
        currentDelayMs: 4_000,
        maxAdaptiveDelayMs,
        backoffMinDelayMs,
      }),
    ).toBe(5_000);
  });

  it("honors Retry-After above adaptive max as a hard floor", () => {
    expect(
      computeAdaptivePressureDelayMs({
        currentDelayMs: 150,
        batchRetryAfterMs: 17_000,
        maxAdaptiveDelayMs,
        backoffMinDelayMs,
      }),
    ).toBe(25_500);
  });

  it("preserves sub-cap Retry-After with scaled backoff", () => {
    expect(
      computeAdaptivePressureDelayMs({
        currentDelayMs: 0,
        batchRetryAfterMs: 2_000,
        maxAdaptiveDelayMs,
        backoffMinDelayMs,
      }),
    ).toBe(3_000);
  });
});

describe("capDelayMsByDeadline", () => {
  it("returns zero when the deadline has already passed", () => {
    expect(capDelayMsByDeadline(5_000, 1_000, 1_500)).toBe(0);
  });

  it("caps delay to remaining budget milliseconds", () => {
    expect(capDelayMsByDeadline(5_000, 4_000, 1_000)).toBe(3_000);
  });

  it("leaves delay unchanged when budget has more time remaining", () => {
    expect(capDelayMsByDeadline(150, 10_000, 1_000)).toBe(150);
  });
});
