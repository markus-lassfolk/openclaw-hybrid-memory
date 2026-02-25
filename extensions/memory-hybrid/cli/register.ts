/**
 * Register hybrid-mem CLI subcommands.
 * Thin orchestrator that delegates to specialized command modules.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { SearchResult } from "../types/memory.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import type { ScopeFilter } from "../types/memory.js";
import { parseSourceDate } from "../utils/dates.js";
import { registerVerifyCommands, type VerifyContext } from "./verify.js";
import { registerDistillCommands, type DistillContext } from "./distill.js";
import { registerManageCommands, type ManageContext } from "./manage.js";
import { registerActiveTaskCommands, type ActiveTaskContext } from "./active-tasks.js";
import { capturePluginError } from "../services/error-reporter.js";
import type {
  FindDuplicatesResult,
  StoreCliOpts,
  StoreCliResult,
  InstallCliResult,
  VerifyCliSink,
  DistillWindowResult,
  RecordDistillResult,
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  GenerateAutoSkillsResult,
  BackfillCliResult,
  BackfillCliSink,
  IngestFilesResult,
  IngestFilesSink,
  DistillCliResult,
  DistillCliSink,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
  MigrateToVaultResult,
  CredentialsAuditResult,
  CredentialsPruneResult,
  UpgradeCliResult,
  UninstallCliResult,
  ConfigCliResult,
} from "./types.js";

export type {
  FindDuplicatesResult,
  StoreCliOpts,
  StoreCliResult,
  InstallCliResult,
  VerifyCliSink,
  DistillWindowResult,
  RecordDistillResult,
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  GenerateAutoSkillsResult,
  BackfillCliResult,
  BackfillCliSink,
  IngestFilesResult,
  IngestFilesSink,
  DistillCliResult,
  DistillCliSink,
  SelfCorrectionExtractResult,
  SelfCorrectionRunResult,
  MigrateToVaultResult,
  CredentialsAuditResult,
  CredentialsPruneResult,
  UpgradeCliResult,
  UninstallCliResult,
  ConfigCliResult,
};
export type { ActiveTaskContext };

export type HybridMemCliContext = {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  versionInfo: { pluginVersion: string; memoryManagerVersion: string; schemaVersion: number };
  embeddings: EmbeddingProvider;
  mergeResults: typeof mergeResults;
  parseSourceDate: (v: string | number | null | undefined) => number | null;
  getMemoryCategories: () => string[];
  cfg: { distill?: { reinforcementBoost?: number; reinforcementProcedureBoost?: number; reinforcementPromotionThreshold?: number } };
  runStore: (opts: StoreCliOpts) => Promise<StoreCliResult>;
  runInstall: (opts: { dryRun: boolean }) => Promise<InstallCliResult>;
  runVerify: (opts: { fix: boolean; logFile?: string; testLlm?: boolean }, sink: VerifyCliSink) => Promise<void>;
  runDistillWindow: (opts: { json: boolean }) => Promise<DistillWindowResult>;
  runRecordDistill: () => Promise<RecordDistillResult>;
  runExtractDaily: (opts: { days: number; dryRun: boolean; verbose?: boolean }, sink: ExtractDailySink) => Promise<ExtractDailyResult>;
  runExtractProcedures: (opts: { sessionDir?: string; days?: number; dryRun: boolean }) => Promise<ExtractProceduresResult>;
  runGenerateAutoSkills: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<GenerateAutoSkillsResult>;
  runSkillsSuggest: (opts: { dryRun: boolean; days?: number; verbose?: boolean }) => Promise<import("../services/memory-to-skills.js").SkillsSuggestResult>;
  runBackfill: (opts: { dryRun: boolean; workspace?: string; limit?: number }, sink: BackfillCliSink) => Promise<BackfillCliResult>;
  runIngestFiles: (opts: { dryRun: boolean; workspace?: string; paths?: string[] }, sink: IngestFilesSink) => Promise<IngestFilesResult>;
  runDistill: (opts: { dryRun: boolean; all?: boolean; days?: number; since?: string; model?: string; verbose?: boolean; maxSessions?: number; maxSessionTokens?: number }, sink: DistillCliSink) => Promise<DistillCliResult>;
  runMigrateToVault: () => Promise<MigrateToVaultResult | null>;
  runCredentialsList: () => Array<{ service: string; type: string; url: string | null }>;
  runCredentialsGet: (opts: { service: string; type?: string }) => { service: string; type: string; value: string; url: string | null; notes: string | null } | null;
  runCredentialsAudit: () => CredentialsAuditResult;
  runCredentialsPrune: (opts: { dryRun: boolean; yes?: boolean; onlyFlags?: string[] }) => CredentialsPruneResult;
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
  runReflection: (opts: { window: number; dryRun: boolean; model: string; verbose?: boolean }) => Promise<{
    factsAnalyzed: number;
    patternsExtracted: number;
    patternsStored: number;
    window: number;
  }>;
  runReflectionRules: (opts: { dryRun: boolean; model: string; verbose?: boolean }) => Promise<{ rulesExtracted: number; rulesStored: number }>;
  runReflectionMeta: (opts: { dryRun: boolean; model: string; verbose?: boolean }) => Promise<{ metaExtracted: number; metaStored: number }>;
  reflectionConfig: { enabled: boolean; defaultWindow: number; minObservations: number; model: string };
  runClassify: (opts: { dryRun: boolean; limit: number; model?: string }) => Promise<{
    reclassified: number;
    total: number;
    breakdown?: Record<string, number>;
  }>;
  autoClassifyConfig: { model: string; batchSize: number; suggestCategories?: boolean };
  runCompaction: () => Promise<{ hot: number; warm: number; cold: number }>;
  runBuildLanguageKeywords: (opts: { model?: string; dryRun?: boolean }) => Promise<
    | { ok: true; path: string; topLanguages: string[]; languagesAdded: number }
    | { ok: false; error: string }
  >;
  runSelfCorrectionExtract: (opts: { days?: number; outputPath?: string }) => Promise<SelfCorrectionExtractResult>;
  runSelfCorrectionRun: (opts: {
    extractPath?: string;
    incidents?: Array<{ userMessage: string; precedingAssistant: string; followingAssistant: string; timestamp?: string; sessionFile: string }>;
    workspace?: string;
    dryRun?: boolean;
    model?: string;
    approve?: boolean;
    noApplyTools?: boolean;
  }) => Promise<SelfCorrectionRunResult>;
  runExtractDirectives: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) => Promise<{ incidents: Array<{ userMessage: string; categories: string[]; extractedRule: string; precedingAssistant: string; confidence: number; timestamp?: string; sessionFile: string }>; sessionsScanned: number }>;
  runExtractReinforcement: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) => Promise<{ incidents: Array<{ userMessage: string; agentBehavior: string; recalledMemoryIds: string[]; toolCallSequence: string[]; confidence: number; timestamp?: string; sessionFile: string }>; sessionsScanned: number }>;
  runGenerateProposals?: (opts: { dryRun: boolean; verbose?: boolean }) => Promise<{ created: number }>;
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
    getWalPending: () => number;
    getLastRunTimestamps: () => { distill?: string; reflect?: string; compact?: string };
    getStorageSizes: () => Promise<{ sqliteBytes?: number; lanceBytes?: number }>;
  };
  listCommands?: {
    listProposals: (opts: { status?: string }) => Promise<Array<{ id: string; title: string; targetFile: string; status: string; confidence: number; createdAt: number }>>;
    proposalApprove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    proposalReject: (id: string, reason?: string) => Promise<{ ok: boolean; error?: string }>;
    listCorrections: (opts: { workspace?: string }) => Promise<{ reportPath: string | null; items: string[] }>;
    correctionsApproveAll: (opts: { workspace?: string }) => Promise<{ applied: number; error?: string }>;
    showItem: (id: string) => Promise<{ type: "fact" | "proposal"; data: unknown } | null>;
  };
  tieringEnabled: boolean;
  resolvedSqlitePath?: string;
  resolvePath?: (file: string) => string;
  /** Active task working memory context (required when activeTask.enabled = true) */
  activeTask?: ActiveTaskContext;
};

/** Chainable command type (Commander-style). */
type Chainable = {
  command(name: string): Chainable;
  description(desc: string): Chainable;
  action(fn: (...args: any[]) => void | Promise<void>): Chainable;
  option(flags: string, desc?: string, defaultValue?: string): Chainable;
  requiredOption(flags: string, desc?: string, defaultValue?: string): Chainable;
  argument(name: string, desc?: string): Chainable;
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
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "register-cli:verify" });
    throw err;
  }

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
    registerDistillCommands(mem, distillContext);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "register-cli:distill" });
    throw err;
  }

  const manageContext: ManageContext = ctx;
  try {
    registerManageCommands(mem, manageContext);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "register-cli:manage" });
    throw err;
  }

  if (ctx.activeTask) {
    try {
      registerActiveTaskCommands(mem, ctx.activeTask);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "register-cli:active-tasks" });
      throw err;
    }
  }
}
