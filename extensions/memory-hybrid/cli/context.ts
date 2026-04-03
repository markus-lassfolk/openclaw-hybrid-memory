/** Shared CLI context for management commands (`registerManageCommands`). */
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { HybridMemoryConfig } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
// biome-ignore lint/style/useImportType: mergeResults kept as value import so typeof mergeResults resolves at the type level without confusion
import { mergeResults } from "../services/merge-results.js";
import type {
  AnalyzeFeedbackPhrasesResult,
  BackfillCliResult,
  BackfillCliSink,
  ConfigCliResult,
  CredentialsAuditResult,
  CredentialsPruneResult,
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
  runEntityEnrichment: (opts: {
    limit: number;
    dryRun: boolean;
    model?: string;
    verbose?: boolean;
  }) => Promise<{
    pending: number;
    processed: number;
    factsEnriched: number;
    skipped?: boolean;
    pendingFactIds?: string[];
    enrichedFacts?: import("../services/entity-enrichment-cli.js").EntityEnrichmentVerboseFact[];
  }>;
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
