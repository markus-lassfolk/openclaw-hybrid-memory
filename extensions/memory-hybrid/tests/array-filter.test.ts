/**
 * Tests for the shared `toArrayFilter` coercion helper (issue #2185 / GlitchTip issue 20).
 */
import { describe, expect, it } from "vitest";
import { toArrayFilter } from "../utils/array-filter.js";

describe("toArrayFilter", () => {
  it("returns undefined for undefined", () => {
    expect(toArrayFilter(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(toArrayFilter(null)).toBeUndefined();
  });

  it("wraps a bare scalar into a single-element array", () => {
    expect(toArrayFilter("open")).toEqual(["open"]);
    expect(toArrayFilter(42)).toEqual([42]);
  });

  it("passes an actual array through unchanged", () => {
    const arr = ["open", "waiting"];
    expect(toArrayFilter(arr)).toBe(arr);
  });

  it("passes an empty array through unchanged", () => {
    expect(toArrayFilter([])).toEqual([]);
  });
});
