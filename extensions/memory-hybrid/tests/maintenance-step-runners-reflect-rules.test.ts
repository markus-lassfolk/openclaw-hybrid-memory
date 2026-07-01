import { describe, expect, it, vi } from "vitest";
import type { HybridMemoryConfig } from "../config.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { buildCliMaintenanceRunners } from "../cli/commands/manage/maintenance-step-runners.js";

function minimalBindings(runReflectionRules: ManageBindings["runReflectionRules"]): ManageBindings {
  return {
    cfg: { maintenance: { orchestrator: { llmCooldownBetweenStepsMs: 0 } } } as HybridMemoryConfig,
    factsDb: {} as ManageBindings["factsDb"],
    vectorDb: {} as ManageBindings["vectorDb"],
    embeddings: { embed: vi.fn() } as unknown as ManageBindings["embeddings"],
    reflectionConfig: { defaultWindow: 7, model: "test-model" },
    runReflectionRules,
  } as unknown as ManageBindings;
}

describe("maintenance-step-runners reflect-rules", () => {
  it("does not throw for tolerated invalid_response_format flake with model output", async () => {
    const runReflectionRules = vi.fn().mockResolvedValue({
      rulesStored: 0,
      rulesExtracted: 0,
      diagnostics: {
        parseSuccess: false,
        status: "degraded",
        zeroRulesReason: "invalid_response_format",
        modelResponseChars: 128,
      },
    });
    const runner = buildCliMaintenanceRunners(minimalBindings(runReflectionRules)).get("reflect-rules");
    expect(runner).toBeDefined();

    const summary = await runner!();

    expect(summary).toContain("zero_rules_reason=invalid_response_format");
    expect(summary).toContain("model_response_chars=128");
    expect(summary).toContain("semantic=success");
  });

  it("throws for genuine reflect-rules semantic failures", async () => {
    const runReflectionRules = vi.fn().mockResolvedValue({
      rulesStored: 0,
      rulesExtracted: 0,
      diagnostics: {
        parseSuccess: false,
        status: "degraded",
        zeroRulesReason: "model_empty",
        modelResponseChars: 0,
      },
    });
    const runner = buildCliMaintenanceRunners(minimalBindings(runReflectionRules)).get("reflect-rules");

    await expect(runner!()).rejects.toThrow(/reflect-rules semantic failure/);
  });
});
