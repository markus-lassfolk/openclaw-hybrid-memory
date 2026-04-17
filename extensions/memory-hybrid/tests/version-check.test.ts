import { describe, expect, it, vi } from "vitest";
import {
	MIN_OPENCLAW_VERSION,
	checkOpenClawVersion,
	isVersionAtLeast,
	parseVersion,
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

	it("parses version strings with a leading v", () => {
		expect(parseVersion("v2026.3.8")).toEqual([2026, 3, 8]);
		expect(parseVersion("v1.0.0")).toEqual([1, 0, 0]);
	});

	it("parses version strings with pre-release suffixes", () => {
		expect(parseVersion("2026.3.8-beta")).toEqual([2026, 3, 8]);
		expect(parseVersion("2026.3.8-rc1")).toEqual([2026, 3, 8]);
		expect(parseVersion("2026.3.8-beta.1")).toEqual([2026, 3, 8]);
		expect(parseVersion("v2026.3.8-beta")).toEqual([2026, 3, 8]);
	});

	it("returns null for invalid version strings", () => {
		expect(parseVersion("")).toBeNull();
		expect(parseVersion("2026.3")).toBeNull();
		expect(parseVersion("not.a.version")).toBeNull();
		expect(parseVersion("2026.-1.8")).toBeNull();
		expect(parseVersion("2026.3.abc")).toBeNull();
	});

	it("returns null for empty segments (e.g. 2026..8)", () => {
		expect(parseVersion("2026..8")).toBeNull();
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

	it("correctly handles pre-release versions", () => {
		// 2026.3.8-beta parses as 2026.3.8 — equal to minimum, so passes
		expect(isVersionAtLeast("2026.3.8-beta", "2026.3.8")).toBe(true);
		// 2026.3.7-rc1 parses as 2026.3.7 — below minimum
		expect(isVersionAtLeast("2026.3.7-rc1", "2026.3.8")).toBe(false);
	});
});

describe("checkOpenClawVersion", () => {
	it("logs a warning when version is undefined (gateway too old to expose api.version)", () => {
		const logger = { warn: vi.fn() };
		checkOpenClawVersion(undefined, logger);
		expect(logger.warn).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining(MIN_OPENCLAW_VERSION),
		);
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

	it("does not throw when version is unparseable (safe fallback, no warning)", () => {
		const logger = { warn: vi.fn() };
		expect(() => checkOpenClawVersion("unknown", logger)).not.toThrow();
		// unparseable versions fall through silently (isVersionAtLeast returns true)
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("handles pre-release versions correctly", () => {
		const logger = { warn: vi.fn() };
		// 2026.3.7-rc1 is below minimum — should warn
		checkOpenClawVersion("2026.3.7-rc1", logger);
		expect(logger.warn).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("2026.3.7-rc1"),
		);
	});

	it("accepts versions with leading v prefix", () => {
		const logger = { warn: vi.fn() };
		checkOpenClawVersion("v2026.3.8", logger);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
