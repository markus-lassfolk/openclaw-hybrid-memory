/** Shared CLI context for management commands (`registerManageCommands`). */
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
// biome-ignore lint/style/useImportType: mergeResults kept as value import so typeof mergeResults resolves at the type level without confusion
import { mergeResults } from "../services/merge-results.js";
import type { ExtractImplicitFeedbackProgressSnapshot } from "./cmd-feedback.js";
import type {
  AnalyzeFeedbackPhrasesResult,
  BackfillCliResult,
  BackfillCliSink,
  ConfigCliResult,
  CredentialsAuditResult,
  CredentialsPruneResult,
  EncryptVaultResult,
  FindDuplicatesResult,
  IngestFilesResult,
  IngestFilesSink,
  MigrateToVaultResult,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
  StoreCliOpts,
  StoreCliResult,
  UninstallCliResult,
  UpgradeCliResult,
  VaultStatusResult,
} from "./types.js";

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
  changeFeed?: import("../services/change-feed.js").ChangeFeed | null;
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
  runCredentialsList: () => Array<{ service: string; type: string; url: string | null }>;
  runCredentialsGet: (opts: {
    service: string;
    type?: string;
  }) => { service: string; type: string; value: string; url: string | null; notes: string | null } | null;
  runCredentialsAudit: () => CredentialsAuditResult;
  runCredentialsPrune: (opts: { dryRun: boolean; yes?: boolean; onlyFlags?: string[] }) => CredentialsPruneResult;
  runUninstall: (opts: { cleanAll: boolean; leaveConfig: boolean }) => Promise<UninstallCliResult>;
  runUpgrade: (version?: string) => Promise<UpgradeCliResult>;
  runConfigView: (
    sink: import("./types.js").VerifyCliSink,
    opts?: { format?: "text" | "json"; featuresOnly?: boolean },
  ) => void | Promise<void>;
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
    batchFailures?: number;
  }>;
  autoClassifyConfig: { model: string; batchSize: number; suggestCategories?: boolean };
  runCompaction: (opts?: { apply?: boolean }) => Promise<{
    hot: number;
    warm: number;
    cold: number;
    structural: number;
    changed?: number;
    examined?: number;
    apply?: boolean;
  }>;
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
  runExtractProcedures?: (opts: {
    days?: number;
    dryRun: boolean;
    verbose?: boolean;
    full?: boolean;
  }) => Promise<unknown>;
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
    all?: boolean;
    verbose?: boolean;
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
  runResolveContradictions: () => Promise<{
    autoResolved: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
    ambiguous: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
  }>;
  runResolveContradictionsDryRun: () => Promise<{
    autoResolvable: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
    ambiguous: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
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
  runSelfCorrectionExtract: (opts: {
    days?: number;
    outputPath?: string;
    verbose?: boolean;
  }) => Promise<SelfCorrectionExtractResult>;
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
    days?: number;
    model?: string;
    approve?: boolean;
    applyTools?: boolean;
    full?: boolean;
    verbose?: boolean;
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
    getLastRunTimestamps: () => { distill?: string; reflect?: string; compact?: string; vectordbOptimize?: string };
    getStorageSizes: () => Promise<{
      sqliteBytes?: number;
      lanceBytes?: number;
      /** True when `du` was killed due to timeout while sizing LanceDB. */
      lanceBytesTimedOut?: boolean;
    }>;
    /** Snapshot of `~/.openclaw/cron/jobs.json` rows whose pluginJobId starts with `hybrid-mem:`. */
    getCronJobsStatus?: () => Array<{
      name: string;
      pluginJobId: string;
      enabled: boolean;
      scheduleExpr: string | null;
      lastRunAtMs: number | null;
    }>;
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
  resolvedLancePath?: string;
  runBackup?: (opts?: { backupDir?: string }) => Promise<import("../cli/backup.js").BackupCliResult>;
  runBackupVerify?: () => import("../cli/backup.js").BackupVerifyResult;
  resolvePath?: (file: string) => string;
  runExtractDaily?: (
    opts: { days: number; dryRun: boolean; verbose?: boolean; force?: boolean; full?: boolean },
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
    full?: boolean;
    includeTrajectories?: boolean;
    includeClosedLoop?: boolean;
    onProgress?: (snapshot: ExtractImplicitFeedbackProgressSnapshot) => void;
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
  runGenerateAutoSkills?: (opts: {
    dryRun: boolean;
    verbose?: boolean;
  }) => Promise<{ generated: number; skipped?: number; paths?: string[] }>;
  runGenerateProposals?: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<{ created: number }>;
  runDreamCycle?: (opts?: { verbose?: boolean }) => Promise<import("../services/dream-cycle.js").DreamCycleResult>;
  runContinuousVerification?: (opts?: {
    verbose?: boolean;
  }) => Promise<import("../services/continuous-verifier.js").VerificationCycleResult>;
  runCrossAgentLearning?: (opts?: {
    verbose?: boolean;
  }) => Promise<import("../cli/handlers.js").CrossAgentLearningCliResult>;
  runToolEffectiveness?: (opts?: { verbose?: boolean }) => Promise<string>;
  runCostReport?: (opts: import("../cli/handlers.js").CostReportCliOpts, sink: { log: (msg: string) => void }) => void;
  pruneCostLog?: (retainDays?: number) => number;
  auditStore?: import("../backends/audit-store.js").AuditStore | null;
  agentHealthStore?: import("../backends/agent-health-store.js").AgentHealthStore | null;
  proposalsDb?: import("../backends/proposals-db.js").ProposalsDB | null;
  runPassiveObserverOnce?: () => Promise<string>;
  runActiveTasksMaintain?: () => Promise<string>;
  eventBus?: import("../backends/event-bus.js").EventBus | null;
};
