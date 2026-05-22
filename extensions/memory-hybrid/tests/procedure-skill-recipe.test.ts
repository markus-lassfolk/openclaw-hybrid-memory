import { describe, expect, it } from "vitest";
import { summarizeRecipeForSidecar } from "../services/procedure-skill-recipe.js";
import { maybeBundleReplayScript } from "../services/skill-script-bundler.js";

describe("procedure-skill-recipe", () => {
  it("caps 1000+ steps within byte budget", () => {
    const steps = Array.from({ length: 1200 }, (_, i) => ({
      tool: "read",
      summary: `step ${i}`,
    }));
    const summary = summarizeRecipeForSidecar(steps);
    expect(summary.withinCap).toBe(true);
    expect(summary.omittedSteps).toBeGreaterThan(0);
    expect(summary.byteLength).toBeLessThanOrEqual(64_000);
  });

  it("handles multibyte summaries", () => {
    const steps = [{ tool: "read", summary: "验证步骤 ".repeat(50) }];
    const summary = summarizeRecipeForSidecar(steps);
    expect(summary.withinCap).toBe(true);
    expect(Buffer.byteLength(summary.recipeJson, "utf8")).toBeLessThanOrEqual(64_000);
  });

  it("preserves exec command in sanitizedSteps so replay.sh can run real steps", () => {
    const recipe = [{ tool: "exec", args: { command: "npm test", cwd: "/tmp/workspace" }, summary: "Run tests" }];
    const summary = summarizeRecipeForSidecar(recipe);
    const steps = summary.sanitizedSteps as Array<{ args?: { command?: string; cwd?: string } }>;
    expect(steps[0]?.args).toEqual({ command: "npm test" });
    const replay = maybeBundleReplayScript(summary.sanitizedSteps);
    expect(replay).toContain("npm test");
    expect(replay).toContain("bash -lc");
  });
});
