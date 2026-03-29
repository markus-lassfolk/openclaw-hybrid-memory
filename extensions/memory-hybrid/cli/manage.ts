import { getEnv } from "../utils/env-manager.js";
/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "../utils/process-runner.js";
import { generateTraceId, buildCouncilSessionKey, buildProvenanceMetadata } from "../utils/provenance.js";
import { relativeTime } from "./shared.js";
import { buildAppliedContent, buildUnifiedDiff } from "./proposals.js";
import type {
  FindDuplicatesResult,
  StoreCliOpts,
  StoreCliResult,
  BackfillCliResult,
  BackfillCliSink,
  IngestFilesResult,
  IngestFilesSink,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
  AnalyzeFeedbackPhrasesResult,
  MigrateToVaultResult,
  CredentialsAuditResult,
  CredentialsPruneResult,
  UpgradeCliResult,
  UninstallCliResult,
  ConfigCliResult,
} from "./types.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { SearchResult } from "../types/memory.js";
// biome-ignore lint/style/useImportType: mergeResults kept as value import so typeof mergeResults resolves at the type level without confusion
import { mergeResults, filterByScope } from "../services/merge-results.js";
import type { ScopeFilter } from "../types/memory.js";
import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getDefaultCronModel, vectorDimsForModel } from "../config.js";
import { parseSourceDate } from "../utils/dates.js";
import { capturePluginError } from "../services/error-reporter.js";
import { mergeAgentHealthDashboard } from "../backends/agent-health-store.js";
import { collectForgeState } from "../routes/dashboard-server.js";
import { withExit, type Chainable } from "./shared.js";
import { getLanguageKeywordsFilePath } from "../utils/language-keywords.js";
import { runMemoryDiagnostics } from "../services/memory-diagnostics.js";
import { runContextAudit } from "../services/context-audit.js";
import { runClosedLoopAnalysis, getEffectivenessReport } from "../services/feedback-effectiveness.js";
import { migrateEmbeddings } from "../services/embedding-migration.js";

export type ManageContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  aliasDb?: import("../services/retrieval-aliases.js").AliasDB | null;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
  embeddings: EmbeddingProvider;
  mergeResults: typeof mergeResults;
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  getMemoryCategories: () => string[];
  cfg: HybridMemoryConfig;
  runStore: (opts: StoreCliOpts) => Promise<StoreCliResult>;
  runBackfill: (
    opts: { dryRun: boolean; workspace?: string; limit?: number },
    sink: BackfillCliSink,
  ) => Promise<BackfillCliResult>;
  runIngestFiles: (
    opts: { dryRun: boolean; workspace?: string; paths?: string[] },
    sink: IngestFilesSink,
  ) => Promise<IngestFilesResult>;
  runMigrateToVault: () => Promise<MigrateToVaultResult | null>;
  runCredentialsList: () => Array<{ service: string; type: string; url: string | null }>;
  runCredentialsGet: (opts: {
    service: string;
    type?: string;
  }) => { service: string; type: string; value: string; url: string | null; notes: string | null } | null;
  runCredentialsAudit: () => CredentialsAuditResult;
  runCredentialsPrune: (opts: { dryRun: boolean; yes?: boolean; onlyFlags?: string[] }) => CredentialsPruneResult;
  runUninstall: (opts: { cleanAll: boolean; leaveConfig: boolean }) => Promise<UninstallCliResult>;
  runUpgrade: (version?: string) => Promise<UpgradeCliResult>;
  runConfigView: (sink: import("./types.js").VerifyCliSink) => void;
  runConfigMode: (mode: string) => ConfigCliResult | Promise<ConfigCliResult>;
  runConfigSet: (key: string, value: string) => ConfigCliResult | Promise<ConfigCliResult>;
  runConfigSetHelp: (key: string) => ConfigCliResult | Promise<ConfigCliResult>;
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
  runReflectIdentity?: (opts: {
    dryRun: boolean;
    model?: string;
    verbose?: boolean;
    window?: number;
  }) => Promise<{ insightsExtracted: number; insightsStored: number; questionsAsked: number }>;
  reflectionConfig: { enabled: boolean; defaultWindow: number; minObservations: number; model: string };
  runClassify: (opts: { dryRun: boolean; limit: number; model?: string }) => Promise<{
    reclassified: number;
    total: number;
    breakdown?: Record<string, number>;
  }>;
  autoClassifyConfig: { model: string; batchSize: number; suggestCategories?: boolean };
  runCompaction: () => Promise<{ hot: number; warm: number; cold: number }>;
  runDistill?: (
    opts: { dryRun: boolean; days?: number; verbose?: boolean },
    sink: { log: (s: string) => void; warn: (s: string) => void },
  ) => Promise<{
    stored: number;
    dedupSkipped: number;
    factsExtracted: number;
    sessionsScanned: number;
    dryRun?: boolean;
    skipped?: boolean;
  }>;
  runRecordDistill?: () => Promise<unknown>;
  runExtractProcedures?: (opts: { days?: number; dryRun: boolean }) => Promise<unknown>;
  runBuildLanguageKeywords: (opts: {
    model?: string;
    dryRun?: boolean;
  }) => Promise<
    { ok: true; path: string; topLanguages: string[]; languagesAdded: number } | { ok: false; error: string }
  >;
  runResolveContradictions: () => Promise<{
    autoResolved: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
    ambiguous: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
  }>;
  runSelfCorrectionExtract: (opts: { days?: number; outputPath?: string }) => Promise<SelfCorrectionExtractResult>;
  runAnalyzeFeedbackPhrases?: (opts: {
    days?: number;
    model?: string;
    outputPath?: string;
    learn?: boolean;
  }) => Promise<AnalyzeFeedbackPhrasesResult>;
  runSelfCorrectionRun: (opts: {
    extractPath?: string;
    incidents?: Array<{
      userMessage: string;
      precedingAssistant: string;
      followingAssistant: string;
      timestamp?: string;
      sessionFile: string;
    }>;
    workspace?: string;
    dryRun?: boolean;
    model?: string;
    approve?: boolean;
    applyTools?: boolean;
    full?: boolean;
  }) => Promise<SelfCorrectionRunResult>;
  runExport: (opts: {
    outputPath: string;
    excludeCredentials?: boolean;
    includeCredentials?: boolean;
    sources?: string[];
    mode?: "replace" | "additive";
  }) => Promise<{ factsExported: number; proceduresExported: number; filesWritten: number; outputPath: string }>;
  richStatsExtras?: {
    getCredentialsCount: () => number;
    getProposalsPending: () => number;
    getProposalsAvailable: () => boolean;
    getWalPending: () => Promise<number>;
    getLastRunTimestamps: () => { distill?: string; reflect?: string; compact?: string };
    getStorageSizes: () => Promise<{ sqliteBytes?: number; lanceBytes?: number }>;
  };
  listCommands?: {
    listProposals: (opts: {
      status?: string;
    }) => Promise<
      Array<{ id: string; title: string; targetFile: string; status: string; confidence: number; createdAt: number }>
    >;
    proposalApprove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    proposalReject: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;
    listCorrections: (opts: { workspace?: string }) => Promise<{ reportPath: string | null; items: string[] }>;
    correctionsApproveAll: (opts: { workspace?: string }) => Promise<{ applied: number; error?: string }>;
    showItem: (id: string) => Promise<{ type: "fact" | "proposal"; data: unknown } | null>;
  };
  tieringEnabled: boolean;
  resolvedSqlitePath?: string;
  resolvedLancePath?: string;
  runBackup?: (opts?: { backupDir?: string }) => Promise<import("../cli/backup.js").BackupCliResult>;
  runBackupVerify?: () => import("../cli/backup.js").BackupVerifyResult;
  resolvePath?: (file: string) => string;
  runExtractDaily?: (
    opts: { days: number; dryRun: boolean; verbose?: boolean },
    sink: { log: (s: string) => void; warn: (s: string) => void },
  ) => Promise<{ stored?: number; totalStored?: number; totalExtracted?: number; daysBack?: number; dryRun?: boolean }>;
  runExtractDirectives?: (opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
  }) => Promise<{ sessionsScanned: number }>;
  runExtractReinforcement?: (opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
  }) => Promise<{ sessionsScanned: number }>;
  runExtractImplicitFeedback?: (opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    includeTrajectories?: boolean;
    includeClosedLoop?: boolean;
  }) => Promise<{
    signalsExtracted: number;
    positiveCount: number;
    negativeCount: number;
    trajectoriesBuilt: number;
    sessionsScanned: number;
    closedLoopReport?: string;
  }>;
  runGenerateAutoSkills?: (opts: {
    dryRun: boolean;
    verbose?: boolean;
  }) => Promise<{ generated: number; skipped?: number; paths?: string[] }>;
  runGenerateProposals?: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<{ created: number }>;
  runDreamCycle?: () => Promise<import("../services/dream-cycle.js").DreamCycleResult>;
  runContinuousVerification?: () => Promise<import("../services/continuous-verifier.js").VerificationCycleResult>;
  runCrossAgentLearning?: () => Promise<import("../cli/handlers.js").CrossAgentLearningCliResult>;
  runToolEffectiveness?: (opts?: { verbose?: boolean }) => Promise<string>;
  runCostReport?: (opts: import("../cli/handlers.js").CostReportCliOpts, sink: { log: (msg: string) => void }) => void;
  pruneCostLog?: (retainDays?: number) => number;
  auditStore?: import("../backends/audit-store.js").AuditStore | null;
  agentHealthStore?: import("../backends/agent-health-store.js").AgentHealthStore | null;
};

export function registerManageCommands(mem: Chainable, ctx: ManageContext): void {
  const {
    factsDb,
    vectorDb,
    aliasDb,
    versionInfo,
    embeddings,
    mergeResults: merge,
    parseSourceDate: parseDate,
    getMemoryCategories,
    cfg,
    runStore,
    runBackfill,
    runIngestFiles,
    runMigrateToVault,
    runCredentialsList,
    runCredentialsGet,
    runCredentialsAudit,
    runCredentialsPrune,
    runUpgrade,
    runUninstall,
    runConfigView,
    runConfigMode,
    runConfigSet,
    runConfigSetHelp,
    runFindDuplicates,
    runConsolidate,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    runReflectIdentity,
    reflectionConfig,
    runClassify,
    autoClassifyConfig,
    runSelfCorrectionExtract,
    runSelfCorrectionRun,
    runAnalyzeFeedbackPhrases,
    runCompaction,
    runDistill,
    runExtractProcedures,
    runBuildLanguageKeywords,
    runExport,
    listCommands,
    tieringEnabled,
    resolvedSqlitePath,
    runExtractDaily,
    runExtractDirectives,
    runExtractReinforcement,
    runExtractImplicitFeedback,
    runGenerateAutoSkills,
    runGenerateProposals,
    resolvePath,
    runDreamCycle,
    runContinuousVerification,
    runCrossAgentLearning,
    runToolEffectiveness,
    runCostReport,
    pruneCostLog,
    resolvedLancePath,
    runBackup,
    runBackupVerify,
    auditStore,
    agentHealthStore,
  } = ctx;

  const BACKFILL_DECAY_MARKER = ".backfill-decay-done";

  const agentsCmd = mem.command("agents").description("Multi-agent health (Issue #789)");
  agentsCmd
    .command("health")
    .description("Show per-agent health (SQLite + Forge live state)")
    .option("--agent <id>", "Filter to a single agent id")
    .action(
      withExit(async (opts?: { agent?: string }) => {
        if (!agentHealthStore) {
          console.error("Agent health store is not available.");
          process.exitCode = 1;
          return;
        }
        const forge = await collectForgeState();
        const views = mergeAgentHealthDashboard(forge, agentHealthStore.listAll());
        const filter = opts?.agent?.trim().toLowerCase();
        let any = false;
        for (const v of views) {
          if (filter && v.agentId !== filter) continue;
          any = true;
          console.log(
            `${v.agentId}\t${v.status}\tscore=${v.score.toFixed(1)}\tlast=${new Date(v.lastSeen).toISOString()}\t${v.lastTask.slice(0, 120)}`,
          );
        }
        if (!any) {
          console.log("(no rows)");
        }
      }),
    );
  agentsCmd
    .command("activity")
    .description("Recent audit events for an agent (requires audit log)")
    .requiredOption("--agent <id>", "Agent id")
    .option("--hours <n>", "Lookback hours", "24")
    .action(
      withExit(async (opts?: { agent?: string; hours?: string }) => {
        if (!auditStore) {
          console.error("Audit store is not available.");
          process.exitCode = 1;
          return;
        }
        const agent = opts?.agent?.trim();
        if (!agent) {
          console.error("--agent is required.");
          process.exitCode = 1;
          return;
        }
        const hours = Math.max(1, Math.min(720, Number.parseInt(String(opts?.hours ?? "24"), 10) || 24));
        const sinceMs = Date.now() - hours * 3600 * 1000;
        const rows = auditStore.query({ sinceMs, agentId: agent, limit: 200 });
        for (const r of rows) {
          const ts = new Date(r.timestamp).toISOString();
          console.log(`${ts}\t${r.action}\t${r.outcome}\t${r.target ?? ""}`);
        }
        if (rows.length === 0) {
          console.log("(no events)");
        }
      }),
    );

  mem
    .command("audit")
    .description("Cross-agent audit trail (Issue #790): query logged memory operations")
    .option("--hours <n>", "Look back window in hours", "24")
    .option("--agent <id>", "Filter by agent id")
    .option("--outcome <o>", "Filter: success, partial, or failed")
    .option("--target <t>", "Substring match on target field")
    .option("--format <f>", "Output: lines, summary, or timeline", "lines")
    .action(
      withExit(
        async (opts?: {
          hours?: string;
          agent?: string;
          outcome?: string;
          target?: string;
          format?: string;
        }) => {
          if (!auditStore) {
            console.error("Audit store is not available (e.g. in-memory tests or missing DB path).");
            process.exitCode = 1;
            return;
          }
          const hours = Math.max(1, Math.min(720, Number.parseInt(String(opts?.hours ?? "24"), 10) || 24));
          const sinceMs = Date.now() - hours * 3600 * 1000;
          const outcome =
            opts?.outcome === "success" || opts?.outcome === "partial" || opts?.outcome === "failed"
              ? opts.outcome
              : undefined;
          const fmt = (opts?.format ?? "lines").toLowerCase();
          const rows = auditStore.query({
            sinceMs,
            agentId: opts?.agent?.trim() || undefined,
            outcome,
            targetContains: opts?.target?.trim() || undefined,
            limit: fmt === "summary" ? 5000 : 500,
          });
          if (fmt === "summary") {
            let total = 0;
            const byOutcome: Record<string, number> = { success: 0, partial: 0, failed: 0 };
            const byAgent: Record<string, number> = {};
            for (const r of rows) {
              total++;
              byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
              byAgent[r.agentId] = (byAgent[r.agentId] ?? 0) + 1;
            }
            console.log(`Audit (last ${hours}h, filtered): total=${total}`);
            console.log(`  success=${byOutcome.success} partial=${byOutcome.partial} failed=${byOutcome.failed}`);
            for (const [a, c] of Object.entries(byAgent).sort((x, y) => y[1] - x[1])) {
              console.log(`  ${a}: ${c}`);
            }
            return;
          }
          if (fmt === "timeline") {
            const byHour = new Map<string, number>();
            for (const r of rows) {
              const d = new Date(r.timestamp);
              const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;
              byHour.set(key, (byHour.get(key) ?? 0) + 1);
            }
            const keys = [...byHour.keys()].sort();
            for (const k of keys) {
              console.log(`${k}  ${"█".repeat(Math.min(40, byHour.get(k) ?? 0))} (${byHour.get(k)})`);
            }
            return;
          }
          for (const r of rows) {
            const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19);
            const dur = r.durationMs != null ? ` [${r.durationMs}ms]` : "";
            const tgt = r.target ? ` ${r.target}` : "";
            const err = r.error ? ` err=${r.error.slice(0, 80)}` : "";
            console.log(`${ts} ${r.agentId} ${r.action} ${r.outcome}${tgt}${dur}${err}`);
          }
          if (rows.length === 0) {
            console.log("(no events in window)");
          }
        },
      ),
    );

  mem
    .command("run-all")
    .description(
      "Run all maintenance tasks in optimal order (prune, compact, distill, extract-*, reflection, generate-proposals, self-correction, build-languages). Use --dry-run to list steps only.",
    )
    .option("--dry-run", "List steps that would run without executing")
    .option("--verbose", "Show detailed output for each step")
    .action(
      withExit(async (opts?: { dryRun?: boolean; verbose?: boolean }) => {
        const dryRun = !!opts?.dryRun;
        const verbose = !!opts?.verbose;
        const log = (s: string) => console.log(s);
        const sink = { log, warn: (s: string) => console.warn(s) };
        const memoryDir = resolvedSqlitePath ? dirname(resolvedSqlitePath) : null;
        const backfillDonePath = memoryDir ? join(memoryDir, BACKFILL_DECAY_MARKER) : null;

        const steps: { name: string; run: () => Promise<void> }[] = [
          {
            name: "backfill-decay",
            run: async () => {
              if (backfillDonePath && existsSync(backfillDonePath)) {
                if (verbose) log("Backfill-decay already done; skipping.");
                return;
              }
              const n = factsDb.backfillDecay();
              const total = Object.values(n).reduce((a, b) => a + b, 0);
              log(`Backfilled decay for ${total} facts.`);
              if (backfillDonePath) {
                try {
                  writeFileSync(backfillDonePath, `${new Date().toISOString()}\n`);
                } catch (err) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    subsystem: "cli",
                    operation: "run-all:backfill-decay-marker",
                  });
                }
              }
            },
          },
          {
            name: "prune",
            run: async () => {
              const n = factsDb.prune();
              log(`Pruned ${n} expired facts.`);
            },
          },
          {
            name: "compact",
            run: async () => {
              const c = await runCompaction();
              log(`Compaction: hot=${c.hot} warm=${c.warm} cold=${c.cold}`);
            },
          },
          ...(runDistill
            ? [
                {
                  name: "distill (3 days)",
                  run: async () => {
                    const r = await runDistill({ dryRun: false, days: 3, verbose }, sink);
                    log(`Distill: ${r.stored} stored from ${r.sessionsScanned} sessions.`);
                  },
                },
              ]
            : []),
          ...(runExtractDaily
            ? [
                {
                  name: "extract-daily (7 days)",
                  run: async () => {
                    const r = await runExtractDaily({ days: 7, dryRun: false, verbose }, sink);
                    const stored = r.totalStored ?? r.stored ?? 0;
                    log(`Extract-daily: ${stored} stored.`);
                  },
                },
              ]
            : []),
          ...(runExtractDirectives
            ? [
                {
                  name: "extract-directives (7 days)",
                  run: async () => {
                    const r = await runExtractDirectives({ days: 7, verbose, dryRun: false });
                    log(`Extract-directives: ${r.sessionsScanned} sessions scanned.`);
                  },
                },
              ]
            : []),
          ...(runExtractReinforcement
            ? [
                {
                  name: "extract-reinforcement (7 days)",
                  run: async () => {
                    const r = await runExtractReinforcement({ days: 7, verbose, dryRun: false });
                    log(`Extract-reinforcement: ${r.sessionsScanned} sessions scanned.`);
                  },
                },
              ]
            : []),
          ...(runExtractImplicitFeedback
            ? [
                {
                  name: "extract-implicit (3 days)",
                  run: async () => {
                    const r = await runExtractImplicitFeedback({ days: 3, verbose, dryRun: false });
                    log(
                      `Extract-implicit: ${r.signalsExtracted} signals (${r.positiveCount}+/${r.negativeCount}-) from ${r.sessionsScanned} sessions.`,
                    );
                  },
                },
              ]
            : []),
          ...(runExtractProcedures
            ? [
                {
                  name: "extract-procedures (7 days)",
                  run: async () => {
                    await runExtractProcedures({ days: 7, dryRun: false });
                    log("Extract procedures done.");
                  },
                },
              ]
            : []),
          ...(runGenerateAutoSkills
            ? [
                {
                  name: "generate-auto-skills",
                  run: async () => {
                    const r = await runGenerateAutoSkills({ dryRun: false, verbose });
                    log(`Generate-auto-skills: ${r.generated} generated.`);
                  },
                },
              ]
            : []),
          {
            name: "reflect",
            run: async () => {
              const r = await runReflection({
                window: reflectionConfig.defaultWindow,
                dryRun: false,
                model: reflectionConfig.model,
                verbose,
              });
              log(`Reflect: ${r.patternsStored} patterns stored.`);
            },
          },
          {
            name: "reflect-rules",
            run: async () => {
              const r = await runReflectionRules({ dryRun: false, model: reflectionConfig.model, verbose });
              log(`Reflect-rules: ${r.rulesStored} rules stored.`);
            },
          },
          {
            name: "reflect-meta",
            run: async () => {
              const r = await runReflectionMeta({ dryRun: false, model: reflectionConfig.model, verbose });
              log(`Reflect-meta: ${r.metaStored} meta-patterns stored.`);
            },
          },
          ...(runReflectIdentity
            ? [
                {
                  name: "reflect-identity",
                  run: async () => {
                    const r = await runReflectIdentity({
                      dryRun: false,
                      model: reflectionConfig.model,
                      verbose,
                      window: reflectionConfig.defaultWindow,
                    });
                    log(`Reflect-identity: ${r.insightsStored} insights stored.`);
                  },
                },
              ]
            : []),
          ...(runGenerateProposals
            ? [
                {
                  name: "generate-proposals",
                  run: async () => {
                    const r = await runGenerateProposals({ dryRun: false, verbose });
                    log(`Generate-proposals: ${r.created} created.`);
                  },
                },
              ]
            : []),
          {
            name: "self-correction-run",
            run: async () => {
              await runSelfCorrectionRun({ dryRun: false });
              log("Self-correction run done.");
            },
          },
          {
            name: "build-languages",
            run: async () => {
              const langPath = getLanguageKeywordsFilePath();
              if (langPath && existsSync(langPath)) {
                try {
                  const ageMs = Date.now() - statSync(langPath).mtimeMs;
                  const ageDays = ageMs / (24 * 60 * 60 * 1000);
                  if (ageDays < 7) {
                    if (verbose) log(`Build-languages: skipped (updated ${ageDays.toFixed(1)} days ago).`);
                    return;
                  }
                } catch (err) {
                  if (verbose) log(`Build-languages: could not read mtime (${err}); running anyway.`);
                }
              }
              const r = await runBuildLanguageKeywords({ dryRun: false });
              if (r.ok) log(`Build-languages: ${r.languagesAdded} languages added.`);
              else if (verbose) log(`Build-languages: ${r.error}`);
            },
          },
        ];
        if (dryRun) {
          log("run-all (dry-run). Would run:");
          steps.forEach((s, i) => log(`  ${i + 1}. ${s.name}`));
          return;
        }
        for (let i = 0; i < steps.length; i++) {
          log(`[${i + 1}/${steps.length}] ${steps[i].name}`);
          try {
            await steps[i].run();
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: `run-all:${steps[i].name}`,
            });
            throw err;
          }
        }
        log("run-all complete.");
      }),
    );

  mem
    .command("compact")
    .description("Run tier compaction: completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT")
    .action(
      withExit(async () => {
        let counts;
        try {
          counts = await runCompaction();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "compact",
          });
          throw err;
        }
        console.log(`Tier compaction: hot=${counts.hot} warm=${counts.warm} cold=${counts.cold}`);
      }),
    );

  mem
    .command("vectordb-optimize")
    .description("Compact LanceDB fragments and prune old versions to reclaim disk space and reduce memory usage")
    .option("--older-than-days <days>", "Remove versions older than this many days (default: 7)", "7")
    .action(
      withExit(async (opts?: { olderThanDays?: string }) => {
        const olderThanDays = Number.parseInt(opts?.olderThanDays ?? "7", 10);
        const olderThanMs = olderThanDays * 24 * 60 * 60 * 1000;
        try {
          const stats = await vectorDb.optimize(olderThanMs);
          console.log(
            `LanceDB: compacted ${stats.compacted} fragments, pruned ${stats.removedFragments} fragment(s), freed ${stats.freedBytes} bytes`,
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "vectordb-optimize",
          });
          throw err;
        }
      }),
    );

  mem
    .command("stats")
    .description(
      "Show memory statistics. Rich output includes procedures, rules, patterns, directives, graph, and operational info. Use --efficiency for tiers, sources, and token estimates.",
    )
    .option("--efficiency", "Show tier/source breakdown, estimated tokens, and token-savings note")
    .option("--brief", "Show only storage and decay counts (legacy-style)")
    .action(
      withExit(async (opts?: { efficiency?: boolean; brief?: boolean }) => {
        const efficiency = opts?.efficiency ?? false;
        const brief = opts?.brief ?? false;
        const sqlCount = factsDb.count();
        let lanceCount = 0;
        try {
          lanceCount = await vectorDb.count();
        } catch (err) {
          capturePluginError(err as Error, {
            operation: "vector-count",
            severity: "info",
            subsystem: "cli",
          });
          // vectorDb may be unavailable
        }
        const breakdown = factsDb.statsBreakdownByTier();
        const expired = factsDb.countExpired();

        const extras = ctx.richStatsExtras;
        const useRich = !brief && extras;

        if (useRich) {
          const byCategory = factsDb.statsBreakdownByCategory();
          const procedures = factsDb.proceduresCount();
          const proceduresValidated = factsDb.proceduresValidatedCount();
          const proceduresPromoted = factsDb.proceduresPromotedCount();
          const directives = factsDb.directivesCount();
          const rules = byCategory.rule ?? 0;
          const patterns = byCategory.pattern ?? 0;
          const metaPatterns = factsDb.metaPatternsCount();
          const links = factsDb.linksCount();
          const entities = factsDb.entityCount();
          const categoriesConfigured = getMemoryCategories();
          const uniqueInMemory = factsDb.uniqueMemoryCategories();
          const credentials = extras.getCredentialsCount();
          const proposalsPending = extras.getProposalsPending();
          const proposalsAvailable = extras.getProposalsAvailable();
          const walPending = await extras.getWalPending();
          const timestamps = extras.getLastRunTimestamps();
          const sizes = await extras.getStorageSizes();

          const { reflectionPatternsCount, reflectionRulesCount } = factsDb.statsReflection();
          const selfCorrectionCount = factsDb.selfCorrectionIncidentsCount();
          const languageKeywordsCount = factsDb.languageKeywordsCount();

          console.log("=== Memory Statistics (rich) ===");
          console.log(`Schema version: ${versionInfo.schemaVersion}`);
          console.log(`Plugin version: ${versionInfo.pluginVersion}`);
          console.log(`Memory Manager: ${versionInfo.memoryManagerVersion}`);
          console.log("");
          console.log(`Total facts (SQLite): ${sqlCount}`);
          console.log(`Total vectors (LanceDB): ${lanceCount}`);
          console.log(`Expired (prunable): ${expired}`);
          console.log("");
          const proceduresNote = procedures === 0 ? " (run extract-procedures to populate)" : "";
          console.log(
            `Procedures: ${procedures} (validated: ${proceduresValidated}, promoted: ${proceduresPromoted})${proceduresNote}`,
          );
          console.log(`Rules: ${rules}`);
          console.log(`Patterns: ${patterns}`);
          console.log(`Meta-patterns: ${metaPatterns}`);
          console.log(`Directives: ${directives}`);
          console.log(`Reflection (patterns/rules): ${reflectionPatternsCount}/${reflectionRulesCount}`);
          console.log(`Self-correction incidents: ${selfCorrectionCount}`);
          console.log(`Language keywords: ${languageKeywordsCount}`);
          console.log("");
          console.log(`Graph (links/entities): ${links}/${entities}`);
          console.log(`Credentials (vaulted): ${credentials}`);
          const proposalsLine = proposalsAvailable
            ? `Proposals (pending): ${proposalsPending}${proposalsPending === 0 ? " (run generate-proposals to create)" : ""}`
            : "Proposals (pending): — (persona proposals disabled)";
          console.log(proposalsLine);
          console.log(`WAL (pending distill): ${walPending}`);
          console.log("");
          console.log(
            `Categories configured: ${categoriesConfigured.length} [${categoriesConfigured.slice(0, 3).join(", ")}...]`,
          );
          console.log(`Categories in memory: ${uniqueInMemory.length} [${uniqueInMemory.slice(0, 3).join(", ")}...]`);
          console.log("");
          console.log(
            `Breakdown: hot=${breakdown.hot}, warm=${breakdown.warm}, cold=${breakdown.cold}, structural=${breakdown.structural}`,
          );
          console.log("");
          if (timestamps.distill) console.log(`Last distill: ${timestamps.distill}`);
          if (timestamps.reflect) console.log(`Last reflect: ${timestamps.reflect}`);
          if (timestamps.compact) console.log(`Last compact: ${timestamps.compact}`);
          if (timestamps.distill || timestamps.reflect || timestamps.compact) console.log("");
          if (sizes.sqliteBytes != null) console.log(`SQLite size: ${(sizes.sqliteBytes / 1024 / 1024).toFixed(2)} MB`);
          if (sizes.lanceBytes != null) console.log(`LanceDB size: ${(sizes.lanceBytes / 1024 / 1024).toFixed(2)} MB`);
          if (sizes.sqliteBytes != null || sizes.lanceBytes != null) console.log("");
        } else if (efficiency) {
          const byTier = breakdown;
          const bySource = factsDb.statsBySource();
          const estimatedTokens = factsDb.estimateTokens();
          console.log("=== Memory Efficiency Stats ===");
          console.log(
            `Breakdown: hot=${byTier.hot}, warm=${byTier.warm}, cold=${byTier.cold}, structural=${byTier.structural}`,
          );
          console.log(`Sources: ${Object.keys(bySource).length}`);
          for (const [src, count] of Object.entries(bySource).slice(0, 5)) {
            console.log(`  ${src}: ${count}`);
          }
          console.log(`Estimated tokens (all tiers): ~${estimatedTokens}`);
          console.log("");
          console.log("Note: Tiering and scoping can significantly reduce token usage in LLM context.");
        } else {
          console.log(`Total facts (SQLite): ${sqlCount}`);
          console.log(`Total vectors (LanceDB): ${lanceCount}`);
          console.log(`Expired (prunable): ${expired}`);
          console.log(
            `Breakdown: hot=${breakdown.hot}, warm=${breakdown.warm}, cold=${breakdown.cold}, structural=${breakdown.structural}`,
          );
        }
      }),
    );

  mem
    .command("prune")
    .description("Remove expired facts (decayed past threshold)")
    .action(
      withExit(async () => {
        const before = factsDb.count();
        const pruned = factsDb.prune();
        const after = factsDb.count();
        console.log(`Pruned ${pruned} expired facts. Before: ${before}, After: ${after}`);
      }),
    );

  mem
    .command("checkpoint")
    .description("Checkpoint vector DB to disk (LanceDB optimization)")
    .action(
      withExit(async () => {
        await vectorDb.checkpoint?.();
        console.log("Vector DB checkpoint complete.");
      }),
    );

  mem
    .command("re-index")
    .description(
      "Reset LanceDB vector index and re-embed all facts from SQLite (use after switching embedding model, e.g. to a larger one).",
    )
    .option("--batch-size <n>", "Facts per embed batch (default: 50)", "50")
    .action(
      withExit(async (opts?: { batchSize?: string }) => {
        const batchSize = Math.max(1, Math.min(500, Number.parseInt(String(opts?.batchSize ?? "50"), 10) || 50));
        console.log("Re-index: resetting LanceDB table...");
        await vectorDb.resetTableForReindex();
        console.log("Re-index: re-embedding all facts (this may take a while)...");
        const result = await migrateEmbeddings({
          factsDb,
          vectorDb,
          embeddings,
          batchSize,
          onProgress: (completed, total) => {
            if (total > 0 && completed % Math.max(1, Math.floor(total / 10)) === 0) {
              process.stdout.write(`  ${completed}/${total} facts embedded...\r`);
            }
          },
          logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
        });
        console.log(
          `Re-index complete: ${result.migrated} embedded, ${result.skipped} skipped, ${result.errors.length} errors.`,
        );
        if (result.errors.length > 0 && result.errors.length <= 10) {
          for (const e of result.errors) console.warn(`  - ${e}`);
        } else if (result.errors.length > 10) {
          console.warn(`  (${result.errors.length} errors; first 5:)`);
          for (const e of result.errors.slice(0, 5)) console.warn(`  - ${e}`);
        }
      }),
    );

  mem
    .command("backfill-decay")
    .description("Backfill decayAt for facts missing it (one-time migration)")
    .action(
      withExit(async () => {
        const updated = factsDb.backfillDecay();
        console.log(`Backfilled decayAt for ${updated} facts.`);
      }),
    );

  mem
    .command("test")
    .description("Run memory diagnostics (structured + semantic + hybrid + auto-recall)")
    .action(
      withExit(async () => {
        const result = await runMemoryDiagnostics({
          factsDb,
          vectorDb,
          embeddings,
          aliasDb,
          minScore: cfg.autoRecall?.minScore ?? 0.3,
          autoRecallLimit: cfg.autoRecall?.limit ?? 10,
        });

        const icon = (ok: boolean) => (ok ? "✅" : "❌");
        console.log("=== Memory Diagnostics ===");
        console.log(`Marker: ${result.markerId}`);
        console.log(`Structured search: ${icon(result.structured.ok)} (${result.structured.count} result(s))`);
        console.log(`Semantic search: ${icon(result.semantic.ok)} (${result.semantic.count} result(s))`);
        console.log(`Hybrid search: ${icon(result.hybrid.ok)} (${result.hybrid.count} result(s))`);
        console.log(`Auto-recall: ${icon(result.autoRecall.ok)} (${result.autoRecall.count} candidate(s))`);
      }),
    );

  mem
    .command("model-info [model]")
    .description(
      "Show vector dimensions for a built-in embedding model name, or print current embedding config when [model] is omitted",
    )
    .action(
      withExit(async (modelArg?: string) => {
        const name = typeof modelArg === "string" ? modelArg.trim() : "";
        if (!name) {
          const emb = cfg.embedding;
          console.log("=== Current embedding config ===");
          console.log(`Provider: ${emb.provider}`);
          console.log(`Model: ${emb.model}`);
          if (emb.models && emb.models.length > 0) {
            console.log(`Models (multi): ${emb.models.join(", ")}`);
          }
          console.log(`Dimensions (resolved in config): ${emb.dimensions}`);
          try {
            const catalog = vectorDimsForModel(emb.model);
            if (catalog === emb.dimensions) {
              console.log(`Catalog dimensions for '${emb.model}': ${catalog} (matches config)`);
            } else {
              console.log(
                `Catalog dimensions for '${emb.model}': ${catalog} (config uses ${emb.dimensions} — may be intentional)`,
              );
            }
          } catch {
            console.log(
              `Model '${emb.model}' is not in the built-in catalog; dimensions are taken from config (${emb.dimensions}).`,
            );
            console.log(
              "For custom Ollama/ONNX models, set embedding.dimensions to the vector size your model outputs.",
            );
          }
          return;
        }
        try {
          const dims = vectorDimsForModel(name);
          console.log(`Model: ${name}`);
          console.log(`Vector dimensions: ${dims}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`error: ${msg}`);
          console.error(
            "For models not in the catalog, set embedding.dimensions in plugin config to the vector size your provider returns.",
          );
          process.exitCode = 1;
          return;
        }
      }),
    );

  mem
    .command("context-audit")
    .description("Report token usage per injected context source and recommendations")
    .action(
      withExit(async () => {
        const audit = await runContextAudit({ cfg, factsDb });

        console.log("=== Context Budget Audit ===");
        console.log(
          `Auto-recall: ${audit.autoRecall.enabled ? `${audit.autoRecall.budgetTokens} token budget` : "disabled"} (format: ${audit.autoRecall.injectionFormat}, hot: ${audit.autoRecall.hotTokens})`,
        );
        console.log(
          `Procedures: ${audit.procedures.enabled ? `${audit.procedures.tokens} tokens` : "disabled"} (lines: ${audit.procedures.lines})`,
        );
        console.log(
          `Active tasks: ${audit.activeTasks.enabled ? `${audit.activeTasks.tokens} tokens` : "disabled"} (active: ${audit.activeTasks.count}, stale: ${audit.activeTasks.stale})`,
        );
        console.log(`Workspace files: ${audit.workspaceFiles.totalTokens} tokens`);
        if (audit.workspaceFiles.files.length > 0) {
          for (const file of audit.workspaceFiles.files) {
            console.log(`  - ${file.file}: ${file.tokens} tokens`);
          }
        }
        console.log(`Total injected (est.): ${audit.totalTokens} tokens`);

        if (audit.recommendations.length > 0) {
          console.log("Recommendations:");
          for (const rec of audit.recommendations) {
            console.log(`  - ${rec}`);
          }
        } else {
          console.log("Recommendations: none — context budget is healthy.");
        }
      }),
    );

  mem
    .command("search <query>")
    .description("Hybrid search (vector + SQL). Returns up to 20 results.")
    .option("--category <cat>", "Filter by category")
    .option("--entity <ent>", "Filter by entity")
    .option("--key <k>", "Filter by key")
    .option("--source <src>", "Filter by source")
    .option("--tier <t>", "Filter by tier (hot/warm/cold/structural)")
    .option("--scope <s>", "Filter by scope (global/user/agent/session)")
    .option("--scope-target <st>", "Scope target (userId/agentId/sessionId)")
    .action(
      withExit(
        async (
          query: string,
          opts?: {
            category?: string;
            entity?: string;
            key?: string;
            source?: string;
            tier?: string;
            scope?: string;
            scopeTarget?: string;
          },
        ) => {
          try {
            // Build scope filter from CLI options
            const scopeFilter: ScopeFilter | undefined = opts?.scope
              ? (() => {
                  const filter: ScopeFilter = {};
                  if (opts.scope === "user") filter.userId = opts.scopeTarget || null;
                  else if (opts.scope === "agent") filter.agentId = opts.scopeTarget || null;
                  else if (opts.scope === "session") filter.sessionId = opts.scopeTarget || null;
                  return filter;
                })()
              : undefined;

            const embedding = await embeddings.embed(query);
            const vectorResults = await vectorDb.search(embedding, 50);
            const sqlResults = factsDb.search(query, 50, {
              scopeFilter,
              tierFilter: opts?.tier === "cold" ? "all" : "warm",
              reinforcementBoost: cfg.distill?.reinforcementBoost ?? 0.1,
              diversityWeight: cfg.reinforcement?.diversityWeight ?? 1.0,
            });

            // Filter vector results by scope
            let filteredVectorResults = vectorResults;
            if (scopeFilter) {
              filteredVectorResults = filterByScope(
                vectorResults,
                (id, opts) => factsDb.getById(id, opts),
                scopeFilter,
              );
            }

            let combined = merge(filteredVectorResults, sqlResults, 20, factsDb);

            if (tieringEnabled && opts?.tier !== "cold") {
              combined = combined.filter((r) => r.entry.tier !== "cold");
            }

            console.log(`Search results for "${query}": ${combined.length}`);
            for (const r of combined) {
              console.log(
                `  [${r.entry.id}] ${r.entry.text} (score=${r.score.toFixed(3)}, tier=${r.entry.tier}, category=${r.entry.category ?? "none"})`,
              );
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "search",
            });
            throw err;
          }
        },
      ),
    );

  mem
    .command("lookup <id>")
    .description("Lookup a fact by ID")
    .action(
      withExit(async (id: string) => {
        try {
          const fact = factsDb.get(id);
          if (!fact) {
            console.log(`Fact not found: ${id}`);
            return;
          }
          console.log(JSON.stringify(fact, null, 2));
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "lookup",
          });
          throw err;
        }
      }),
    );

  mem
    .command("forget <id>")
    .description("Remove a memory by ID (from SQLite and LanceDB). ID can be full UUID or a short hex prefix.")
    .option("--yes", "Skip confirmation")
    .action(
      withExit(async (id: string, opts?: { yes?: boolean }) => {
        try {
          let resolvedId = id;
          if (id.length < 36 && !id.includes("-")) {
            const prefixResult = factsDb.findByIdPrefix(id);
            if (prefixResult && "ambiguous" in prefixResult) {
              const countText = prefixResult.count >= 3 ? `${prefixResult.count}+` : `${prefixResult.count}`;
              console.error(
                `Prefix "${id}" is ambiguous (matches ${countText} facts). Use the full UUID from search or lookup.`,
              );
              process.exitCode = 1;
              return;
            }
            if (prefixResult && "id" in prefixResult) {
              resolvedId = prefixResult.id;
            }
          }
          const fact = factsDb.get(resolvedId);
          if (!opts?.yes) {
            if (fact) {
              console.log(`About to remove: ${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}`);
            } else {
              console.log(`Memory not found in SQLite (may still exist in LanceDB): ${resolvedId}`);
            }
            console.log("Run with --yes to confirm, or cancel (Ctrl+C).");
            return;
          }
          const sqlDeleted = factsDb.delete(resolvedId);
          let lanceDeleted = false;
          try {
            lanceDeleted = await vectorDb.delete(resolvedId);
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "forget",
            });
            console.error(`LanceDB delete failed: ${err}`);
          }
          aliasDb?.deleteByFactId(resolvedId);
          if (!sqlDeleted && !lanceDeleted) {
            console.error(`Memory not found: ${id}`);
            process.exitCode = 1;
            return;
          }
          const note = resolvedId !== id ? ` (resolved from prefix "${id}")` : "";
          console.log(`Forgotten${note}. SQLite: ${sqlDeleted}, LanceDB: ${lanceDeleted}`);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "forget",
          });
          throw err;
        }
      }),
    );

  mem
    .command("categories")
    .description("List all categories in memory (discovered from facts)")
    .action(
      withExit(async () => {
        try {
          const cats = factsDb.uniqueMemoryCategories();
          console.log(`Categories in memory (${cats.length}):`);
          for (const c of cats) {
            console.log(`  - ${c}`);
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "categories",
          });
          throw err;
        }
      }),
    );

  mem
    .command("list")
    .description("List recent facts (default 10)")
    .option("--limit <n>", "Max results", "10")
    .option("--category <cat>", "Filter by category")
    .option("--entity <ent>", "Filter by entity")
    .option("--key <k>", "Filter by key")
    .option("--source <src>", "Filter by source")
    .option("--tier <t>", "Filter by tier (hot/warm/cold/structural)")
    .action(
      withExit(
        async (opts?: {
          limit?: string;
          category?: string;
          entity?: string;
          key?: string;
          source?: string;
          tier?: string;
        }) => {
          try {
            const limit = Number.parseInt(opts?.limit ?? "10", 10);
            const filters = {
              category: opts?.category,
              entity: opts?.entity,
              key: opts?.key,
              source: opts?.source,
              tier: opts?.tier as "hot" | "warm" | "cold" | "structural" | undefined,
            };
            const facts = factsDb.list(limit, filters);
            console.log(`Recent facts (limit ${limit}):`);
            for (const f of facts) {
              console.log(`  [${f.id}] ${f.text} (tier=${f.tier}, category=${f.category ?? "none"})`);
            }
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "list",
            });
            throw err;
          }
        },
      ),
    );

  mem
    .command("show <id>")
    .description(
      "Show full detail for a fact by ID. For proposals use: hybrid-mem proposals show <id> (supports --diff, --json)",
    )
    .action(
      withExit(async (id: string) => {
        if (!listCommands?.showItem) {
          const fact = factsDb.get(id);
          if (!fact) {
            console.log(`Fact not found: ${id}`);
            return;
          }
          console.log(JSON.stringify(fact, null, 2));
          return;
        }
        const item = await listCommands.showItem(id);
        if (!item) {
          console.log(`Item not found: ${id}`);
          return;
        }
        if (item.type === "proposal") {
          console.log(`Proposal ${id}. Use: openclaw hybrid-mem proposals show ${id} (--diff, --json)`);
          return;
        }
        console.log(`Type: ${item.type}`);
        console.log(JSON.stringify(item.data, null, 2));
      }),
    );

  // ---- Token-budget tiered trimming (Issue #792) ----
  const budget = mem.command("budget").description("Token budget status and tiered trimming simulation");
  budget
    .command("show")
    .description("Show current token budget status and overflow")
    .action(
      withExit(async () => {
        try {
          const status = factsDb.getTokenBudgetStatus();
          const fmt = (n: number) => n.toLocaleString();
          console.log("Token Budget Report");
          console.log(
            `  Budget:  ${fmt(status.budget)} tokens (approx ${fmt(Math.round(status.budget * 3.8))} chars @ 3.8 chars/token)`,
          );
          console.log(
            `  Used:    ${fmt(status.totalTokens)} tokens (approx ${fmt(Math.round(status.totalTokens * 3.8))} chars)`,
          );
          console.log(`  Overflow: ${fmt(status.overflow)} tokens`);
          console.log(`
By Tier:`);
          console.log(
            `  P0 (never trim):  ${fmt(status.byTier.p0)} tokens  (${status.factCount.p0} facts) — edicts, verified, preserveUntil, preserveTags`,
          );
          console.log(
            `  P1 (trim last):   ${fmt(status.byTier.p1)} tokens  (${status.factCount.p1} facts) — importance >0.8, recent <1h`,
          );
          console.log(
            `  P2 (trim middle): ${fmt(status.byTier.p2)} tokens  (${status.factCount.p2} facts) — importance 0.5-0.8`,
          );
          console.log(
            `  P3 (trim first):  ${fmt(status.byTier.p3)} tokens  (${status.factCount.p3} facts) — importance <0.5`,
          );
          if (status.overflow > 0) {
            console.log(`
⚠️  Budget exceeded by ${fmt(status.overflow)} tokens. Run 'memory budget simulate' to see what would be trimmed.`);
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "budget-show",
          });
          throw err;
        }
      }),
    );
  budget
    .command("simulate")
    .description("Simulate tiered trimming to stay within budget")
    .option(
      "--budget <n>",
      "Token budget override (default: 80% of 32k context)",
      String(Math.ceil((32_000 * 0.8) / 3.8)),
    )
    .action(
      withExit(async (opts?: { budget?: string }) => {
        try {
          const DEFAULT_BUDGET = Math.ceil((32_000 * 0.8) / 3.8);
          const budgetVal = Number.parseInt(opts?.budget ?? String(DEFAULT_BUDGET), 10);
          const result = factsDb.trimToBudget(budgetVal, true);
          const fmt = (n: number) => n.toLocaleString();
          console.log(`Budget Simulation (budget=${fmt(budgetVal)} tokens)`);
          console.log(`  Before: ${fmt(result.beforeTokens)} tokens`);
          console.log(`  After:  ${fmt(result.afterTokens)} tokens`);
          console.log(`  Would trim ${result.trimmed.length} fact(s):`);
          if (result.trimmed.length === 0) {
            console.log("    (nothing to trim — within budget)");
          } else {
            for (const t of result.trimmed) {
              console.log(
                `  [${t.tier}] importance=${t.importance.toFixed(2)} tokens=${fmt(t.tokenCost)} — "${t.textPreview}"`,
              );
            }
          }
          console.log(`
Preserved (P0 — never trimmed, ${result.preserved.length} fact(s)):`);
          if (result.preserved.length === 0) {
            console.log("    (none)");
          } else {
            for (const p of result.preserved.slice(0, 20)) {
              console.log(`  ${p.id} — ${p.reason}`);
            }
            if (result.preserved.length > 20) {
              console.log(`  ... and ${result.preserved.length - 20} more`);
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "budget-simulate",
          });
          throw err;
        }
      }),
    );

  mem
    .command("preserve")
    .description("Force-preserve a fact from tiered trimming. Run without options to show current preserve status.")
    .option("--until <epoch>", "Preserve until epoch seconds, 'never' to clear, or shorthand like '1y' (default: 1y)")
    .option("-t, --tag <tag>", "Add a preserve tag (can be repeated)")
    .action(
      withExit(async (id: string, opts?: { until?: string; tag?: string | null }) => {
        try {
          const fact = factsDb.get(id);
          if (!fact) {
            console.log(`Fact not found: ${id}`);
            process.exitCode = 1;
            return;
          }
          const nowSec = Math.floor(Date.now() / 1000);
          const YEAR_SEC = 365 * 24 * 3600;

          let untilSec: number | null = null;
          const untilRaw = opts?.until;
          if (untilRaw && untilRaw !== "never") {
            const shorthandMatch = untilRaw.match(/^(\d+)([yYmMdD])$/);
            if (shorthandMatch) {
              const val = Number.parseInt(shorthandMatch[1]!, 10);
              const unit = shorthandMatch[2]?.toLowerCase();
              if (unit === "y") untilSec = nowSec + val * YEAR_SEC;
              else if (unit === "d") untilSec = nowSec + val * 86400;
              else if (unit === "m") untilSec = nowSec + val * 30 * 86400;
            } else {
              const parsed = Number.parseInt(untilRaw, 10);
              if (Number.isNaN(parsed) || parsed <= nowSec) {
                console.error(
                  `error: --until must be epoch seconds in the future, 'never', or shorthand like '1y'. Got: ${untilRaw}`,
                );
                process.exitCode = 1;
                return;
              }
              untilSec = parsed;
            }
          } else if (untilRaw === "never") {
            untilSec = null;
          } else {
            untilSec = nowSec + YEAR_SEC;
          }

          const addedTags: string[] = [];
          if (opts?.tag) {
            const tagVal = opts.tag;
            if (Array.isArray(tagVal)) {
              addedTags.push(...tagVal.map(String));
            } else {
              addedTags.push(String(tagVal));
            }
          }

          factsDb.setPreserveUntil(id, untilSec);
          if (addedTags.length > 0) {
            factsDb.setPreserveTags(id, addedTags, "add");
          }
          const final = factsDb.getById(id);
          const preview = fact.text.length > 80 ? `${fact.text.slice(0, 80)}…` : fact.text;
          console.log(`Preserved: "${preview}"`);
          const untilStr = final?.preserveUntil != null ? new Date(final.preserveUntil! * 1000).toISOString() : "null";
          console.log(`  preserveUntil: ${untilStr}`);
          console.log(`  preserveTags:  ${(final?.preserveTags ?? []).join(", ") || "(none)"}`);
          const tags = (fact.tags ?? []).map(String);
          if (tags.includes("edict")) {
            console.log(`  note: fact already has 'edict' tag — already P0 (never trimmed)`);
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "preserve",
          });
          throw err;
        }
      }),
    );

  const proposals = mem.command("proposals").description("Manage persona-driven proposals");
  const proposalStatusValues = ["pending", "approved", "rejected", "applied"] as const;
  proposals
    .command("list")
    .description("List pending proposals")
    .option("--status <s>", `Filter by status: ${proposalStatusValues.join(", ")}`)
    .action(
      withExit(async (opts?: { status?: string }) => {
        if (!listCommands?.listProposals) {
          console.log("Proposals feature not available (personaProposals disabled or no workspace).");
          return;
        }
        const status = opts?.status;
        if (
          status != null &&
          status !== "" &&
          !proposalStatusValues.includes(status as (typeof proposalStatusValues)[number])
        ) {
          console.error(`error: --status requires one of: ${proposalStatusValues.join(", ")}`);
          process.exitCode = 1;
          return;
        }
        const items = await listCommands.listProposals({ status: status || undefined });
        console.log(`Proposals (${items.length}):`);
        for (const p of items) {
          console.log(
            `  [${p.id}] ${p.title} (target=${p.targetFile}, status=${p.status}, confidence=${p.confidence.toFixed(2)})`,
          );
        }
      }),
    );
  proposals
    .command("approve <id>")
    .description("Approve a proposal by ID")
    .action(
      withExit(async (id: string) => {
        if (!listCommands?.proposalApprove) {
          console.log("Proposals feature not available.");
          return;
        }
        const res = await listCommands.proposalApprove(id);
        if (res.ok) {
          console.log(`Proposal ${id} approved and applied.`);
        } else {
          console.error(`Error approving proposal ${id}: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );
  proposals
    .command("reject <id>")
    .description("Reject a proposal by ID")
    .option("--reason <r>", "Rejection reason")
    .action(
      withExit(async (id: string, opts?: { reason?: string }) => {
        if (!listCommands?.proposalReject) {
          console.log("Proposals feature not available.");
          return;
        }
        const res = await listCommands.proposalReject(id, opts?.reason);
        if (res.ok) {
          console.log(`Proposal ${id} rejected.`);
        } else {
          console.error(`Error rejecting proposal ${id}: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  proposals
    .command("show <proposalId>")
    .description("Show full proposal content (observation, suggested change, optional diff)")
    .option("--json", "Machine-readable output")
    .option("--diff", "Show unified diff against current target file")
    .action(
      withExit(async (proposalId: string, opts?: { json?: boolean; diff?: boolean }) => {
        if (!listCommands?.showItem) {
          console.log("Proposals feature not available.");
          return;
        }
        const item = await listCommands.showItem(proposalId);
        if (!item || item.type !== "proposal") {
          console.error(`Proposal ${proposalId} not found`);
          process.exitCode = 1;
          return;
        }
        const proposal = item.data as {
          id: string;
          status: string;
          targetFile: string;
          confidence: number;
          observation: string;
          suggestedChange: string;
          createdAt: number;
          evidenceSessions?: string[];
        };
        const workspace = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
        const targetPath = join(workspace, proposal.targetFile);
        const includeDiff = !!opts?.diff || !!opts?.json;
        let diffText: string | null = null;
        if (includeDiff) {
          try {
            const current = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
            const proposed = buildAppliedContent(current, proposal, new Date().toISOString()).content;
            diffText = buildUnifiedDiff(current, proposed, proposal.targetFile);
          } catch {
            diffText = null;
          }
        }
        if (opts?.json) {
          console.log(JSON.stringify({ ...proposal, diff: diffText }, null, 2));
          return;
        }
        const created = new Date(proposal.createdAt * 1000).toISOString();
        const evidenceCount = Array.isArray(proposal.evidenceSessions) ? proposal.evidenceSessions.length : 0;
        console.log(`Proposal: ${proposal.id}`);
        console.log(`Status: ${proposal.status}`);
        console.log(`Target: ${proposal.targetFile}`);
        console.log(`Confidence: ${proposal.confidence.toFixed(2)}`);
        console.log(`Created: ${created}`);
        console.log(`Evidence: ${evidenceCount} sessions`);
        console.log("");
        console.log("── Observation ──");
        console.log(proposal.observation);
        console.log("");
        console.log("── Suggested Change ──");
        console.log(proposal.suggestedChange);
        if (opts?.diff && diffText) {
          console.log("");
          console.log("── Preview (diff) ──");
          console.log(diffText);
        }
      }),
    );

  const corrections = mem.command("corrections").description("Manage self-correction reports");
  corrections
    .command("list")
    .description("List pending corrections (from latest self-correction run)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        if (!listCommands?.listCorrections) {
          console.log("Corrections feature not available.");
          return;
        }
        const { reportPath, items } = await listCommands.listCorrections({ workspace: opts?.workspace });
        if (!reportPath) {
          console.log("No corrections report found.");
          return;
        }
        console.log(`Corrections report: ${reportPath}`);
        console.log(`Pending items (${items.length}):`);
        for (const item of items) {
          console.log(`  - ${item}`);
        }
      }),
    );
  corrections
    .command("approve-all")
    .description("Approve all pending corrections (auto-fix memory + TOOLS.md)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        if (!listCommands?.correctionsApproveAll) {
          console.log("Corrections feature not available.");
          return;
        }
        const { applied, error } = await listCommands.correctionsApproveAll({ workspace: opts?.workspace });
        if (error) {
          console.error(`Error applying corrections: ${error}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Applied ${applied} corrections.`);
      }),
    );

  mem
    .command("review")
    .description("Start interactive review of pending proposals + corrections")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .action(
      withExit(async (opts?: { workspace?: string }) => {
        console.log("=== Interactive Review (proposals + corrections) ===");
        if (!listCommands) {
          console.log("Review feature not available (personaProposals disabled or no workspace).");
          return;
        }
        const proposals = listCommands.listProposals ? await listCommands.listProposals({ status: "pending" }) : [];
        const { reportPath, items: corrections } = listCommands.listCorrections
          ? await listCommands.listCorrections({ workspace: opts?.workspace })
          : { reportPath: null, items: [] };

        console.log(`Pending proposals: ${proposals.length}`);
        console.log(`Pending corrections: ${corrections.length}`);
        console.log("");
        console.log("To approve/reject proposals: hybrid-mem proposals approve <id> | reject <id>");
        console.log("To approve all corrections: hybrid-mem corrections approve-all");
        console.log("");
        console.log("Proposals:");
        for (const p of proposals) {
          console.log(`  [${p.id}] ${p.title} (target=${p.targetFile}, confidence=${p.confidence.toFixed(2)})`);
        }
        console.log("");
        if (reportPath) {
          console.log(`Corrections report: ${reportPath}`);
          for (const item of corrections) {
            console.log(`  - ${item}`);
          }
        } else {
          console.log("No corrections report found.");
        }
      }),
    );

  mem
    .command("store <text>")
    .description("Store a fact (with optional category, entity, key-value, sourceDate, tags, supersedes, scope)")
    .option("--category <cat>", "Category")
    .option("--entity <ent>", "Entity")
    .option("--key <k>", "Key")
    .option("--value <v>", "Value")
    .option("--source-date <d>", "Source date (ISO or timestamp)")
    .option("--tags <t>", "Tags (comma-separated)")
    .option("--supersedes <id>", "Fact ID this store supersedes (replaces)")
    .option("--scope <s>", "Memory scope (global, user, agent, session). Default global.")
    .option(
      "--scope-target <st>",
      "Scope target (userId, agentId, sessionId). Required when scope is user/agent/session.",
    )
    .action(
      withExit(
        async (
          text: string,
          opts?: {
            category?: string;
            entity?: string;
            key?: string;
            value?: string;
            sourceDate?: string;
            tags?: string;
            supersedes?: string;
            scope?: "global" | "user" | "agent" | "session";
            scopeTarget?: string;
          },
        ) => {
          let res;
          try {
            res = await runStore({
              text,
              category: opts?.category,
              entity: opts?.entity,
              key: opts?.key,
              value: opts?.value,
              sourceDate: opts?.sourceDate,
              tags: opts?.tags,
              supersedes: opts?.supersedes,
              scope: opts?.scope,
              scopeTarget: opts?.scopeTarget,
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "store",
            });
            throw err;
          }
          if (res.outcome === "duplicate") {
            console.log("Duplicate fact (skipped).");
          } else if (res.outcome === "credential") {
            console.log(`Credential stored: ${res.service} (${res.type}), id=${res.id}`);
          } else if (res.outcome === "credential_skipped_duplicate") {
            console.log(`Credential already in vault (skipped): ${res.service} (${res.type})`);
          } else if (res.outcome === "credential_parse_error") {
            console.log("Credential parse error (skipped).");
          } else if (res.outcome === "credential_vault_error") {
            console.log("Credential vault error — could not write to secure vault (skipped).");
          } else if (res.outcome === "credential_db_error") {
            console.log("Credential pointer error — vault entry written but pointer storage failed (skipped).");
          } else if (res.outcome === "noop") {
            console.log(`No-op: ${res.reason}`);
          } else if (res.outcome === "retracted") {
            console.log(`Retracted fact ${res.targetId}: ${res.reason}`);
          } else if (res.outcome === "updated") {
            console.log(`Updated fact ${res.id} (superseded ${res.supersededId}): ${res.reason}`);
          } else if (res.outcome === "stored") {
            console.log(
              `Stored: ${res.textPreview} (id=${res.id}${res.supersededId ? `, superseded ${res.supersededId}` : ""})`,
            );
          }
        },
      ),
    );

  mem
    .command("config")
    .description("Show current configuration and feature toggles (use config-set to change)")
    .action(
      withExit(async () => {
        try {
          runConfigView({ log: (s) => console.log(s), error: (s) => console.error(s) });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config",
          });
          throw err;
        }
      }),
    );

  mem
    .command("config-mode <mode>")
    .description("Set memory mode (local, minimal, enhanced, complete). Writes memory/.config if needed.")
    .action(
      withExit(async (mode: string) => {
        let res;
        try {
          res = await runConfigMode(mode);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config-mode",
          });
          throw err;
        }
        if (res.ok) {
          console.log(res.message);
        } else {
          console.error(`Error: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("config-set <key> <value>")
    .description(
      'Set a config key in memory/.config. Toggles: config-set <feature> enabled|disabled (e.g. nightlyCycle, extraction). Other keys: errorReporting.botName "MyBot". For help: hybrid-mem help config-set <key>',
    )
    .action(
      withExit(async (key: string, value: string) => {
        let res;
        try {
          res = await runConfigSet(key, value);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config-set",
          });
          throw err;
        }
        if (res.ok) {
          console.log(res.message);
        } else {
          console.error(`Error: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("help config-set <key>")
    .description("Show help for a config key")
    .action(
      withExit(async (key: string) => {
        let res;
        try {
          res = await runConfigSetHelp(key);
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "config-set-help",
          });
          throw err;
        }
        if (res.ok) {
          console.log(res.message);
        } else {
          console.error(`Error: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("backfill")
    .description(
      "Backfill memory from workspace documents (Markdown, text files). Run once to seed memory with existing project docs.",
    )
    .option("--dry-run", "Show what would be stored without storing")
    .option("--workspace <w>", "Workspace path (default: cwd)")
    .option("--limit <n>", "Max facts to store (default: no limit)")
    .action(
      withExit(async (opts?: { dryRun?: boolean; workspace?: string; limit?: string }) => {
        let res;
        try {
          res = await runBackfill(
            {
              dryRun: !!opts?.dryRun,
              workspace: opts?.workspace,
              limit: opts?.limit ? Number.parseInt(opts.limit, 10) : undefined,
            },
            { log: console.log, warn: console.warn },
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "backfill",
          });
          throw err;
        }
        console.log(
          `Backfill complete: ${res.stored} stored, ${res.skipped} skipped, ${res.candidates} candidates, ${res.files} files ${opts?.dryRun ? "(dry-run)" : ""}`,
        );
      }),
    );

  mem
    .command("ingest-files")
    .description(
      "Ingest files from workspace (Markdown, text). Extract facts and store in memory. Use --paths for specific files.",
    )
    .option("--dry-run", "Show what would be stored without storing")
    .option("--workspace <w>", "Workspace path (default: cwd)")
    .option("--paths <p...>", "Specific file paths (relative to workspace)")
    .action(
      withExit(async (opts?: { dryRun?: boolean; workspace?: string; paths?: string[] }) => {
        let res;
        try {
          res = await runIngestFiles(
            { dryRun: !!opts?.dryRun, workspace: opts?.workspace, paths: opts?.paths },
            { log: console.log, warn: console.warn },
          );
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "ingest-files",
          });
          throw err;
        }
        console.log(
          `Ingest complete: ${res.stored} stored, ${res.skipped} skipped, ${res.extracted} extracted, ${res.files} files ${opts?.dryRun ? "(dry-run)" : ""}`,
        );
      }),
    );

  mem
    ?.command("export")
    .description(
      "Export memory to MEMORY.md + memory/ directory (vanilla OpenClaw format). Use --output to specify path.",
    )
    .requiredOption("--output <path>", "Output directory path")
    .option("--exclude-credentials", "Exclude credentials from export")
    .option("--include-credentials", "Include credentials in export (default: exclude)")
    .option("--sources <s...>", "Filter by source (comma-separated)")
    .option("--mode <m>", "Export mode: replace (overwrite) or additive (merge). Default: replace.", "replace")
    .action(
      withExit(
        async (opts: {
          output: string;
          excludeCredentials?: boolean;
          includeCredentials?: boolean;
          sources?: string[];
          mode?: "replace" | "additive";
        }) => {
          let res;
          try {
            res = await runExport({
              outputPath: opts.output,
              excludeCredentials: opts.excludeCredentials,
              includeCredentials: opts.includeCredentials,
              sources: opts.sources,
              mode: opts.mode ?? "replace",
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "export",
            });
            throw err;
          }
          console.log(
            `Exported ${res.factsExported} facts, ${res.proceduresExported} procedures to ${res.outputPath} (${res.filesWritten} files written).`,
          );
        },
      ),
    );

  mem
    .command("find-duplicates")
    .description("Find duplicate or near-duplicate facts using vector similarity")
    .option("--threshold <n>", "Similarity threshold (0-1, default 0.85)", "0.85")
    .option("--include-structured", "Include structured facts (kv, credentials) in search")
    .option("--limit <n>", "Max pairs to return (default 100)", "100")
    .action(
      withExit(async (opts?: { threshold?: string; includeStructured?: boolean; limit?: string }) => {
        const threshold = Number.parseFloat(opts?.threshold ?? "0.85");
        const includeStructured = !!opts?.includeStructured;
        const limit = Number.parseInt(opts?.limit ?? "100", 10);
        let res;
        try {
          res = await runFindDuplicates({ threshold, includeStructured, limit });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "find-duplicates",
          });
          throw err;
        }
        console.log(
          `Found ${res.pairs.length} duplicate pairs (threshold=${threshold}, candidates=${res.candidatesCount}, skippedStructured=${res.skippedStructured})`,
        );
        for (const p of res.pairs) {
          console.log(`  [${p.idA}] <-> [${p.idB}] (score=${p.score.toFixed(3)})`);
          console.log(`    A: ${p.textA.substring(0, 60)}...`);
          console.log(`    B: ${p.textB.substring(0, 60)}...`);
        }
      }),
    );

  mem
    .command("consolidate")
    .description("Consolidate duplicate facts: cluster by vector similarity, merge via LLM, delete originals")
    .option("--threshold <n>", "Similarity threshold (0-1, default 0.85)", "0.85")
    .option("--include-structured", "Include structured facts (kv, credentials) in consolidation")
    .option("--dry-run", "Show what would be consolidated without consolidating")
    .option("--limit <n>", "Max clusters to process (default 10)", "10")
    .option("--model <m>", "LLM model for merging (default: default tier from config)")
    .action(
      withExit(
        async (opts?: {
          threshold?: string;
          includeStructured?: boolean;
          dryRun?: boolean;
          limit?: string;
          model?: string;
        }) => {
          const threshold = Number.parseFloat(opts?.threshold ?? "0.85");
          const includeStructured = !!opts?.includeStructured;
          const dryRun = !!opts?.dryRun;
          const limit = Number.parseInt(opts?.limit ?? "10", 10);
          const model = opts?.model ?? getDefaultCronModel(getCronModelConfig(ctx.cfg), "default");
          let res;
          try {
            res = await runConsolidate({ threshold, includeStructured, dryRun, limit, model });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "consolidate",
            });
            throw err;
          }
          console.log(
            `Consolidation complete: ${res.clustersFound} clusters found, ${res.merged} merged, ${res.deleted} deleted ${dryRun ? "(dry-run)" : ""}`,
          );
        },
      ),
    );

  mem
    .command("reflect")
    .description("Run reflection: analyze recent facts, extract patterns, store in memory")
    .option("--window <n>", "Days to look back (default from config)", reflectionConfig.defaultWindow.toString())
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("--verbose", "Log each pattern as it is extracted")
    .action(
      withExit(async (opts?: { window?: string; dryRun?: boolean; model?: string; verbose?: boolean }) => {
        const window = opts?.window ? Number.parseInt(opts.window, 10) : reflectionConfig.defaultWindow;
        const dryRun = !!opts?.dryRun;
        const model = opts?.model ?? reflectionConfig.model;
        const verbose = !!opts?.verbose;
        let res;
        try {
          res = await runReflection({ window, dryRun, model, verbose });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "reflect",
          });
          throw err;
        }
        console.log(
          `Reflection complete: analyzed ${res.factsAnalyzed} facts, extracted ${res.patternsExtracted} patterns, stored ${res.patternsStored} ${dryRun ? "(dry-run)" : ""}`,
        );
      }),
    );

  mem
    .command("reflect-rules")
    .description("Run reflection (rules): extract high-level rules from patterns")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("--verbose", "Log each rule as it is extracted")
    .action(
      withExit(async (opts?: { dryRun?: boolean; model?: string; verbose?: boolean }) => {
        const dryRun = !!opts?.dryRun;
        const model = opts?.model ?? reflectionConfig.model;
        const verbose = !!opts?.verbose;
        let res;
        try {
          res = await runReflectionRules({ dryRun, model, verbose });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "reflect-rules",
          });
          throw err;
        }
        console.log(
          `Reflection (rules) complete: extracted ${res.rulesExtracted} rules, stored ${res.rulesStored} ${dryRun ? "(dry-run)" : ""}`,
        );
      }),
    );

  mem
    .command("reflect-meta")
    .description("Run reflection (meta-patterns): extract meta-patterns from existing patterns")
    .option("--dry-run", "Show what would be stored without storing")
    .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
    .option("--verbose", "Log each meta-pattern as it is extracted")
    .action(
      withExit(async (opts?: { dryRun?: boolean; model?: string; verbose?: boolean }) => {
        const dryRun = !!opts?.dryRun;
        const model = opts?.model ?? reflectionConfig.model;
        const verbose = !!opts?.verbose;
        let res;
        try {
          res = await runReflectionMeta({ dryRun, model, verbose });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "reflect-meta",
          });
          throw err;
        }
        console.log(
          `Reflection (meta) complete: extracted ${res.metaExtracted} meta-patterns, stored ${res.metaStored} ${dryRun ? "(dry-run)" : ""}`,
        );
      }),
    );

  if (runReflectIdentity) {
    mem
      .command("reflect-identity")
      .description("Run identity reflection: synthesize persona-level insights from reflection outputs")
      .option("--window <n>", "Days to look back (default from config)", reflectionConfig.defaultWindow.toString())
      .option("--dry-run", "Show what would be stored without storing")
      .option("--model <m>", "LLM model (default from config)", reflectionConfig.model)
      .option("--verbose", "Log each identity insight as it is stored")
      .action(
        withExit(async (opts?: { window?: string; dryRun?: boolean; model?: string; verbose?: boolean }) => {
          const window = opts?.window ? Number.parseInt(opts.window, 10) : reflectionConfig.defaultWindow;
          const dryRun = !!opts?.dryRun;
          const model = opts?.model ?? reflectionConfig.model;
          const verbose = !!opts?.verbose;
          const res = await runReflectIdentity({ dryRun, model, verbose, window });
          console.log(
            `Identity reflection complete: extracted ${res.insightsExtracted} insights, stored ${res.insightsStored} ${dryRun ? "(dry-run)" : ""}`,
          );
        }),
      );
  }

  if (runDreamCycle) {
    mem
      .command("dream-cycle")
      .description(
        "Run nightly dream cycle: prune expired/decayed facts, consolidate old episodic events, reflect to extract patterns, optionally extract rules",
      )
      .action(
        withExit(async () => {
          let res;
          try {
            res = await runDreamCycle();
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "dream-cycle",
            });
            throw err;
          }
          if (res.skipped) {
            console.log("Dream cycle skipped (nightlyCycle.enabled = false in config).");
          } else {
            console.log(`Dream cycle complete: ${res.digestSummary}`);
            console.log(`  Facts pruned: ${res.factsPruned}`);
            console.log(`  Facts decayed: ${res.factsDecayed}`);
            console.log(`  Events consolidated: ${res.eventsConsolidated} → ${res.factsCreated} facts`);
            console.log(`  Patterns found: ${res.patternsFound}`);
            console.log(`  Rules generated: ${res.rulesGenerated}`);
          }

          if (
            !res.skipped &&
            runContinuousVerification &&
            cfg.verification.enabled &&
            cfg.verification.continuousVerification
          ) {
            let verificationRes;
            try {
              verificationRes = await runContinuousVerification();
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "continuous-verification",
              });
              throw err;
            }
            console.log("Continuous verification complete:");
            console.log(`  Checked: ${verificationRes.checked}`);
            console.log(`  Confirmed: ${verificationRes.confirmed}`);
            console.log(`  Stale: ${verificationRes.stale}`);
            console.log(`  Uncertain: ${verificationRes.uncertain}`);
            console.log(`  Errors: ${verificationRes.errors}`);
          }

          // Extract implicit feedback signals as part of nightly cycle
          if (!res.skipped && runExtractImplicitFeedback && cfg.implicitFeedback?.enabled !== false) {
            try {
              const implRes = await runExtractImplicitFeedback({ days: 3, dryRun: false, includeClosedLoop: false });
              console.log(
                `Extract-implicit: ${implRes.signalsExtracted} signals (${implRes.positiveCount}+/${implRes.negativeCount}-) from ${implRes.sessionsScanned} sessions.`,
              );
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:extract-implicit",
              });
            }
          }

          // Closed-loop effectiveness analysis
          if (!res.skipped && cfg.closedLoop?.enabled !== false && cfg.closedLoop?.runInNightlyCycle !== false) {
            try {
              const clReport = runClosedLoopAnalysis(factsDb, cfg.closedLoop ?? { enabled: true });
              console.log(
                `Closed-loop analysis: ${clReport.rulesAnalyzed} rules measured, ${clReport.deprecated} deprecated, ${clReport.boosted} boosted.`,
              );
              if (clReport.rulesAnalyzed > 0) {
                const report = getEffectivenessReport(factsDb);
                if (report && report.length > 0) console.log(report);
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:closed-loop",
              });
            }
          }

          // Cross-agent learning (Issue #263 — Phase 2)
          if (
            !res.skipped &&
            runCrossAgentLearning &&
            cfg.crossAgentLearning?.enabled &&
            cfg.crossAgentLearning?.runInNightlyCycle !== false
          ) {
            try {
              const caRes = await runCrossAgentLearning();
              console.log(
                `Cross-agent learning: ${caRes.generalisedStored} generalised patterns stored from ${caRes.agentsScanned} agents.`,
              );
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:cross-agent-learning",
              });
            }
          }

          // Tool effectiveness scoring (Issue #263 — Phase 3)
          if (
            !res.skipped &&
            runToolEffectiveness &&
            cfg.toolEffectiveness?.enabled !== false &&
            cfg.toolEffectiveness?.runInNightlyCycle !== false
          ) {
            try {
              const teOutput = await runToolEffectiveness({});
              if (teOutput && !teOutput.startsWith("No tool")) {
                console.log(`Tool effectiveness: ${teOutput.split("\n")[0]}`);
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:tool-effectiveness",
              });
            }
          }
          // Cost log pruning (Issue #270)
          if (
            !res.skipped &&
            pruneCostLog &&
            cfg.costTracking?.enabled !== false &&
            cfg.costTracking?.pruneInNightlyCycle !== false
          ) {
            try {
              const pruned = pruneCostLog(cfg.costTracking?.retainDays);
              if (pruned > 0) console.log(`Cost log: pruned ${pruned} old entries.`);
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "dream-cycle:cost-log-prune",
              });
            }
          }
        }),
      );
  }

  mem
    .command("resolve-contradictions")
    .description("Resolve unresolved contradictions (auto-resolve obvious cases, report ambiguous pairs)")
    .action(
      withExit(async () => {
        let res;
        try {
          res = await ctx.runResolveContradictions();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "resolve-contradictions",
          });
          throw err;
        }
        console.log(
          `Contradictions resolved: ${res.autoResolved.length} auto-resolved, ${res.ambiguous.length} ambiguous.`,
        );
        if (res.ambiguous.length > 0) {
          console.log("Ambiguous pairs (manual review recommended):");
          for (const a of res.ambiguous.slice(0, 10)) {
            console.log(`  - ${a.factIdNew} ↔ ${a.factIdOld} (${a.contradictionId})`);
          }
          if (res.ambiguous.length > 10) {
            console.log(`  ...and ${res.ambiguous.length - 10} more`);
          }
        }
      }),
    );

  mem
    .command("classify")
    .description("Reclassify uncategorized facts using LLM (auto-classify)")
    .option("--dry-run", "Show what would be reclassified without reclassifying")
    .option("--limit <n>", "Max facts to classify (default 100)", "100")
    .option("--model <m>", "LLM model (default from config)")
    .action(
      withExit(async (opts?: { dryRun?: boolean; limit?: string; model?: string }) => {
        const dryRun = !!opts?.dryRun;
        const limit = Number.parseInt(opts?.limit ?? "100", 10);
        const model = opts?.model;
        let res;
        try {
          res = await runClassify({ dryRun, limit, model });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "classify",
          });
          throw err;
        }
        console.log(
          `Classify complete: reclassified ${res.reclassified}/${res.total} facts ${dryRun ? "(dry-run)" : ""}`,
        );
        if (res.breakdown) {
          console.log("Breakdown by category:");
          for (const [cat, count] of Object.entries(res.breakdown)) {
            console.log(`  ${cat}: ${count}`);
          }
        }
      }),
    );

  mem
    .command("build-languages")
    .description(
      "Detect top 3 languages from memory text; LLM produces intent-based natural equivalents (triggers, extraction patterns) and writes .language-keywords.json",
    )
    .option("--model <m>", "LLM model (default from autoClassify config)")
    .option("--dry-run", "Show what would be generated without writing")
    .action(
      withExit(async (opts?: { model?: string; dryRun?: boolean }) => {
        const model = opts?.model ?? ctx.autoClassifyConfig.model;
        const dryRun = !!opts?.dryRun;
        let res;
        try {
          res = await runBuildLanguageKeywords({ model, dryRun });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "build-languages",
          });
          throw err;
        }
        if (res.ok) {
          console.log(
            `Built language keywords: top languages=[${res.topLanguages.join(", ")}], added=${res.languagesAdded}, path=${res.path} ${dryRun ? "(dry-run)" : ""}`,
          );
        } else {
          console.error(`Error building language keywords: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("self-correction-extract")
    .description(
      "Extract self-correction incidents from session JSONL using multi-language correction signals from .language-keywords.json",
    )
    .option("--days <n>", "Days to look back (default 7)", "7")
    .option("--output <path>", "Output path for incidents JSON (default: memory/.self-correction-incidents.json)")
    .action(
      withExit(async (opts?: { days?: string; output?: string }) => {
        const days = opts?.days ? Number.parseInt(opts.days, 10) : 7;
        const outputPath = opts?.output;
        let res;
        try {
          res = await runSelfCorrectionExtract({ days, outputPath });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "self-correction-extract",
          });
          throw err;
        }
        console.log(
          `Self-correction extract complete: ${res.incidents.length} incidents found, ${res.sessionsScanned} sessions scanned.`,
        );
      }),
    );

  mem
    .command("self-correction-run")
    .description("Analyze extracted incidents and auto-remediate (memory store, TOOLS.md); report to memory/reports")
    .option("--extract-path <path>", "Path to incidents JSON (default: memory/.self-correction-incidents.json)")
    .option("--workspace <w>", "Workspace path (for TOOLS.md)")
    .option("--dry-run", "Show what would be applied without applying")
    .option("--model <m>", "LLM model (default from autoClassify config)")
    .option("--approve", "Auto-approve all corrections (skip review)")
    .option("--no-apply-tools", "Skip TOOLS.md updates (memory-only)")
    .option("--full", "Force full re-scan (bypass 23-hour startup guard)")
    .action(
      withExit(
        async (opts?: {
          extractPath?: string;
          workspace?: string;
          dryRun?: boolean;
          model?: string;
          approve?: boolean;
          applyTools?: boolean;
          full?: boolean;
        }) => {
          const extractPath = opts?.extractPath;
          const workspace = opts?.workspace;
          const dryRun = !!opts?.dryRun;
          const model = opts?.model ?? ctx.autoClassifyConfig.model;
          const approve = !!opts?.approve;
          const full = !!opts?.full;
          let res;
          try {
            res = await runSelfCorrectionRun({
              extractPath,
              workspace,
              dryRun,
              model,
              approve,
              applyTools: opts?.applyTools,
              full,
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "cli",
              operation: "self-correction-run",
            });
            throw err;
          }
          if (res.error) {
            console.error(`Error: ${res.error}`);
            process.exitCode = 1;
            return;
          }
          console.log(
            `Self-correction run complete: ${res.incidentsFound} incidents found, ${res.analysed} analysed, ${res.autoFixed} auto-fixed ${dryRun ? "(dry-run)" : ""}`,
          );
          if (res.proposals.length > 0) {
            console.log(`Proposals (${res.proposals.length}):`);
            for (const p of res.proposals) {
              console.log(`  - ${p}`);
            }
          }
          if (res.reportPath) {
            console.log(`Report: ${res.reportPath}`);
          }
          if (res.toolsSuggestions && res.toolsSuggestions.length > 0) {
            console.log(`TOOLS.md suggestions (${res.toolsSuggestions.length}):`);
            for (const s of res.toolsSuggestions) {
              console.log(`  - ${s}`);
            }
          }
          if (res.toolsApplied != null && res.toolsApplied > 0) {
            console.log(`TOOLS.md updates applied: ${res.toolsApplied}`);
          }
        },
      ),
    );

  if (runExtractImplicitFeedback) {
    mem
      .command("extract-implicit")
      .description(
        "Extract implicit feedback signals from session transcripts and route to reinforcement/self-correction pipelines",
      )
      .option("--days <n>", "Days to look back (default 3)", "3")
      .option("--dry-run", "Show what would be stored without storing")
      .option("--verbose", "Show detailed signal output per session")
      .option("--no-trajectories", "Skip trajectory building")
      .option("--no-closed-loop", "Skip closed-loop analysis")
      .action(
        withExit(
          async (opts?: {
            days?: string;
            dryRun?: boolean;
            verbose?: boolean;
            trajectories?: boolean;
            closedLoop?: boolean;
          }) => {
            const days = opts?.days ? Number.parseInt(opts.days, 10) : 3;
            const dryRun = !!opts?.dryRun;
            const verbose = !!opts?.verbose;
            const includeTrajectories = opts?.trajectories !== false;
            const includeClosedLoop = opts?.closedLoop !== false;
            let res;
            try {
              res = await runExtractImplicitFeedback({ days, dryRun, verbose, includeTrajectories, includeClosedLoop });
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "cli",
                operation: "extract-implicit",
              });
              throw err;
            }
            console.log(
              `Extract-implicit complete: ${res.signalsExtracted} signals from ${res.sessionsScanned} sessions ${dryRun ? "(dry-run)" : ""}`,
            );
            console.log(`  Positive signals: ${res.positiveCount}`);
            console.log(`  Negative signals: ${res.negativeCount}`);
            console.log(`  Trajectories built: ${res.trajectoriesBuilt}`);
            if (res.closedLoopReport) {
              console.log(`\n${res.closedLoopReport}`);
            }
          },
        ),
      );
  }

  // ----- cross-agent-learning (Issue #263 — Phase 2) -----
  mem
    .command("cross-agent-learning")
    .description("Generalise agent-scoped lessons into global patterns (Issue #263 — Phase 2)")
    .action(
      withExit(async () => {
        if (!runCrossAgentLearning) {
          console.error("cross-agent-learning is not available in this context.");
          process.exitCode = 1;
          return;
        }
        if (!cfg.crossAgentLearning?.enabled) {
          console.log("Cross-agent learning is disabled (crossAgentLearning.enabled = false).");
          return;
        }
        let res;
        try {
          res = await runCrossAgentLearning();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "cross-agent-learning",
          });
          throw err;
        }
        console.log("Cross-agent learning complete:");
        console.log(`  Agents scanned: ${res.agentsScanned}`);
        console.log(`  Lessons considered: ${res.lessonsConsidered}`);
        console.log(`  Generalised stored: ${res.generalisedStored}`);
        console.log(`  Links created: ${res.linksCreated}`);
        console.log(`  Skipped duplicates: ${res.skippedDuplicates}`);
        if (res.errors > 0) console.log(`  Errors: ${res.errors}`);
      }),
    );

  // ----- cost-report (Issue #270) -----
  mem
    .command("cost-report")
    .description("Show LLM token usage and estimated cost breakdown by feature (Issue #270)")
    .option("--days <n>", "Days of history to include (default: 7)", "7")
    .option("--model", "Show breakdown by model instead of feature")
    .option("--feature <name>", "Filter to a specific feature (e.g. auto-classify)")
    .option("--csv", "Output as CSV")
    .option("--format <format>", "Output format: pretty (default, emoji+%) or compact (terse)", "pretty")
    .option("--modes", "Show estimated $/month cost ranges for each config mode (local/minimal/enhanced/complete)")
    .action(
      withExit(
        async (opts?: {
          days?: string;
          model?: boolean;
          feature?: string;
          csv?: boolean;
          format?: string;
          modes?: boolean;
        }) => {
          if (!runCostReport) {
            console.error("cost-report is not available in this context.");
            process.exitCode = 1;
            return;
          }
          const days = opts?.days ? Number.parseInt(opts.days, 10) : 7;
          const format = opts?.format === "compact" ? ("compact" as const) : ("pretty" as const);
          runCostReport(
            { days, model: !!opts?.model, feature: opts?.feature, csv: !!opts?.csv, format, modes: !!opts?.modes },
            { log: (msg) => console.log(msg) },
          );
        },
      ),
    );

  // ----- tool-effectiveness (Issue #263 — Phase 3) -----
  mem
    .command("tool-effectiveness")
    .description("Compute and display tool effectiveness scores from workflow traces (Issue #263 — Phase 3)")
    .option("--verbose", "Show detailed per-tool breakdown")
    .action(
      withExit(async (opts?: { verbose?: boolean }) => {
        if (!runToolEffectiveness) {
          console.error("tool-effectiveness is not available in this context.");
          process.exitCode = 1;
          return;
        }
        let output: string;
        try {
          output = await runToolEffectiveness({ verbose: !!opts?.verbose });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "tool-effectiveness",
          });
          throw err;
        }
        console.log(output);
      }),
    );

  mem
    .command("analyze-feedback-phrases")
    .description(
      "Analyze session logs with an LLM (e.g. Gemini) to discover your praise/frustration phrases; optional --learn to save to .user-feedback-phrases.json",
    )
    .option("--days <n>", "Days of sessions to analyze (omit for auto: 30 on first run, 3 thereafter)")
    .option("--model <m>", "LLM model (e.g. gemini-2.0-flash for 1M context)", "")
    .option("--output <path>", "Write suggested phrases JSON to file", "")
    .option(
      "--learn",
      "Merge discovered phrases into .user-feedback-phrases.json (reinforcement/correction detection will use them)",
    )
    .action(
      withExit(async (opts?: { days?: string; model?: string; output?: string; learn?: boolean }) => {
        if (!runAnalyzeFeedbackPhrases) {
          console.error("analyze-feedback-phrases is not available in this context.");
          process.exitCode = 1;
          return;
        }
        const days = opts?.days ? Number.parseInt(opts.days, 10) : undefined;
        const outputPath = opts?.output;
        const learn = !!opts?.learn;
        const model = opts?.model?.trim() || undefined;
        let res;
        try {
          res = await runAnalyzeFeedbackPhrases({ days, model, outputPath, learn });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "analyze-feedback-phrases",
          });
          throw err;
        }
        if (res.error) {
          console.error(res.error);
          process.exitCode = 1;
          return;
        }
        console.log(`Sessions scanned: ${res.sessionsScanned}`);
        console.log(`Reinforcement phrases: ${res.reinforcement.length}`);
        if (res.reinforcement.length > 0) {
          res.reinforcement.slice(0, 15).forEach((p) => console.log(`  + ${p}`));
          if (res.reinforcement.length > 15) console.log(`  ... and ${res.reinforcement.length - 15} more`);
        }
        console.log(`Correction phrases: ${res.correction.length}`);
        if (res.correction.length > 0) {
          res.correction.slice(0, 15).forEach((p) => console.log(`  - ${p}`));
          if (res.correction.length > 15) console.log(`  ... and ${res.correction.length - 15} more`);
        }
        if (res.learned) {
          console.log(
            "Phrases saved to .user-feedback-phrases.json (reinforcement/correction detection will use them).",
          );
        }
        if (outputPath) {
          console.log(`Output written to ${outputPath}`);
        }
      }),
    );

  const credentials = mem.command("credentials").description("Manage credentials (vaulted)");
  credentials
    .command("migrate-to-vault")
    .description("Migrate credentials from plaintext to vaulted storage (one-time)")
    .action(
      withExit(async () => {
        let res;
        try {
          res = await runMigrateToVault();
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "migrate-to-vault",
          });
          throw err;
        }
        if (!res) {
          console.log("No credentials to migrate (or migration already done).");
          return;
        }
        if (res.errors.length > 0) {
          console.error(`Errors during migration: ${res.errors.join(", ")}`);
        }
        console.log(`Migrated ${res.migrated} credentials (${res.skipped} skipped).`);
      }),
    );

  credentials
    .command("list")
    .description(
      "List credentials in vault (service, type, url only — no values). One entry per (service, type); repeated stores overwrite.",
    )
    .option(
      "--service <pattern>",
      "Filter by service name (case-insensitive substring match). Note: partial patterns match all services containing the string — e.g. 'git' matches 'github' and 'gitea'. Use quotes for multi-word patterns.",
    )
    .action(
      withExit(async (opts?: { service?: string }) => {
        let list = runCredentialsList();
        if (list.length === 0) {
          console.log("No credentials in vault.");
          return;
        }
        const pattern = opts?.service?.trim();
        if (pattern) {
          const lower = pattern.toLowerCase();
          list = list.filter((e) => e.service.toLowerCase().includes(lower));
          if (list.length === 0) {
            console.log(`No credentials matching service "${pattern}".`);
            return;
          }
          console.log(
            `Credentials matching "${pattern}" (case-insensitive substring, ${list.length} result${list.length === 1 ? "" : "s"}):`,
          );
        } else {
          console.log(`Credentials (${list.length}):`);
        }
        for (const e of list) {
          console.log(`  ${e.service} (${e.type})${e.url ? ` — ${e.url}` : ""}`);
        }
      }),
    );

  credentials
    .command("get")
    .description(
      "Retrieve a credential value by service name. Omit --type to get the most recently updated credential for the service, or use --type to disambiguate when multiple types exist.",
    )
    .requiredOption("--service <name>", "Service name (e.g. 'unifi', 'github')")
    .option(
      "--type <type>",
      "Credential type (token, password, api_key, ssh, bearer, other). Omit to get the most recently updated entry for the service, or when you don't know which type is stored.",
    )
    .option(
      "--value-only",
      "Print only the secret value (for piping); no metadata. Warning: value is printed in plaintext.",
    )
    .option(
      "--show-value",
      "Reveal the secret value in the default (metadata) output. Without this flag the value is masked for safety.",
    )
    .action(
      withExit(async (opts: { service: string; type?: string; valueOnly?: boolean; showValue?: boolean }) => {
        const entry = runCredentialsGet({ service: opts.service, type: opts.type });
        if (!entry) {
          console.error(
            `No credential found for service "${opts.service}"${opts.type ? ` (type: ${opts.type})` : ""}.`,
          );
          process.exitCode = 1;
          return;
        }
        if (opts.valueOnly) {
          console.log(entry.value);
          return;
        }
        console.log(`service: ${entry.service}`);
        console.log(`type: ${entry.type}`);
        if (opts.showValue) {
          console.log(`value: ${entry.value}`);
        } else {
          console.log("value: *** (use --show-value to reveal, or --value-only to pipe)");
        }
        if (entry.url) console.log(`url: ${entry.url}`);
        if (entry.notes) console.log(`notes: ${entry.notes}`);
      }),
    );

  credentials
    .command("audit")
    .description("Audit vault: flag suspicious entries (natural language, long service names, duplicates)")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const audit = runCredentialsAudit();
        if (opts?.json) {
          console.log(JSON.stringify({ total: audit.total, entries: audit.entries }, null, 2));
          return;
        }
        if (audit.total === 0) {
          console.log("No credentials in vault.");
          return;
        }
        const suspicious = audit.entries.filter((e) => e.flags.length > 0);
        console.log(`Audit: ${audit.total} total, ${suspicious.length} suspicious.`);
        for (const e of audit.entries) {
          const flagStr = e.flags.length > 0 ? ` [${e.flags.join(", ")}]` : "";
          console.log(`  ${e.service} (${e.type})${flagStr}`);
        }
      }),
    );

  credentials
    .command("prune")
    .description("Remove suspicious credential entries (default: dry-run; use --yes to apply)")
    .option("--dry-run", "Only list what would be removed (default)")
    .option("--yes", "Actually remove flagged entries")
    .option("--only-flags <reasons>", "Comma-separated flags to prune (e.g. natural_language,service_too_long)")
    .action(
      withExit(async (opts?: { dryRun?: boolean; yes?: boolean; onlyFlags?: string }) => {
        const yes = opts?.yes === true;
        const dryRun = yes ? false : opts?.dryRun !== false;
        const onlyFlags = opts?.onlyFlags
          ? opts.onlyFlags
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const res = runCredentialsPrune({ dryRun, yes, onlyFlags });
        if (res.removed === 0) {
          console.log(res.dryRun ? "No suspicious entries to prune (dry-run)." : "No entries removed.");
          return;
        }
        if (res.dryRun) {
          console.log(`Would remove ${res.removed} entries (run with --yes to apply):`);
          for (const e of res.entries) {
            console.log(`  ${e.service} (${e.type})`);
          }
        } else {
          console.log(`Removed ${res.removed} entries.`);
        }
      }),
    );

  const scope = mem.command("scope").description("Manage memory scopes (global, user, agent, session)");
  scope
    .command("list")
    .description("List all scopes in memory (discovered from facts)")
    .action(
      withExit(async () => {
        const scopes = factsDb.uniqueScopes();
        console.log(`Scopes in memory (${scopes.length}):`);
        for (const s of scopes) {
          console.log(`  - ${s}`);
        }
      }),
    );
  scope
    .command("stats")
    .description("Show scope statistics (count by scope)")
    .action(
      withExit(async () => {
        const stats = factsDb.scopeStats();
        console.log("Scope stats:");
        for (const [s, count] of Object.entries(stats)) {
          console.log(`  ${s}: ${count}`);
        }
      }),
    );
  scope
    ?.command("prune")
    .description("Prune all facts in a specific scope (WARNING: destructive)")
    .requiredOption("--scope <s>", "Scope to prune (global/user/agent/session)")
    .option(
      "--scope-target <st>",
      "Scope target (userId/agentId/sessionId). Required when scope is user/agent/session.",
    )
    .action(
      withExit(async (opts: { scope: string; scopeTarget?: string }) => {
        const scopeFilter: ScopeFilter = {};
        if (opts.scope === "user") scopeFilter.userId = opts.scopeTarget || null;
        else if (opts.scope === "agent") scopeFilter.agentId = opts.scopeTarget || null;
        else if (opts.scope === "session") scopeFilter.sessionId = opts.scopeTarget || null;

        const deleted = factsDb.pruneScopedFacts(scopeFilter);
        console.log(
          `Pruned ${deleted} facts from scope ${opts.scope}${opts.scopeTarget ? ` (target=${opts.scopeTarget})` : ""}.`,
        );
      }),
    );
  scope
    ?.command("promote")
    .description("Promote high-importance session-scoped facts to global scope")
    .option("--dry-run", "Preview without making changes")
    .option("--threshold-days <n>", "Minimum age in days for a session fact to be promoted (default: 7)", "7")
    .option("--min-importance <n>", "Minimum importance score to promote (default: 0.7)", "0.7")
    .action(
      withExit(async (opts: { dryRun?: boolean; thresholdDays: string; minImportance: string }) => {
        const thresholdDays = Number.parseFloat(opts.thresholdDays);
        const minImportance = Number.parseFloat(opts.minImportance);

        if (Number.isNaN(thresholdDays) || thresholdDays < 0) {
          console.error("--threshold-days must be a non-negative number");
          process.exit(1);
        }
        if (Number.isNaN(minImportance) || minImportance < 0 || minImportance > 1) {
          console.error("--min-importance must be a number between 0 and 1");
          process.exit(1);
        }

        const candidates = factsDb.findSessionFactsForPromotion(thresholdDays, minImportance);
        if (candidates.length === 0) {
          console.log("No session facts eligible for promotion.");
          return;
        }

        if (opts.dryRun) {
          console.log(`Would promote ${candidates.length} facts from session to global scope (dry-run):`);
          for (const f of candidates) {
            console.log(
              `  [${f.id}] importance=${f.importance.toFixed(2)} scope_target=${f.scopeTarget ?? "null"} text="${f.text.slice(0, 80)}"`,
            );
          }
          return;
        }

        let promoted = 0;
        for (const f of candidates) {
          if (factsDb.promoteScope(f.id, "global", null)) {
            promoted++;
          }
        }
        console.log(`Promoted ${promoted} facts from session to global scope.`);
      }),
    );

  // Procedure feedback loop CLI (#782)
  const procedureCmd = mem
    .command("procedure")
    .description("Show procedure details (versions, failures, avoidance notes)");
  procedureCmd
    .command("show <id>")
    .description("Show all versions and failure history for a procedure")
    .action(
      withExit(async (opts: { id: string }) => {
        const proc = factsDb.getProcedureById(opts.id);
        if (!proc) {
          console.log(`Procedure not found: ${opts.id}`);
          return;
        }

        const versions = factsDb.getProcedureVersions(opts.id);
        const failures = factsDb.getProcedureFailures(opts.id);
        const totalSuccess = proc.successCount + versions.reduce((s, v) => s + v.successCount, 0);
        const totalFailure = proc.failureCount + versions.reduce((s, v) => s + v.failureCount, 0);
        const total = totalSuccess + totalFailure;
        const rate = total > 0 ? totalSuccess / total : 0;

        console.log(`Procedure: ${proc.taskPattern}`);
        console.log(`  ID:         ${proc.id}`);
        console.log(`  Type:       ${proc.procedureType}`);
        console.log(`  Confidence: ${proc.confidence?.toFixed(3) ?? "n/a"}`);
        console.log(
          `  Success:    ${totalSuccess} (procedure table) + ${versions.reduce((s, v) => s + v.successCount, 0)} (versions) = ${totalSuccess}`,
        );
        console.log(
          `  Failure:   ${totalFailure} (procedure table) + ${versions.reduce((s, v) => s + v.failureCount, 0)} (versions) = ${totalFailure}`,
        );
        console.log(`  Rate:      ${(rate * 100).toFixed(1)}%`);
        console.log(`  Outcome:   ${proc.lastOutcome ?? "unknown"}`);
        console.log(
          `  Last Validated: ${proc.lastValidated ? new Date(proc.lastValidated * 1000).toISOString() : "never"}`,
        );
        console.log(`  Last Failed:   ${proc.lastFailed ? new Date(proc.lastFailed * 1000).toISOString() : "never"}`);

        if (proc.avoidanceNotes && proc.avoidanceNotes.length > 0) {
          console.log("\n  Avoidance notes (all versions):");
          for (const note of proc.avoidanceNotes) {
            console.log(`    - ${note}`);
          }
        }

        if (versions.length > 0) {
          console.log(`\n  Versions (${versions.length}):`);
          for (const v of versions) {
            const pct =
              v.successCount + v.failureCount > 0
                ? ` (${((v.successCount / (v.successCount + v.failureCount)) * 100).toFixed(0)}% success)`
                : "";
            console.log(`    v${v.versionNumber}: ${v.successCount} OK, ${v.failureCount} failed${pct}`);
            if (v.avoidanceNotes && v.avoidanceNotes.length > 0) {
              for (const note of v.avoidanceNotes.slice(0, 3)) {
                console.log(`      ⚠ ${note}`);
              }
            }
          }
        }

        if (failures.length > 0) {
          console.log(`\n  Recent failures (${failures.length} total):`);
          for (const f of failures.slice(0, 10)) {
            const when = new Date(f.timestamp * 1000).toISOString();
            const step = f.failedAtStep !== null ? ` step ${f.failedAtStep}` : "";
            console.log(`    [${when}] v${f.versionNumber}${step}: ${f.context ?? "(no context)"}`);
          }
        } else {
          console.log("\n  No failures recorded.");
        }
      }),
    );

  procedureCmd
    .command("list")
    .description("List all procedures (optionally filtered by type)")
    .option("--type <type>", "Filter by type: positive, negative, or all (default: all)")
    .option("--limit <n>", "Maximum number to show (default: 20)")
    .action(
      withExit(async (opts: { type?: string; limit?: number }) => {
        const limit = opts.limit ?? 20;
        const procs = factsDb.listProcedures(limit * 3); // over-fetch then filter
        const filtered = opts.type && opts.type !== "all" ? procs.filter((p) => p.procedureType === opts.type) : procs;
        const shown = filtered.slice(0, limit);

        console.log(`Procedures (showing ${shown.length} of ${filtered.length}):`);
        for (const p of shown) {
          const rate = p.successRate !== undefined ? ` ${(p.successRate * 100).toFixed(0)}%` : "";
          const ver = p.version !== undefined ? ` v${p.version}` : "";
          console.log(
            `  [${p.id.slice(0, 8)}] ${p.procedureType.padEnd(8)} ${rate.padEnd(6)} ${ver} "${p.taskPattern.slice(0, 60)}"`,
          );
        }
      }),
    );

  mem
    .command("version")
    .description("Show installed version and latest available on GitHub and npm")
    .option("--json", "Machine-readable JSON output")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const installed = ctx.versionInfo.pluginVersion;
        const timeoutMs = 3000;
        const fetchWithTimeout = async (url: string): Promise<Response> => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), timeoutMs);
          try {
            const res = await fetch(url, { signal: c.signal });
            clearTimeout(t);
            return res;
          } catch (err) {
            clearTimeout(t);
            if (err instanceof Error && err.name === "AbortError") throw new Error("Request timed out");
            throw err;
          }
        };

        let githubVersion: string | null = null;
        let npmVersion: string | null = null;
        try {
          const ghRes = await fetchWithTimeout(
            "https://api.github.com/repos/markus-lassfolk/openclaw-hybrid-memory/releases/latest",
          );
          if (ghRes.ok) {
            const data = (await ghRes.json()) as { tag_name?: string };
            const tag = data.tag_name;
            githubVersion = typeof tag === "string" ? tag.replace(/^v/, "") : null;
          }
        } catch {
          githubVersion = null;
        }
        try {
          const npmRes = await fetchWithTimeout("https://registry.npmjs.org/openclaw-hybrid-memory/latest");
          if (npmRes.ok) {
            const data = (await npmRes.json()) as { version?: string };
            npmVersion = typeof data.version === "string" ? data.version : null;
          }
        } catch {
          npmVersion = null;
        }

        const compare = (a: string, b: string): number => {
          const parseNum = (s: string): number => {
            const n = Number.parseInt(s, 10);
            return Number.isNaN(n) ? 0 : n;
          };
          const pa = a
            .replace(/[-+].*/, "")
            .split(".")
            .map(parseNum);
          const pb = b
            .replace(/[-+].*/, "")
            .split(".")
            .map(parseNum);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const va = pa[i] ?? 0;
            const vb = pb[i] ?? 0;
            if (va !== vb) return va < vb ? -1 : 1;
          }
          return 0;
        };
        const updateHint = (latest: string | null) => {
          if (latest == null) return "";
          return compare(installed, latest) < 0 ? " ⬆ update available" : " (up to date)";
        };

        if (opts?.json) {
          console.log(
            JSON.stringify(
              {
                name: "openclaw-hybrid-memory",
                installed,
                github: githubVersion ?? "unavailable",
                npm: npmVersion ?? "unavailable",
                updateAvailable:
                  (githubVersion != null && compare(installed, githubVersion) < 0) ||
                  (npmVersion != null && compare(installed, npmVersion) < 0),
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log("openclaw-hybrid-memory");
        console.log(`  Installed:  ${installed}`);
        console.log(
          `  GitHub:     ${githubVersion ?? "unavailable"}${githubVersion != null && compare(installed, githubVersion) > 0 ? " (installed is newer)" : updateHint(githubVersion)}`,
        );
        console.log(
          `  npm:        ${npmVersion ?? "unavailable"}${npmVersion != null && compare(installed, npmVersion) > 0 ? " (installed is newer)" : updateHint(npmVersion)}`,
        );
      }),
    );

  mem
    .command("upgrade [version]")
    .description("Upgrade hybrid-mem to a specific version (or latest). Downloads and installs plugin from GitHub.")
    .action(
      withExit(async (version?: string) => {
        const res = await runUpgrade(version);
        if (res.ok) {
          console.log(`Upgraded to version ${res.version}. Plugin installed at: ${res.pluginDir}`);
        } else {
          console.error(`Error upgrading: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  mem
    .command("uninstall")
    .description("Uninstall hybrid-mem: clean plugin files, optionally remove from OpenClaw config")
    .option("--clean-all", "Remove all plugin data (SQLite, LanceDB, reports, config)")
    .option("--leave-config", "Keep OpenClaw config entry (just clean plugin files)")
    .action(
      withExit(async (opts?: { cleanAll?: boolean; leaveConfig?: boolean }) => {
        let res;
        try {
          res = await runUninstall({
            cleanAll: !!opts?.cleanAll,
            leaveConfig: !!opts?.leaveConfig,
          });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "cli",
            operation: "uninstall",
          });
          throw err;
        }
        if (res.outcome === "config_updated") {
          console.log(`Uninstalled ${res.pluginId}: config updated, cleaned ${res.cleaned.length} files.`);
        } else if (res.outcome === "config_not_found") {
          console.log(`Uninstalled ${res.pluginId}: config not found, cleaned ${res.cleaned.length} files.`);
        } else if (res.outcome === "config_error") {
          console.error(
            `Uninstalled ${res.pluginId}: config error (${res.error}), cleaned ${res.cleaned.length} files.`,
          );
        } else if (res.outcome === "leave_config") {
          console.log(`Uninstalled ${res.pluginId}: config left intact, cleaned ${res.cleaned.length} files.`);
        }
      }),
    );

  // Issue #276 — Backup commands
  const backup = mem
    .command("backup")
    .description(
      `Create a snapshot backup of memory state (SQLite + LanceDB). Default destination: ~/.openclaw/backups/memory/TIMESTAMP/\n\nNOTE: To include memory in scheduled openclaw backups, add these paths to your openclaw.yaml backup config:\n  - ${resolvedSqlitePath ?? "<memoryDir>/memory.db"}\n  - ${resolvedLancePath ?? "<memoryDir>/lance/"}`,
    )
    .option("--dest <dir>", "Override backup destination directory")
    .action(
      withExit(async (opts?: { dest?: string }) => {
        if (!runBackup) {
          console.error("Backup is not available in this configuration.");
          process.exitCode = 1;
          return;
        }
        console.log("Creating memory backup…");
        const res = await runBackup({ backupDir: opts?.dest });

        // State file path for heartbeat monitoring (Issue #276, Gap 5)
        const stateDir = join(homedir(), ".openclaw", "state");
        const backupStateFile = join(stateDir, "memory-backup-last.json");

        if (res.ok) {
          const sqliteKb = (res.sqliteSize / 1024).toFixed(1);
          const lanceKb = (res.lancedbSize / 1024).toFixed(1);
          console.log(`✓ Backup complete in ${res.durationMs}ms`);
          console.log(`  Location: ${res.backupDir}`);
          console.log(`  SQLite:   ${sqliteKb} KB${res.integrityOk ? " (integrity OK)" : " ⚠ integrity check failed"}`);
          console.log(`  LanceDB:  ${lanceKb} KB`);
          if (!res.integrityOk) {
            console.warn("⚠ SQLite integrity check failed — backup may be from a corrupt source.");
          }
          // Record successful backup state for heartbeat monitoring
          try {
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(
              backupStateFile,
              `${JSON.stringify(
                {
                  ok: true,
                  timestamp: new Date().toISOString(),
                  backupDir: res.backupDir,
                  sqliteSize: res.sqliteSize,
                  lancedbSize: res.lancedbSize,
                  durationMs: res.durationMs,
                  integrityOk: res.integrityOk,
                },
                null,
                2,
              )}\n`,
            );
          } catch {
            // Non-fatal — state file is advisory only
          }
        } else {
          console.error(`✗ Backup failed: ${res.error}`);
          // Write failure state so heartbeat monitoring can detect and alert (Issue #276, Gap 5)
          try {
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(
              backupStateFile,
              `${JSON.stringify(
                {
                  ok: false,
                  timestamp: new Date().toISOString(),
                  error: res.error,
                },
                null,
                2,
              )}\n`,
            );
            console.error(`  ⚠ Backup failure recorded to: ${backupStateFile}`);
            console.error("  Add to HEARTBEAT.md to get alerted:");
            console.error("    Check ~/.openclaw/state/memory-backup-last.json — if ok=false, alert Markus.");
          } catch {
            // Non-fatal
          }
          process.exitCode = 1;
        }
      }),
    );

  backup
    .command("verify")
    .description("Verify SQLite DB integrity without creating a new backup.")
    .action(
      withExit(async () => {
        if (!runBackupVerify) {
          console.error("Backup verify is not available in this configuration.");
          process.exitCode = 1;
          return;
        }
        const res = runBackupVerify();
        if (res.ok) {
          const status = res.integrityOk ? "✓" : "✗";
          console.log(`${status} ${res.message}`);
          if (!res.integrityOk) process.exitCode = 1;
        } else {
          console.error(`✗ Verify failed: ${res.error}`);
          process.exitCode = 1;
        }
      }),
    );

  // Issue #276, Gap 4 — Schedule backup via system cron
  backup
    .command("schedule")
    .description(
      "Print cron setup instructions for automated weekly memory backups.\n\n" +
        "Installs a cron entry (schedule from config, default: weekly Sunday at 04:00) that runs\n" +
        "`hybrid-mem backup` and writes output to ~/.openclaw/logs/backup.log.\n\n" +
        "The backup state is recorded to ~/.openclaw/state/memory-backup-last.json\n" +
        "so HEARTBEAT.md monitoring can detect failures.",
    )
    .option("--dry-run", "Print the cron line without installing it")
    .action(
      withExit(async (opts?: { dryRun?: boolean }) => {
        // Use config-provided cron expression (falls back to the same default as parseCronReliabilityConfig)
        const cronExpr = cfg.maintenance?.cronReliability?.weeklyBackupCron ?? "0 4 * * 0";
        const hybridMemBin = "hybrid-mem"; // resolved by PATH at runtime
        const logDir = join(homedir(), ".openclaw", "logs");
        const logFile = join(logDir, "backup.log");
        const cronLine = `${cronExpr} ${hybridMemBin} backup >> ${logFile} 2>&1`;

        if (opts?.dryRun) {
          console.log("Cron line (dry-run — not installed):");
          console.log(`  ${cronLine}`);
          return;
        }

        // Attempt to install via crontab
        try {
          mkdirSync(logDir, { recursive: true });
        } catch {
          // Non-fatal
        }

        let currentCrontab = "";
        try {
          currentCrontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
        } catch {
          // No existing crontab — that's fine
        }

        if (currentCrontab.includes("hybrid-mem backup")) {
          console.log("✓ A hybrid-mem backup cron entry already exists:");
          const existing = currentCrontab.split("\n").find((l) => l.includes("hybrid-mem backup"));
          if (existing) console.log(`  ${existing}`);
          return;
        }

        const newCrontab = `${(currentCrontab.trimEnd() ? `${currentCrontab.trimEnd()}\n` : "") + cronLine}\n`;
        try {
          const tmpFile = join(tmpdir(), `crontab-hybrid-mem-${Date.now()}.txt`);
          writeFileSync(tmpFile, newCrontab, "utf-8");
          execSync(`crontab ${tmpFile}`);
          try {
            unlinkSync(tmpFile);
          } catch {
            /* ignore */
          }
          console.log(`✓ Weekly backup scheduled (${cronExpr}).`);
          console.log(`  Log: ${logFile}`);
          console.log(`  State: ${join(homedir(), ".openclaw", "state", "memory-backup-last.json")}`);
          console.log("");
          console.log("Add to HEARTBEAT.md to get alerted on failure:");
          console.log("  Check ~/.openclaw/state/memory-backup-last.json — if ok=false, alert Markus.");
        } catch (err) {
          console.error(`✗ Failed to install crontab: ${err}`);
          console.log("");
          console.log("Add manually with: crontab -e");
          console.log(`  ${cronLine}`);
          process.exitCode = 1;
        }
      }),
    );

  // Issue #281 — Maintenance status command
  const maintenance = mem
    .command("maintenance")
    .description("Memory maintenance management and health checks (Issue #281).");

  maintenance
    .command("status")
    .description("Show maintenance cron job health: nightly cycle, weekly backup, and any reliability issues.")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (opts?: { json?: boolean }) => {
        const cronStorePath = join(homedir(), ".openclaw", "cron", "jobs.json");
        const staleThresholdMs = (cfg.maintenance?.cronReliability?.staleThresholdHours ?? 28) * 60 * 60 * 1000;
        const nightlyCronExpr = cfg.maintenance?.cronReliability?.nightlyCron ?? "0 3 * * *";
        const weeklyBackupCronExpr = cfg.maintenance?.cronReliability?.weeklyBackupCron ?? "0 4 * * 0";

        /** Job health record */
        type JobStatus = {
          name: string;
          pluginJobId: string;
          enabled: boolean;
          lastRunAt: string | null;
          nextRunAt: string | null;
          lastStatus: string | null;
          isStale: boolean;
          isMissing: boolean;
          configuredSchedule: string;
          issue?: string;
        };

        const jobsOfInterest: Array<{ id: string; label: string; scheduleExpr: string; staleMs: number }> = [
          {
            id: "hybrid-mem:nightly-distill",
            label: "nightly-memory-sweep",
            scheduleExpr: nightlyCronExpr,
            staleMs: staleThresholdMs,
          },
          {
            id: "hybrid-mem:nightly-dream-cycle",
            label: "nightly-dream-cycle",
            scheduleExpr: cfg.nightlyCycle?.schedule ?? "45 2 * * *",
            staleMs: staleThresholdMs,
          },
          {
            id: "hybrid-mem:weekly-reflection",
            label: "weekly-reflection",
            scheduleExpr: "0 3 * * 0",
            staleMs: 7 * 24 * 60 * 60 * 1000,
          },
          {
            id: "hybrid-mem:weekly-extract-procedures",
            label: "weekly-extract-procedures",
            scheduleExpr: "0 4 * * 0",
            staleMs: 7 * 24 * 60 * 60 * 1000,
          },
          {
            id: "hybrid-mem:weekly-deep-maintenance",
            label: "weekly-deep-maintenance",
            scheduleExpr: weeklyBackupCronExpr,
            staleMs: 7 * 24 * 60 * 60 * 1000,
          },
          {
            id: "hybrid-mem:monthly-consolidation",
            label: "monthly-consolidation",
            scheduleExpr: "0 5 1 * *",
            staleMs: 32 * 24 * 60 * 60 * 1000,
          },
        ];

        const results: JobStatus[] = [];

        let cronStore: { jobs?: unknown[] } = { jobs: [] };
        if (existsSync(cronStorePath)) {
          try {
            cronStore = JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] };
          } catch {
            // corrupt store — treat all as missing
          }
        }

        const jobs = Array.isArray(cronStore.jobs) ? (cronStore.jobs as Array<Record<string, unknown>>) : [];

        for (const wanted of jobsOfInterest) {
          const found = jobs.find((j) => j && (j.pluginJobId === wanted.id || String(j.name ?? "") === wanted.label));

          if (!found) {
            results.push({
              name: wanted.label,
              pluginJobId: wanted.id,
              enabled: false,
              lastRunAt: null,
              nextRunAt: null,
              lastStatus: null,
              isStale: false,
              isMissing: true,
              configuredSchedule: wanted.scheduleExpr,
              issue: "Job not found in cron store — run `hybrid-mem verify --fix` to install.",
            });
            continue;
          }

          const enabled = found.enabled !== false;
          const state = found.state as
            | { nextRunAtMs?: number; lastRunAtMs?: number; lastStatus?: string; lastError?: string }
            | undefined;
          const lastRunAtMs = state?.lastRunAtMs;
          const nextRunAtMs = state?.nextRunAtMs;
          const lastStatus = state?.lastStatus ?? null;

          const isStale = enabled && lastRunAtMs != null && Date.now() - lastRunAtMs > wanted.staleMs;
          const neverRan = enabled && lastRunAtMs == null;

          let issue: string | undefined;
          if (!enabled) {
            issue = "Job is disabled.";
          } else if (neverRan) {
            issue = "Job has never run — check cron daemon is running.";
          } else if (isStale) {
            const hoursSince = Math.floor((Date.now() - (lastRunAtMs ?? 0)) / 3600000);
            issue = `Job is stale — last run was ${hoursSince}h ago (threshold: ${Math.floor(wanted.staleMs / 3600000)}h).`;
          } else if (lastStatus === "error") {
            issue = `Last run failed: ${state?.lastError ?? "unknown error"}`;
          }

          results.push({
            name: wanted.label,
            pluginJobId: wanted.id,
            enabled,
            lastRunAt: lastRunAtMs != null ? new Date(lastRunAtMs).toISOString() : null,
            nextRunAt: nextRunAtMs != null ? new Date(nextRunAtMs).toISOString() : null,
            lastStatus,
            isStale,
            isMissing: false,
            configuredSchedule: wanted.scheduleExpr,
            issue,
          });
        }

        const issues = results.filter((r) => r.issue);

        if (opts?.json) {
          console.log(JSON.stringify({ ok: issues.length === 0, jobs: results, issueCount: issues.length }, null, 2));
          return;
        }

        // Human-readable output
        console.log("Memory Maintenance Status (Issue #281)");
        console.log("========================================");
        console.log(`Cron store: ${cronStorePath}`);
        console.log(`Stale threshold (daily): ${cfg.maintenance?.cronReliability?.staleThresholdHours ?? 28}h`);
        console.log("");

        for (const r of results) {
          const icon = r.isMissing ? "❌" : !r.enabled ? "⏸ " : r.issue ? "⚠️ " : "✅";
          const lastRun = r.lastRunAt
            ? `last: ${relativeTime(new Date(r.lastRunAt).getTime())} (${r.lastStatus ?? "unknown"})`
            : "last: never";
          const nextRun = r.nextRunAt ? `next: ${relativeTime(new Date(r.nextRunAt).getTime())}` : "";
          const timing = [lastRun, nextRun].filter(Boolean).join("  ");
          console.log(
            `${icon} ${r.name.padEnd(32)} ${r.isMissing ? "MISSING" : r.enabled ? "enabled " : "disabled"} ${timing}`,
          );
          if (r.issue) {
            console.log(`   └─ ${r.issue}`);
          }
        }

        console.log("");
        if (issues.length === 0) {
          console.log("✅ All maintenance jobs healthy.");
        } else {
          console.log(`⚠️  ${issues.length} issue(s) detected. Run \`hybrid-mem verify --fix\` to repair.`);
          if (issues.some((r) => r.isMissing)) {
            console.log("   Missing jobs can be registered with: hybrid-mem install");
          }
        }
      }),
    );

  maintenance
    .command("cron-health")
    .description(
      "Check if expected cron jobs exist and have fired recently. " +
        "Logs warnings for missing or stale jobs. Useful in heartbeat checks.",
    )
    .action(
      withExit(async () => {
        const cronStorePath = join(homedir(), ".openclaw", "cron", "jobs.json");
        const staleThresholdMs = (cfg.maintenance?.cronReliability?.staleThresholdHours ?? 28) * 60 * 60 * 1000;
        const criticalJobs = [
          "hybrid-mem:nightly-distill",
          "hybrid-mem:weekly-reflection",
          "hybrid-mem:weekly-deep-maintenance",
        ];

        let cronStore: { jobs?: unknown[] } = { jobs: [] };
        if (existsSync(cronStorePath)) {
          try {
            cronStore = JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] };
          } catch {
            console.warn("⚠ Could not read cron store — skipping health check.");
            return;
          }
        } else {
          console.warn("⚠ Cron store not found — maintenance jobs not installed. Run: hybrid-mem install");
          return;
        }

        const jobs = Array.isArray(cronStore.jobs) ? (cronStore.jobs as Array<Record<string, unknown>>) : [];
        let healthy = true;

        for (const id of criticalJobs) {
          const job = jobs.find((j) => j && j.pluginJobId === id);
          if (!job) {
            console.warn(`⚠ Maintenance job missing: ${id}. Run: hybrid-mem install`);
            healthy = false;
            continue;
          }
          if (job.enabled === false) {
            continue; // Disabled by user intent — not an error
          }
          const state = job.state as { lastRunAtMs?: number; lastStatus?: string } | undefined;
          if (state?.lastRunAtMs != null && Date.now() - state.lastRunAtMs > staleThresholdMs) {
            const h = Math.floor((Date.now() - state.lastRunAtMs) / 3600000);
            console.warn(`⚠ Stale maintenance job: ${id} (last run ${h}h ago). Check cron daemon.`);
            healthy = false;
          }
        }

        if (healthy) {
          console.log("✓ Maintenance cron jobs healthy.");
        }
      }),
    );

  // Issue #280 — Council provenance utility command
  const council = mem.command("council").description("Council review provenance utilities (Issue #280).");

  council
    .command("provenance-headers")
    .description(
      "Generate ACP provenance headers for a council review session. " +
        "Output is JSON — pass to sessions_spawn or embed in review comments.",
    )
    .option("--session-key <key>", "Session key for this council member (e.g. council-review-pr-283)")
    .option("--member <name>", "Council member name/label (e.g. 'Gemini Architect')")
    .option("--trace-id <id>", "Shared trace ID for this council run (auto-generated if omitted)")
    .option("--parent-session <session>", "Orchestrator session key (e.g. 'main')")
    .option("--mode <mode>", "Provenance mode: meta+receipt | meta | receipt | none (from config if omitted)")
    .action(
      withExit(
        async (opts?: {
          sessionKey?: string;
          member?: string;
          traceId?: string;
          parentSession?: string;
          mode?: string;
        }) => {
          const configMode = cfg.maintenance?.council?.provenance ?? "meta+receipt";
          const mode =
            (opts?.mode as import("../config/types/maintenance.js").CouncilProvenanceMode | undefined) ?? configMode;
          const sessionKeyPrefix = cfg.maintenance?.council?.sessionKeyPrefix ?? "council-review";
          const sessionKey = opts?.sessionKey?.trim() || buildCouncilSessionKey(sessionKeyPrefix);

          const { headers, receipt } = buildProvenanceMetadata(mode, sessionKey, {
            councilMember: opts?.member,
            traceId: opts?.traceId,
            parentSession: opts?.parentSession,
          });

          console.log(JSON.stringify({ sessionKey, mode, headers, receipt }, null, 2));
        },
      ),
    );

  council
    .command("trace-id")
    .description("Generate a unique trace ID for a council review run.")
    .action(
      withExit(async () => {
        console.log(generateTraceId());
      }),
    );
}
