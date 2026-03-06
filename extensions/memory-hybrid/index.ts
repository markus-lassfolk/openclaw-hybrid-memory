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
import Database from "better-sqlite3";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

import {
  DEFAULT_MEMORY_CATEGORIES,
  setMemoryCategories,
  isValidCategory,
  type MemoryCategory,
  DECAY_CLASSES,
  type DecayClass,
  type HybridMemoryConfig,
  hybridConfigSchema,
  vectorDimsForModel,
  CREDENTIAL_TYPES,
  type CredentialType,
  PROPOSAL_STATUSES,
  type IdentityFileType,
  type ConfigMode,
} from "./config.js";
import { versionInfo } from "./versionInfo.js";
import { WriteAheadLog } from "./backends/wal.js";
import { VectorDB } from "./backends/vector-db.js";
import { FactsDB, MEMORY_LINK_TYPES, type MemoryLinkType, type ContradictionRecord } from "./backends/facts-db.js";
import { registerHybridMemCliWithApi } from "./setup/cli-context.js";
import { deepMerge } from "./cli/handlers.js";
import { Embeddings, safeEmbed, type EmbeddingProvider } from "./services/embeddings.js";
import { chatComplete, distillBatchTokenLimit, distillMaxOutputTokens, createPendingLLMWarnings } from "./services/chat.js";
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
  runRetrievalPipeline,
  packIntoBudget,
  serializeFactForContext,
  estimateTokenCount,
  DEFAULT_RETRIEVAL_CONFIG,
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
export type { GapFact, SuggestedLink, KnowledgeGapReport, GapMode, GapFactsDB, GapVectorDB, GapEmbeddings } from "./services/knowledge-gaps.js";
import { detectClusters, generateClusterLabel } from "./services/topic-clusters.js";
export type { TopicCluster, ClusterDetectionResult, ClusterDetectionOptions, ClusterFactLookup } from "./services/topic-clusters.js";
import { AliasDB, generateAliases, storeAliases, searchAliasStrategy } from "./services/retrieval-aliases.js";
import { gatherIngestFiles } from "./services/ingest-utils.js";
import type { MemoryEntry, SearchResult, ScopeFilter } from "./types/memory.js";
import { MEMORY_SCOPES } from "./types/memory.js";
import { loadPrompt, fillPrompt } from "./utils/prompt-loader.js";
import { truncateText, truncateForStorage, estimateTokens, estimateTokensForDisplay, formatProgressiveIndexLine, chunkSessionText, chunkTextByChars } from "./utils/text.js";
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
import { runSelfCorrectionExtract, type CorrectionIncident, type SelfCorrectionExtractResult } from "./services/self-correction-extract.js";
import { insertRulesUnderSection } from "./services/tools-md-section.js";
import { tryExtractionFromTemplates } from "./utils/extraction-from-template.js";
import { extractCredentialsFromToolCalls, type ToolCallCredential } from "./services/credential-scanner.js";
import { runDirectiveExtract, type DirectiveExtractResult, type DirectiveIncident } from "./services/directive-extract.js";
import { runReinforcementExtract, type ReinforcementExtractResult, type ReinforcementIncident } from "./services/reinforcement-extract.js";
import { getDirectiveSignalRegex, getReinforcementSignalRegex } from "./utils/language-keywords.js";
import { detectAuthFailure, buildCredentialQuery, formatCredentialHint, DEFAULT_AUTH_FAILURE_PATTERNS, type AuthFailurePattern } from "./services/auth-failure-detect.js";
import { classifyMemoryOperation, parseClassificationResponse, type MemoryClassification } from "./services/classification.js";
import { extractStructuredFields } from "./services/fact-extraction.js";
import { getMemoryTriggers, detectCredentialPatterns, extractCredentialMatch, isCredentialLike, tryParseCredentialForVault, VAULT_POINTER_PREFIX, inferServiceFromText, SENSITIVE_PATTERNS } from "./services/auto-capture.js";
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
import { registerTools } from "./setup/register-tools.js";
import { registerLifecycleHooks, type HooksContext } from "./setup/register-hooks.js";
import { capturePluginError } from "./services/error-reporter.js";
import { PythonBridge } from "./services/python-bridge.js";

// Backend Imports (extracted from god file for maintainability)

import { CredentialsDB, type CredentialEntry, deriveKey, encryptValue, decryptValue } from "./backends/credentials-db.js";
import { ProposalsDB, type ProposalEntry } from "./backends/proposals-db.js";
import { EventLog } from "./backends/event-log.js";
import { IssueStore } from "./backends/issue-store.js";
import { WorkflowStore, sequenceDistance, sequenceSimilarity, extractGoalKeywords, hashToolSequence } from "./backends/workflow-store.js";
import { WorkflowTracker, _resetRateLimitForTest } from "./services/workflow-tracker.js";
import { CrystallizationStore } from "./backends/crystallization-store.js";
import { PatternDetector, computePatternId, scorePattern } from "./services/pattern-detector.js";
import { SkillCrystallizer, deriveSkillName, isExecOnlySequence } from "./services/skill-crystallizer.js";
import { SkillValidator } from "./services/skill-validator.js";
import { CrystallizationProposer } from "./services/crystallization-proposer.js";
import { VerificationStore, shouldAutoClassify, VerificationError } from "./services/verification-store.js";
import { ProvenanceService } from "./services/provenance.js";
import { ToolProposalStore } from "./backends/tool-proposal-store.js";
import { GapDetector, computeGapId, deriveToolNameFromSequence } from "./services/gap-detector.js";
import { ToolProposer } from "./services/tool-proposer.js";

// Helper Functions

/** Get top-N existing facts by embedding similarity. Resolves vector search ids via factsDb (filters superseded). Falls back to empty array on vector search failure. */
/** Wrappers for extracted helper functions that need access to module-level config */
function shouldCapture(text: string): boolean {
  return shouldCaptureUtil(text, cfg.captureMaxChars, getMemoryTriggers());
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

// LLM-based Auto-Classifier

/** Minimum "other" facts before we run category discovery (avoid noise on tiny sets). */
// Plugin Definition

// Mutable module-level state so that ALL closures (tools, event handlers,
// timers) always see the *current* instances — even after a SIGUSR1 reload
// where stop() closes the old DB and register() creates a new one.
// Without this, old closures captured const locals from the first register()
// call and kept using a closed database after restart.
let cfg: HybridMemoryConfig;
let resolvedLancePath: string;
let resolvedSqlitePath: string;
let factsDb: FactsDB;
let vectorDb: VectorDB;
let embeddings: EmbeddingProvider;
let openai: OpenAI;
let credentialsDb: CredentialsDB | null = null;
let wal: WriteAheadLog | null = null;
let proposalsDb: ProposalsDB | null = null;
let eventLog: EventLog | null = null;
let aliasDb: AliasDB | null = null;

let issueStore: IssueStore | null = null;
let workflowStore: WorkflowStore | null = null;
let crystallizationStore: import("./backends/crystallization-store.js").CrystallizationStore | null = null;
let toolProposalStore: import("./backends/tool-proposal-store.js").ToolProposalStore | null = null;
let provenanceService: ProvenanceService | null = null;
let pythonBridge: PythonBridge | null = null;
let pendingLLMWarnings = createPendingLLMWarnings();

// Timer references (wrapped in objects so they can be passed by reference)
const timers = {
  pruneTimer: { value: null as ReturnType<typeof setInterval> | null },
  classifyTimer: { value: null as ReturnType<typeof setInterval> | null },
  classifyStartupTimeout: { value: null as ReturnType<typeof setTimeout> | null },
  proposalsPruneTimer: { value: null as ReturnType<typeof setInterval> | null },
  languageKeywordsTimer: { value: null as ReturnType<typeof setInterval> | null },
  languageKeywordsStartupTimeout: { value: null as ReturnType<typeof setTimeout> | null },
  postUpgradeTimeout: { value: null as ReturnType<typeof setTimeout> | null },
  passiveObserverTimer: { value: null as ReturnType<typeof setInterval> | null },
};

/** Last progressive index fact IDs (1-based position → fact id) so memory_recall(id: 1) can resolve. */
const lastProgressiveIndexIds: string[] = [];

/** Runtime-detected agent identity. Used for dynamic scope filtering and default store scope. */
// Runtime-detected agent identity
// 
// ⚠️ MODULE-LEVEL STATE WARNING:
// This is a singleton variable shared across all plugin invocations within the same OpenClaw process.
// ASSUMPTION: OpenClaw plugins are single-threaded and do not run in parallel for different agents.
// If OpenClaw ever implements multi-threaded plugin execution, this approach will cause race conditions
// (Agent A's memory operations could be attributed to Agent B).
//
// Mitigation strategies (if threading is added):
// 1. Use AsyncLocalStorage to maintain per-request context
// 2. Use a Map keyed by session/request ID
// 3. Pass agentId explicitly through all memory operations
//
// Current behavior:
// - Updated on each before_agent_start event
// - Used by memory_store to auto-scope facts to the current agent
// - Falls back to cfg.multiAgent.orchestratorId if detection fails
// 
// ⚠️ THREADING WARNING: This is a module-level singleton. If OpenClaw's plugin
// host ever switches to concurrent request handling, this variable could race
// between agent sessions. Current implementation assumes serial execution per
// plugin instance.
//
// Config option `multiAgent.strictAgentScoping` can be enabled to throw an error
// if agent detection fails in "agent" or "auto" scope modes, rather than silently
// falling back to orchestrator.
// Note: Using a mutable ref object { value } so that lifecycle hooks can update the value
// and tools will see the updated value (fixes pass-by-value bug from refactor).
const currentAgentIdRef: { value: string | null } = { value: null };

const restartPendingClearedRef: { value: boolean } = { value: false };

const memoryHybridPlugin = {
  id: PLUGIN_ID,
  name: "Memory (Hybrid: SQLite + LanceDB)",
  description:
    "Two-tier memory: SQLite+FTS5 for structured facts, LanceDB for semantic search",
  kind: "memory" as const,
  configSchema: hybridConfigSchema,
  versionInfo,

  register(api: ClawdbotPluginApi) {
    // Reopen guard: ensure any previous instance is closed before creating new one (avoids duplicate
    // DB instances if host calls register() before stop(), e.g. on SIGUSR1 or rapid reload).
    closeOldDatabases({ factsDb, vectorDb, credentialsDb, proposalsDb, eventLog, aliasDb, issueStore, workflowStore, crystallizationStore, toolProposalStore, provenanceService });
    credentialsDb = null;
    proposalsDb = null;
    eventLog = null;
    aliasDb = null;

    issueStore = null;
    workflowStore = null;
    crystallizationStore = null;
    toolProposalStore = null;
    provenanceService = null;
    // pythonBridge shutdown will be added by #206
    if (pythonBridge) {
      pythonBridge.shutdown().catch(() => {});
      pythonBridge = null;
    }
    pendingLLMWarnings = createPendingLLMWarnings();

    try {
      cfg = hybridConfigSchema.parse(api.pluginConfig);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:config-parse" });
      throw err;
    }

    try {
      const dbContext = initializeDatabases(cfg, api);
      factsDb = dbContext.factsDb;
      vectorDb = dbContext.vectorDb;
      embeddings = dbContext.embeddings;
      openai = dbContext.openai;
      credentialsDb = dbContext.credentialsDb;
      wal = dbContext.wal;
      proposalsDb = dbContext.proposalsDb;
      eventLog = dbContext.eventLog;
      aliasDb = dbContext.aliasDb;
      issueStore = dbContext.issueStore;
      workflowStore = dbContext.workflowStore;
      crystallizationStore = dbContext.crystallizationStore;
      toolProposalStore = dbContext.toolProposalStore;
      provenanceService = dbContext.provenanceService;
      resolvedLancePath = dbContext.resolvedLancePath;
      resolvedSqlitePath = dbContext.resolvedSqlitePath;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:init-databases" });
      throw err;
    }

    api.logger.info(
      `memory-hybrid: registered (v${versionInfo.pluginVersion}, memory-manager ${versionInfo.memoryManagerVersion}) sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath}`,
    );

    // ========================================================================
    // Python Bridge (lazy — only when documents.enabled, spawns on first use)
    // ========================================================================

    // Initialized lazily — PythonBridge only spawns the subprocess on first convert() call
    pythonBridge = cfg.documents.enabled ? new PythonBridge(cfg.documents.pythonPath) : null;

    // ========================================================================
    // Tools

    try {
      registerTools({
      factsDb,
      vectorDb,
      cfg,
      embeddings,
      openai,
      wal,
      credentialsDb,
      proposalsDb,
      eventLog,
      issueStore,
      workflowStore,
      crystallizationStore,
      toolProposalStore,
      lastProgressiveIndexIds,
      currentAgentIdRef,
      pendingLLMWarnings,
      resolvedSqlitePath,
      timers: { proposalsPruneTimer: timers.proposalsPruneTimer },
      buildToolScopeFilter,
      walWrite,
      walRemove,
      findSimilarByEmbedding,
      runReflection,
      runReflectionRules,
      runReflectionMeta,
      pythonBridge,
    }, api);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:tools" });
      throw err;
    }

    // CLI Commands
    try {
      registerHybridMemCliWithApi(api, {
      factsDb,
      vectorDb,
      embeddings,
      openai,
      cfg,
      credentialsDb,
      aliasDb,
      wal,
      proposalsDb,
      eventLog,
      resolvedSqlitePath,
      resolvedLancePath,
      pluginId: PLUGIN_ID,
      detectCategory,
    });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:cli" });
      throw err;
    }

    // Lifecycle Hooks (issueStore may be null; issue-related behavior is gated inside hooks)
    try {
      registerLifecycleHooks({
        factsDb,
        vectorDb,
        embeddings,
        openai,
        cfg,
        credentialsDb,
        aliasDb,
        wal,
        currentAgentIdRef,
        lastProgressiveIndexIds,
        restartPendingClearedRef,
        resolvedSqlitePath,
        walWrite: (operation, data, logger) => walWrite(wal, operation, data, logger),
        walRemove: (id, logger) => walRemove(wal, id, logger),
        findSimilarByEmbedding,
        shouldCapture,
        detectCategory,
        pendingLLMWarnings,
        issueStore: issueStore ?? null,
      }, api);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:hooks" });
      throw err;
    }

    // Service

    try {
      api.registerService(
      createPluginService({
        PLUGIN_ID,
        factsDb,
        vectorDb,
        embeddings,
        credentialsDb,
        proposalsDb,
        wal,
        cfg,
        openai,
        resolvedLancePath,
        resolvedSqlitePath,
        api,
        timers,
        pythonBridge,
      })
    );
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:service" });
      throw err;
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
  // Encryption primitives (used by CredentialsDB)
  deriveKey,
  encryptValue,
  decryptValue,
  // Classes for testing
  FactsDB,
  CredentialsDB,
  ProposalsDB,
  EventLog,
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
  runRetrievalPipeline,
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
  _resetRateLimitForTest,
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
  shouldAutoClassify,
  VerificationError,
  // Provenance tracing (Issue #163)
  ProvenanceService,
};

export { versionInfo } from "./versionInfo.js";
export { sanitizeMessagesForClaude, type MessageLike } from "./utils/sanitize-messages.js";
export type { ContradictionRecord } from "./backends/facts-db.js";
export default memoryHybridPlugin;
