// @ts-nocheck
/**
 * Register hybrid-mem CLI subcommands.
 * Thin orchestrator that delegates to specialized command modules.
 */

import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { capturePluginError } from "../services/error-reporter.js";
import type { mergeResults } from "../services/merge-results.js";
import type { AliasDB } from "../services/retrieval-aliases.js";
import { PLUGIN_ID } from "../utils/constants.js";
import { type ActiveTaskContext, registerActiveTaskCommands } from "./active-tasks.js";
import { registerBenchmarkCommands } from "./benchmark.js";
import { registerHelpCommand } from "./cmd-help.js";
import { registerInstallIndexCommand } from "./cmd-install-index.js";
import { executeMineCommand } from "./cmd-mine.js";
import { registerStatusCommands } from "./cmd-status.js";
import { registerUserFriendlyCommands, type UserFriendlyContext } from "./cmd-user-friendly.js";
import { registerAllCliGroups } from "./commands/register-cli-groups.js";
import type { DistillContext } from "./distill.js";
import { registerGoalCommands } from "./goals.js";
import { type ManageContext, registerManageCommands } from "./manage.js";
import { registerSkillsCommands } from "./skills.js";
import { registerTaskQueueStatusCommands } from "./task-queue-status.js";
import type {
  AnalyzeFeedbackPhrasesResult,
  BackfillCliResult,
  BackfillCliSink,
  ConfigCliResult,
  CredentialsAuditResult,
  CredentialsPruneResult,
  DistillCliResult,
  DistillCliSink,
  DistillWindowResult,
  EncryptVaultResult,
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  FindDuplicatesResult,
  GenerateAutoSkillsResult,
  IngestFilesResult,
  IngestFilesSink,
  InstallCliResult,
  MigrateToVaultResult,
  RecordDistillResult,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
  StoreCliOpts,
  StoreCliResult,
  UninstallCliResult,
  UpgradeCliResult,
  VaultStatusResult,
  VerifyCliSink,
} from "./types.js";
import { registerVerifiedCommands } from "./verified.js";
import { registerVerifyCommands, type VerifyContext } from "./verify.js";

export type {
  ActiveTaskContext,
  AnalyzeFeedbackPhrasesResult,
  BackfillCliResult,
  BackfillCliSink,
  ConfigCliResult,
  CredentialsAuditResult,
  CredentialsPruneResult,
  DistillCliResult,
  DistillCliSink,
  DistillWindowResult,
  EncryptVaultResult,
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  FindDuplicatesResult,
  GenerateAutoSkillsResult,
  IngestFilesResult,
  IngestFilesSink,
  InstallCliResult,
  MigrateToVaultResult,
  RecordDistillResult,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
  StoreCliOpts,
  StoreCliResult,
  UninstallCliResult,
  UpgradeCliResult,
  VaultStatusResult,
  VerifyCliSink,
};

export type HybridMemCliContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  wal?: WriteAheadLog | null;
  aliasDb?: AliasDB | null;
  crystallizationStore?: CrystallizationStore | null;
  changeFeed?: import("../services/change-feed.js").ChangeFeed | null;
  provenanceService?: import("../services/provenance.js").ProvenanceService | null;
  issueStore?: import("../backends/issue-store.js").IssueStore | null;
  versionInfo: {
    pluginVersion: string;
    memoryManagerVersion: string;
    schemaVersion: number;
  };
  embeddings: EmbeddingProvider;
  mergeResults: typeof mergeResults;
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  getMemoryCategories: () => string[];
  cfg: HybridMemoryConfig;
  runStore: (opts: StoreCliOpts) => Promise<StoreCliResult>;
  runInstall: (opts: { dryRun: boolean }) => Promise<InstallCliResult>;
  runVerify: (
    opts: {
      fix: boolean;
      logFile?: string;
      testLlm?: boolean;
      reconcile?: boolean;
      reconcilePolicy?: "conservative" | "balanced" | "aggressive";
      reconcileMaxFixes?: number;
    },
    sink: VerifyCliSink,
  ) => Promise<void>;
  runDistillWindow: (opts: { json: boolean }) => Promise<DistillWindowResult>;
  runRecordDistill: () => Promise<RecordDistillResult>;
  runExtractDaily: (
    opts: { days: number; dryRun: boolean; verbose?: boolean; force?: boolean; full?: boolean },
    sink: ExtractDailySink,
  ) => Promise<ExtractDailyResult>;
  runExtractProcedures: (opts: {
    sessionDir?: string;
    days?: number;
    dryRun: boolean;
    verbose?: boolean;
    full?: boolean;
  }) => Promise<ExtractProceduresResult>;
  runGenerateAutoSkills: (opts: {
    dryRun: boolean;
    apply?: boolean;
    verbose?: boolean;
    max?: number;
    policy?: string;
    json?: boolean;
    bypassDuplicateSkillCache?: boolean;
  }) => Promise<GenerateAutoSkillsResult>;
  runSkillsSuggest: (opts: {
    dryRun?: boolean;
    apply?: boolean;
    days?: number;
    verbose?: boolean;
  }) => Promise<import("../services/memory-to-skills.js").SkillsSuggestResult>;
  runBackfill: (
    opts: { dryRun: boolean; workspace?: string; limit?: number },
    sink: BackfillCliSink,
  ) => Promise<BackfillCliResult>;
  runIngestFiles: (
    opts: { dryRun: boolean; workspace?: string; paths?: string[] },
    sink: IngestFilesSink,
  ) => Promise<IngestFilesResult>;
  runDistill: (
    opts: {
      dryRun: boolean;
      all?: boolean;
      days?: number;
      since?: string;
      model?: string;
      verbose?: boolean;
      maxSessions?: number;
      maxSessionTokens?: number;
      full?: boolean;
      force?: boolean;
      steeringPrompt?: string;
      /** Dream attachment allowlist (#2174); empty = process none. */
      sessionIds?: string[];
    },
    sink: DistillCliSink,
  ) => Promise<DistillCliResult>;
  runMigrateToVault: () => Promise<MigrateToVaultResult | null>;
  runEncryptVault: (opts: {
    yes?: boolean;
    backup?: boolean;
    backupPath?: string;
    verify?: boolean;
  }) => EncryptVaultResult;
  runRekeyVault: (opts: {
    yes?: boolean;
    backup?: boolean;
    backupPath?: string;
    verify?: boolean;
  }) => import("./types.js").RekeyVaultResult;
  runVaultStatus: () => VaultStatusResult | null;
  runCredentialsList: () => Array<{
    service: string;
    type: string;
    url: string | null;
  }>;
  runCredentialsGet: (opts: { service: string; type?: string }) => {
    service: string;
    type: string;
    value: string;
    url: string | null;
    notes: string | null;
  } | null;
  runCredentialsAudit: () => CredentialsAuditResult;
  runCredentialsPrune: (opts: { dryRun: boolean; yes?: boolean; onlyFlags?: string[] }) => CredentialsPruneResult;
  /** Historical credential revisions (issue #2104). All return null when the vault is disabled. */
  runCredentialRevisionList: (opts: {
    service: string;
    type: import("../config.js").CredentialType;
  }) => import("../backends/credentials-db.js").CredentialRevisionMeta[] | null;
  runCredentialRevisionGet: (opts: {
    service: string;
    type: import("../config.js").CredentialType;
    revision: string;
  }) => import("../backends/credentials-db.js").CredentialRevisionEntry | null;
  runCredentialRevisionRestore: (opts: {
    service: string;
    type: import("../config.js").CredentialType;
    revision: string;
  }) => import("../backends/credentials-db.js").CredentialEntry | null;
  runCredentialRevisionPurge: (opts: {
    service: string;
    type: import("../config.js").CredentialType;
    revision?: string;
    all?: boolean;
  }) => { purged: number } | null;
  runCredentialRevisionPin: (opts: {
    service: string;
    type: import("../config.js").CredentialType;
    revision: string;
    pinned: boolean;
  }) => { changed: boolean } | null;
  runUninstall: (opts: { cleanAll: boolean; leaveConfig: boolean }) => Promise<UninstallCliResult>;
  runUpgrade: (version?: string) => Promise<UpgradeCliResult>;
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
  runReflection: (opts: {
    window: number;
    dryRun: boolean;
    model: string;
    verbose?: boolean;
    steeringPrompt?: string;
    sessionIds?: string[];
  }) => Promise<{
    factsAnalyzed: number;
    patternsExtracted: number;
    patternsStored: number;
    window: number;
    semanticOutcome?: string;
  }>;
  runReflectionRules: (opts: {
    dryRun: boolean;
    model: string;
    verbose?: boolean;
    thinkingMode?: import("../services/chat.js").MiniMaxThinkingMode;
  }) => Promise<{
    rulesExtracted: number;
    rulesStored: number;
    diagnostics?: {
      modelResponseChars: number;
      parseSuccess: boolean;
      parsedCandidates: number;
      rejectedDuplicates: number;
      rejectedLowConfidence: number;
      stored: number;
      zeroRulesReason?: string;
      status: "ok" | "partial" | "degraded";
    };
  }>;
  runReflectionMeta: (opts: { dryRun: boolean; model: string; verbose?: boolean }) => Promise<{
    metaExtracted: number;
    metaStored: number;
    diagnostics?: import("../services/reflection.js").ReflectionMetaDiagnostics;
  }>;
  reflectionConfig: {
    enabled: boolean;
    defaultWindow: number;
    minObservations: number;
    model: string;
  };
  runDreamCycle: (opts?: { verbose?: boolean }) => Promise<import("../services/dream-cycle.js").DreamCycleResult>;
  runContinuousVerification: (opts?: {
    verbose?: boolean;
  }) => Promise<import("../services/continuous-verifier.js").VerificationCycleResult>;
  runResolveContradictions: () => Promise<{
    autoResolved: Array<{
      contradictionId: string;
      factIdNew: string;
      factIdOld: string;
    }>;
    ambiguous: Array<{
      contradictionId: string;
      factIdNew: string;
      factIdOld: string;
    }>;
  }>;
  runResolveContradictionsDryRun: () => Promise<{
    autoResolvable: Array<{
      contradictionId: string;
      factIdNew: string;
      factIdOld: string;
    }>;
    ambiguous: Array<{
      contradictionId: string;
      factIdNew: string;
      factIdOld: string;
    }>;
  }>;
  runResolveContradictionsProjectStateLww: (opts: {
    dryRun?: boolean;
  }) => Promise<import("../backends/facts-db/contradictions.js").ProjectStateLwwResult>;
  runResolveContradictionsAuto: (
    opts: import("../backends/facts-db/contradictions.js").ResolveContradictionsAutoOptions,
  ) => Promise<import("../backends/facts-db/contradictions.js").ResolveContradictionsAutoResult>;
  runApplyContradictionReviewDecisions: (
    decisions: import("../backends/facts-db/contradictions.js").ContradictionReviewDecision[],
  ) => Promise<import("../backends/facts-db/contradictions.js").ApplyContradictionReviewResult>;
  requireWalFlushBeforeMutation: (phase: string) => Promise<{ committed: number; skipped: number }>;
  runClassify: (opts: { dryRun: boolean; limit: number; model?: string }) => Promise<{
    reclassified: number;
    total: number;
    breakdown?: Record<string, number>;
    batchFailures?: number;
  }>;
  autoClassifyConfig: {
    model: string;
    batchSize: number;
    suggestCategories?: boolean;
  };
  runCompaction: (opts?: { apply?: boolean }) => Promise<{
    hot: number;
    warm: number;
    cold: number;
    structural: number;
    changed?: number;
    examined?: number;
    apply?: boolean;
  }>;
  runBuildLanguageKeywords: (opts: {
    model?: string;
    dryRun?: boolean;
  }) => Promise<
    { ok: true; path: string; topLanguages: string[]; languagesAdded: number } | { ok: false; error: string }
  >;
  runEntityEnrichment: (opts: {
    limit: number;
    dryRun: boolean;
    model?: string;
    verbose?: boolean;
    all?: boolean;
    adaptiveCatchUp?: boolean;
    batchSize?: number;
    batchDelayMs?: number;
    timeBudgetSec?: number;
    targetDurationSec?: number;
    maxConcurrency?: number;
    providerPressureBudget?: number;
    onProgress?: (progress: import("../services/entity-enrichment-cli.js").EntityEnrichmentProgress) => void;
    onAdaptivePacing?: (state: import("../services/entity-enrichment-cli.js").EntityEnrichmentAdaptivePacing) => void;
  }) => Promise<import("../services/entity-enrichment-cli.js").EntityEnrichmentCliResult>;
  runSelfCorrectionExtract: (opts: {
    days?: number;
    outputPath?: string;
    verbose?: boolean;
  }) => Promise<SelfCorrectionExtractResult>;
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
    days?: number;
    model?: string;
    approve?: boolean;
    applyTools?: boolean;
    full?: boolean;
    verbose?: boolean;
    /** Dream attachment allowlist (#2174); empty = scan none. */
    sessionIds?: string[];
  }) => Promise<SelfCorrectionRunResult>;
  runAnalyzeFeedbackPhrases: (opts: {
    days?: number;
    model?: string;
    outputPath?: string;
    learn?: boolean;
  }) => Promise<AnalyzeFeedbackPhrasesResult>;
  runExtractDirectives: (opts: { days?: number; verbose?: boolean; dryRun?: boolean; full?: boolean }) => Promise<{
    incidents: Array<{
      userMessage: string;
      categories: string[];
      extractedRule: string;
      precedingAssistant: string;
      confidence: number;
      timestamp?: string;
      sessionFile: string;
    }>;
    sessionsScanned: number;
    skipped?: boolean;
    stored?: number;
    partial?: boolean;
    dedupeDegraded?: boolean;
    cursorBlockedReason?: string;
  }>;
  runExtractReinforcement: (opts: { days?: number; verbose?: boolean; dryRun?: boolean; full?: boolean }) => Promise<{
    incidents: Array<{
      userMessage: string;
      agentBehavior: string;
      recalledMemoryIds: string[];
      toolCallSequence: string[];
      confidence: number;
      timestamp?: string;
      sessionFile: string;
    }>;
    sessionsScanned: number;
    skipped?: boolean;
    jobRunId?: string;
    semanticOutcome?: string;
    annotationStatus?: string;
  }>;
  runExtractImplicitFeedback?: (opts: {
    days?: number;
    verbose?: boolean;
    dryRun?: boolean;
    full?: boolean;
    includeTrajectories?: boolean;
    includeClosedLoop?: boolean;
    onProgress?: (snapshot: import("./cmd-feedback.js").ExtractImplicitFeedbackProgressSnapshot) => void;
  }) => Promise<{
    signalsExtracted: number;
    positiveCount: number;
    negativeCount: number;
    trajectoriesBuilt: number;
    sessionsScanned: number;
    sessionsVisited: number;
    sessionsProcessed: number;
    sessionsSkipped: number;
    sessionsDeferred: number;
    backlogSessionsEstimate: number;
    backlogSignalsEstimate: number;
    backlogTrajectoriesEstimate: number;
    partial: boolean;
    partialReason?: import("./cmd-feedback.js").ExtractImplicitFeedbackStopReason;
    closedLoopReport?: string;
    skipped?: boolean;
  }>;
  runGenerateProposals?: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<{
    created: number;
    jobRunId?: string;
    semanticOutcome?: string;
  }>;
  runExport: (opts: {
    outputPath: string;
    excludeCredentials?: boolean;
    includeCredentials?: boolean;
    sources?: string[];
    mode?: "replace" | "additive";
  }) => Promise<{
    factsExported: number;
    proceduresExported: number;
    filesWritten: number;
    outputPath: string;
  }>;
  richStatsExtras?: {
    getCredentialsCount: () => number;
    getProposalsPending: () => number;
    getProposalsAvailable: () => boolean;
    getWalPending: () => Promise<number> | number;
    getLastRunTimestamps: () => {
      distill?: string;
      reflect?: string;
      compact?: string;
      vectordbOptimize?: string;
    };
    getStorageSizes: () => Promise<{
      sqliteBytes?: number;
      lanceBytes?: number;
      lanceBytesTimedOut?: boolean;
    }>;
    getCronJobsStatus?: () => Array<{
      name: string;
      pluginJobId: string;
      enabled: boolean;
      scheduleExpr: string | null;
      lastRunAtMs: number | null;
    }>;
  };
  listCommands?: {
    listProposals: (opts: { status?: string }) => Promise<
      Array<{
        id: string;
        title: string;
        targetFile: string;
        status: string;
        confidence: number;
        createdAt: number;
      }>
    >;
    proposalApprove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    proposalReject: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;
    listCorrections: (opts: { workspace?: string }) => Promise<{
      reportPath: string | null;
      items: string[];
    }>;
    correctionsApproveAll: (opts: { workspace?: string }) => Promise<{
      applied: number;
      error?: string;
    }>;
    showItem: (id: string) => Promise<{ type: "fact" | "proposal"; data: unknown } | null>;
    triageProposals?: (opts: {
      dryRun?: boolean;
      apply?: boolean;
      policy?: string;
      max?: number;
      json?: boolean;
      stateDb?: string;
      workspace?: string;
    }) => Promise<import("../services/persona-proposal-triage.js").PersonaProposalTriageResult>;
  };
  tieringEnabled: boolean;
  resolvedSqlitePath?: string;
  resolvePath?: (file: string) => string;
  /** Active task working memory context (required when activeTask.enabled = true) */
  activeTask?: ActiveTaskContext;
  runCrossAgentLearning?: (opts?: {
    verbose?: boolean;
  }) => Promise<import("../cli/handlers.js").CrossAgentLearningCliResult>;
  runToolEffectiveness?: (opts?: { verbose?: boolean }) => Promise<string>;
  runCostReport?: (opts: import("../cli/handlers.js").CostReportCliOpts, sink: { log: (msg: string) => void }) => void;
  pruneCostLog?: (retainDays?: number) => number;
  /** Resolved path to LanceDB vector store (for backup). */
  resolvedLancePath?: string;
  /** Create a point-in-time backup snapshot (Issue #276). */
  runBackup?: (opts?: { backupDir?: string }) => Promise<import("../cli/backup.js").BackupCliResult>;
  /** Verify SQLite DB integrity without creating a backup (Issue #276). */
  runBackupVerify?: () => import("../cli/backup.js").BackupVerifyResult;
  /** Cross-agent audit log (Issue #790). */
  auditStore?: import("../backends/audit-store.js").AuditStore | null;
  agentHealthStore?: import("../backends/agent-health-store.js").AgentHealthStore | null;
  proposalsDb?: import("../backends/proposals-db.js").ProposalsDB | null;
  runPassiveObserverOnce?: () => Promise<string>;
  runActiveTasksMaintain?: () => Promise<string>;
};

/** Chainable command type (Commander-style). */
type Chainable = {
  command(name: string): Chainable;
  description(desc: string): Chainable;
  action(fn: (...args: any[]) => void | Promise<void>): Chainable;
  option(flags: string, desc?: string, defaultValue?: unknown): Chainable;
  requiredOption(flags: string, desc?: string, defaultValue?: unknown): Chainable;
  argument?(name: string, desc?: string): Chainable;
  alias?(name: string): Chainable;
};

export function registerHybridMemCli(mem: Chainable, ctx: HybridMemCliContext): void {
  const verifyContext: VerifyContext = {
    runVerify: ctx.runVerify,
    runInstall: ctx.runInstall,
  };
  try {
    registerVerifyCommands(mem, verifyContext);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:verify",
    });
    throw err;
  }

  try {
    registerHelpCommand(mem);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:help",
    });
    throw err;
  }

  const manageContext: ManageContext = ctx;
  const distillContext: DistillContext = {
    runDistillWindow: ctx.runDistillWindow,
    runRecordDistill: ctx.runRecordDistill,
    runExtractDaily: ctx.runExtractDaily,
    runExtractProcedures: ctx.runExtractProcedures,
    runGenerateAutoSkills: ctx.runGenerateAutoSkills,
    runSkillsSuggest: ctx.runSkillsSuggest,
    runDistill: ctx.runDistill,
    runExtractDirectives: ctx.runExtractDirectives,
    runExtractReinforcement: ctx.runExtractReinforcement,
    runGenerateProposals: ctx.runGenerateProposals,
  };
  try {
    registerAllCliGroups(mem, manageContext, distillContext);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:groups",
    });
    throw err;
  }

  try {
    registerManageCommands(mem, manageContext);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:manage",
    });
    throw err;
  }

  try {
    registerSkillsCommands(mem, {
      crystallizationStore: ctx.crystallizationStore ?? null,
      cfg: ctx.cfg,
      factsDb: ctx.factsDb ?? null,
      changeFeed: ctx.changeFeed ?? null,
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:skills",
    });
    throw err;
  }

  try {
    registerTaskQueueStatusCommands(mem);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:task-queue-status",
    });
    throw err;
  }

  try {
    registerStatusCommands(mem, {
      factsDb: ctx.factsDb,
      vectorDb: ctx.vectorDb,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      resolvedLancePath: ctx.resolvedLancePath,
      pluginId: PLUGIN_ID,
      cfg: ctx.cfg as unknown as Record<string, unknown>,
      costTracker: ctx.costTracker ?? null,
      auditStore: ctx.auditStore ?? null,
      agentHealthStore: ctx.agentHealthStore ?? null,
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:status",
    });
    throw err;
  }

  try {
    registerActiveTaskCommands(mem, ctx.cfg, ctx.activeTask);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:active-tasks",
    });
    throw err;
  }

  try {
    registerGoalCommands(mem, ctx);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:goals",
    });
    throw err;
  }

  try {
    registerVerifiedCommands(mem, {
      factsDb: ctx.factsDb,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      resolvePath: ctx.resolvePath,
      reverificationDays: ctx.cfg.verification?.reverificationDays,
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:verified",
    });
    throw err;
  }

  try {
    registerBenchmarkCommands(mem, ctx);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:benchmark",
    });
    throw err;
  }

  // Register user-friendly commands (setup, demo, providers, health, doctor, examples)
  try {
    const userFriendlyContext: UserFriendlyContext = {
      cfg: ctx.cfg,
      factsDb: ctx.factsDb,
      vectorDb: ctx.vectorDb,
      wal: ctx.wal,
      embeddings: ctx.embeddings,
      resolvedSqlitePath: ctx.resolvedSqlitePath,
      aliasDb: ctx.aliasDb,
      runBackup: ctx.runBackup,
      runConfigSet: ctx.runConfigSet,
      runConfigMode: ctx.runConfigMode,
      runInstall: ctx.runInstall,
      runMine: async (path: string) => {
        await executeMineCommand(path, {}, ctx.factsDb, ctx.vectorDb, ctx.embeddings);
      },
    };
    registerUserFriendlyCommands(mem, userFriendlyContext);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:user-friendly",
    });
    throw err;
  }

  // Register the install-index reconciliation commands (issue #2008).
  try {
    registerInstallIndexCommand(mem);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "register-cli:install-index",
    });
  }
}
