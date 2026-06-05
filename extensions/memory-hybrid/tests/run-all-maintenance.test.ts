/**
 * run-all maintenance CLI — orchestrator alias smoke tests (#2026.5.190).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HybridMemoryConfig } from "../config.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerRunAllCommand } from "../cli/commands/manage/register-agents-audit-runall.js";

function minimalCfg(): HybridMemoryConfig {
  return {
    maintenance: { orchestrator: { llmCooldownBetweenStepsMs: 0, rateLimitMaxRetries: 2 } },
    autoClassify: { enabled: false },
    lifecycle: { adapters: { github: { enabled: false } } },
  } as HybridMemoryConfig;
}

function makeBindings(overrides: Partial<ManageBindings> & { factsDb: ManageBindings["factsDb"] }): ManageBindings {
  return {
    cfg: minimalCfg(),
    vectorDb: {
      delete: vi.fn().mockResolvedValue(true),
    },
    embeddings: { embed: vi.fn().mockResolvedValue([]) },
    auditStore: null,
    agentHealthStore: null,
    resolvedSqlitePath: overrides.resolvedSqlitePath ?? null,
    BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    runCompaction: vi.fn().mockResolvedValue({ hot: 0, warm: 0, cold: 0 }),
    runDistill: null,
    runExtractDaily: null,
    runExtractDirectives: null,
    runExtractReinforcement: null,
    runExtractImplicitFeedback: null,
    runExtractProcedures: null,
    runGenerateAutoSkills: null,
    runReflectIdentity: null,
    runGenerateProposals: null,
    runSelfCorrectionRun: vi.fn().mockResolvedValue({ incidentsFound: 0, analysed: 0 }),
    runBuildLanguageKeywords: vi.fn().mockResolvedValue({ ok: true, languagesAdded: 0 }),
    runResolveContradictions: vi.fn().mockResolvedValue({ autoResolved: [], ambiguous: [] }),
    runResolveContradictionsAuto: vi.fn().mockResolvedValue({
      total: 0,
      deterministic: 0,
      llm: 0,
      merged: 0,
      manualReview: 0,
      applied: true,
      decisionsApplied: 0,
      targetRate: 0.8,
      achievedRate: 1,
      targetMet: true,
      reviewItems: [],
    }),
    runEntityEnrichment: vi.fn().mockResolvedValue({ processed: 0, factsEnriched: 0 }),
    runClassify: vi.fn().mockResolvedValue({ reclassified: 0, total: 0 }),
    runCredentialsPrune: vi.fn().mockReturnValue({ removed: 0 }),
    reflectionConfig: { defaultWindow: 7, model: "test-model" },
    runReflection: vi.fn().mockResolvedValue({ patternsStored: 0, factsAnalyzed: 0 }),
    runReflectionRules: vi.fn().mockResolvedValue({ rulesStored: 0 }),
    runReflectionMeta: vi.fn().mockResolvedValue({ metaStored: 0 }),
    requireWalFlushBeforeMutation: vi.fn().mockResolvedValue({ committed: 0, skipped: 0 }),
    ...overrides,
  } as unknown as ManageBindings;
}

describe("run-all maintenance CLI", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("dry-run lists orchestrator steps without executing handlers", async () => {
    const backfillDecay = vi.fn();
    const prune = vi.fn();
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerRunAllCommand(
      mem,
      makeBindings({
        factsDb: {
          backfillDecay,
          prune,
          listExpiredFactIdsPendingPrune: () => [],
          countActiveFactsByCategory: () => 0,
        } as never,
      }),
    );

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => {
      lines.push(String(s));
    });

    await mem.parseAsync(["run-all", "--dry-run"], { from: "user" });

    expect(lines.some((l) => l.includes("Maintenance full"))).toBe(true);
    expect(lines.some((l) => l.includes("backfill-decay"))).toBe(true);
    expect(lines.some((l) => l.includes("prune"))).toBe(true);
    expect(backfillDecay).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });
});
