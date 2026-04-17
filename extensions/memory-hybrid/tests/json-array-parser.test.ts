/**
 * Tests for the shared JSON array extraction utility.
 *
 * Coverage:
 *   extractJsonArray:
 *     - simple array: ["a", "b"] → ["a", "b"]
 *     - code-fenced: ```json\n["a"]\n``` → ["a"]
 *     - prose-wrapped: "Here are the results: ["a", "b"] hope that helps" → ["a", "b"]
 *     - literal brackets in strings: ["query about [topic]", "another"] → works
 *     - no array found → []
 *     - mixed types: ["a", 123, null] → ["a", 123, null]
 *     - empty response → []
 */

import { describe, expect, it } from "vitest";
import { extractJsonArray } from "../services/json-array-parser.js";

describe("extractJsonArray", () => {
	it("parses a simple array", () => {
		expect(extractJsonArray('["a", "b"]')).toEqual(["a", "b"]);
	});

	it("handles code-fenced JSON", () => {
		expect(extractJsonArray('```json\n["a"]\n```')).toEqual(["a"]);
	});

	it("handles prose-wrapped array", () => {
		expect(
			extractJsonArray('Here are the results: ["a", "b"] hope that helps'),
		).toEqual(["a", "b"]);
	});

	it("handles literal brackets inside string values", () => {
		expect(extractJsonArray('["query about [topic]", "another"]')).toEqual([
			"query about [topic]",
			"another",
		]);
	});

	it("returns empty array when no array is present", () => {
		expect(extractJsonArray("no array here")).toEqual([]);
	});

	it("returns mixed-type array as-is", () => {
		expect(extractJsonArray('["a", 123, null]')).toEqual(["a", 123, null]);
	});

	it("returns empty array for empty response", () => {
		expect(extractJsonArray("")).toEqual([]);
	});

	it("returns empty array for an empty JSON array", () => {
		expect(extractJsonArray("[]")).toEqual([]);
	});

	it("ignores invalid JSON before a valid array", () => {
		expect(extractJsonArray('[broken, ["a", "b"]')).toEqual(["a", "b"]);
	});

	it("returns the first valid array when multiple exist", () => {
		expect(extractJsonArray('["first"] some text ["second"]')).toEqual([
			"first",
		]);
	});
});
