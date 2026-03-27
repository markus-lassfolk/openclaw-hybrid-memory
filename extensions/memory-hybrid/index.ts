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

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";

import { type ContradictionRecord, FactsDB, MEMORY_LINK_TYPES, type MemoryLinkType } from "./backends/facts-db.js";
import { VectorDB } from "./backends/vector-db.js";
import { WriteAheadLog } from "./backends/wal.js";
import { buildInstallDefaults, deepMerge } from "./cli/handlers.js";
import {
  CREDENTIAL_TYPES,
  type ConfigMode,
  type CredentialType,
  DECAY_CLASSES,
  DEFAULT_MEMORY_CATEGORIES,
  type DecayClass,
  type HybridMemoryConfig,
  type IdentityFileType,
  type MemoryCategory,
  PROPOSAL_STATUSES,
  isValidCategory,
  setMemoryCategories,
  vectorDimsForModel,
} from "./config.js";
import { hybridConfigSchema } from "./config/hybrid-schema.js";
import {
  chatComplete,
  createPendingLLMWarnings,
  distillBatchTokenLimit,
  distillMaxOutputTokens,
} from "./services/chat.js";
import { type EmbeddingProvider, Embeddings, safeEmbed } from "./services/embeddings.js";
import { buildFts5Query, rebuildFtsIndex, searchFts } from "./services/fts-search.js";
import { HOP_SCORE_DECAY, expandGraph, formatLinkPath } from "./services/graph-retrieval.js";
import { filterByScope, mergeResults } from "./services/merge-results.js";
import { extractProceduresFromSessions } from "./services/procedure-extractor.js";
import { generateAutoSkills } from "./services/procedure-skill-generator.js";
import {
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalPipelineOptions,
  estimateTokenCount,
  packIntoBudget,
  runExplicitDeepRetrieval,
  serializeFactForContext,
} from "./services/retrieval-orchestrator.js";
import {
  type FactMetadata,
  type FusedResult,
  RRF_K_DEFAULT,
  type RankedResult,
  applyPostRrfAdjustments,
  fuseResults,
} from "./services/rrf-fusion.js";
import { registerHybridMemCliWithApi } from "./setup/cli-context.js";
import { versionInfo } from "./versionInfo.js";
export type { GraphExpandedResult, LinkPathStep, GraphFactLookup } from "./services/graph-retrieval.js";
import { findShortestPath, formatPath, resolveInput } from "./services/shortest-path.js";
export type { ShortestPathResult, PathStep, ShortestPathLookup } from "./services/shortest-path.js";
import {
  analyzeKnowledgeGaps,
  computeIsolationScore,
  computeRankScore,
  detectOrphans,
  detectSuggestedLinks,
  detectWeak,
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
import type { MemoryPluginAPI } from "./api/memory-plugin-api.js";
import { type PluginRuntime, createTimers } from "./api/plugin-runtime.js";
import {
  type AuthFailurePattern,
  DEFAULT_AUTH_FAILURE_PATTERNS,
  buildCredentialQuery,
  detectAuthFailure,
  formatCredentialHint,
} from "./services/auth-failure-detect.js";
import {
  SENSITIVE_PATTERNS,
  VAULT_POINTER_PREFIX,
  detectCredentialPatterns,
  extractCredentialMatch,
  getMemoryTriggers,
  inferServiceFromText,
  isCredentialLike,
  tryParseCredentialForVault,
} from "./services/auto-capture.js";
import { normalizeSuggestedLabel, runAutoClassify, runClassifyForCli } from "./services/auto-classifier.js";
import { detectCategory as detectCategoryUtil, shouldCapture as shouldCaptureUtil } from "./services/capture-utils.js";
import {
  type MemoryClassification,
  classifyMemoryOperation,
  parseClassificationResponse,
} from "./services/classification.js";
import { getRoot, isStructuredForConsolidation, runConsolidate, unionFind } from "./services/consolidation.js";
import { ContextualVariantGenerator, VariantGenerationQueue } from "./services/contextual-variants.js";
import { CREDENTIAL_REDACTION_MIGRATION_FLAG, migrateCredentialsToVault } from "./services/credential-migration.js";
import { type ToolCallCredential, extractCredentialsFromToolCalls } from "./services/credential-scanner.js";
import {
  type DirectiveExtractResult,
  type DirectiveIncident,
  runDirectiveExtract,
} from "./services/directive-extract.js";
import type { EmbeddingRegistry } from "./services/embedding-registry.js";
import { capturePluginError } from "./services/error-reporter.js";
import { extractStructuredFields } from "./services/fact-extraction.js";
import { gatherIngestFiles } from "./services/ingest-utils.js";
import { PythonBridge } from "./services/python-bridge.js";
import {
  dotProductSimilarity,
  normalizeVector,
  parsePatternsFromReflectionResponse,
  runReflection,
  runReflectionMeta,
  runReflectionRules,
} from "./services/reflection.js";
import {
  type ReinforcementExtractResult,
  type ReinforcementIncident,
  runReinforcementExtract,
} from "./services/reinforcement-extract.js";
import { AliasDB, generateAliases, searchAliasStrategy, storeAliases } from "./services/retrieval-aliases.js";
import {
  type CorrectionIncident,
  type SelfCorrectionExtractResult,
  runSelfCorrectionExtract,
} from "./services/self-correction-extract.js";
import { insertRulesUnderSection } from "./services/tools-md-section.js";
import { findSimilarByEmbedding } from "./services/vector-search.js";
import { walRemove, walWrite } from "./services/wal-helpers.js";
import { closeOldDatabases, initializeDatabases } from "./setup/init-databases.js";
import { type PluginServiceContext, createPluginService } from "./setup/plugin-service.js";
import { registerLifecycleHooks } from "./setup/register-hooks.js";
import { registerTools } from "./setup/register-tools.js";
import type { MemoryEntry, ScopeFilter, SearchResult } from "./types/memory.js";
import { MEMORY_SCOPES } from "./types/memory.js";
import {
  BATCH_STORE_IMPORTANCE,
  BATCH_THROTTLE_MS,
  CLASSIFY_CANDIDATE_MAX_CHARS,
  CLI_STORE_IMPORTANCE,
  CONSOLIDATION_MERGE_MAX_CHARS,
  CREDENTIAL_NOTES_MAX_CHARS,
  DEFAULT_MIN_SCORE,
  FACT_PREVIEW_MAX_CHARS,
  PLUGIN_ID,
  REFLECTION_DEDUPE_THRESHOLD,
  REFLECTION_IMPORTANCE,
  REFLECTION_MAX_FACTS_PER_CATEGORY,
  REFLECTION_MAX_FACT_LENGTH,
  REFLECTION_META_MAX_CHARS,
  REFLECTION_PATTERN_MAX_CHARS,
  REFLECTION_TEMPERATURE,
  SECONDS_PER_DAY,
  SQLITE_BUSY_TIMEOUT_MS,
  getRestartPendingPath,
} from "./utils/constants.js";
import { parseSourceDate } from "./utils/dates.js";
import { calculateExpiry, classifyDecay } from "./utils/decay.js";
import { tryExtractionFromTemplates } from "./utils/extraction-from-template.js";
import {
  getCategoryDecisionRegex,
  getCategoryEntityRegex,
  getCategoryFactRegex,
  getCategoryPreferenceRegex,
  getCorrectionSignalRegex,
  getExtractionTemplates,
  getLanguageKeywordsFilePath,
  getMemoryTriggerRegexes,
  setKeywordsPath,
} from "./utils/language-keywords.js";
import { getDirectiveSignalRegex, getReinforcementSignalRegex } from "./utils/language-keywords.js";
import { initPluginLogger } from "./utils/logger.js";
import { fillPrompt, loadPrompt } from "./utils/prompt-loader.js";
import { computeDynamicSalience } from "./utils/salience.js";
import { buildToolScopeFilter } from "./utils/scope-filter.js";
import {
  TAG_PATTERNS,
  extractTags,
  normalizeTextForDedupe,
  normalizedHash,
  parseTags,
  serializeTags,
  tagsContains,
} from "./utils/tags.js";
import {
  chunkSessionText,
  chunkTextByChars,
  estimateTokens,
  estimateTokensForDisplay,
  formatProgressiveIndexLine,
  truncateForStorage,
  truncateText,
} from "./utils/text.js";

// Backend Imports (extracted from god file for maintainability)

import {
  type CredentialEntry,
  CredentialsDB,
  decryptValue,
  deriveKey,
  encryptValue,
} from "./backends/credentials-db.js";
import { CrystallizationStore } from "./backends/crystallization-store.js";
import { EventBus, computeFingerprint } from "./backends/event-bus.js";
import { EventLog } from "./backends/event-log.js";
import { IssueStore } from "./backends/issue-store.js";
import { LearningsDB } from "./backends/learnings-db.js";
import { type ProposalEntry, ProposalsDB } from "./backends/proposals-db.js";
import { ToolProposalStore } from "./backends/tool-proposal-store.js";
import {
  WorkflowStore,
  extractGoalKeywords,
  hashToolSequence,
  sequenceDistance,
  sequenceSimilarity,
} from "./backends/workflow-store.js";
import { CrystallizationProposer } from "./services/crystallization-proposer.js";
import { GapDetector, computeGapId, deriveToolNameFromSequence } from "./services/gap-detector.js";
import { PatternDetector, computePatternId, scorePattern } from "./services/pattern-detector.js";
import { ProvenanceService } from "./services/provenance.js";
import { SkillCrystallizer, deriveSkillName, isExecOnlySequence } from "./services/skill-crystallizer.js";
import { SkillValidator } from "./services/skill-validator.js";
import { ToolProposer } from "./services/tool-proposer.js";
import { VerificationError, VerificationStore, shouldAutoVerify } from "./services/verification-store.js";
import { WorkflowTracker } from "./services/workflow-tracker.js";

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
      if (old.timers.languageKeywordsStartupTimeout.value)
        clearTimeout(old.timers.languageKeywordsStartupTimeout.value);
      if (old.timers.postUpgradeTimeout.value) clearTimeout(old.timers.postUpgradeTimeout.value);
      if (old.timers.passiveObserverTimer.value) clearInterval(old.timers.passiveObserverTimer.value);
      if (old.timers.watchdogTimer.value) clearInterval(old.timers.watchdogTimer.value);
      // Issue #463: Dispose lifecycle hooks (stale session sweep timer, per-session state)
      old.lifecycleHooksHandle?.dispose();
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

    // Clean up old resources immediately after atomic swap to prevent leaks if registration fails (Issue #590)
    if (old) {
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
    }

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
  },
};

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
