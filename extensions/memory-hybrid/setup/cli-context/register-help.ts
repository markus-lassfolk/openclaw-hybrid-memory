// @ts-nocheck
import { getEnv } from "../../utils/env-manager.js";
/**
 * Build HybridMemCliContext from handler context and services.
 * Moves CLI wiring out of index.ts so the plugin entry stays small.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Command } from "commander";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { ActiveTaskContext } from "../../cli/active-tasks.js";
import { runBackup as runBackupFn, runBackupVerify as runBackupVerifyFn } from "../../cli/backup.js";
import type { HandlerContext } from "../../cli/handlers.js";
import * as handlers from "../../cli/handlers.js";
import { applyApprovedProposal, getProposalExpiryError } from "../../cli/proposals.js";
import type { HybridMemCliContext } from "../../cli/register.js";
import { getCronModelConfig, getDefaultCronModel, hybridConfigSchema } from "../../config.js";
import { syncProposalWithdrawnInChangeFeed } from "../../services/change-feed-emit.js";
import {
  applyParsedCorrectionRules,
  parseReportProposedSections,
  parseReportRulesForApply,
} from "../../services/corrections-report.js";
import { readGuardTimestampMs } from "../../services/cron-guard.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { readOpenClawCronStore } from "../../services/openclaw-cron-store.js";
import { runPersonaProposalTriage, validatePersonaPolicy } from "../../services/persona-proposal-triage.js";
import { resolveCliWorkspaceRoot } from "../../utils/cli-workspace-root.js";
import { parseDuration } from "../../utils/duration.js";
import { resetPluginLogger, restoreDefaultLogger } from "../../utils/logger.js";
import { buildCliContextServices } from "./cli-services.js";
import { HYBRID_MEM_CLI_ROOT_DESCRIPTOR } from "./help-text.js";
import { registerCliWithHelp } from "./register-cli-with-help.js";
/**
 * Help-only CLI wiring for `openclaw hybrid-mem --help` (and subcommand help).
 *
 * When OpenClaw prints help, no Commander action runs; `postAction` teardown hooks never fire.
 * If the plugin bootstraps databases or starts async background checks during register(), those
 * handles can keep the process alive and make help look hung (issue #<hang-help>).
 *
 * This registers the full Commander command tree without initializing DBs, native deps, or any
 * background checks. It intentionally ignores the user's plugin config so help is deterministic
 * even when config secrets (env:/file:) are missing.
 */
export function registerHybridMemCliHelpOnlyWithApi(api: ClawdbotPluginApi): void {
  // Silence config-parser telemetry so help output stays clean.
  resetPluginLogger();
  let cfg: HandlerContext["cfg"];
  try {
    cfg = hybridConfigSchema.parse({
      embedding: {
        provider: "openai",
        apiKey: "sk-help-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
      },
    });
  } catch {
    // Fallback that does not require credentials (still needs a model name for provider != openai).
    cfg = hybridConfigSchema.parse({
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
      },
    });
  } finally {
    restoreDefaultLogger();
  }

  const resolvedSqlitePath = api.resolvePath(cfg.sqlitePath);
  const resolvedLancePath = api.resolvePath(cfg.lanceDbPath);

  const stub: unknown = {};
  const cliRegistrationCtx: HybridMemCliRegistrationContext = {
    factsDb: stub as HandlerContext["factsDb"],
    vectorDb: stub as HandlerContext["vectorDb"],
    embeddings: stub as HandlerContext["embeddings"],
    openai: stub as HandlerContext["openai"],
    cfg,
    credentialsDb: null,
    aliasDb: null,
    wal: null,
    proposalsDb: null,
    identityReflectionStore: null,
    personaStateStore: null,
    crystallizationStore: null,
    verificationStore: null,
    provenanceService: null,
    issueStore: null,
    resolvedSqlitePath,
    resolvedLancePath,
    pluginId: "openclaw-hybrid-memory",
    detectCategory: (() => "fact") as HandlerContext["detectCategory"],
    eventLog: null,
    costTracker: null,
    eventBus: null,
    auditStore: null,
    agentHealthStore: null,
  };

  const handlerCtx: HandlerContext = {
    ...cliRegistrationCtx,
    logger: api.logger,
    api,
  };

  const services = buildCliContextServices(cliRegistrationCtx, api);
  api.registerCli(
    ({ program }: { program: Command }) => {
      const cliCtx = createHybridMemCliContext(handlerCtx, api, services);
      registerCliWithHelp(program, cliCtx);
    },
    { descriptors: [HYBRID_MEM_CLI_ROOT_DESCRIPTOR] },
  );
}

function buildRichStatsExtras(ctx: HandlerContext): NonNullable<HybridMemCliContext["richStatsExtras"]> {
  const { credentialsDb, proposalsDb, wal, factsDb, resolvedSqlitePath, resolvedLancePath } = ctx;
  const memoryDir = dirname(resolvedSqlitePath);
  return {
    getCredentialsCount: () => (credentialsDb ? credentialsDb.list().length : 0),
    getProposalsPending: () => (proposalsDb ? proposalsDb.list({ status: "pending" }).length : 0),
    getProposalsAvailable: () => !!proposalsDb,
    getWalPending: async () => (wal ? (await wal.readAllRecoverable()).entries.length : 0),
    getLastRunTimestamps: () => {
      const out: { distill?: string; reflect?: string; compact?: string; vectordbOptimize?: string } = {};
      for (const [key, file] of [
        ["distill", ".distill_last_run"],
        ["reflect", ".reflect_last_run"],
        ["compact", ".compact_last_run"],
        ["vectordbOptimize", ".vectordb_optimize_last_run"],
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
      let lanceBytesTimedOut = false;
      async function dirSizeAsync(p: string): Promise<number | "timeout"> {
        try {
          const { execFile } = await import("node:child_process");
          return await new Promise<number | "timeout">((resolve) => {
            execFile("du", ["-sk", p], { timeout: 5000, maxBuffer: 2_000_000 }, (error, stdout) => {
              if (error) {
                if ("killed" in error && error.killed) {
                  resolve("timeout");
                  return;
                }
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
        const est = factsDb.estimateStorageBytes();
        sqliteBytes = est.sqliteBytes + est.walBytes + est.shmBytes;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "facts-storage-estimate",
          severity: "info",
          subsystem: "cli",
        });
        try {
          if (existsSync(resolvedSqlitePath)) sqliteBytes = statSync(resolvedSqlitePath).size;
        } catch (statErr) {
          capturePluginError(statErr instanceof Error ? statErr : new Error(String(statErr)), {
            operation: "stat-check",
            severity: "info",
            subsystem: "cli",
          });
          /* ignore */
        }
      }
      try {
        if (existsSync(resolvedLancePath)) {
          const lz = await dirSizeAsync(resolvedLancePath);
          if (lz === "timeout") lanceBytesTimedOut = true;
          else lanceBytes = lz;
        }
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "dir-size",
          severity: "info",
          subsystem: "cli",
        });
        /* ignore */
      }
      return { sqliteBytes, lanceBytes, lanceBytesTimedOut };
    },
    getCronJobsStatus: () => {
      const owHome =
        process.env.OPENCLAW_HOME?.trim() || join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".openclaw");
      let store: { jobs?: unknown[] };
      try {
        store = readOpenClawCronStore(owHome).store;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "stats-read-cron-store",
          severity: "info",
          subsystem: "cli",
        });
        return [];
      }
      if (!Array.isArray(store.jobs)) return [];
      const out: Array<{
        name: string;
        pluginJobId: string;
        enabled: boolean;
        scheduleExpr: string | null;
        lastRunAtMs: number | null;
      }> = [];
      for (const j of store.jobs as Array<Record<string, unknown>>) {
        if (!j || typeof j !== "object") continue;
        const pluginJobId = typeof j.pluginJobId === "string" ? j.pluginJobId : "";
        if (!pluginJobId.startsWith("hybrid-mem:")) continue;
        const sched = j.schedule as { expr?: string } | string | undefined;
        const scheduleExpr = typeof sched === "string" ? sched : typeof sched?.expr === "string" ? sched.expr : null;
        const state = (typeof j.state === "object" && j.state !== null ? j.state : {}) as Record<string, unknown>;
        const stateLast = typeof state.lastRunAtMs === "number" ? state.lastRunAtMs : null;
        const jobName = typeof j.name === "string" ? j.name : pluginJobId;
        const guardMs = readGuardTimestampMs(jobName.replace(/\s+/g, "-"), owHome);
        const lastRunAtMs =
          stateLast != null && guardMs != null ? Math.max(stateLast, guardMs) : (stateLast ?? guardMs);
        out.push({
          name: jobName,
          pluginJobId,
          enabled: j.enabled !== false,
          scheduleExpr,
          lastRunAtMs,
        });
      }
      return out;
    },
  };
}

function buildListCommands(
  ctx: HandlerContext,
  api: ClawdbotPluginApi,
): NonNullable<HybridMemCliContext["listCommands"]> {
  const { factsDb, proposalsDb, cfg, resolvedSqlitePath, changeFeed } = ctx;
  const workspaceRoot = (workspace?: string) => resolveCliWorkspaceRoot({ workspace });
  const reportDir = (workspace?: string) => join(workspaceRoot(workspace), "memory", "reports");

  function parseReportProposedSectionsLocal(content: string): string[] {
    return parseReportProposedSections(content);
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
      const expiryError = getProposalExpiryError(p);
      if (expiryError) return { ok: false, error: expiryError };
      const approved = proposalsDb.updateStatusIf(id, "approved", "pending");
      if (!approved) return { ok: false, error: "Proposal is not pending" };
      const applyResult = await applyApprovedProposal({ proposalsDb, cfg, resolvedSqlitePath, api, changeFeed }, id);
      if (!applyResult.ok) {
        proposalsDb.updateStatusIf(id, "pending", "approved");
        return { ok: false, error: applyResult.error };
      }
      return { ok: true };
    },
    proposalReject: async (id: string, reason?: string) => {
      if (!proposalsDb) return { ok: false, error: "Proposals not available" };
      const p = proposalsDb.get(id);
      if (!p) return { ok: false, error: `Proposal ${id} not found` };
      if (p.status !== "pending") return { ok: false, error: `Proposal is already ${p.status}` };
      const rejected = proposalsDb.updateStatusIf(id, "rejected", "pending", undefined, reason);
      if (!rejected) return { ok: false, error: "Proposal is not pending" };
      syncProposalWithdrawnInChangeFeed(changeFeed, cfg, `persona:${id}`, reason ?? "Rejected via CLI");
      return { ok: true };
    },
    listCorrections: async (opts: { workspace?: string }) => {
      const report = getLatestCorrectionReport(opts.workspace);
      if (!report) return { reportPath: null, items: [] };
      const items = parseReportProposedSectionsLocal(report.content);
      return { reportPath: report.path, items };
    },
    correctionsApproveAll: async (opts: { workspace?: string }) => {
      const report = getLatestCorrectionReport(opts.workspace);
      if (!report) return { applied: 0, error: "No self-correction report found" };
      const root = workspaceRoot(opts.workspace);
      const parsed = parseReportRulesForApply(report.content, root);
      const totalRules =
        parsed.toolsRules.length +
        [...parsed.agentsRulesByFile.values()].reduce((n, rules) => n + rules.length, 0) +
        parsed.skillUpdates.length;
      if (totalRules === 0 && parsed.unresolvedSkillUpdates.length === 0) {
        return {
          applied: 0,
          error: "No suggested TOOLS, persona, or skill rules in report (run self-correction-run first)",
        };
      }
      const scCfg = cfg.selfCorrection ?? { toolsSection: "Self-correction rules" };
      const section =
        typeof scCfg === "object" && scCfg && "toolsSection" in scCfg
          ? (scCfg.toolsSection as string)
          : "Self-correction rules";
      const { applied, errors } = applyParsedCorrectionRules({
        workspaceRoot: root,
        toolsSection: section,
        parsed,
      });
      if (errors.length > 0 && applied === 0) {
        return { applied: 0, error: errors.join("; ") };
      }
      return { applied, error: errors.length > 0 ? errors.join("; ") : undefined };
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
    triageProposals: async (opts: {
      dryRun?: boolean;
      apply?: boolean;
      policy?: string;
      max?: number;
      json?: boolean;
      stateDb?: string;
      workspace?: string;
    }) => {
      if (!proposalsDb) throw new Error("Proposals not available");
      if (opts.dryRun && opts.apply) throw new Error("Use only one of --dry-run or --apply");
      const policy = opts.policy ?? "report-only";
      validatePersonaPolicy(policy);
      return runPersonaProposalTriage({
        proposalsDb,
        cfg,
        mode: opts.dryRun ? "dry-run" : opts.apply ? "apply" : "dry-run",
        policy,
        max: opts.max,
        stateDbPath: opts.stateDb,
        workspace: opts.workspace,
        changeFeed: ctx.changeFeed,
        resolvedSqlitePath: ctx.resolvedSqlitePath,
      });
    },
  };
}

/**
 * Build the ActiveTaskContext from the handler context.
 * Resolves file paths against the workspace root.
 */
function buildActiveTaskCliContext(handlerCtx: HandlerContext): ActiveTaskContext {
  const workspaceRoot = getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
  const { activeTask } = handlerCtx.cfg;
  // Resolve relative paths against workspace root (use isAbsolute for cross-platform support)
  const activeTaskFilePath = isAbsolute(activeTask.filePath)
    ? activeTask.filePath
    : join(workspaceRoot, activeTask.filePath);
  const memoryDir = join(workspaceRoot, "memory");
  return {
    activeTaskFilePath,
    workspaceRoot,
    cfg: handlerCtx.cfg,
    staleMinutes: parseDuration(activeTask.staleThreshold),
    flushOnComplete: activeTask.flushOnComplete,
    memoryDir,
    ledger: activeTask.ledger,
    projection: activeTask.projection,
    factsDb: handlerCtx.factsDb,
    vectorDb: handlerCtx.vectorDb,
    embeddings: handlerCtx.embeddings,
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
    wal: handlerCtx.wal,
    aliasDb: handlerCtx.aliasDb,
    crystallizationStore: handlerCtx.crystallizationStore ?? null,
    changeFeed: handlerCtx.changeFeed ?? null,
    provenanceService: handlerCtx.provenanceService ?? null,
    issueStore: handlerCtx.issueStore ?? null,
    serendipityStore: handlerCtx.serendipityStore ?? null,
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
    runEncryptVault: (opts) => handlers.runEncryptVaultForCli(handlerCtx, opts),
    runRekeyVault: (opts) => handlers.runRekeyVaultForCli(handlerCtx, opts),
    runVaultStatus: () => handlers.runVaultStatusForCli(handlerCtx),
    runCredentialsList: () => handlers.runCredentialsListForCli(handlerCtx),
    runCredentialsGet: (opts) => handlers.runCredentialsGetForCli(handlerCtx, opts),
    runCredentialsAudit: () => handlers.runCredentialsAuditForCli(handlerCtx),
    runCredentialsPrune: (opts) => handlers.runCredentialsPruneForCli(handlerCtx, opts),
    runCredentialRevisionList: (opts) => handlers.runCredentialRevisionListForCli(handlerCtx, opts),
    runCredentialRevisionGet: (opts) => handlers.runCredentialRevisionGetForCli(handlerCtx, opts),
    runCredentialRevisionRestore: (opts) => handlers.runCredentialRevisionRestoreForCli(handlerCtx, opts),
    runCredentialRevisionPurge: (opts) => handlers.runCredentialRevisionPurgeForCli(handlerCtx, opts),
    runCredentialRevisionPin: (opts) => handlers.runCredentialRevisionPinForCli(handlerCtx, opts),
    runUninstall: (opts) => Promise.resolve(handlers.runUninstallForCli(handlerCtx, opts)),
    runUpgrade: (v?) => handlers.runUpgradeForCli(handlerCtx, v),
    runConfigView: (sink, opts) => handlers.runConfigViewForCli(handlerCtx, sink, opts),
    runConfigMode: (mode) => Promise.resolve(handlers.runConfigModeForCli(handlerCtx, mode)),
    runConfigSet: (key, value) => Promise.resolve(handlers.runConfigSetForCli(handlerCtx, key, value)),
    runConfigSetHelp: (key) => Promise.resolve(handlers.runConfigSetHelpForCli(handlerCtx, key)),
    runFindDuplicates: services.runFindDuplicates,
    runConsolidate: services.runConsolidate,
    runReflection: services.runReflection,
    runReflectionRules: services.runReflectionRules,
    runReflectionMeta: services.runReflectionMeta,
    runReflectIdentity: services.runReflectIdentity,
    runInsightSynthesis: services.runInsightSynthesis,
    runContradictionCandidates: services.runContradictionCandidates,
    runDreamCycle: services.runDreamCycle,
    runContinuousVerification: services.runContinuousVerification,
    runResolveContradictions: services.runResolveContradictions,
    runResolveContradictionsDryRun: services.runResolveContradictionsDryRun,
    runResolveContradictionsProjectStateLww: services.runResolveContradictionsProjectStateLww,
    runResolveContradictionsAuto: services.runResolveContradictionsAuto,
    runApplyContradictionReviewDecisions: services.runApplyContradictionReviewDecisions,
    requireWalFlushBeforeMutation: services.requireWalFlushBeforeMutation,
    reflectionConfig: {
      ...handlerCtx.cfg.reflection,
      model: handlerCtx.cfg.reflection.model ?? getDefaultCronModel(getCronModelConfig(handlerCtx.cfg), "maintenance"),
    },
    runClassify: services.runClassify,
    autoClassifyConfig: {
      ...handlerCtx.cfg.autoClassify,
      model: handlerCtx.cfg.autoClassify.model ?? getDefaultCronModel(getCronModelConfig(handlerCtx.cfg), "nano"),
    },
    runCompaction: services.runCompaction,
    runBuildLanguageKeywords: services.runBuildLanguageKeywords,
    runEntityEnrichment: services.runEntityEnrichment,
    runSelfCorrectionExtract: (opts) => Promise.resolve(handlers.runSelfCorrectionExtractForCli(handlerCtx, opts)),
    runSelfCorrectionRun: (opts) => handlers.runSelfCorrectionRunForCli(handlerCtx, opts),
    runAnalyzeFeedbackPhrases: (opts) => handlers.runAnalyzeFeedbackPhrasesForCli(handlerCtx, opts),
    runExtractDirectives: (opts) => handlers.runExtractDirectivesForCli(handlerCtx, opts),
    runExtractReinforcement: (opts) => handlers.runExtractReinforcementForCli(handlerCtx, opts),
    runExtractImplicitFeedback: (opts) => handlers.runExtractImplicitFeedbackForCli(handlerCtx, opts),
    runCrossAgentLearning: (opts) => handlers.runCrossAgentLearningForCli(handlerCtx, opts),
    runToolEffectiveness: (opts) => handlers.runToolEffectivenessForCli(handlerCtx, opts),
    runCostReport: (opts, sink) => handlers.runCostReportForCli(handlerCtx, opts, sink),
    pruneCostLog: (retainDays) => (handlerCtx.costTracker ? handlerCtx.costTracker.pruneOldEntries(retainDays) : 0),
    runPassiveObserverOnce: services.runPassiveObserverOnce,
    runActiveTasksMaintain: handlerCtx.cfg.activeTask?.enabled
      ? async () => {
          const activeCtx = buildActiveTaskCliContext(handlerCtx);
          if (!activeCtx) return "skipped (activeTask context unavailable)";
          const { runActiveTaskMaintain } = await import("../../cli/active-tasks.js");
          const result = await runActiveTaskMaintain(activeCtx, handlerCtx.cfg, { apply: true, jsonMode: true });
          const reconciled = result.reconcile?.reconciled ?? 0;
          const failed = result.reconcile?.failed ?? 0;
          const semantic =
            result.status === "partial" || result.status === "failed" || failed > 0 ? "partial" : "success";
          return `status=${result.status} reconciled=${reconciled} failed=${failed} semantic=${semantic}`;
        }
      : undefined,
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
    auditStore: handlerCtx.auditStore ?? null,
    agentHealthStore: handlerCtx.agentHealthStore ?? null,
    proposalsDb: handlerCtx.proposalsDb ?? null,
    openai: handlerCtx.openai,
  };
}

/** Register hybrid-mem CLI with the program subcommand and help text */
