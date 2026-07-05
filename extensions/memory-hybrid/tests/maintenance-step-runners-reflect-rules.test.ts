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
  it("throws for invalid_response_format even when the model returned output (#2043)", async () => {
    // invalid_response_format means the model responded but its output couldn't be parsed at all — a
    // real pipeline break, not a benign "nothing to extract" case. It used to be tolerated as a
    // one-off flake and reported as semantic=success, hiding a broken extraction run.
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

    await expect(runner!()).rejects.toThrow(/reflect-rules semantic failure/);
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
