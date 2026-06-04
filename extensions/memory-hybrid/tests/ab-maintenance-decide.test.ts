import { describe, expect, it } from "vitest";
import {
  buildDecisionReport,
  compareCells,
  qualityRichness,
  scoreCell,
} from "../benchmark/ab-maintenance/decide.js";
import type { AbRunResult } from "../benchmark/ab-maintenance/types.js";

describe("quality-first decide scoring", () => {
  it("prefers more reflection patterns over lower latency", () => {
    const m3Adaptive = {
      task: "reflection" as const,
      model: "MiniMax-M3" as const,
      thinking: "adaptive" as const,
      ok: true,
      latencyMs: 57_265,
      operational: { patternCount: 17, finishReason: "stop" },
    };
    const m27Disabled = {
      task: "reflection" as const,
      model: "MiniMax-M2.7-highspeed" as const,
      thinking: "disabled" as const,
      ok: true,
      latencyMs: 17_457,
      operational: { patternCount: 7, finishReason: "stop" },
    };
    expect(qualityRichness(m3Adaptive)).toBeGreaterThan(qualityRichness(m27Disabled));
    expect(compareCells(m3Adaptive, m27Disabled)).toBeLessThan(0);
    expect(scoreCell(m3Adaptive)).toBeGreaterThan(scoreCell(m27Disabled));
  });

  it("penalizes consolidation truncation heavily", () => {
    const m3 = {
      task: "consolidation" as const,
      model: "MiniMax-M3" as const,
      thinking: "disabled" as const,
      ok: true,
      latencyMs: 3532,
      operational: { mergedChars: 251, finishReason: "stop" },
    };
    const m27Truncated = {
      task: "consolidation" as const,
      model: "MiniMax-M2.7-highspeed" as const,
      thinking: "disabled" as const,
      ok: false,
      latencyMs: 5632,
      operational: { mergedChars: 1355, finishReason: "length" },
    };
    expect(scoreCell(m3)).toBeGreaterThan(scoreCell(m27Truncated));
  });

  it("picks M3 adaptive for reflection on run 2026-06-04T10-42-51 metrics", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const metricsPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../.ab-fixtures/out/2026-06-04T10-42-51/metrics.json",
    );
    const result = JSON.parse(readFileSync(metricsPath, "utf-8")) as AbRunResult;
    const { recommendations } = buildDecisionReport(result);
    const reflection = recommendations.find((r) => r.task === "reflection");
    expect(reflection?.model).toBe("MiniMax-M3");
    expect(["adaptive", "enabled"]).toContain(reflection?.thinking);
  });
});
