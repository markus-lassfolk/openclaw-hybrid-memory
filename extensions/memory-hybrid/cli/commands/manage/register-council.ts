import { getEnv } from "../../../utils/env-manager.js";
/**
 * CLI registration functions for management commands.
 * Extracted from cli/register.ts lines 290-1552.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mergeAgentHealthDashboard } from "../../../backends/agent-health-store.js";
import type { FactsDB } from "../../../backends/facts-db.js";
import type { VectorDB } from "../../../backends/vector-db.js";
import type { HybridMemoryConfig } from "../../../config.js";
import { getCronModelConfig, getDefaultCronModel, vectorDimsForModel } from "../../../config.js";
import { collectForgeState } from "../../../routes/dashboard-server.js";
import { runContextAudit } from "../../../services/context-audit.js";
import { migrateEmbeddings } from "../../../services/embedding-migration.js";
import type { EmbeddingProvider } from "../../../services/embeddings.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import { getEffectivenessReport, runClosedLoopAnalysis } from "../../../services/feedback-effectiveness.js";
import { runMemoryDiagnostics } from "../../../services/memory-diagnostics.js";
import { filterByScope, mergeResults } from "../../../services/merge-results.js";
import type { SearchResult } from "../../../types/memory.js";
import type { ScopeFilter } from "../../../types/memory.js";
import { getLanguageKeywordsFilePath } from "../../../utils/language-keywords.js";
import { execSync } from "../../../utils/process-runner.js";
import { buildCouncilSessionKey, buildProvenanceMetadata, generateTraceId } from "../../../utils/provenance.js";
import type { ManageContext } from "../../context.js";
import { buildAppliedContent, buildUnifiedDiff } from "../../proposals.js";
import { type Chainable, relativeTime, withExit } from "../../shared.js";
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
} from "../../types.js";

import type { ManageBindings } from "./bindings.js";

export function registerManageCouncil(mem: Chainable, b: ManageBindings): void {
  const {
    factsDb,
    vectorDb,
    aliasDb,
    versionInfo,
    embeddings,
    mergeResults: merge,
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
    runEntityEnrichment,
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
    ctx,
    BACKFILL_DECAY_MARKER,
  } = b;

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
            (opts?.mode as import("../../../config/types/maintenance.js").CouncilProvenanceMode | undefined) ??
            configMode;
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
