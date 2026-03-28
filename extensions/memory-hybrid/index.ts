/**
 * OpenClaw Memory Hybrid Plugin
 *
 * Two-tier memory system:
 *   1. SQLite + FTS5 — structured facts, instant full-text search, zero API cost
 *   2. LanceDB — semantic vector search for fuzzy/contextual recall
 *
 * Retrieval merges results from both backends, deduplicates, and prioritizes
 * high-confidence FTS5 matches over approximate vector matches.
 */

import { Type } from "@sinclair/typebox";
import type OpenAI from "openai";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import {
  DEFAULT_MEMORY_CATEGORIES,
  setMemoryCategories,
  isValidCategory,
  type MemoryCategory,
  DECAY_CLASSES,
  type DecayClass,
  type HybridMemoryConfig,
  vectorDimsForModel,
  CREDENTIAL_TYPES,
  type CredentialType,
  PROPOSAL_STATUSES,
  type IdentityFileType,
  type ConfigMode,
} from "./config.js";
import { hybridConfigSchema } from "./config/hybrid-schema.js";
import { versionInfo } from "./versionInfo.js";
import { WriteAheadLog } from "./backends/wal.js";
import { VectorDB } from "./backends/vector-db.js";
import { FactsDB, MEMORY_LINK_TYPES, type MemoryLinkType, type ContradictionRecord } from "./backends/facts-db.js";
import { registerHybridMemCliWithApi } from "./setup/cli-context.js";
import { buildInstallDefaults, deepMerge } from "./cli/handlers.js";
import { Embeddings, safeEmbed, type EmbeddingProvider } from "./services/embeddings.js";
import {
  chatComplete,
  distillBatchTokenLimit,
  distillMaxOutputTokens,
  createPendingLLMWarnings,
} from "./services/chat.js";
import { extractProceduresFromSessions } from "./services/procedure-extractor.js";
import { generateAutoSkills } from "./services/procedure-skill-generator.js";
import { mergeResults, filterByScope } from "./services/merge-results.js";
import { searchFts, rebuildFtsIndex, buildFts5Query } from "./services/fts-search.js";
import {
  fuseResults,
  applyPostRrfAdjustments,
  RRF_K_DEFAULT,
  type RankedResult,
  type FusedResult,
  type FactMetadata,
} from "./services/rrf-fusion.js";
import {
  runExplicitDeepRetrieval,
  packIntoBudget,
  serializeFactForContext,
  estimateTokenCount,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalPipelineOptions,
} from "./services/retrieval-orchestrator.js";
import { expandGraph, formatLinkPath, HOP_SCORE_DECAY } from "./services/graph-retrieval.js";
export type { GraphExpandedResult, LinkPathStep, GraphFactLookup } from "./services/graph-retrieval.js";
import { findShortestPath, resolveInput, formatPath } from "./services/shortest-path.js";
export type { ShortestPathResult, PathStep, ShortestPathLookup } from "./services/shortest-path.js";
import {
  analyzeKnowledgeGaps,
  detectOrphans,
  detectWeak,
  detectSuggestedLinks,
  computeIsolationScore,
  computeRankScore,
} from "./services/knowledge-gaps.js";
export type {
  GapFact,
  SuggestedLink,
  KnowledgeGapReport,
  GapMode,
  GapFactsDB,
  GapVectorDB,
  GapEmbeddings,
} from "./services/knowledge-gaps.js";
import { detectClusters, generateClusterLabel } from "./services/topic-clusters.js";
export type {
  TopicCluster,
  ClusterDetectionResult,
  ClusterDetectionOptions,
  ClusterFactLookup,
} from "./services/topic-clusters.js";
import { AliasDB, generateAliases, storeAliases, searchAliasStrategy } from "./services/retrieval-aliases.js";
import { gatherIngestFiles } from "./services/ingest-utils.js";
import type { MemoryEntry, SearchResult, ScopeFilter } from "./types/memory.js";
import { MEMORY_SCOPES } from "./types/memory.js";
import { loadPrompt, fillPrompt } from "./utils/prompt-loader.js";
import { initPluginLogger } from "./utils/logger.js";
import {
  truncateText,
  truncateForStorage,
  estimateTokens,
  estimateTokensForDisplay,
  formatProgressiveIndexLine,
  chunkSessionText,
  chunkTextByChars,
} from "./utils/text.js";
import {
  REFLECTION_MAX_FACT_LENGTH,
  REFLECTION_MAX_FACTS_PER_CATEGORY,
  CREDENTIAL_NOTES_MAX_CHARS,
  FACT_PREVIEW_MAX_CHARS,
  CLASSIFY_CANDIDATE_MAX_CHARS,
  DEFAULT_MIN_SCORE,
  CLI_STORE_IMPORTANCE,
  BATCH_STORE_IMPORTANCE,
  REFLECTION_IMPORTANCE,
  CONSOLIDATION_MERGE_MAX_CHARS,
  REFLECTION_PATTERN_MAX_CHARS,
  REFLECTION_META_MAX_CHARS,
  REFLECTION_DEDUPE_THRESHOLD,
  REFLECTION_TEMPERATURE,
  BATCH_THROTTLE_MS,
  SQLITE_BUSY_TIMEOUT_MS,
  SECONDS_PER_DAY,
  PLUGIN_ID,
  getRestartPendingPath,
} from "./utils/constants.js";
import {
  normalizeTextForDedupe,
  normalizedHash,
  TAG_PATTERNS,
  extractTags,
  serializeTags,
  parseTags,
  tagsContains,
} from "./utils/tags.js";
import { parseSourceDate } from "./utils/dates.js";
import { calculateExpiry, classifyDecay } from "./utils/decay.js";
import { computeDynamicSalience } from "./utils/salience.js";
import {
  setKeywordsPath,
  getLanguageKeywordsFilePath,
  getMemoryTriggerRegexes,
  getCategoryDecisionRegex,
  getCategoryPreferenceRegex,
  getCategoryEntityRegex,
  getCategoryFactRegex,
  getExtractionTemplates,
  getCorrectionSignalRegex,
} from "./utils/language-keywords.js";
import {
  runSelfCorrectionExtract,
  type CorrectionIncident,
  type SelfCorrectionExtractResult,
} from "./services/self-correction-extract.js";
import { insertRulesUnderSection } from "./services/tools-md-section.js";
import { tryExtractionFromTemplates } from "./utils/extraction-from-template.js";
import { extractCredentialsFromToolCalls, type ToolCallCredential } from "./services/credential-scanner.js";
import {
  runDirectiveExtract,
  type DirectiveExtractResult,
  type DirectiveIncident,
} from "./services/directive-extract.js";
import {
  runReinforcementExtract,
  type ReinforcementExtractResult,
  type ReinforcementIncident,
} from "./services/reinforcement-extract.js";
import { getDirectiveSignalRegex, getReinforcementSignalRegex } from "./utils/language-keywords.js";
import {
  detectAuthFailure,
  buildCredentialQuery,
  formatCredentialHint,
  DEFAULT_AUTH_FAILURE_PATTERNS,
  type AuthFailurePattern,
} from "./services/auth-failure-detect.js";
import {
  classifyMemoryOperation,
  parseClassificationResponse,
  type MemoryClassification,
} from "./services/classification.js";
import { extractStructuredFields } from "./services/fact-extraction.js";
import {
  getMemoryTriggers,
  detectCredentialPatterns,
  extractCredentialMatch,
  isCredentialLike,
  tryParseCredentialForVault,
  VAULT_POINTER_PREFIX,
  inferServiceFromText,
  SENSITIVE_PATTERNS,
} from "./services/auto-capture.js";
import { runAutoClassify, runClassifyForCli, normalizeSuggestedLabel } from "./services/auto-classifier.js";
import { unionFind, getRoot, isStructuredForConsolidation, runConsolidate } from "./services/consolidation.js";
import { shouldCapture as shouldCaptureUtil, detectCategory as detectCategoryUtil } from "./services/capture-utils.js";
import { buildToolScopeFilter } from "./utils/scope-filter.js";
import { walWrite, walRemove } from "./services/wal-helpers.js";
import {
  runReflection,
  runReflectionRules,
  runReflectionMeta,
  normalizeVector,
  dotProductSimilarity,
  parsePatternsFromReflectionResponse,
} from "./services/reflection.js";
import { findSimilarByEmbedding } from "./services/vector-search.js";
import { migrateCredentialsToVault, CREDENTIAL_REDACTION_MIGRATION_FLAG } from "./services/credential-migration.js";
import { createPluginService, type PluginServiceContext } from "./setup/plugin-service.js";
import { initializeDatabases, closeOldDatabases } from "./setup/init-databases.js";
import type { MemoryPluginAPI } from "./api/memory-plugin-api.js";
import { type PluginRuntime, createTimers } from "./api/plugin-runtime.js";
import { registerTools } from "./setup/register-tools.js";
import { registerLifecycleHooks } from "./setup/register-hooks.js";
import { capturePluginError } from "./services/error-reporter.js";
import { PythonBridge } from "./services/python-bridge.js";
import type { EmbeddingRegistry } from "./services/embedding-registry.js";
import { ContextualVariantGenerator, VariantGenerationQueue } from "./services/contextual-variants.js";

// Backend Imports (extracted from god file for maintainability)

import {
  CredentialsDB,
  type CredentialEntry,
  deriveKey,
  encryptValue,
  decryptValue,
} from "./backends/credentials-db.js";
import { ProposalsDB, type ProposalEntry } from "./backends/proposals-db.js";
import { EventLog } from "./backends/event-log.js";
import { EventBus, computeFingerprint } from "./backends/event-bus.js";
import { IssueStore } from "./backends/issue-store.js";
import { LearningsDB } from "./backends/learnings-db.js";
import {
  WorkflowStore,
  sequenceDistance,
  sequenceSimilarity,
  extractGoalKeywords,
  hashToolSequence,
} from "./backends/workflow-store.js";
import { WorkflowTracker } from "./services/workflow-tracker.js";
import { CrystallizationStore } from "./backends/crystallization-store.js";
import { PatternDetector, computePatternId, scorePattern } from "./services/pattern-detector.js";
import { SkillCrystallizer, deriveSkillName, isExecOnlySequence } from "./services/skill-crystallizer.js";
import { SkillValidator } from "./services/skill-validator.js";
import { CrystallizationProposer } from "./services/crystallization-proposer.js";
import { VerificationStore, shouldAutoVerify, VerificationError } from "./services/verification-store.js";
import { ProvenanceService } from "./services/provenance.js";
import { ToolProposalStore } from "./backends/tool-proposal-store.js";
import { GapDetector, computeGapId, deriveToolNameFromSequence } from "./services/gap-detector.js";
import { ToolProposer } from "./services/tool-proposer.js";

// Helper Functions

/** Wrappers for extracted helper functions that need access to per-instance config via runtimeRef. */
function shouldCapture(text: string): boolean {
  return shouldCaptureUtil(text, runtimeRef.value?.cfg.captureMaxChars ?? 5000, getMemoryTriggers());
}

function detectCategory(text: string): MemoryCategory {
  return detectCategoryUtil(
    text,
    getCategoryDecisionRegex(),
    getCategoryPreferenceRegex(),
    getCategoryEntityRegex(),
    getCategoryFactRegex(),
  );
}

// Plugin Definition

/**
 * Module-level ref holding the active PluginRuntime instance.
 *
 * All closures (tools, event handlers, timers) capture this ref object rather than
 * individual module-level variables.  When register() creates a fresh PluginRuntime
 * after a SIGUSR1 reload, those closures automatically see the new instance through
 * `runtimeRef.value`.
 *
 * Using a ref object (rather than scattered module-level `let`s) means two independent
 * plugin instances can each maintain their own runtime without any shared module-level
 * mutable state — see tests/plugin-runtime.test.ts for isolation proof.
 */
const runtimeRef: { value: PluginRuntime | null } = { value: null };

const memoryHybridPlugin = {
  id: PLUGIN_ID,
  name: "Memory (Hybrid: SQLite + LanceDB)",
  description: "Two-tier memory: SQLite+FTS5 for structured facts, LanceDB for semantic search",
  kind: "memory" as const,
  configSchema: hybridConfigSchema,
  versionInfo,

  register(api: ClawdbotPluginApi) {
    runMemoryHybridRegister(api);
  },
};

function runMemoryHybridRegister(api: ClawdbotPluginApi): void {
  // Initialize structured logger early so all runtime code (services/backends/lifecycle)
  // routes through api.logger instead of raw console.*.
  initPluginLogger(api.logger);

  // Reopen guard: ensure any previous instance is closed before creating new one (avoids duplicate
  // DB instances if host calls register() before stop(), e.g. on SIGUSR1 or rapid reload).
  const old = runtimeRef.value;
  if (old) {
    // Clear old timer handles to prevent leaks
    if (old.timers.pruneTimer.value) clearInterval(old.timers.pruneTimer.value);
    if (old.timers.classifyTimer.value) clearInterval(old.timers.classifyTimer.value);
    if (old.timers.classifyStartupTimeout.value) clearTimeout(old.timers.classifyStartupTimeout.value);
    if (old.timers.proposalsPruneTimer.value) clearInterval(old.timers.proposalsPruneTimer.value);
    if (old.timers.languageKeywordsTimer.value) clearInterval(old.timers.languageKeywordsTimer.value);
    if (old.timers.languageKeywordsStartupTimeout.value) clearTimeout(old.timers.languageKeywordsStartupTimeout.value);
    if (old.timers.postUpgradeTimeout.value) clearTimeout(old.timers.postUpgradeTimeout.value);
    if (old.timers.passiveObserverTimer.value) clearInterval(old.timers.passiveObserverTimer.value);
    if (old.timers.watchdogTimer.value) clearInterval(old.timers.watchdogTimer.value);
    // Issue #463: Dispose lifecycle hooks (stale session sweep timer, per-session state)
    old.lifecycleHooksHandle?.dispose();
    // Close SQLite/Lance and related stores before opening new connections (issue #802 — same paths must not be double-opened).
    closeOldDatabases({
      factsDb: old.factsDb,
      edictStore: old.edictStore,
      vectorDb: old.vectorDb,
      credentialsDb: old.credentialsDb,
      proposalsDb: old.proposalsDb,
      identityReflectionStore: old.identityReflectionStore,
      personaStateStore: old.personaStateStore,
      eventLog: old.eventLog,
      narrativesDb: old.narrativesDb,
      aliasDb: old.aliasDb,
      eventBus: old.eventBus,
      issueStore: old.issueStore,
      workflowStore: old.workflowStore,
      crystallizationStore: old.crystallizationStore,
      toolProposalStore: old.toolProposalStore,
      verificationStore: old.verificationStore,
      provenanceService: old.provenanceService,
      learningsDb: old.learningsDb,
      apitapStore: old.apitapStore,
    });
    old.pythonBridge?.shutdown().catch(() => {});
    runtimeRef.value = null;
  }

  let cfg: HybridMemoryConfig;
  try {
    cfg = hybridConfigSchema.parse(api.pluginConfig);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:config-parse",
    });
    throw err;
  }

  let dbContext: ReturnType<typeof initializeDatabases>;
  try {
    dbContext = initializeDatabases(cfg, api);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:init-databases",
    });
    throw err;
  }

  const { resolvedSqlitePath, resolvedLancePath } = dbContext;

  api.logger.info(
    `memory-hybrid: registered (v${versionInfo.pluginVersion}, memory-manager ${versionInfo.memoryManagerVersion}) sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath}`,
  );

  // ========================================================================
  // Event Bus for Sensor Sweep (Issue #236)
  // ========================================================================

  let eventBus: EventBus | null = null;
  if (cfg.sensorSweep.enabled) {
    try {
      const eventBusPath = join(dirname(resolvedSqlitePath), "event-bus.db");
      eventBus = new EventBus(eventBusPath);
      api.logger.info(`memory-hybrid: event bus initialized at ${eventBusPath}`);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "registration",
        operation: "plugin-register:event-bus-init",
        severity: "warning",
      });
      eventBus = null;
    }
  }

  // ========================================================================
  // Python Bridge (lazy -- only when documents.enabled, spawns on first use)
  // ========================================================================

  // Initialized lazily -- PythonBridge only spawns the subprocess on first convert() call
  const pythonBridge = cfg.documents.enabled ? new PythonBridge(cfg.documents.pythonPath) : null;

  // Eagerly check Python dependencies at startup so missing packages surface
  // immediately (in logs) rather than on first document conversion (issue #422).
  if (pythonBridge) {
    const { ok, missing, spawnError } = pythonBridge.checkDependencies();
    if (!ok) {
      if (spawnError) {
        api.logger.warn(
          `memory-hybrid: documents.enabled but Python binary not found or failed to spawn: ${spawnError.message}. ` +
            `Check documents.pythonPath configuration (currently: ${cfg.documents.pythonPath}).`,
        );
      } else {
        const pkgs = missing.join(", ");
        api.logger.warn(
          `memory-hybrid: documents.enabled but required Python package(s) not installed: ${pkgs}. ` +
            `Run: ${cfg.documents.pythonPath} -m pip install ${missing.join(" ")}  (see extensions/memory-hybrid/scripts/requirements.txt)`,
        );
      }
    }
  }

  // ========================================================================
  // Contextual Variant Generator (Issue #159)
  // ========================================================================

  let variantQueue: VariantGenerationQueue | null = null;
  if (cfg.contextualVariants.enabled) {
    const variantGenerator = new ContextualVariantGenerator(cfg.contextualVariants, dbContext.openai);
    variantQueue = new VariantGenerationQueue(variantGenerator, async (factId, variantType, variants) => {
      for (const v of variants) {
        dbContext.factsDb.storeVariant(factId, variantType, v);
      }
    });
  }

  // ========================================================================
  // Learnings Intake Buffer (Issue #617)
  // ========================================================================

  let learningsDb: LearningsDB | null = null;
  try {
    const learningsDbPath = join(dirname(resolvedSqlitePath), "learnings.db");
    learningsDb = new LearningsDB(learningsDbPath);
    api.logger.info(`memory-hybrid: learnings DB initialized at ${learningsDbPath}`);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:learnings-db-init",
      severity: "warning",
    });
    learningsDb = null;
  }

  // ========================================================================
  // Build PluginRuntime -- single instance-scoped container for all state
  // ========================================================================

  const newRuntime: PluginRuntime = {
    cfg,
    resolvedLancePath,
    resolvedSqlitePath,
    factsDb: dbContext.factsDb,
    edictStore: dbContext.edictStore,
    vectorDb: dbContext.vectorDb,
    embeddings: dbContext.embeddings,
    embeddingRegistry: dbContext.embeddingRegistry,
    openai: dbContext.openai,
    credentialsDb: dbContext.credentialsDb,
    wal: dbContext.wal,
    proposalsDb: dbContext.proposalsDb,
    identityReflectionStore: dbContext.identityReflectionStore,
    personaStateStore: dbContext.personaStateStore,
    eventLog: dbContext.eventLog,
    narrativesDb: dbContext.narrativesDb,
    aliasDb: dbContext.aliasDb,
    eventBus,
    costTracker: dbContext.costTracker,
    issueStore: dbContext.issueStore,
    workflowStore: dbContext.workflowStore,
    crystallizationStore: dbContext.crystallizationStore,
    toolProposalStore: dbContext.toolProposalStore,
    provenanceService: dbContext.provenanceService,
    verificationStore: dbContext.verificationStore,
    apitapStore: dbContext.apitapStore,
    pythonBridge,
    variantQueue,
    learningsDb,
    lifecycleHooksHandle: null, // set after registerLifecycleHooks below
    pendingLLMWarnings: createPendingLLMWarnings(),
    currentAgentIdRef: { value: null },
    restartPendingClearedRef: { value: false },
    recallInFlightRef: { value: 0 },
    lastProgressiveIndexIds: [],
    timers: createTimers(),
  };

  runtimeRef.value = newRuntime;

  const runtime = newRuntime;

  // Phase 2.6 / Phase 3: Single plugin context satisfying MemoryPluginAPI (stable internal API).
  const pluginContext: MemoryPluginAPI = {
    factsDb: runtime.factsDb,
    edictStore: runtime.edictStore,
    vectorDb: runtime.vectorDb,
    cfg: runtime.cfg,
    embeddings: runtime.embeddings,
    embeddingRegistry: runtime.embeddingRegistry,
    openai: runtime.openai,
    wal: runtime.wal,
    credentialsDb: runtime.credentialsDb,
    aliasDb: runtime.aliasDb,
    proposalsDb: runtime.proposalsDb,
    eventLog: runtime.eventLog,
    narrativesDb: runtime.narrativesDb,
    provenanceService: runtime.provenanceService,
    issueStore: runtime.issueStore ?? null,
    workflowStore: runtime.workflowStore,
    crystallizationStore: runtime.crystallizationStore,
    toolProposalStore: runtime.toolProposalStore,
    verificationStore: runtime.verificationStore,
    variantQueue: runtime.variantQueue,
    lastProgressiveIndexIds: runtime.lastProgressiveIndexIds,
    currentAgentIdRef: runtime.currentAgentIdRef,
    restartPendingClearedRef: runtime.restartPendingClearedRef,
    recallInFlightRef: runtime.recallInFlightRef,
    pendingLLMWarnings: runtime.pendingLLMWarnings,
    resolvedSqlitePath: runtime.resolvedSqlitePath,
    timers: { proposalsPruneTimer: runtime.timers.proposalsPruneTimer },
    buildToolScopeFilter,
    walWrite,
    walRemove,
    findSimilarByEmbedding,
    shouldCapture,
    detectCategory,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    pythonBridge: runtime.pythonBridge,
    apitapStore: runtime.apitapStore,
  };

  // ========================================================================
  // Tools

  try {
    registerTools(pluginContext, api);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:tools",
    });
    throw err;
  }

  // CLI Commands
  try {
    registerHybridMemCliWithApi(api, {
      factsDb: runtime.factsDb,
      vectorDb: runtime.vectorDb,
      embeddings: runtime.embeddings,
      openai: runtime.openai,
      cfg: runtime.cfg,
      credentialsDb: runtime.credentialsDb,
      aliasDb: runtime.aliasDb,
      wal: runtime.wal,
      proposalsDb: runtime.proposalsDb,
      identityReflectionStore: runtime.identityReflectionStore,
      personaStateStore: runtime.personaStateStore,
      eventLog: runtime.eventLog,
      verificationStore: runtime.verificationStore,
      provenanceService: runtime.provenanceService,
      costTracker: runtime.costTracker,
      eventBus: runtime.eventBus,
      resolvedSqlitePath: runtime.resolvedSqlitePath,
      resolvedLancePath: runtime.resolvedLancePath,
      pluginId: PLUGIN_ID,
      detectCategory,
    });
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:cli",
    });
    throw err;
  }

  // ContextEngine Plugin Slot (Issue #273) -- feature-detected, non-fatal if unavailable

  import("./services/context-engine.js")
    .then(({ registerHybridContextEngine }) =>
      registerHybridContextEngine({
        factsDb: runtime.factsDb,
        vectorDb: runtime.vectorDb,
        wal: runtime.wal,
        embeddings: runtime.embeddings,
        cfg: runtime.cfg,
        logger: api.logger,
        pluginVersion: versionInfo.pluginVersion,
      }),
    )
    .catch((err: unknown) => {
      api.logger.warn?.(`memory-hybrid: ContextEngine registration skipped: ${err}`);
    });

  // Lifecycle Hooks (issueStore may be null; issue-related behavior is gated inside hooks)
  try {
    runtime.lifecycleHooksHandle = registerLifecycleHooks(pluginContext, api);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:hooks",
    });
    throw err;
  }

  // Service

  try {
    api.registerService(
      createPluginService({
        PLUGIN_ID,
        factsDb: runtime.factsDb,
        edictStore: runtime.edictStore,
        vectorDb: runtime.vectorDb,
        embeddings: runtime.embeddings,
        embeddingRegistry: runtime.embeddingRegistry,
        credentialsDb: runtime.credentialsDb,
        proposalsDb: runtime.proposalsDb,
        wal: runtime.wal,
        eventLog: runtime.eventLog,
        cfg: runtime.cfg,
        openai: runtime.openai,
        resolvedLancePath: runtime.resolvedLancePath,
        resolvedSqlitePath: runtime.resolvedSqlitePath,
        api,
        timers: runtime.timers,
        pythonBridge: runtime.pythonBridge,
        provenanceService: runtime.provenanceService,
        costTracker: runtime.costTracker,
      }),
    );
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "registration",
      operation: "plugin-register:service",
    });
    throw err;
  }

  // Issue #281 -- Verify cron health on boot
  //
  // When `maintenance.cronReliability.verifyOnBoot` is true (the default), check
  // whether a backup cron entry exists and log a warning if missing. This does NOT
  // auto-install the cron entry -- users must explicitly run `hybrid-mem backup schedule`
  // to install it.
  //
  // This runs asynchronously and is entirely non-fatal: cron check failures
  // (e.g. no `crontab` binary, read-only environment) are logged as debug and do not
  // block the plugin from starting.
  if (cfg.maintenance?.cronReliability?.verifyOnBoot !== false) {
    setImmediate(() => {
      void (async () => {
        try {
          const { execSync } = await import("node:child_process");

          // Check if a backup cron is already registered
          let currentCrontab = "";
          try {
            currentCrontab = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
          } catch {
            // No existing crontab
          }

          if (currentCrontab.includes("hybrid-mem backup")) {
            // Already scheduled -- nothing to do
            api.logger.debug?.("memory-hybrid: boot-check -- weekly backup cron already present");
            return;
          }

          // Cron not found -- log warning
          const weeklyExpr = cfg.maintenance?.cronReliability?.weeklyBackupCron ?? "0 4 * * 0";
          api.logger.warn?.(
            `memory-hybrid: boot-check -- weekly backup cron not found. Run 'hybrid-mem backup schedule' to install (${weeklyExpr}).`,
          );
        } catch (err) {
          // Non-fatal -- crontab may not be available (containers, read-only envs)
          api.logger.debug?.(`memory-hybrid: boot-check -- could not verify backup cron (non-fatal): ${err}`);
        }
      })();
    });
  }
}

// Export internal functions and classes for testing
export const _testing = {
  // Utility functions
  normalizeTextForDedupe,
  normalizedHash,
  truncateText,
  truncateForStorage,
  extractTags,
  serializeTags,
  parseTags,
  tagsContains,
  parseSourceDate,
  estimateTokens,
  estimateTokensForDisplay,
  formatProgressiveIndexLine,
  classifyDecay,
  calculateExpiry,
  extractStructuredFields,
  detectCategory,
  detectCredentialPatterns,
  extractCredentialMatch,
  isCredentialLike,
  inferServiceFromText,
  isStructuredForConsolidation,
  runConsolidate,
  normalizeSuggestedLabel,
  unionFind,
  getRoot,
  mergeResults,
  filterByScope,
  safeEmbed,
  deepMerge,
  buildInstallDefaults,
  // Encryption primitives (used by CredentialsDB)
  deriveKey,
  encryptValue,
  decryptValue,
  // Classes for testing
  FactsDB,
  CredentialsDB,
  ProposalsDB,
  EventLog,
  EventBus,
  computeFingerprint,
  VectorDB,
  Embeddings,
  WriteAheadLog,
  // Classification (for tests)
  parseClassificationResponse,
  findSimilarByEmbedding,
  // Reflection parsing (for tests) - re-exported from service
  parsePatternsFromReflectionResponse,
  normalizeVector,
  dotProductSimilarity,
  // FTS5 search service (Issue #151)
  searchFts,
  rebuildFtsIndex,
  buildFts5Query,
  // RRF scoring pipeline (Issue #152)
  fuseResults,
  applyPostRrfAdjustments,
  RRF_K_DEFAULT,
  runExplicitDeepRetrieval,
  packIntoBudget,
  serializeFactForContext,
  estimateTokenCount,
  DEFAULT_RETRIEVAL_CONFIG,
  // GraphRAG retrieval (Issue #145)
  expandGraph,
  formatLinkPath,
  HOP_SCORE_DECAY,
  // Shortest-path traversal (Issue #140)
  findShortestPath,
  resolveInput,
  formatPath,
  // Knowledge gap analysis (Issue #141)
  analyzeKnowledgeGaps,
  detectOrphans,
  detectWeak,
  detectSuggestedLinks,
  computeIsolationScore,
  computeRankScore,
  // Topic cluster detection (Issue #146)
  detectClusters,
  generateClusterLabel,
  // Retrieval aliases (Issue #149)
  AliasDB,
  generateAliases,
  storeAliases,
  searchAliasStrategy,
  // Issue lifecycle tracking (Issue #137)
  IssueStore,
  // Workflow trace tracking (Issue #209)
  WorkflowStore,
  WorkflowTracker,
  sequenceDistance,
  sequenceSimilarity,
  extractGoalKeywords,
  hashToolSequence,
  // Workflow crystallization (Issue #208)
  CrystallizationStore,
  PatternDetector,
  SkillCrystallizer,
  SkillValidator,
  CrystallizationProposer,
  computePatternId,
  scorePattern,
  deriveSkillName,
  isExecOnlySequence,
  // Plugin self-extension (Issue #210)
  ToolProposalStore,
  GapDetector,
  ToolProposer,
  computeGapId,
  deriveToolNameFromSequence,
  // Verification store for critical facts (Issue #162)
  VerificationStore,
  shouldAutoVerify,
  VerificationError,
  // Provenance tracing (Issue #163)
  ProvenanceService,
  // Learnings intake buffer — staged memory promotion (Issue #617)
  LearningsDB,
};

export { versionInfo } from "./versionInfo.js";
export { sanitizeMessagesForClaude, type MessageLike } from "./utils/sanitize-messages.js";
export type { ContradictionRecord } from "./backends/facts-db.js";
export type { RetrievalPipelineOptions } from "./services/retrieval-orchestrator.js";
export default memoryHybridPlugin;
