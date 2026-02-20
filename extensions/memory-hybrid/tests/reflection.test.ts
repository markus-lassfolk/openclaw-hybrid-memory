/**
 * Reflection layer — parsePatternsFromReflectionResponse and prompt loading.
 */

import { describe, it, expect } from "vitest";
import { _testing } from "../index.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";

const { parsePatternsFromReflectionResponse } = _testing;

describe("parsePatternsFromReflectionResponse", () => {
  it("extracts valid PATTERN: lines", () => {
    const raw = `
Some intro text.

PATTERN: User consistently favors functional composition over OOP
PATTERN: User prefers small, focused code units (functions <20 lines)
PATTERN: User values type safety (TypeScript strict mode)

Other content ignored.
`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toBe("User consistently favors functional composition over OOP");
    expect(parsed[1]).toBe("User prefers small, focused code units (functions <20 lines)");
    expect(parsed[2]).toBe("User values type safety (TypeScript strict mode)");
  });

  it("ignores lines that are too short (<20 chars)", () => {
    const raw = `PATTERN: Too short`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(0);
  });

  it("ignores lines that are too long (>500 chars)", () => {
    const long = "x".repeat(501);
    const raw = `PATTERN: ${long}`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(0);
  });

  it("accepts patterns at exact min/max bounds", () => {
    const minLen = "x".repeat(20);
    const maxLen = "x".repeat(500);
    const raw = `PATTERN: ${minLen}\nPATTERN: ${maxLen}`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(2);
  });

  it("deduplicates case-insensitive within batch", () => {
    const raw = `
PATTERN: User prefers composition over inheritance
PATTERN: user prefers composition over inheritance
PATTERN: User prefers composition over inheritance
`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("User prefers composition over inheritance");
  });

  it("handles leading whitespace before PATTERN:", () => {
    const raw = `  PATTERN: User prefers explicit error handling`;
    const parsed = parsePatternsFromReflectionResponse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe("User prefers explicit error handling");
  });

  it("returns empty for empty or non-matching input", () => {
    expect(parsePatternsFromReflectionResponse("")).toHaveLength(0);
    expect(parsePatternsFromReflectionResponse("No PATTERN: here")).toHaveLength(0);
    expect(parsePatternsFromReflectionResponse("RULE: This is a rule")).toHaveLength(0);
  });
});

describe("Reflection prompt template", () => {
  it("loads reflection prompt with window and facts placeholders", () => {
    const tmpl = loadPrompt("reflection");
    expect(tmpl).toContain("{{window}}");
    expect(tmpl).toContain("{{facts}}");
  });

  it("fillPrompt substitutes window and facts", () => {
    const tmpl = loadPrompt("reflection");
    const filled = fillPrompt(tmpl, { window: "14", facts: "[preference] User likes dark mode" });
    expect(filled).toContain("14");
    expect(filled).toContain("[preference] User likes dark mode");
  });
});
