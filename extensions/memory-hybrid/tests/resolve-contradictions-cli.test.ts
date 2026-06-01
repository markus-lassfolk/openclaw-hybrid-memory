import { Command } from "commander";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";

type LwwResult = Awaited<ReturnType<ManageBindings["runResolveContradictionsProjectStateLww"]>>;

function makeBindings(overrides: Partial<ManageBindings> = {}): ManageBindings {
  const base = {
    factsDb: {
      getById: vi.fn().mockReturnValue(null),
    },
    cfg: {},
    runFindDuplicates: vi.fn().mockResolvedValue({ pairs: [], candidatesCount: 0, skippedStructured: 0 }),
    runConsolidate: vi.fn().mockResolvedValue({ clustersFound: 0, merged: 0, deleted: 0 }),
    runReflection: vi.fn().mockResolvedValue({ factsAnalyzed: 0, patternsExtracted: 0, patternsStored: 0, window: 7 }),
    reflectionConfig: { enabled: true, defaultWindow: 7, minObservations: 1, model: "test-model" },
    runReflectionRules: vi.fn().mockResolvedValue({ rulesExtracted: 0, rulesStored: 0 }),
    runReflectionMeta: vi.fn().mockResolvedValue({ metaExtracted: 0, metaStored: 0 }),
    runReflectIdentity: vi.fn().mockResolvedValue({ insightsExtracted: 0, insightsStored: 0, questionsAsked: 0 }),
    runClassify: vi.fn().mockResolvedValue({ reclassified: 0, total: 0, breakdown: {} }),
    runEntityEnrichment: vi.fn().mockResolvedValue({ pending: 0, processed: 0, factsEnriched: 0 }),
    runDreamCycle: vi.fn().mockResolvedValue({ skipped: true }),
    runContinuousVerification: vi.fn().mockResolvedValue({ skipped: true }),
    runExtractImplicitFeedback: vi.fn().mockResolvedValue({
      signalsExtracted: 0,
      positiveCount: 0,
      negativeCount: 0,
      trajectoriesBuilt: 0,
      sessionsScanned: 0,
    }),
    runCrossAgentLearning: vi.fn().mockResolvedValue({ stored: 0 }),
    runToolEffectiveness: vi.fn().mockResolvedValue("ok"),
    pruneCostLog: vi.fn().mockReturnValue(0),
    runBackfill: vi.fn().mockResolvedValue({ stored: 0, skipped: 0, candidates: 0, files: 0 }),
    runIngestFiles: vi.fn().mockResolvedValue({ stored: 0, skipped: 0, extracted: 0, files: 0 }),
    runExport: vi
      .fn()
      .mockResolvedValue({ factsExported: 0, proceduresExported: 0, filesWritten: 0, outputPath: "/tmp" }),
    runBuildLanguageKeywords: vi
      .fn()
      .mockResolvedValue({ ok: true, path: "/tmp/languages.json", topLanguages: [], languagesAdded: 0 }),
    runResolveContradictions: vi.fn().mockResolvedValue({ autoResolved: [], ambiguous: [] }),
    runResolveContradictionsDryRun: vi.fn().mockResolvedValue({ autoResolvable: [], ambiguous: [] }),
    runResolveContradictionsProjectStateLww: vi.fn().mockResolvedValue({
      groups: [],
      totalCandidates: 0,
      wouldSupersede: 0,
      wouldManualReview: 0,
      applied: 0,
    }),
    runResolveContradictionsAuto: vi.fn().mockResolvedValue({
      total: 0,
      deterministic: 0,
      llm: 0,
      merged: 0,
      manualReview: 0,
      applied: false,
      decisionsApplied: 0,
      targetRate: 0.8,
      achievedRate: 1,
      targetMet: true,
      reviewItems: [],
    }),
    runApplyContradictionReviewDecisions: vi
      .fn()
      .mockResolvedValue({ applied: 0, keptNew: 0, keptOld: 0, manualReview: 0, rejected: 0, errors: [] }),
    vectorDb: {},
    versionInfo: { pluginVersion: "test", memoryManagerVersion: "test", schemaVersion: 1 },
    embeddings: {},
    mergeResults: vi.fn(),
    parseSourceDate: vi.fn().mockReturnValue(null),
    getMemoryCategories: vi.fn().mockReturnValue(["fact", "project"]),
    runStore: vi.fn(),
    runMigrateToVault: vi.fn().mockResolvedValue(null),
    runEncryptVault: vi.fn(),
    runCredentialsList: vi.fn().mockReturnValue([]),
    runCredentialsGet: vi.fn().mockReturnValue(null),
    runCredentialsAudit: vi.fn(),
    runCredentialsPrune: vi.fn(),
    runUninstall: vi.fn(),
    runUpgrade: vi.fn(),
    runConfigView: vi.fn(),
    runConfigMode: vi.fn(),
    runConfigSet: vi.fn(),
    runConfigSetHelp: vi.fn(),
    autoClassifyConfig: { model: "test-model", batchSize: 8 },
    runCompaction: vi.fn().mockResolvedValue({ hot: 0, warm: 0, cold: 0, structural: 0 }),
    runSelfCorrectionExtract: vi.fn(),
    runSelfCorrectionRun: vi.fn(),
    tieringEnabled: false,
    resolvedSqlitePath: null,
    resolvedLancePath: null,
    aliasDb: null,
    auditStore: null,
    agentHealthStore: null,
    listCommands: () => [],
    merge: vi.fn(),
    BACKFILL_DECAY_MARKER: ".backfill-decay-done",
    ctx: { cfg: {} },
  };
  const merged = { ...base, ...overrides } as Record<string, unknown>;
  if (!("ctx" in overrides)) {
    merged.ctx = {
      cfg: merged.cfg,
      runResolveContradictions: merged.runResolveContradictions,
      runResolveContradictionsDryRun: merged.runResolveContradictionsDryRun,
      runResolveContradictionsProjectStateLww: merged.runResolveContradictionsProjectStateLww,
      runResolveContradictionsAuto: merged.runResolveContradictionsAuto,
      runApplyContradictionReviewDecisions: merged.runApplyContradictionReviewDecisions,
    };
  }
  return merged as ManageBindings;
}

function makeProgram(bindings: ManageBindings): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(mem, bindings);
  return mem;
}

function sampleLwwResult(overrides: Partial<LwwResult> = {}): LwwResult {
  return {
    groups: [
      {
        entity: "hybrid-memory-issue-1636-pr",
        key: "status",
        scope: null,
        scopeTarget: null,
        candidates: [
          {
            contradictionId: "c-1",
            factIdNew: "new-1",
            factIdOld: "old-1",
            entity: "hybrid-memory-issue-1636-pr",
            key: "status",
            scope: null,
            scopeTarget: null,
            newFactDate: 1_700_000_060,
            oldFactDate: 1_700_000_000,
            newSource: "conversation",
            oldSource: "active-task",
            newConf: 1,
            oldConf: 1,
            newValueExcerpt: "done",
            oldValueExcerpt: "in_progress",
            action: "supersede",
            possibleOverloadedEntity: false,
          },
        ],
      },
    ],
    totalCandidates: 1,
    wouldSupersede: 1,
    wouldManualReview: 0,
    applied: 1,
    ...overrides,
  };
}

describe("enrich-entities CLI options", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("uses default limit=200 for bounded dry-run", async () => {
    const runEntityEnrichment = vi
      .fn()
      .mockResolvedValue({ pending: 0, pendingTotal: 0, processed: 0, factsEnriched: 0, remainingTotal: 0 });
    const mem = makeProgram(makeBindings({ runEntityEnrichment }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await mem.parseAsync(["enrich-entities", "--dry-run"], { from: "user" });

    expect(runEntityEnrichment).toHaveBeenCalledTimes(1);
    const opts = runEntityEnrichment.mock.calls[0]?.[0];
    expect(opts.limit).toBe(200);
    expect(opts.dryRun).toBe(true);
    expect(opts.all).toBe(false);
    expect(typeof opts.onProgress).toBe("function");
  });

  it("accepts explicit high --limit for catch-up runs", async () => {
    const runEntityEnrichment = vi
      .fn()
      .mockResolvedValue({ pending: 0, pendingTotal: 0, processed: 0, factsEnriched: 0, remainingTotal: 0 });
    const mem = makeProgram(makeBindings({ runEntityEnrichment }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await mem.parseAsync(["enrich-entities", "--dry-run", "--limit", "2000"], { from: "user" });

    expect(runEntityEnrichment).toHaveBeenCalledTimes(1);
    const opts = runEntityEnrichment.mock.calls[0]?.[0];
    expect(opts.limit).toBe(2000);
    expect(opts.dryRun).toBe(true);
    expect(opts.all).toBe(false);
  });

  it("enables exhaustive catch-up with --all", async () => {
    const runEntityEnrichment = vi
      .fn()
      .mockResolvedValue({ pending: 0, pendingTotal: 0, processed: 0, factsEnriched: 0, remainingTotal: 0 });
    const mem = makeProgram(makeBindings({ runEntityEnrichment }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await mem.parseAsync(["enrich-entities", "--dry-run", "--all"], { from: "user" });

    expect(runEntityEnrichment).toHaveBeenCalledTimes(1);
    const opts = runEntityEnrichment.mock.calls[0]?.[0];
    expect(opts.limit).toBe(200);
    expect(opts.dryRun).toBe(true);
    expect(opts.all).toBe(true);
  });

  it("passes adaptive catch-up pacing options when enabled", async () => {
    const runEntityEnrichment = vi.fn().mockResolvedValue({
      pending: 0,
      pendingTotal: 0,
      processed: 0,
      factsEnriched: 0,
      remainingTotal: 0,
      mode: "bounded",
      effectiveLimit: 200,
      estimatedRunsRemaining: 0,
      mentions: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      rejectReasons: {},
    });
    const mem = makeProgram(makeBindings({ runEntityEnrichment }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await mem.parseAsync(
      ["enrich-entities", "--dry-run", "--adaptive-catch-up", "--batch-size", "30", "--batch-delay-ms", "300"],
      { from: "user" },
    );

    expect(runEntityEnrichment).toHaveBeenCalledTimes(1);
    const opts = runEntityEnrichment.mock.calls[0]?.[0];
    expect(opts.adaptiveCatchUp).toBe(true);
    expect(opts.batchSize).toBe(30);
    expect(opts.batchDelayMs).toBe(300);
    expect(typeof opts.onAdaptivePacing).toBe("function");
  });
});

describe("resolve-contradictions CLI contract mode", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("supports --dry-run contract mode with grouped details and structured summary", async () => {
    const runResolveContradictionsProjectStateLww = vi.fn().mockResolvedValue(sampleLwwResult({ applied: 0 }));
    const runResolveContradictions = vi.fn().mockResolvedValue({ autoResolved: [], ambiguous: [] });
    const mem = makeProgram(
      makeBindings({
        runResolveContradictionsProjectStateLww,
        runResolveContradictions,
      }),
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions", "--dry-run"], { from: "user" });

    expect(runResolveContradictionsProjectStateLww).toHaveBeenCalledWith({ dryRun: true });
    expect(runResolveContradictions).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("hybrid-memory-issue-1636-pr / status"))).toBe(true);
    expect(lines.some((l) => l.includes("project-state-lww summary auto-resolved=1 dry-run=1 remaining=0"))).toBe(true);
  });

  it("supports --apply contract mode with grouped details and structured summary", async () => {
    const runResolveContradictionsProjectStateLww = vi.fn().mockResolvedValue(sampleLwwResult({ applied: 1 }));
    const mem = makeProgram(
      makeBindings({
        runResolveContradictionsProjectStateLww,
      }),
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions", "--apply"], { from: "user" });

    expect(runResolveContradictionsProjectStateLww).toHaveBeenCalledWith({ dryRun: false });
    expect(lines.some((l) => l.includes("hybrid-memory-issue-1636-pr / status"))).toBe(true);
    expect(lines.some((l) => l.includes("project-state-lww summary auto-resolved=1 dry-run=0 remaining=0"))).toBe(true);
  });

  it("prints structured summary in empty dry-run output", async () => {
    const runResolveContradictionsProjectStateLww = vi
      .fn()
      .mockResolvedValue(
        sampleLwwResult({ groups: [], totalCandidates: 0, wouldSupersede: 0, wouldManualReview: 0, applied: 0 }),
      );
    const mem = makeProgram(
      makeBindings({
        runResolveContradictionsProjectStateLww,
      }),
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions", "--dry-run"], { from: "user" });

    expect(lines.some((l) => l.includes("project-state-lww summary auto-resolved=0 dry-run=1 remaining=0"))).toBe(true);
  });

  it("rejects ambiguous flag combinations", async () => {
    const mem = makeProgram(makeBindings());
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(mem.parseAsync(["resolve-contradictions", "--dry-run", "--apply"], { from: "user" })).rejects.toThrow(
      "--dry-run and --apply are mutually exclusive",
    );
  });

  it("supports --auto dry-run, summary reporting, and review export", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-contradictions-cli-"));
    const exportPath = join(tmpDir, "review.jsonl");
    const runResolveContradictionsAuto = vi.fn().mockResolvedValue({
      total: 5,
      deterministic: 4,
      llm: 0,
      merged: 0,
      manualReview: 1,
      applied: false,
      decisionsApplied: 0,
      targetRate: 0.8,
      achievedRate: 0.8,
      targetMet: true,
      reviewItems: [
        {
          contradictionId: "c-1",
          factIdNew: "new-1",
          factIdOld: "old-1",
          entity: "proj",
          key: "status",
          scope: null,
          scopeTarget: null,
          newFactDate: 100,
          oldFactDate: 90,
          newSource: "conversation",
          oldSource: "cli",
          newConf: 1,
          oldConf: 1,
          newValueExcerpt: "done",
          oldValueExcerpt: "blocked",
          newTextExcerpt: "Project done",
          oldTextExcerpt: "Project blocked",
          possibleOverloadedEntity: false,
          suggestedDecision: "manual_review",
          suggestedStrategy: "manual-review",
          suggestedConfidence: 0,
          suggestedReason: "Needs human review.",
        },
      ],
    });
    const mem = makeProgram(makeBindings({ runResolveContradictionsAuto }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions", "--auto", "--dry-run", "--export-review", exportPath], {
      from: "user",
    });

    expect(runResolveContradictionsAuto).toHaveBeenCalledWith({
      dryRun: true,
      targetRate: 0.8,
      llm: false,
      model: undefined,
    });
    expect(lines.some((l) => l.includes("contradiction-auto summary total=5 deterministic=4 llm=0"))).toBe(true);
    const exported = readFileSync(exportPath, "utf-8").trim().split("\n");
    expect(exported).toHaveLength(1);
    expect(JSON.parse(exported[0])).toMatchObject({ contradictionId: "c-1", suggestedDecision: "manual_review" });
  });

  it("supports --apply-review with parsed JSONL decisions", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-contradictions-cli-"));
    const reviewPath = join(tmpDir, "review-decisions.jsonl");
    const runApplyContradictionReviewDecisions = vi
      .fn()
      .mockResolvedValue({ applied: 1, keptNew: 1, keptOld: 0, manualReview: 0, rejected: 0, errors: [] });
    const mem = makeProgram(makeBindings({ runApplyContradictionReviewDecisions }));
    writeFileSync(
      reviewPath,
      `${JSON.stringify({ contradictionId: "c-1", decision: "keep_new", reason: "Latest fact is correct." })}\n`,
      "utf-8",
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions", "--apply-review", reviewPath], { from: "user" });

    expect(runApplyContradictionReviewDecisions).toHaveBeenCalledWith([
      {
        contradictionId: "c-1",
        decision: "keep_new",
        reason: "Latest fact is correct.",
        confidence: undefined,
        mergedFactText: undefined,
      },
    ]);
    expect(lines.some((l) => l.includes("contradiction-review apply summary applied=1 kept_new=1 kept_old=0"))).toBe(
      true,
    );
  });

  it("rejects invalid --apply-review files before applying decisions", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-contradictions-cli-"));
    const reviewPath = join(tmpDir, "review-invalid.jsonl");
    const runApplyContradictionReviewDecisions = vi.fn();
    const mem = makeProgram(makeBindings({ runApplyContradictionReviewDecisions }));
    writeFileSync(
      reviewPath,
      [
        JSON.stringify({ contradictionId: "c-1", decision: "keep_new", reason: "Latest fact is correct." }),
        JSON.stringify({ contradictionId: "c-2", decision: "drop_both" }),
      ].join("\n"),
      "utf-8",
    );

    await expect(
      mem.parseAsync(["resolve-contradictions", "--apply-review", reviewPath], { from: "user" }),
    ).rejects.toThrow(`Invalid review file ${reviewPath}: line 2: unsupported decision`);
    expect(runApplyContradictionReviewDecisions).not.toHaveBeenCalled();
  });

  it("reports rejected --apply-review decisions without hiding partial success", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-contradictions-cli-"));
    const reviewPath = join(tmpDir, "review-partial.jsonl");
    const runApplyContradictionReviewDecisions = vi.fn().mockResolvedValue({
      applied: 1,
      keptNew: 0,
      keptOld: 1,
      manualReview: 1,
      rejected: 2,
      errors: ["Contradiction c-2: already resolved.", "Contradiction c-3: row not found."],
    });
    const mem = makeProgram(makeBindings({ runApplyContradictionReviewDecisions }));
    writeFileSync(
      reviewPath,
      [
        JSON.stringify({ contradictionId: "c-1", decision: "keep_old", reason: "Old fact is still canonical." }),
        JSON.stringify({ contradictionId: "c-2", decision: "manual_review", reason: "Need another pass." }),
        JSON.stringify({ contradictionId: "c-3", decision: "keep_new", reason: "Retry the newer fact." }),
      ].join("\n"),
      "utf-8",
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions", "--apply-review", reviewPath], { from: "user" });

    expect(lines.some((l) => l.includes("applied=1 kept_new=0 kept_old=1 manual_review=1 rejected=2"))).toBe(true);
    expect(lines).toContain("  - Contradiction c-2: already resolved.");
    expect(lines).toContain("  - Contradiction c-3: row not found.");
  });

  it("prints unresolved ambiguity buckets with deterministic actionable count", async () => {
    const runResolveContradictions = vi.fn().mockResolvedValue({
      autoResolved: [],
      ambiguous: [{ contradictionId: "c-1", factIdNew: "new-1", factIdOld: "old-1" }],
    });
    const runResolveContradictionsAuto = vi.fn().mockResolvedValue({
      total: 1,
      deterministic: 1,
      llm: 0,
      merged: 0,
      manualReview: 0,
      applied: false,
      decisionsApplied: 0,
      targetRate: 0.8,
      achievedRate: 1,
      targetMet: true,
      reviewItems: [],
    });
    const mem = makeProgram(makeBindings({ runResolveContradictions, runResolveContradictionsAuto }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions"], { from: "user" });

    expect(lines).toContain("unresolved_by_reason:");
    expect(lines).toContain("  safe_deterministic_auto=1");
    expect(lines).toContain("  possible_entity_reuse=0");
    expect(lines).toContain("  older_verified=0");
    expect(lines).toContain("  human_required=0");
    expect(
      lines.some((l) =>
        l.includes("Apply deterministic safe bucket (1): openclaw hybrid-mem resolve-contradictions --auto --apply"),
      ),
    ).toBe(true);
  });

  it("prints bucket-specific remediation steps for unresolved ambiguity classes", async () => {
    const runResolveContradictions = vi.fn().mockResolvedValue({
      autoResolved: [],
      ambiguous: [{ contradictionId: "c-1", factIdNew: "new-1", factIdOld: "old-1" }],
    });
    const runResolveContradictionsAuto = vi.fn().mockResolvedValue({
      total: 4,
      deterministic: 2,
      llm: 0,
      merged: 0,
      manualReview: 4,
      applied: false,
      decisionsApplied: 0,
      targetRate: 0.8,
      achievedRate: 0.5,
      targetMet: false,
      reviewItems: [
        {
          contradictionId: "c-2",
          factIdNew: "new-2",
          factIdOld: "old-2",
          entity: "proj",
          key: "status",
          scope: null,
          scopeTarget: null,
          newFactDate: 101,
          oldFactDate: 100,
          newSource: "conversation",
          oldSource: "conversation",
          newConf: 0.9,
          oldConf: 0.8,
          newValueExcerpt: "done",
          oldValueExcerpt: "blocked",
          newTextExcerpt: "done",
          oldTextExcerpt: "blocked",
          possibleOverloadedEntity: true,
          suggestedDecision: "manual_review",
          suggestedStrategy: "manual-review",
          suggestedConfidence: 0,
          suggestedReason: "Possible entity reuse detected; leaving for manual review.",
        },
        {
          contradictionId: "c-3",
          factIdNew: "new-3",
          factIdOld: "old-3",
          entity: "proj",
          key: "status",
          scope: null,
          scopeTarget: null,
          newFactDate: 102,
          oldFactDate: 100,
          newSource: "conversation",
          oldSource: "conversation",
          newConf: 0.9,
          oldConf: 0.8,
          newValueExcerpt: "done",
          oldValueExcerpt: "blocked",
          newTextExcerpt: "done",
          oldTextExcerpt: "blocked",
          possibleOverloadedEntity: false,
          suggestedDecision: "manual_review",
          suggestedStrategy: "manual-review",
          suggestedConfidence: 0,
          suggestedReason: "Older fact is verified; leaving for manual review.",
        },
        {
          contradictionId: "c-4",
          factIdNew: "new-4",
          factIdOld: "old-4",
          entity: "proj",
          key: "status",
          scope: null,
          scopeTarget: null,
          newFactDate: 103,
          oldFactDate: 100,
          newSource: "conversation",
          oldSource: "conversation",
          newConf: 0.9,
          oldConf: 0.8,
          newValueExcerpt: "done",
          oldValueExcerpt: "blocked",
          newTextExcerpt: "done",
          oldTextExcerpt: "blocked",
          possibleOverloadedEntity: false,
          suggestedDecision: "manual_review",
          suggestedStrategy: "manual-review",
          suggestedConfidence: 0,
          suggestedReason: "No safe deterministic resolution matched.",
        },
        {
          contradictionId: "c-5",
          factIdNew: "new-5",
          factIdOld: "old-5",
          entity: "proj",
          key: "status",
          scope: null,
          scopeTarget: null,
          newFactDate: 104,
          oldFactDate: 100,
          newSource: "conversation",
          oldSource: "conversation",
          newConf: 0.9,
          oldConf: 0.8,
          newValueExcerpt: "done",
          oldValueExcerpt: "blocked",
          newTextExcerpt: "done",
          oldTextExcerpt: "blocked",
          possibleOverloadedEntity: false,
          suggestedDecision: "manual_review",
          suggestedStrategy: "manual-review",
          suggestedConfidence: 0,
          suggestedReason: "Needs human review.",
        },
      ],
    });
    const mem = makeProgram(makeBindings({ runResolveContradictions, runResolveContradictionsAuto }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions"], { from: "user" });

    expect(
      lines.some((l) =>
        l.includes("Review possible entity-reuse bucket (1): inspect entity naming/scope before superseding facts."),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.includes(
          "Review verified-older bucket (1): verify whether stale verification should be retained or replaced.",
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.includes(
          "Review human-required bucket (1): export and adjudicate with openclaw hybrid-mem resolve-contradictions --auto --dry-run --export-review <path>.",
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.includes(
          "Review other-manual bucket (1): inspect details output and handle pair-specific blockers before rerun.",
        ),
      ),
    ).toBe(true);
  });

  it("marks large ambiguous backlog with no progress as degraded", async () => {
    const runResolveContradictions = vi.fn().mockResolvedValue({
      autoResolved: [],
      ambiguous: [
        { contradictionId: "c-1", factIdNew: "new-1", factIdOld: "old-1" },
        { contradictionId: "c-2", factIdNew: "new-2", factIdOld: "old-2" },
      ],
    });
    const runResolveContradictionsAuto = vi.fn().mockResolvedValue({
      total: 2,
      deterministic: 0,
      llm: 0,
      merged: 0,
      manualReview: 2,
      applied: false,
      decisionsApplied: 0,
      targetRate: 0.8,
      achievedRate: 0,
      targetMet: false,
      reviewItems: [],
    });
    const mem = makeProgram(makeBindings({ runResolveContradictions, runResolveContradictionsAuto }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["resolve-contradictions", "--degraded-ambiguous-threshold", "1"], { from: "user" });

    expect(process.exitCode).toBe(2);
    expect(lines.some((l) => l.includes("resolve-contradictions summary auto_resolved=0 ambiguous=2"))).toBe(true);
    expect(lines.some((l) => l.includes("Backlog alert: ambiguous=2 with auto-resolved=0 exceeds degraded threshold 1"))).toBe(
      true,
    );
  });

  it("emits resolve-contradictions JSON summary for cron validation", async () => {
    const runResolveContradictions = vi.fn().mockResolvedValue({
      autoResolved: [],
      ambiguous: [{ contradictionId: "c-1", factIdNew: "new-1", factIdOld: "old-1" }],
    });
    const mem = makeProgram(makeBindings({ runResolveContradictions }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(
      ["resolve-contradictions", "--json", "--degraded-ambiguous-threshold", "1"],
      { from: "user" },
    );

    const jsonLine = lines.find((line) => line.trim().startsWith("{"));
    expect(jsonLine).toBeTruthy();
    const summary = JSON.parse(jsonLine as string);
    expect(summary).toMatchObject({
      mode: "default",
      autoResolved: 0,
      ambiguous: 1,
      noProgress: true,
      degraded: true,
      exitCode: 2,
      exitReason: "ambiguous_backlog_no_progress",
      suggestions: {
        details: "openclaw hybrid-mem resolve-contradictions --details",
        projectStateLwwDryRun: "openclaw hybrid-mem resolve-contradictions --project-state-lww --dry-run",
      },
    });
  });
});
