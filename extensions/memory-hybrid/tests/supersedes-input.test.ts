/**
 * Regression tests for #2139: memory_store `supersedes` accepted only a string, so passing an
 * array of fact ids (the natural shape when correcting several stale facts) threw
 * `supersedes?.trim is not a function`. normalizeSupersedesInput now accepts a string, an array of
 * id strings, or nothing, and returns a structured error for any other shape.
 */
import { describe, expect, it } from "vitest";
import { normalizeSupersedesInput } from "../services/supersedes-input.js";

describe("normalizeSupersedesInput (#2139)", () => {
  it("returns an empty id list for null/undefined/empty", () => {
    expect(normalizeSupersedesInput(undefined)).toEqual({ ok: true, ids: [] });
    expect(normalizeSupersedesInput(null)).toEqual({ ok: true, ids: [] });
    expect(normalizeSupersedesInput("")).toEqual({ ok: true, ids: [] });
    expect(normalizeSupersedesInput("   ")).toEqual({ ok: true, ids: [] });
  });

  it("wraps a single trimmed id string into a one-element list", () => {
    expect(normalizeSupersedesInput("  047efc02-b019-4236-8843-5cf4724e3db0 ")).toEqual({
      ok: true,
      ids: ["047efc02-b019-4236-8843-5cf4724e3db0"],
    });
  });

  it("accepts an array of fact ids (the exact shape from the issue)", () => {
    const result = normalizeSupersedesInput([
      "047efc02-b019-4236-8843-5cf4724e3db0",
      "65da78dc-a4be-43c8-b236-f99df8b8db78",
    ]);
    expect(result).toEqual({
      ok: true,
      ids: ["047efc02-b019-4236-8843-5cf4724e3db0", "65da78dc-a4be-43c8-b236-f99df8b8db78"],
    });
  });

  it("trims, drops blank entries, and de-duplicates array ids", () => {
    const result = normalizeSupersedesInput([" a ", "a", "", "b", "  ", "b"]);
    expect(result).toEqual({ ok: true, ids: ["a", "b"] });
  });

  it("returns a structured error (not a thrown exception) for a non-string array element", () => {
    const result = normalizeSupersedesInput(["a", 42]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("number");
  });

  it("returns a structured error for a non-string, non-array value", () => {
    const objResult = normalizeSupersedesInput({ id: "x" });
    expect(objResult.ok).toBe(false);
    if (!objResult.ok) expect(objResult.error).toContain("object");

    const numResult = normalizeSupersedesInput(5);
    expect(numResult.ok).toBe(false);
    if (!numResult.ok) expect(numResult.error).toContain("number");
  });

  it("never throws on the input shapes that previously hit supersedes.trim()", () => {
    for (const bad of [["a", null], ["a", ["nested"]], true, 0, {}]) {
      expect(() => normalizeSupersedesInput(bad)).not.toThrow();
    }
  });
});
