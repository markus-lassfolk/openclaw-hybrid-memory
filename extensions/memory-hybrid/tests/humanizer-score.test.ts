/**
 * Tests for humanizer style scoring service (Issue #616).
 *
 * Covers:
 *   - parseHumanizerOutput: valid JSON, missing score, malformed JSON, patterns, category_breakdown
 *   - formatQualityLoopEntry: score formatting, pattern truncation, model/skill tags
 *   - runHumanizerScore: short text skip, length truncation, ENOENT graceful return
 *   - parseHumanizerConfig: defaults, custom values, opt-in behavior
 */

import { describe, it, expect } from "vitest";
import { parseHumanizerOutput, formatQualityLoopEntry, runHumanizerScore } from "../services/humanizer-score.js";
import { parseHumanizerConfig } from "../config/parsers/features.js";

// ---------------------------------------------------------------------------
// parseHumanizerOutput
// ---------------------------------------------------------------------------

describe("parseHumanizerOutput", () => {
  it("returns null for empty string", () => {
    expect(parseHumanizerOutput("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseHumanizerOutput("   \n  ")).toBeNull();
  });

  it("returns null for non-JSON input", () => {
    expect(parseHumanizerOutput("not json at all")).toBeNull();
  });

  it("returns null when score field is missing", () => {
    expect(parseHumanizerOutput(JSON.stringify({ patterns_triggered: [] }))).toBeNull();
  });

  it("returns null when score is not a number", () => {
    expect(parseHumanizerOutput(JSON.stringify({ score: "high" }))).toBeNull();
  });

  it("parses minimal valid output", () => {
    const result = parseHumanizerOutput(JSON.stringify({ score: 0.5 }));
    expect(result).not.toBeNull();
    expect(result!.score).toBe(0.5);
    expect(result!.patternsTriggered).toEqual([]);
    expect(result!.categoryBreakdown).toEqual({});
  });

  it("clamps score to [0, 1]", () => {
    expect(parseHumanizerOutput(JSON.stringify({ score: 1.5 }))!.score).toBe(1);
    expect(parseHumanizerOutput(JSON.stringify({ score: -0.3 }))!.score).toBe(0);
  });

  it("extracts patterns_triggered as strings", () => {
    const result = parseHumanizerOutput(
      JSON.stringify({ score: 0.7, patterns_triggered: ["great_question", "happy_to_help", 42, null] }),
    );
    expect(result!.patternsTriggered).toEqual(["great_question", "happy_to_help"]);
  });

  it("extracts category_breakdown as number map", () => {
    const result = parseHumanizerOutput(
      JSON.stringify({ score: 0.3, category_breakdown: { gush: 0.2, filler: 0.1, invalid: "x" } }),
    );
    expect(result!.categoryBreakdown).toEqual({ gush: 0.2, filler: 0.1 });
  });

  it("includes optional uniformity_score and pattern_score", () => {
    const result = parseHumanizerOutput(JSON.stringify({ score: 0.6, uniformity_score: 0.4, pattern_score: 0.7 }));
    expect(result!.rawOutput.uniformity_score).toBe(0.4);
    expect(result!.rawOutput.pattern_score).toBe(0.7);
  });

  it("handles trailing whitespace around JSON", () => {
    const result = parseHumanizerOutput(`  ${JSON.stringify({ score: 0.5 })}  `);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatQualityLoopEntry
// ---------------------------------------------------------------------------

describe("formatQualityLoopEntry", () => {
  function makeResult(score: number, patterns: string[] = []) {
    return {
      score,
      patternsTriggered: patterns,
      categoryBreakdown: {},
      rawOutput: { score },
    };
  }

  it("formats score with 2 decimal places", () => {
    const entry = formatQualityLoopEntry(makeResult(0.73));
    expect(entry).toContain("humanizer_score: 0.73");
  });

  it("includes patterns when present", () => {
    const entry = formatQualityLoopEntry(makeResult(0.5, ["great_question", "happy_to_help"]));
    expect(entry).toContain("patterns: ['great_question', 'happy_to_help']");
  });

  it("truncates patterns to first 5", () => {
    const patterns = ["a", "b", "c", "d", "e", "f", "g"];
    const entry = formatQualityLoopEntry(makeResult(0.5, patterns));
    // Should only show first 5
    expect(entry).toContain("'e'");
    expect(entry).not.toContain("'f'");
  });

  it("omits patterns line when none triggered", () => {
    const entry = formatQualityLoopEntry(makeResult(0.5, []));
    expect(entry).not.toContain("patterns:");
  });

  it("includes modelTag when provided", () => {
    const entry = formatQualityLoopEntry(makeResult(0.5), { modelTag: "sonnet" });
    expect(entry).toContain("model: sonnet");
  });

  it("includes skillTag when provided", () => {
    const entry = formatQualityLoopEntry(makeResult(0.5), { skillTag: "weather" });
    expect(entry).toContain("skill: weather");
  });

  it("produces compact single-line output", () => {
    const entry = formatQualityLoopEntry(makeResult(0.73, ["gush"]), { modelTag: "sonnet", skillTag: "weather" });
    expect(entry).toBe("humanizer_score: 0.73, patterns: ['gush'], model: sonnet, skill: weather");
  });
});

// ---------------------------------------------------------------------------
// runHumanizerScore
// ---------------------------------------------------------------------------

describe("runHumanizerScore", () => {
  const defaultCfg = { bin: "humanizer", minTextLength: 100, maxTextLength: 4000 };

  it("returns null for text shorter than minTextLength", async () => {
    const result = await runHumanizerScore("short", { ...defaultCfg, minTextLength: 100 });
    expect(result).toBeNull();
  });

  it("returns null for empty text", async () => {
    const result = await runHumanizerScore("", defaultCfg);
    expect(result).toBeNull();
  });

  it("returns null gracefully when humanizer binary is not installed (ENOENT)", async () => {
    // Uses a non-existent binary path to simulate ENOENT
    const result = await runHumanizerScore("A".repeat(200), {
      bin: "/nonexistent/path/to/humanizer-missing-binary",
      minTextLength: 10,
      maxTextLength: 4000,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseHumanizerConfig
// ---------------------------------------------------------------------------

describe("parseHumanizerConfig", () => {
  it("defaults to disabled with sensible defaults", () => {
    const cfg = parseHumanizerConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.bin).toBe("humanizer");
    expect(cfg.minTextLength).toBe(100);
    expect(cfg.maxTextLength).toBe(4000);
    expect(cfg.modelTag).toBeUndefined();
    expect(cfg.skillTag).toBeUndefined();
  });

  it("enables when explicitly set", () => {
    const cfg = parseHumanizerConfig({ humanizer: { enabled: true } });
    expect(cfg.enabled).toBe(true);
  });

  it("uses custom bin path", () => {
    const cfg = parseHumanizerConfig({ humanizer: { bin: "/usr/local/bin/humanizer" } });
    expect(cfg.bin).toBe("/usr/local/bin/humanizer");
  });

  it("clamps maxTextLength to 20000", () => {
    const cfg = parseHumanizerConfig({ humanizer: { maxTextLength: 999999 } });
    expect(cfg.maxTextLength).toBe(20000);
  });

  it("uses default bin when empty string given", () => {
    const cfg = parseHumanizerConfig({ humanizer: { bin: "   " } });
    expect(cfg.bin).toBe("humanizer");
  });

  it("parses modelTag and skillTag", () => {
    const cfg = parseHumanizerConfig({ humanizer: { modelTag: "sonnet", skillTag: "weather" } });
    expect(cfg.modelTag).toBe("sonnet");
    expect(cfg.skillTag).toBe("weather");
  });

  it("returns undefined for empty modelTag/skillTag", () => {
    const cfg = parseHumanizerConfig({ humanizer: { modelTag: "", skillTag: "  " } });
    expect(cfg.modelTag).toBeUndefined();
    expect(cfg.skillTag).toBeUndefined();
  });
});
