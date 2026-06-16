/**
 * Timezone-safe quiet-window tests (Issue #1904 risk mitigation).
 */
import { describe, expect, it } from "vitest";
import { isInQuietWindowAt, quietWindowEndEpochSecAt } from "../services/quiet-window.js";

const QW = {
  enabled: true,
  start: "01:00",
  end: "06:00",
  tz: "UTC",
};

describe("quiet-window UTC", () => {
  it("detects inside window", () => {
    const at = new Date("2026-06-16T03:30:00Z");
    expect(isInQuietWindowAt(QW, at)).toBe(true);
  });

  it("detects outside window", () => {
    const at = new Date("2026-06-16T10:00:00Z");
    expect(isInQuietWindowAt(QW, at)).toBe(false);
  });

  it("computes end at window boundary", () => {
    const at = new Date("2026-06-16T03:30:00Z");
    const end = quietWindowEndEpochSecAt(QW, at);
    expect(end).not.toBeNull();
    expect(new Date(end! * 1000).toISOString()).toBe("2026-06-16T06:00:00.000Z");
  });
});

describe("quiet-window wrap-around", () => {
  const wrap = { enabled: true, start: "22:00", end: "06:00", tz: "UTC" };

  it("inside after midnight", () => {
    expect(isInQuietWindowAt(wrap, new Date("2026-06-16T02:00:00Z"))).toBe(true);
  });

  it("inside before midnight", () => {
    expect(isInQuietWindowAt(wrap, new Date("2026-06-16T23:00:00Z"))).toBe(true);
  });

  it("outside midday", () => {
    expect(isInQuietWindowAt(wrap, new Date("2026-06-16T12:00:00Z"))).toBe(false);
  });
});

describe("quiet-window Europe/Stockholm", () => {
  const qw = { enabled: true, start: "01:00", end: "06:00", tz: "Europe/Stockholm" };

  it("respects configured IANA timezone", () => {
    // 2026-06-16 02:00 in Stockholm is 00:00 UTC (CEST = UTC+2)
    const at = new Date("2026-06-16T00:30:00Z");
    expect(isInQuietWindowAt(qw, at)).toBe(true);
  });
});
