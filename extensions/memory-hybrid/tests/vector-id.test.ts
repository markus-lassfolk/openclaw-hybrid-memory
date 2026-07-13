import { describe, expect, it } from "vitest";
import { isValidVectorId, normalizeVectorId, toSafeIdLiteral } from "../utils/vector-id.js";

describe("isValidVectorId", () => {
  it("accepts standard UUIDs, any case", () => {
    expect(isValidVectorId("f89f1594-cf90-4d0a-99a5-9d8994c91979")).toBe(true);
    expect(isValidVectorId("F89F1594-CF90-4D0A-99A5-9D8994C91979")).toBe(true);
  });

  it("accepts slug-style ids with letters, digits, dot, underscore, hyphen", () => {
    expect(isValidVectorId("close-goals-2026-06-27-clean-slate-final-1782588700")).toBe(true);
    expect(isValidVectorId("close_active.tasks-2026")).toBe(true);
    expect(isValidVectorId("a")).toBe(true);
  });

  it("rejects empty and whitespace-only ids", () => {
    expect(isValidVectorId("")).toBe(false);
    expect(isValidVectorId("   ")).toBe(false);
  });

  it("rejects ids containing quotes or SQL-injection-shaped payloads", () => {
    expect(isValidVectorId("x'; DROP TABLE facts; --")).toBe(false);
    expect(isValidVectorId("id' OR '1'='1")).toBe(false);
    expect(isValidVectorId("a b")).toBe(false);
    expect(isValidVectorId("a/b")).toBe(false);
  });

  it("rejects ids longer than 256 characters", () => {
    expect(isValidVectorId("a".repeat(256))).toBe(true);
    expect(isValidVectorId("a".repeat(257))).toBe(false);
  });
});

describe("normalizeVectorId", () => {
  it("lowercases UUID-shaped ids for canonical matching", () => {
    expect(normalizeVectorId("F89F1594-CF90-4D0A-99A5-9D8994C91979")).toBe("f89f1594-cf90-4d0a-99a5-9d8994c91979");
  });

  it("preserves slug case exactly (no lowercasing of non-UUID ids)", () => {
    expect(normalizeVectorId("Close-Goals-2026-06-27")).toBe("Close-Goals-2026-06-27");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeVectorId("  slug-id  ")).toBe("slug-id");
  });
});

describe("toSafeIdLiteral", () => {
  it("wraps a valid slug id in single quotes", () => {
    expect(toSafeIdLiteral("close-goals-2026")).toBe("'close-goals-2026'");
  });

  it("escapes embedded single quotes defensively even though the charset already excludes them", () => {
    // isValidVectorId rejects quotes outright, so this exercises the throw path, not escaping.
    expect(() => toSafeIdLiteral("has'quote")).toThrow(/Invalid LanceDB row id/);
  });

  it("throws for empty ids", () => {
    expect(() => toSafeIdLiteral("")).toThrow(/Invalid LanceDB row id/);
  });

  it("throws for ids with disallowed characters", () => {
    expect(() => toSafeIdLiteral("a b")).toThrow(/Invalid LanceDB row id/);
  });
});
