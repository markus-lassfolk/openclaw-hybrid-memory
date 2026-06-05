/**
 * Grouped CLI namespaces and deprecated flat aliases (CLI consolidation plan).
 */

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDistillGroup } from "../cli/distill.js";
import { registerReflectGroup } from "../cli/commands/register-reflect-group.js";
import { registerQualityGroup } from "../cli/commands/register-quality-group.js";
import { registerStorageGroup } from "../cli/commands/manage/register-storage-maintenance.js";
import { registerLearnGroup } from "../cli/commands/register-learn-group.js";
import { registerMaintenanceGroup } from "../cli/commands/register-maintenance-group.js";
import { warnDeprecatedAlias } from "../cli/shared.js";

function commandNames(program: Command): string[] {
  return program.commands.map((c) => c.name());
}

function hasNestedCommand(program: Command, ...path: string[]): boolean {
  let node: Command | undefined = program;
  for (const segment of path) {
    node = node?.commands.find((c) => c.name() === segment);
    if (!node) return false;
  }
  return true;
}

describe("CLI grouped namespaces", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers top-level group namespaces from distill registration", () => {
    const mem = new Command("hybrid-mem");
    registerDistillGroup(mem, {
      runDistillWindow: vi.fn(),
      runRecordDistill: vi.fn(),
      runExtractDaily: vi.fn(),
      runExtractProcedures: vi.fn(),
      runGenerateAutoSkills: vi.fn(),
      runDistill: vi.fn(),
      runExtractDirectives: vi.fn(),
      runExtractReinforcement: vi.fn(),
    });

    expect(commandNames(mem)).toContain("distill");
    expect(hasNestedCommand(mem, "distill", "run")).toBe(true);
    expect(hasNestedCommand(mem, "distill", "extract-daily")).toBe(true);
    expect(commandNames(mem)).toContain("extract-daily");
  });

  it("registers reflect group with patterns subcommand and flat reflect alias", () => {
    const mem = new Command("hybrid-mem");
    const b = {
      runReflection: vi.fn(),
      runReflectionRules: vi.fn(),
      runReflectionMeta: vi.fn(),
      runReflectIdentity: vi.fn(),
      runDreamCycle: vi.fn(),
      reflectionConfig: { defaultWindow: 7, model: "test" },
      cfg: {},
      factsDb: {},
    } as never;

    registerReflectGroup(mem, b);

    expect(hasNestedCommand(mem, "reflect", "patterns")).toBe(true);
    expect(hasNestedCommand(mem, "reflect", "rules")).toBe(true);
    expect(commandNames(mem)).toContain("reflect-rules");
  });

  it("registers quality group with duplicates subcommand and flat find-duplicates alias", () => {
    const mem = new Command("hybrid-mem");
    const b = {
      runFindDuplicates: vi.fn(),
      runConsolidate: vi.fn(),
      runClassify: vi.fn(),
      runEntityEnrichment: vi.fn(),
      runBuildLanguageKeywords: vi.fn(),
      cfg: {},
      factsDb: {},
    } as never;

    registerQualityGroup(mem, b);

    expect(hasNestedCommand(mem, "quality", "duplicates")).toBe(true);
    expect(commandNames(mem)).toContain("find-duplicates");
  });

  it("registers storage group with compact subcommand and flat tier-compact alias", () => {
    const mem = new Command("hybrid-mem");
    const b = {
      factsDb: { sqlitePath: "/tmp/facts.db" },
      vectorDb: {},
      cfg: {},
      runCompaction: vi.fn(),
    } as never;

    registerStorageGroup(mem, b);

    expect(hasNestedCommand(mem, "storage", "compact")).toBe(true);
    expect(commandNames(mem)).toContain("tier-compact");
  });

  it("registers learn group with self-correction subgroup", () => {
    const mem = new Command("hybrid-mem");
    const b = {
      cfg: {},
      ctx: {},
      runSelfCorrectionExtract: vi.fn(),
      runSelfCorrectionRun: vi.fn(),
      runExtractImplicitFeedback: vi.fn(),
      runCrossAgentLearning: vi.fn(),
      runToolEffectiveness: vi.fn(),
      runAnalyzeFeedbackPhrases: vi.fn(),
      pruneCostLog: vi.fn(),
      runCostReport: vi.fn(),
    } as never;

    registerLearnGroup(mem, b);

    expect(hasNestedCommand(mem, "learn", "self-correction", "extract")).toBe(true);
    expect(commandNames(mem)).toContain("self-correction-extract");
  });

  it("warns when flat learn aliases run", async () => {
    const { Command } = await import("commander");
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const b = {
      cfg: { crossAgentLearning: { enabled: true } },
      ctx: {},
      runExtractImplicitFeedback: vi.fn().mockResolvedValue({
        signalsExtracted: 0,
        sessionsScanned: 0,
        sessionsVisited: 0,
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        positiveCount: 0,
        negativeCount: 0,
        trajectoriesBuilt: 0,
      }),
      runCrossAgentLearning: vi.fn().mockResolvedValue({
        agentsScanned: 0,
        lessonsConsidered: 0,
        generalisedStored: 0,
        provenanceRecorded: 0,
        skippedDuplicates: 0,
        errors: 0,
      }),
      runSelfCorrectionExtract: vi.fn(),
      runSelfCorrectionRun: vi.fn(),
      runToolEffectiveness: vi.fn(),
      runAnalyzeFeedbackPhrases: vi.fn(),
      pruneCostLog: vi.fn(),
      runCostReport: vi.fn(),
    } as never;

    registerLearnGroup(mem, b);

    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg: string) => {
      stderr.push(String(msg));
    });

    await mem.parseAsync(["extract-implicit", "--dry-run"], { from: "user" });
    expect(stderr.some((line) => line.includes("extract-implicit") && line.includes("learn implicit"))).toBe(true);
  });

  it("registers maintenance group with backfill --all parent action", async () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const ctx = {
      cfg: {
        embedding: { provider: "ollama" },
        procedures: { allAgentSessions: false, sessionsDir: "/tmp/no-sessions" },
      },
      versionInfo: { pluginVersion: "test" },
      factsDb: {
        sqlitePath: "/tmp/facts.db",
        getRawDb: () => ({}),
      },
      vectorDb: {},
      ctx: { cfg: {} },
    } as never;
    const b = {
      factsDb: {
        getRawDb: () => ({}),
      },
      cfg: ctx.cfg,
    } as never;

    registerMaintenanceGroup(mem, b, ctx);

    expect(hasNestedCommand(mem, "maintenance", "backfill", "daily-logs")).toBe(true);
    expect(hasNestedCommand(mem, "maintenance", "run-all")).toBe(true);
    expect(commandNames(mem)).toContain("run-all");

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => {
      lines.push(String(s));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["maintenance", "backfill", "--all", "--days", "0"], { from: "user" });
    expect(lines.some((l) => l.includes("maintenance backfill --all"))).toBe(true);
  });
});

describe("CLI full registration", () => {
  it("registers grouped and manage commands without duplicate Commander names", async () => {
    const { Command } = await import("commander");
    const { registerAllCliGroups } = await import("../cli/commands/register-cli-groups.js");
    const { registerManageCommands } = await import("../cli/commands/register-manage-commands.js");

    const mem = new Command("hybrid-mem");
    const ctx = {
      cfg: { embedding: { provider: "ollama", model: "nomic-embed-text" } },
      versionInfo: { pluginVersion: "test" },
      factsDb: {
        sqlitePath: "/tmp/facts.db",
        getRawDb: () => ({}),
        backfillDecay: () => ({}),
        prune: () => 0,
        listExpiredFactIdsPendingPrune: () => [],
        setMaintenanceState: () => {},
      },
      vectorDb: { delete: async () => true },
      runCompaction: async () => ({ hot: 0, warm: 0, cold: 0 }),
      runReflection: async () => ({ patternsStored: 0, factsAnalyzed: 0, patternsExtracted: 0 }),
      runReflectionRules: async () => ({ rulesStored: 0, rulesExtracted: 0 }),
      runReflectionMeta: async () => ({ metaStored: 0 }),
      runFindDuplicates: async () => ({ clusters: [] }),
      runConsolidate: async () => ({ merged: 0 }),
      runClassify: async () => ({ classified: 0 }),
      runEntityEnrichment: async () => ({ enriched: 0 }),
      runBuildLanguageKeywords: async () => ({ ok: true, languagesAdded: 0 }),
      runSelfCorrectionExtract: async () => ({ incidents: [] }),
      runSelfCorrectionRun: async () => undefined,
      runExtractImplicitFeedback: async () => ({
        signalsExtracted: 0,
        positiveCount: 0,
        negativeCount: 0,
        sessionsScanned: 0,
      }),
      runCrossAgentLearning: async () => ({
        agentsScanned: 0,
        lessonsConsidered: 0,
        generalisedStored: 0,
        provenanceRecorded: 0,
        skippedDuplicates: 0,
        errors: 0,
      }),
      runToolEffectiveness: async () => "",
      runAnalyzeFeedbackPhrases: async () => ({
        sessionsScanned: 0,
        reinforcement: [],
        correction: [],
        learned: false,
      }),
      runCostReport: () => {},
      pruneCostLog: () => 0,
      reflectionConfig: { defaultWindow: 7, model: "test" },
      runBackfill: async () => ({ stored: 0 }),
      runIngestFiles: async () => ({ stored: 0 }),
      runExport: async () => ({ factsExported: 0, proceduresExported: 0, filesWritten: 0, outputPath: "" }),
      ctx: { cfg: { embedding: { provider: "ollama" } } },
    } as never;

    const distillContext = {
      runDistillWindow: vi.fn(),
      runRecordDistill: vi.fn(),
      runExtractDaily: vi.fn(),
      runExtractProcedures: vi.fn(),
      runGenerateAutoSkills: vi.fn(),
      runDistill: vi.fn(),
      runExtractDirectives: vi.fn(),
      runExtractReinforcement: vi.fn(),
    };

    expect(() => {
      registerAllCliGroups(mem, ctx, distillContext);
      registerManageCommands(mem, ctx);
    }).not.toThrow();
  });
});

describe("warnDeprecatedAlias", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a one-time stderr deprecation notice", () => {
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg: string) => {
      stderr.push(String(msg));
    });

    warnDeprecatedAlias("extract-daily", "distill extract-daily");
    warnDeprecatedAlias("extract-daily", "distill extract-daily");

    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("extract-daily");
    expect(stderr[0]).toContain("distill extract-daily");
  });
});
