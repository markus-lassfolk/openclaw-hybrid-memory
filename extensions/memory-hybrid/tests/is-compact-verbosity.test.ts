/**
 * Tests for isCompactVerbosity helper function (Issue #317 bugfix)
 */

import { describe, expect, it } from "vitest";
import type { VerbosityLevel } from "../config/types/index.js";
import { isCompactVerbosity } from "../config/utils.js";

describe("isCompactVerbosity helper", () => {
	it("returns false for undefined", () => {
		expect(isCompactVerbosity(undefined)).toBe(false);
	});

	it("returns false for 'normal'", () => {
		expect(isCompactVerbosity("normal" as VerbosityLevel)).toBe(false);
	});

	it("returns false for 'verbose'", () => {
		expect(isCompactVerbosity("verbose" as VerbosityLevel)).toBe(false);
	});

	it("returns true for 'quiet'", () => {
		expect(isCompactVerbosity("quiet" as VerbosityLevel)).toBe(true);
	});

	it("returns true for 'silent'", () => {
		expect(isCompactVerbosity("silent" as VerbosityLevel)).toBe(true);
	});
});
