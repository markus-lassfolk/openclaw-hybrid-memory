/**
 * Tests for the duration string parser utility.
 *
 * parseDuration(input) → minutes
 * formatDuration(minutes) → string
 */

import { describe, it, expect } from "vitest";
import { parseDuration, formatDuration } from "../utils/duration.js";

// ---------------------------------------------------------------------------
// parseDuration — valid inputs
// ---------------------------------------------------------------------------

describe("parseDuration — valid inputs", () => {
  it("parses plain integer as minutes", () => {
    expect(parseDuration("30")).toBe(30);
    expect(parseDuration("1440")).toBe(1440);
    expect(parseDuration("1")).toBe(1);
  });

  it("parses minutes only: '30m' → 30", () => {
    expect(parseDuration("30m")).toBe(30);
  });

  it("parses minutes only: '1m' → 1", () => {
    expect(parseDuration("1m")).toBe(1);
  });

  it("parses hours only: '2h' → 120", () => {
    expect(parseDuration("2h")).toBe(120);
  });

  it("parses hours only: '1h' → 60", () => {
    expect(parseDuration("1h")).toBe(60);
  });

  it("parses days only: '1d' → 1440", () => {
    expect(parseDuration("1d")).toBe(1440);
  });

  it("parses days only: '3d' → 4320", () => {
    expect(parseDuration("3d")).toBe(4320);
  });

  it("parses days + hours: '1d12h' → 2160", () => {
    expect(parseDuration("1d12h")).toBe(2160);
  });

  it("parses days + hours + minutes: '1d12h30m' → 2190", () => {
    expect(parseDuration("1d12h30m")).toBe(2190);
  });

  it("parses hours + minutes: '2h30m' → 150", () => {
    expect(parseDuration("2h30m")).toBe(150);
  });

  it("parses days + minutes (no hours): '1d30m' → 1470", () => {
    expect(parseDuration("1d30m")).toBe(1470);
  });

  it("is case-insensitive (uppercase D/H/M)", () => {
    expect(parseDuration("2H")).toBe(120);
    expect(parseDuration("1D")).toBe(1440);
    expect(parseDuration("30M")).toBe(30);
    expect(parseDuration("1D12H30M")).toBe(2190);
  });

  it("trims leading/trailing whitespace", () => {
    expect(parseDuration("  24h  ")).toBe(1440);
    expect(parseDuration("\t30m\n")).toBe(30);
  });

  it("parses large values correctly", () => {
    // 7 days = 10080 minutes
    expect(parseDuration("7d")).toBe(10080);
    // 100h = 6000 minutes
    expect(parseDuration("100h")).toBe(6000);
  });

  it("parses '45m' → 45", () => {
    expect(parseDuration("45m")).toBe(45);
  });

  it("parses '1d6h' → 1800", () => {
    expect(parseDuration("1d6h")).toBe(1800);
  });
});

// ---------------------------------------------------------------------------
// parseDuration — invalid / edge-case inputs
// ---------------------------------------------------------------------------

describe("parseDuration — invalid inputs", () => {
  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow(/empty input/);
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseDuration("   ")).toThrow(/empty input/);
  });

  it("throws on zero as plain integer", () => {
    expect(() => parseDuration("0")).toThrow(/must be > 0/);
  });

  it("throws on '0m'", () => {
    expect(() => parseDuration("0m")).toThrow(/must be > 0/);
  });

  it("throws on '0h0m'", () => {
    expect(() => parseDuration("0h0m")).toThrow(/must be > 0/);
  });

  it("throws on negative plain integer", () => {
    // Leading minus makes it fail the plain-integer check; also fails the regex
    expect(() => parseDuration("-5")).toThrow();
  });

  it("throws on unrecognised format: 'five'", () => {
    expect(() => parseDuration("five")).toThrow(/unrecognised duration/i);
  });

  it("throws on wrong unit order 'm1d': m before d is invalid", () => {
    // Our regex requires d → h → m order; reverse order should throw
    expect(() => parseDuration("30m1d")).toThrow(/unrecognised duration/i);
  });

  it("throws on wrong unit order 'h2d'", () => {
    expect(() => parseDuration("2h1d")).toThrow(/unrecognised duration/i);
  });

  it("throws on decimal values '1.5h'", () => {
    expect(() => parseDuration("1.5h")).toThrow();
  });

  it("throws on mixed number+unit without proper pattern '5 h'", () => {
    // Space between number and unit is not allowed
    expect(() => parseDuration("5 h")).toThrow();
  });

  it("throws on stray characters '2h!'", () => {
    expect(() => parseDuration("2h!")).toThrow();
  });

  it("throws on duplicate units '2h3h'", () => {
    // Regex won't match a second h after the first group consumed \d+h
    expect(() => parseDuration("2h3h")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatDuration — round-trip and display
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats 30 minutes as '30m'", () => {
    expect(formatDuration(30)).toBe("30m");
  });

  it("formats 60 minutes as '1h'", () => {
    expect(formatDuration(60)).toBe("1h");
  });

  it("formats 90 minutes as '1h30m'", () => {
    expect(formatDuration(90)).toBe("1h30m");
  });

  it("formats 1440 minutes as '1d'", () => {
    expect(formatDuration(1440)).toBe("1d");
  });

  it("formats 2880 minutes as '2d'", () => {
    expect(formatDuration(2880)).toBe("2d");
  });

  it("formats 2190 minutes as '1d12h30m'", () => {
    expect(formatDuration(2190)).toBe("1d12h30m");
  });

  it("formats 2160 minutes as '1d12h'", () => {
    expect(formatDuration(2160)).toBe("1d12h");
  });

  it("formats 1470 minutes as '1d30m'", () => {
    expect(formatDuration(1470)).toBe("1d30m");
  });

  it("formats 0 as '0m'", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("round-trips: parseDuration → formatDuration", () => {
    const cases = ["30m", "2h", "1d", "1d12h", "1d12h30m", "45m", "1h30m", "3d"];
    for (const input of cases) {
      const minutes = parseDuration(input);
      const formatted = formatDuration(minutes);
      expect(formatted).toBe(input);
    }
  });
});
