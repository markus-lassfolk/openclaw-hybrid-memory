import { describe, expect, it } from "vitest";

import { stableStringify } from "../utils/stable-stringify.js";

describe("stableStringify", () => {
  it("does not rely on localeCompare for key ordering", () => {
    const originalLocaleCompare = String.prototype.localeCompare;
    const localeCompareSpy = function (): number {
      throw new Error("localeCompare should not be used");
    };

    String.prototype.localeCompare = localeCompareSpy;
    try {
      expect(stableStringify({ ä: 1, z: 2, a: { b: true, A: true } })).toBe('{"a":{"A":true,"b":true},"z":2,"ä":1}');
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });
});
