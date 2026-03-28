import { describe, expect, it } from "vitest";
import { truncateForStorage } from "../utils/text.js";

describe("truncateForStorage", () => {
  it("returns empty string for null", () => {
    expect(truncateForStorage(null, 100)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(truncateForStorage(undefined, 100)).toBe("");
  });

  it("returns trimmed text under maxChars", () => {
    expect(truncateForStorage("  hello world  ", 100)).toBe("hello world");
  });

  it("truncates text over maxChars with suffix", () => {
    const result = truncateForStorage("a".repeat(200), 50);
    expect(result).toContain("[truncated]");
    expect(result.length).toBeLessThan(200);
  });

  it("handles empty string", () => {
    expect(truncateForStorage("", 100)).toBe("");
  });

  it("handles maxChars of zero", () => {
    expect(truncateForStorage("hello world", 0)).toBe("");
  });
});
