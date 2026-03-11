import { describe, it, expect, vi } from "vitest";
import {
  MIN_OPENCLAW_VERSION,
  parseVersion,
  isVersionAtLeast,
  checkOpenClawVersion,
} from "../utils/version-check.js";

describe("MIN_OPENCLAW_VERSION", () => {
  it("is 2026.3.8", () => {
    expect(MIN_OPENCLAW_VERSION).toBe("2026.3.8");
  });
});

describe("parseVersion", () => {
  it("parses a valid version string", () => {
    expect(parseVersion("2026.3.8")).toEqual([2026, 3, 8]);
    expect(parseVersion("2026.3.100")).toEqual([2026, 3, 100]);
    expect(parseVersion("2026.3.0")).toEqual([2026, 3, 0]);
    expect(parseVersion("1.0.0")).toEqual([1, 0, 0]);
  });

  it("returns null for invalid version strings", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("2026.3")).toBeNull();
    expect(parseVersion("2026.3.8.1")).toBeNull();
    expect(parseVersion("not.a.version")).toBeNull();
    expect(parseVersion("2026.-1.8")).toBeNull();
    expect(parseVersion("2026.3.abc")).toBeNull();
  });
});

describe("isVersionAtLeast", () => {
  it("returns true when current equals minimum", () => {
    expect(isVersionAtLeast("2026.3.8", "2026.3.8")).toBe(true);
  });

  it("returns true when current is greater (patch)", () => {
    expect(isVersionAtLeast("2026.3.9", "2026.3.8")).toBe(true);
    expect(isVersionAtLeast("2026.3.100", "2026.3.8")).toBe(true);
  });

  it("returns true when current is greater (minor)", () => {
    expect(isVersionAtLeast("2026.4.0", "2026.3.8")).toBe(true);
    expect(isVersionAtLeast("2026.10.0", "2026.3.8")).toBe(true);
  });

  it("returns true when current is greater (major/year)", () => {
    expect(isVersionAtLeast("2027.1.0", "2026.3.8")).toBe(true);
  });

  it("returns false when current is less (patch)", () => {
    expect(isVersionAtLeast("2026.3.7", "2026.3.8")).toBe(false);
    expect(isVersionAtLeast("2026.3.0", "2026.3.8")).toBe(false);
  });

  it("returns false when current is less (minor)", () => {
    expect(isVersionAtLeast("2026.2.99", "2026.3.8")).toBe(false);
    expect(isVersionAtLeast("2026.3.2", "2026.3.8")).toBe(false);
  });

  it("returns false when current is less (major/year)", () => {
    expect(isVersionAtLeast("2025.99.99", "2026.3.8")).toBe(false);
  });

  it("returns true if either version is unparseable (safe fallback)", () => {
    expect(isVersionAtLeast("not-a-version", "2026.3.8")).toBe(true);
    expect(isVersionAtLeast("2026.3.8", "not-a-version")).toBe(true);
  });
});

describe("checkOpenClawVersion", () => {
  it("does nothing when version is undefined", () => {
    const logger = { warn: vi.fn() };
    checkOpenClawVersion(undefined, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does nothing when version meets the minimum", () => {
    const logger = { warn: vi.fn() };
    checkOpenClawVersion("2026.3.8", logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does nothing when version exceeds the minimum", () => {
    const logger = { warn: vi.fn() };
    checkOpenClawVersion("2026.3.100", logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when version is below the minimum", () => {
    const logger = { warn: vi.fn() };
    checkOpenClawVersion("2026.3.2", logger);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw v2026.3.2 detected"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("minimum recommended is v2026.3.8"),
    );
  });

  it("warning message includes guidance about affected features", () => {
    const logger = { warn: vi.fn() };
    checkOpenClawVersion("2026.3.2", logger);
    const msg = logger.warn.mock.calls[0][0] as string;
    expect(msg).toContain("CLI subcommands");
    expect(msg).toContain("SIGUSR1 reload");
  });

  it("does not throw when version is unparseable", () => {
    const logger = { warn: vi.fn() };
    expect(() => checkOpenClawVersion("unknown", logger)).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
