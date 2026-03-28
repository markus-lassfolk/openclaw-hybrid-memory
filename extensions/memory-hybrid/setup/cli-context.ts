/**
 * Build HybridMemCliContext from handler context and services.
 * Moves CLI wiring out of index.ts so the plugin entry stays small.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { ActiveTaskContext } from "../cli/active-tasks.js";
import { parseDuration } from "../utils/duration.js";
import type { Command } from "commander";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { registerHybridMemCli, type HybridMemCliContext } from "../cli/register.js";
import type { HandlerContext } from "../cli/handlers.js";
import * as handlers from "../cli/handlers.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import type { FindDuplicatesResult } from "../cli/types.js";
import { runFindDuplicates } from "../services/find-duplicates.js";
import { runConsolidate } from "../services/consolidation.js";
import { runReflection, runReflectionRules, runReflectionMeta } from "../services/reflection.js";
import { runDreamCycle, type DreamCycleResult } from "../services/dream-cycle.js";
import { runVerificationCycle, type VerificationCycleResult } from "../services/continuous-verifier.js";
import { runClassifyForCli } from "../services/auto-classifier.js";
import { runBuildLanguageKeywords } from "../services/language-keywords-build.js";
import { runExport } from "../services/export-memory.js";
import { mergeResults } from "../services/merge-results.js";
import { parseSourceDate } from "../utils/dates.js";
import {
  getMemoryCategories,
  getDefaultCronModel,
  getCronModelConfig,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { versionInfo } from "../versionInfo.js";
import { capturePluginError } from "../services/error-reporter.js";
import { applyApprovedProposal } from "../cli/proposals.js";
import { runBackup as runBackupFn, runBackupVerify as runBackupVerifyFn } from "../cli/backup.js";
import { pluginLogger } from "../utils/logger.js";
import { runPreConsolidationFlush } from "../services/pre-consolidation-flush.js";

/** Help text shown after hybrid-mem commands list */
export const HYBRID_MEM_HELP_GROUPED = `
Commands by category:

  Setup & installation
    install              Apply recommended config and defaults (run after first setup)
    verify               Verify infrastructure and functionality (DBs, embedding API, jobs); use --fix to apply defaults
    config               Show current configuration and feature toggles (use config-set to change)

  Maintenance (run regularly or use run-all)
    run-all              Run all maintenance tasks in optimal order (see below)
    compact              Tier compaction: move facts between hot/warm/cold
    prune                Remove expired (decayed) facts
    checkpoint           Checkpoint vector DB to disk
    re-index             Reset LanceDB and re-embed all facts (after changing embedding model)
    backfill-decay       Backfill decay fields (one-time migration)
    backfill             Seed memory from workspace Markdown/text files

  Stats & query
    stats                Show memory statistics (--efficiency for tiers/tokens)
    test                 Run memory diagnostics (structured/semantic/hybrid/auto-recall)
    model-info [model]   Dimensions for a catalog embedding model, or current config if omitted
    context-audit        Report token usage per injected context source
    search <query>       Hybrid search (vector + SQL)
    lookup <id>          Get fact by ID
    list                 List recent facts (--limit, --category, --tier, etc.)
    show <id>            Show fact or proposal by ID
    categories           List categories present in memory

  Proposals & corrections
    proposals list       List persona proposals (--status)
    proposals show <id>  Show full proposal (--json, --diff)
    proposals approve/reject <id>
    corrections list     List pending corrections from last report
    corrections approve-all   Apply all TOOLS/AGENTS rules from report
    review               Show proposals and corrections with actions

  Store & ingestion
    store <text>         Store a fact (options: --category, --entity, --key, --value)
    ingest-files         Ingest workspace files (--paths for specific files)
    distill              Extract facts from session logs (--days, --model)
    distill-window       Show date range available for distill
    record-distill       Record last distill run for cron
    extract-daily        Extract daily summaries from sessions
    extract-procedures   Extract procedures from sessions (--days)
    extract-directives   Extract directive rules from sessions
    extract-reinforcement  Extract reinforcement from praise
    generate-auto-skills   Generate skills from procedures
    generate-proposals    Generate persona proposals from reflection (--dry-run, --verbose)

  Reflection & classification
    reflect              Analyze recent facts, extract patterns
    reflect-rules        Extract rules from patterns
    reflect-meta         Extract meta-patterns
    classify             Reclassify facts with LLM
    build-languages      Build language keywords for self-correction

  Dedup & consolidation
    find-duplicates      Find near-duplicate facts (--threshold)
    consolidate          Merge duplicates via LLM (--dry-run first)

  Self-correction
    self-correction-extract  Extract incidents from sessions
    self-correction-run      Analyze and remediate (TOOLS.md, memory)

  Export & config
    export               Export to MEMORY.md / memory/ (--output)
    config               View configuration and feature toggles
    config-mode <mode>   Set memory mode
    config-set <key> <value>

  Credentials & scope
    credentials migrate-to-vault
    scope list|stats|prune|promote

  Sensor sweep (requires sensorSweep.enabled: true)
    sensor-sweep         Run sensor data collection (Garmin, GitHub, memory patterns, sessions)
    sensor-events        Query events written to the Event Bus

  Plugin lifecycle
    upgrade [version]    Upgrade to version or latest
    uninstall            Remove plugin (--clean-all, --leave-config)
    backup               Create a point-in-time snapshot (SQLite + LanceDB)
    backup verify        Check SQLite integrity without creating a backup
`;

const HYBRID_MEM_HELP_ACTIVE_TASKS = `
  Working memory
    active-tasks                   List active tasks from ACTIVE-TASK.md
    active-tasks complete <label>  Mark task as Done and flush to memory log
    active-tasks stale             Show tasks not updated within staleThreshold
    active-tasks add <label> <desc>  Add or update a task entry
`;

export const HYBRID_MEM_CLI_COMMANDS = [
  "hybrid-mem",
  "hybrid-mem dashboard",
  "hybrid-mem run-all",
  "hybrid-mem install",
  "hybrid-mem stats",
  "hybrid-mem test",
  "hybrid-mem model-info",
  "hybrid-mem context-audit",
  "hybrid-mem compact",
  "hybrid-mem prune",
  "hybrid-mem checkpoint",
  "hybrid-mem backfill-decay",
  "hybrid-mem backfill",
  "hybrid-mem ingest-files",
  "hybrid-mem distill",
  "hybrid-mem extract-daily",
  "hybrid-mem extract-procedures",
  "hybrid-mem generate-auto-skills",
  "hybrid-mem generate-proposals",
  "hybrid-mem extract-directives",
  "hybrid-mem extract-reinforcement",
  "hybrid-mem search",
  "hybrid-mem lookup",
  "hybrid-mem list",
  "hybrid-mem show",
  "hybrid-mem proposals list",
  "hybrid-mem proposals show",
  "hybrid-mem proposals approve",
  "hybrid-mem proposals reject",
  "hybrid-mem corrections list",
  "hybrid-mem corrections approve",
  "hybrid-mem review",
  "hybrid-mem store",
  "hybrid-mem classify",
  "hybrid-mem build-languages",
  "hybrid-mem self-correction-extract",
  "hybrid-mem self-correction-run",
  "hybrid-mem analyze-feedback-phrases",
  "hybrid-mem categories",
  "hybrid-mem find-duplicates",
  "hybrid-mem consolidate",
  "hybrid-mem reflect",
  "hybrid-mem reflect-rules",
  "hybrid-mem reflect-meta",
  "hybrid-mem dream-cycle",
  "hybrid-mem resolve-contradictions",
  "hybrid-mem config",
  "hybrid-mem verify",
  "hybrid-mem credentials migrate-to-vault",
  "hybrid-mem distill-window",
  "hybrid-mem record-distill",
  "hybrid-mem scope prune-session",
  "hybrid-mem scope promote",
  "hybrid-mem uninstall",
  "hybrid-mem active-tasks",
  "hybrid-mem active-tasks complete",
  "hybrid-mem active-tasks stale",
  "hybrid-mem active-tasks add",
  "hybrid-mem cost-report",
  "hybrid-mem tool-effectiveness",
  "hybrid-mem cross-agent-learning",
  "hybrid-mem sensor-sweep",
  "hybrid-mem sensor-events",
] as const;

/** Services that are not in cli/handlers (reflection, consolidate, export, etc.) */
export interface CliContextServices {
  runFindDuplicates: (opts: {
    threshold: number;
    includeStructured: boolean;
    limit: number;
  }) => Promise<FindDuplicatesResult>;
  runConsolidate: (opts: {
    threshold: number;
    includeStructured: boolean;
    dryRun: boolean;
    limit: number;
    model: string;
  }) => Promise<{ clustersFound: number; merged: number; deleted: number }>;
  runReflection: (opts: { window: number; dryRun: boolean; model: string; verbose?: boolean }) => Promise<{
    factsAnalyzed: number;
    patternsExtracted: number;
    patternsStored: number;
    window: number;
  }>;
  runReflectionRules: (opts: {
    dryRun: boolean;
    model: string;
    verbose?: boolean;
  }) => Promise<{ rulesExtracted: number; rulesStored: number }>;
  runReflectionMeta: (opts: {
    dryRun: boolean;
    model: string;
    verbose?: boolean;
  }) => Promise<{ metaExtracted: number; metaStored: number }>;
  runClassify: (opts: { dryRun: boolean; limit: number; model?: string }) => Promise<{
    reclassified: number;
    total: number;
    breakdown?: Record<string, number>;
  }>;
  runCompaction: () => Promise<{ hot: number; warm: number; cold: number }>;
  runBuildLanguageKeywords: (opts: {
    model?: string;
    dryRun?: boolean;
  }) => Promise<
    { ok: true; path: string; topLanguages: string[]; languagesAdded: number } | { ok: false; error: string }
  >;
  runExport: (opts: {
    outputPath: string;
    excludeCredentials?: boolean;
    includeCredentials?: boolean;
    sources?: string[];
    mode?: "replace" | "additive";
  }) => Promise<{ factsExported: number; proceduresExported: number; filesWritten: number; outputPath: string }>;
  runDreamCycle: () => Promise<DreamCycleResult>;
  runContinuousVerification: () => Promise<VerificationCycleResult>;
  runResolveContradictions: () => Promise<{
    autoResolved: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
    ambiguous: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
  }>;
  getMemoryCategories: () => string[];
  mergeResults: HybridMemCliContext["mergeResults"];
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
}

/** Context passed from plugin register() to wire CLI without pulling all service imports into index. */
export interface HybridMemCliRegistrationContext {
  factsDb: HandlerContext["factsDb"];
  vectorDb: HandlerContext["vectorDb"];
  embeddings: HandlerContext["embeddings"];
  openai: HandlerContext["openai"];
  cfg: HandlerContext["cfg"];
  credentialsDb: HandlerContext["credentialsDb"];
  aliasDb: HandlerContext["aliasDb"];
  wal: HandlerContext["wal"];
  proposalsDb: HandlerContext["proposalsDb"];
  identityReflectionStore: HandlerContext["identityReflectionStore"];
  personaStateStore: HandlerContext["personaStateStore"];
  verificationStore?: import("../services/verification-store.js").VerificationStore | null;
  provenanceService?: import("../services/provenance.js").ProvenanceService | null;
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  pluginId: string;
  detectCategory: HandlerContext["detectCategory"];
  /** Optional event log for episodic consolidation in dream cycle. */
  eventLog?: import("../backends/event-log.js").EventLog | null;
  /** LLM cost tracker (Issue #270). */
  costTracker?: import("../backends/cost-tracker.js").CostTracker | null;
  /** Event Bus for sensor sweep (Issue #236). Required when sensorSweep.enabled. */
  eventBus?: import("../backends/event-bus.js").EventBus | null;
}

function buildCliContextServices(ctx: HybridMemCliRegistrationContext, api: ClawdbotPluginApi): CliContextServices {
  const {
    factsDb,
    vectorDb,
    embeddings,
    openai,
    cfg,
    resolvedSqlitePath,
    aliasDb,
    verificationStore,
    provenanceService,
    wal,
  } = ctx;
  const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
  const logSink = { info: (m: string) => pluginLogger.info(m), warn: (m: string) => pluginLogger.warn(m) };
  return {
    runFindDuplicates: (opts) => runFindDuplicates(factsDb, vectorDb, embeddings, opts, api.logger),
    runConsolidate: async (opts) => {
      // Skip if OpenAI provider is configured but API key is missing
      if (cfg.embedding?.provider === "openai" && !cfg.embedding?.apiKey) {
        return { clustersFound: 0, merged: 0, deleted: 0 };
      }
      await runPreConsolidationFlush({ wal, factsDb, vectorDb, embeddings }, api.logger, "cli_consolidation");
      return runConsolidate(factsDb, vectorDb, embeddings, openai, opts, api.logger, aliasDb, provenanceService);
    },
    runReflection: async (opts) => {
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      const result = await runReflection(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        {
          defaultWindow: cfg.reflection.defaultWindow,
          minObservations: cfg.reflection.minObservations,
          enabled: cfg.reflection.enabled,
        },
        { ...opts, model: opts.model ?? defaultModel, fallbackModels },
        logSink,
        provenanceService,
      );
      // Record savings: each pattern stored encodes knowledge that saves future manual analysis
      if (result.patternsStored > 0 && !opts.dryRun && ctx.costTracker) {
        ctx.costTracker.recordSavings({
          feature: "reflection",
          action: "pattern extracted and stored",
          countAvoided: result.patternsStored,
          estimatedSavingUsd: result.patternsStored * 0.0005,
          note: `${result.factsAnalyzed} facts analyzed → ${result.patternsStored} patterns stored`,
        });
      }
      return result;
    },
    runReflectionRules: (opts) => {
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      return runReflectionRules(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        { ...opts, model: opts.model ?? defaultModel, fallbackModels },
        logSink,
        provenanceService,
      );
    },
    runReflectionMeta: (opts) => {
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      return runReflectionMeta(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        { ...opts, model: opts.model ?? defaultModel, fallbackModels },
        logSink,
        provenanceService,
      );
    },
    runClassify: async (opts) => {
      const result = await runClassifyForCli(
        factsDb,
        openai,
        cfg.autoClassify,
        {
          ...opts,
          model: opts.model ?? cfg.autoClassify.model ?? resolveReflectionModelAndFallbacks(cfg, "nano").defaultModel,
        },
        discoveredPath,
        logSink,
        undefined,
      );
      // Record savings: batching avoids N individual LLM calls
      if (result.reclassified > 0 && !opts.dryRun && ctx.costTracker) {
        const batchSize = cfg.autoClassify.batchSize ?? 20;
        const batchesUsed = Math.ceil(result.reclassified / batchSize);
        const callsAvoided = Math.max(0, result.reclassified - batchesUsed);
        if (callsAvoided > 0) {
          ctx.costTracker.recordSavings({
            feature: "auto-classify",
            action: "batch-classified facts",
            countAvoided: callsAvoided,
            estimatedSavingUsd: callsAvoided * 0.0001,
            note: `${result.reclassified} facts in ${batchesUsed} batch(es) vs ${result.reclassified} individual calls`,
          });
        }
      }
      return result;
    },
    runCompaction: () =>
      Promise.resolve(
        factsDb.runCompaction({
          inactivePreferenceDays: cfg.memoryTiering.inactivePreferenceDays,
          hotMaxTokens: cfg.memoryTiering.hotMaxTokens,
          hotMaxFacts: cfg.memoryTiering.hotMaxFacts,
        }),
      ),
    runBuildLanguageKeywords: (opts) =>
      runBuildLanguageKeywords(factsDb.getFactsForConsolidation(300), openai, dirname(resolvedSqlitePath), {
        model: opts.model ?? cfg.autoClassify.model ?? resolveReflectionModelAndFallbacks(cfg, "default").defaultModel,
        dryRun: opts.dryRun,
      }),
    runExport: (opts) =>
      Promise.resolve(
        runExport(factsDb, opts, {
          pluginVersion: versionInfo.pluginVersion,
          schemaVersion: versionInfo.schemaVersion,
        }),
      ),
    runDreamCycle: async () => {
      const { defaultModel, fallbackModels } = resolveReflectionModelAndFallbacks(cfg, "default");
      const dreamModel = cfg.nightlyCycle.model ?? defaultModel;
      await runPreConsolidationFlush({ wal, factsDb, vectorDb, embeddings }, api.logger, "dream_cycle_consolidation");
      return runDreamCycle(
        factsDb,
        vectorDb,
        embeddings,
        openai,
        ctx.eventLog ?? null,
        {
          enabled: cfg.nightlyCycle.enabled,
          schedule: cfg.nightlyCycle.schedule,
          reflectWindowDays: cfg.nightlyCycle.reflectWindowDays,
          pruneMode: cfg.nightlyCycle.pruneMode,
          model: dreamModel,
          fallbackModels: fallbackModels ?? [],
          consolidateAfterDays: cfg.nightlyCycle.consolidateAfterDays,
          eventLogArchivalDays: cfg.eventLog.archivalDays,
          eventLogArchivePath: cfg.eventLog.archivePath,
          maxUnconsolidatedAgeDays: cfg.nightlyCycle.maxUnconsolidatedAgeDays,
          logRetentionDays: cfg.nightlyCycle.logRetentionDays,
          vacuumOnCycle: cfg.nightlyCycle.vacuumOnCycle,
        },
        logSink,
        provenanceService,
      );
    },
    runContinuousVerification: async () => {
      if (!verificationStore || !cfg.verification.enabled || !cfg.verification.continuousVerification) {
        return { checked: 0, confirmed: 0, stale: 0, uncertain: 0, errors: 0 };
      }
      return runVerificationCycle(verificationStore, factsDb, openai, {
        cycleDays: cfg.verification.cycleDays,
        verificationModel: cfg.verification.verificationModel,
      });
    },
    runResolveContradictions: () => Promise.resolve(factsDb.resolveContradictions()),
    getMemoryCategories: () => [...getMemoryCategories()],
    mergeResults,
    parseSourceDate,
    versionInfo,
  };
}

/**
 * Register hybrid-mem CLI with the API. Call from index after DB init.
 * Builds handler context and services inside setup so index stays a thin orchestrator.
 */
export function registerHybridMemCliWithApi(api: ClawdbotPluginApi, ctx: HybridMemCliRegistrationContext): void {
  const handlerCtx: HandlerContext = {
    ...ctx,
    logger: api.logger,
    api,
  };
  const services = buildCliContextServices(ctx, api);
  api.registerCli(
    ({ program }: { program: Command }) => {
      try {
        const cliCtx = createHybridMemCliContext(handlerCtx, api, services);
        registerCliWithHelp(program, cliCtx);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "registration",
          operation: "register-cli:callback",
        });
        throw err;
      }
    },
    { commands: [...HYBRID_MEM_CLI_COMMANDS] },
  );
}

function buildRichStatsExtras(ctx: HandlerContext): NonNullable<HybridMemCliContext["richStatsExtras"]> {
  const { credentialsDb, proposalsDb, wal, resolvedSqlitePath, resolvedLancePath } = ctx;
  const memoryDir = dirname(resolvedSqlitePath);
  return {
    getCredentialsCount: () => (credentialsDb ? credentialsDb.list().length : 0),
    getProposalsPending: () => (proposalsDb ? proposalsDb.list({ status: "pending" }).length : 0),
    getProposalsAvailable: () => !!proposalsDb,
    getWalPending: async () => (wal ? (await wal.getValidEntries()).length : 0),
    getLastRunTimestamps: () => {
      const out: { distill?: string; reflect?: string; compact?: string } = {};
      for (const [key, file] of [
        ["distill", ".distill_last_run"],
        ["reflect", ".reflect_last_run"],
        ["compact", ".compact_last_run"],
      ] as const) {
        const path = join(memoryDir, file);
        if (existsSync(path)) {
          try {
            const line = readFileSync(path, "utf-8").split("\n")[0]?.trim() ?? "";
            if (line) out[key] = line;
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: "read-goal-file",
              severity: "info",
              subsystem: "cli",
            });
            /* ignore */
          }
        }
      }
      return out;
    },
    getStorageSizes: async () => {
      let sqliteBytes: number | undefined;
      let lanceBytes: number | undefined;
      async function dirSizeAsync(p: string): Promise<number> {
        try {
          const { execFile } = await import("node:child_process");
          return await new Promise<number>((resolve) => {
            execFile("du", ["-sk", p], (error, stdout) => {
              if (error) {
                try {
                  const st = statSync(p);
                  resolve(st.isDirectory() ? 0 : st.size);
                } catch (err) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    operation: "stat-check",
                    severity: "info",
                    subsystem: "cli",
                  });
                  resolve(0);
                }
                return;
              }
              const match = /^(\d+)/.exec(stdout.trim());
              resolve(match ? Number.parseInt(match[1], 10) * 1024 : 0);
            });
          });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "dir-size",
            severity: "info",
            subsystem: "cli",
          });
          return 0;
        }
      }
      try {
        if (existsSync(resolvedSqlitePath)) sqliteBytes = statSync(resolvedSqlitePath).size;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "stat-check",
          severity: "info",
          subsystem: "cli",
        });
        /* ignore */
      }
      try {
        if (existsSync(resolvedLancePath)) lanceBytes = await dirSizeAsync(resolvedLancePath);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dir-size",
          severity: "info",
          subsystem: "cli",
        });
        /* ignore */
      }
      return { sqliteBytes, lanceBytes };
    },
  };
}

function buildListCommands(
  ctx: HandlerContext,
  api: ClawdbotPluginApi,
): NonNullable<HybridMemCliContext["listCommands"]> {
  const { factsDb, proposalsDb, cfg, resolvedSqlitePath } = ctx;
  const workspaceRoot = () => process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
  const reportDir = (workspace?: string) => join(workspace ?? workspaceRoot(), "memory", "reports");

  function parseReportProposedSections(content: string): string[] {
    const lines = content.split("\n");
    const items: string[] = [];
    let inSection = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("## Suggested TOOLS.md rules") || trimmed === "## Proposed (review before applying)") {
        inSection = true;
        continue;
      }
      if (trimmed.startsWith("## ")) {
        inSection = false;
        continue;
      }
      if (inSection && trimmed.startsWith("- ") && trimmed.length > 2) items.push(trimmed.slice(2).trim());
    }
    return items;
  }

  function parseReportRulesForApply(content: string): { toolsRules: string[]; agentsRules: string[] } {
    const toolsRules: string[] = [];
    const agentsRules: string[] = [];
    const lines = content.split("\n");
    let inSuggested = false;
    let inProposed = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("## Suggested TOOLS.md rules")) {
        inSuggested = true;
        inProposed = false;
        continue;
      }
      if (trimmed === "## Proposed (review before applying)") {
        inSuggested = false;
        inProposed = true;
        continue;
      }
      if (trimmed.startsWith("## ")) {
        inSuggested = false;
        inProposed = false;
        continue;
      }
      if (trimmed.startsWith("- ") && trimmed.length > 2) {
        const text = trimmed.slice(2).trim();
        if (inSuggested) {
          toolsRules.push(text);
        } else if (inProposed) {
          if (text.startsWith("[AGENTS_RULE]") || text.startsWith("[SKILL_UPDATE]")) {
            agentsRules.push(text.replace(/^\[(AGENTS_RULE|SKILL_UPDATE)\]\s*/i, "").trim());
          } else {
            toolsRules.push(text.replace(/^\[TOOLS_RULE\]\s*/i, "").trim());
          }
        }
      }
    }
    return { toolsRules, agentsRules };
  }

  function getLatestCorrectionReport(workspace?: string): { path: string; content: string } | null {
    const dir = reportDir(workspace);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("self-correction-") && f.endsWith(".md"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const path = join(dir, files[0]);
    try {
      const content = readFileSync(path, "utf-8");
      return { path, content };
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "read-report-file",
        severity: "info",
        subsystem: "cli",
      });
      return null;
    }
  }

  return {
    listProposals: async (opts: { status?: string }) => {
      if (!proposalsDb) return [];
      const list = proposalsDb.list({ status: opts.status });
      return list.map((p) => ({
        id: p.id,
        title: p.title,
        targetFile: p.targetFile,
        status: p.status,
        confidence: p.confidence,
        createdAt: p.createdAt,
      }));
    },
    proposalApprove: async (id: string) => {
      if (!proposalsDb) return { ok: false, error: "Proposals not available" };
      const p = proposalsDb.get(id);
      if (!p) return { ok: false, error: `Proposal ${id} not found` };
      if (p.status !== "pending") return { ok: false, error: `Proposal is already ${p.status}` };
      proposalsDb.updateStatus(id, "approved");
      const applyResult = await applyApprovedProposal({ proposalsDb, cfg, resolvedSqlitePath, api }, id);
      if (!applyResult.ok) {
        proposalsDb.updateStatus(id, "pending");
        return { ok: false, error: applyResult.error };
      }
      return { ok: true };
    },
    proposalReject: async (id: string, reason?: string) => {
      if (!proposalsDb) return { ok: false, error: "Proposals not available" };
      const p = proposalsDb.get(id);
      if (!p) return { ok: false, error: `Proposal ${id} not found` };
      if (p.status !== "pending") return { ok: false, error: `Proposal is already ${p.status}` };
      proposalsDb.updateStatus(id, "rejected", undefined, reason);
      return { ok: true };
    },
    listCorrections: async (opts: { workspace?: string }) => {
      const report = getLatestCorrectionReport(opts.workspace);
      if (!report) return { reportPath: null, items: [] };
      const items = parseReportProposedSections(report.content);
      return { reportPath: report.path, items };
    },
    correctionsApproveAll: async (opts: { workspace?: string }) => {
      const report = getLatestCorrectionReport(opts.workspace);
      if (!report) return { applied: 0, error: "No self-correction report found" };
      const { toolsRules, agentsRules } = parseReportRulesForApply(report.content);
      const totalRules = toolsRules.length + agentsRules.length;
      if (totalRules === 0)
        return { applied: 0, error: "No suggested TOOLS or AGENTS rules in report (run self-correction-run first)" };
      const root = opts.workspace ?? workspaceRoot();
      const scCfg = cfg.selfCorrection ?? { toolsSection: "Self-correction rules" };
      const section =
        typeof scCfg === "object" && scCfg && "toolsSection" in scCfg
          ? (scCfg.toolsSection as string)
          : "Self-correction rules";
      let applied = 0;
      if (toolsRules.length > 0) {
        const toolsPath = join(root, "TOOLS.md");
        if (!existsSync(toolsPath)) return { applied: 0, error: "TOOLS.md not found in workspace" };
        const { inserted } = insertRulesUnderSection(toolsPath, section, toolsRules);
        applied += inserted;
      }
      if (agentsRules.length > 0) {
        const agentsPath = join(root, "AGENTS.md");
        const { inserted } = insertRulesUnderSection(agentsPath, section, agentsRules, "# AGENTS");
        applied += inserted;
      }
      return { applied };
    },
    showItem: async (id: string) => {
      const fact = factsDb.getById(id);
      if (fact) return { type: "fact" as const, data: fact };
      if (proposalsDb) {
        const p = proposalsDb.get(id);
        if (p) return { type: "proposal" as const, data: p };
      }
      return null;
    },
  };
}

/**
 * Build the ActiveTaskContext from the handler context.
 * Resolves file paths against the workspace root.
 */
function buildActiveTaskCliContext(handlerCtx: HandlerContext): ActiveTaskContext {
  const workspaceRoot = process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
  const { activeTask } = handlerCtx.cfg;
  // Resolve relative paths against workspace root (use isAbsolute for cross-platform support)
  const activeTaskFilePath = isAbsolute(activeTask.filePath)
    ? activeTask.filePath
    : join(workspaceRoot, activeTask.filePath);
  const memoryDir = join(workspaceRoot, "memory");
  return {
    activeTaskFilePath,
    staleMinutes: parseDuration(activeTask.staleThreshold),
    flushOnComplete: activeTask.flushOnComplete,
    memoryDir,
  };
}

/**
 * Build the full CLI context passed to registerHybridMemCli.
 * Uses handlers from cli/handlers.ts and services for reflection/consolidation/export etc.
 */
export function createHybridMemCliContext(
  handlerCtx: HandlerContext,
  api: ClawdbotPluginApi,
  services: CliContextServices,
): HybridMemCliContext {
  const log = { warn: (m: string) => api.logger.warn?.(m) };
  return {
    factsDb: handlerCtx.factsDb,
    vectorDb: handlerCtx.vectorDb,
    aliasDb: handlerCtx.aliasDb,
    versionInfo: services.versionInfo,
    embeddings: handlerCtx.embeddings,
    mergeResults: services.mergeResults,
    parseSourceDate: services.parseSourceDate,
    getMemoryCategories: services.getMemoryCategories,
    cfg: handlerCtx.cfg,
    runStore: (opts) => handlers.runStoreForCli(handlerCtx, opts, log),
    runInstall: (opts) => Promise.resolve(handlers.runInstallForCli(opts)),
    runVerify: (opts, sink) => handlers.runVerifyForCli(handlerCtx, opts, sink),
    runResetAuthBackoff: () => handlers.runResetAuthBackoffForCli(handlerCtx),
    runDistillWindow: (opts) => Promise.resolve(handlers.runDistillWindowForCli(handlerCtx, opts)),
    runRecordDistill: () => Promise.resolve(handlers.runRecordDistillForCli(handlerCtx)),
    runExtractDaily: (opts, sink) => handlers.runExtractDailyForCli(handlerCtx, opts, sink),
    runExtractProcedures: (opts) => handlers.runExtractProceduresForCli(handlerCtx, opts),
    runGenerateAutoSkills: (opts) => handlers.runGenerateAutoSkillsForCli(handlerCtx, opts),
    runBackfill: (opts, sink) => handlers.runBackfillForCli(handlerCtx, opts, sink),
    runIngestFiles: (opts, sink) => handlers.runIngestFilesForCli(handlerCtx, opts, sink),
    runDistill: (opts, sink) => handlers.runDistillForCli(handlerCtx, opts, sink),
    runMigrateToVault: () => handlers.runMigrateToVaultForCli(handlerCtx),
    runCredentialsList: () => handlers.runCredentialsListForCli(handlerCtx),
    runCredentialsGet: (opts) => handlers.runCredentialsGetForCli(handlerCtx, opts),
    runCredentialsAudit: () => handlers.runCredentialsAuditForCli(handlerCtx),
    runCredentialsPrune: (opts) => handlers.runCredentialsPruneForCli(handlerCtx, opts),
    runUninstall: (opts) => Promise.resolve(handlers.runUninstallForCli(handlerCtx, opts)),
    runUpgrade: (v?) => handlers.runUpgradeForCli(handlerCtx, v),
    runConfigView: (sink) => handlers.runConfigViewForCli(handlerCtx, sink),
    runConfigMode: (mode) => Promise.resolve(handlers.runConfigModeForCli(handlerCtx, mode)),
    runConfigSet: (key, value) => Promise.resolve(handlers.runConfigSetForCli(handlerCtx, key, value)),
    runConfigSetHelp: (key) => Promise.resolve(handlers.runConfigSetHelpForCli(handlerCtx, key)),
    runFindDuplicates: services.runFindDuplicates,
    runConsolidate: services.runConsolidate,
    runReflection: services.runReflection,
    runReflectionRules: services.runReflectionRules,
    runReflectionMeta: services.runReflectionMeta,
    runDreamCycle: services.runDreamCycle,
    runContinuousVerification: services.runContinuousVerification,
    runResolveContradictions: services.runResolveContradictions,
    reflectionConfig: {
      ...handlerCtx.cfg.reflection,
      model: handlerCtx.cfg.reflection.model ?? getDefaultCronModel(getCronModelConfig(handlerCtx.cfg), "default"),
    },
    runClassify: services.runClassify,
    autoClassifyConfig: {
      ...handlerCtx.cfg.autoClassify,
      model: handlerCtx.cfg.autoClassify.model ?? getDefaultCronModel(getCronModelConfig(handlerCtx.cfg), "nano"),
    },
    runCompaction: services.runCompaction,
    runBuildLanguageKeywords: services.runBuildLanguageKeywords,
    runSelfCorrectionExtract: (opts) => Promise.resolve(handlers.runSelfCorrectionExtractForCli(handlerCtx, opts)),
    runSelfCorrectionRun: (opts) => handlers.runSelfCorrectionRunForCli(handlerCtx, opts),
    runAnalyzeFeedbackPhrases: (opts) => handlers.runAnalyzeFeedbackPhrasesForCli(handlerCtx, opts),
    runExtractDirectives: (opts) => handlers.runExtractDirectivesForCli(handlerCtx, opts),
    runExtractReinforcement: (opts) => handlers.runExtractReinforcementForCli(handlerCtx, opts),
    runExtractImplicitFeedback: (opts) => handlers.runExtractImplicitFeedbackForCli(handlerCtx, opts),
    runCrossAgentLearning: () => handlers.runCrossAgentLearningForCli(handlerCtx),
    runToolEffectiveness: (opts) => handlers.runToolEffectivenessForCli(handlerCtx, opts),
    runCostReport: (opts, sink) => handlers.runCostReportForCli(handlerCtx, opts, sink),
    pruneCostLog: (retainDays) => (handlerCtx.costTracker ? handlerCtx.costTracker.pruneOldEntries(retainDays) : 0),
    runExport: services.runExport,
    richStatsExtras: buildRichStatsExtras(handlerCtx),
    listCommands: buildListCommands(handlerCtx, api),
    tieringEnabled: handlerCtx.cfg.memoryTiering.enabled,
    resolvedSqlitePath: handlerCtx.resolvedSqlitePath,
    resolvedLancePath: handlerCtx.resolvedLancePath,
    resolvePath: (file: string) => api.resolvePath(file),
    // Issue #276 — Backup CLI
    runBackup: (opts) =>
      runBackupFn({
        resolvedSqlitePath: handlerCtx.resolvedSqlitePath,
        resolvedLancePath: handlerCtx.resolvedLancePath,
        backupDir: opts?.backupDir,
      }),
    runBackupVerify: () => runBackupVerifyFn({ resolvedSqlitePath: handlerCtx.resolvedSqlitePath }),
    runGenerateProposals: (opts) => handlers.runGenerateProposalsForCli(handlerCtx, opts, api),
    activeTask: handlerCtx.cfg.activeTask.enabled ? buildActiveTaskCliContext(handlerCtx) : undefined,
    eventBus: handlerCtx.eventBus ?? null,
  };
}

/** Register hybrid-mem CLI with the program subcommand and help text */
export function registerCliWithHelp(
  program: { command: (name: string) => { description: (d: string) => unknown } },
  ctx: HybridMemCliContext,
): void {
  const mem = program.command("hybrid-mem").description("Hybrid memory plugin commands");
  try {
    registerHybridMemCli(mem as Parameters<typeof registerHybridMemCli>[0], ctx);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:hybrid-mem",
    });
    throw err;
  }
  if (typeof (mem as { addHelpText?: (loc: string, text: string) => void }).addHelpText === "function") {
    const helpText = ctx.activeTask ? HYBRID_MEM_HELP_GROUPED + HYBRID_MEM_HELP_ACTIVE_TASKS : HYBRID_MEM_HELP_GROUPED;
    (mem as { addHelpText: (loc: string, text: string) => void }).addHelpText("after", helpText);
  }
}
