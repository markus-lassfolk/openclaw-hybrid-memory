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
import { FactsDB, MEMORY_LINK_TYPES, type MemoryLinkType } from "./backends/facts-db.js";
import { registerHybridMemCliWithApi } from "./setup/cli-context.js";
import { Embeddings, safeEmbed } from "./services/embeddings.js";
import { chatComplete, distillBatchTokenLimit, distillMaxOutputTokens } from "./services/chat.js";
import { extractProceduresFromSessions } from "./services/procedure-extractor.js";
import { generateAutoSkills } from "./services/procedure-skill-generator.js";
import { mergeResults, filterByScope } from "./services/merge-results.js";
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
import { unionFind, getRoot, isStructuredForConsolidation } from "./services/consolidation.js";
import { shouldCapture as shouldCaptureUtil, detectCategory as detectCategoryUtil } from "./services/capture-utils.js";
import { buildToolScopeFilter } from "./utils/scope-filter.js";
import { walWrite, walRemove } from "./services/wal-helpers.js";
import {
  runReflection,
  runReflectionRules,
  runReflectionMeta,
  normalizeVector,
  cosineSimilarity,
  parsePatternsFromReflectionResponse,
} from "./services/reflection.js";
import { findSimilarByEmbedding } from "./services/vector-search.js";
import { migrateCredentialsToVault, CREDENTIAL_REDACTION_MIGRATION_FLAG } from "./services/credential-migration.js";
import { registerProposalsCli, type ProposalsCliContext } from "./cli/proposals.js";
import { createPluginService, type PluginServiceContext } from "./setup/plugin-service.js";
import { initializeDatabases, closeOldDatabases } from "./setup/init-databases.js";
import { registerTools } from "./setup/register-tools.js";
import { registerLifecycleHooks, type HooksContext } from "./setup/register-hooks.js";
import { capturePluginError } from "./services/error-reporter.js";

// ============================================================================
// Backend Imports (extracted from god file for maintainability)
// ============================================================================

import { CredentialsDB, type CredentialEntry, deriveKey, encryptValue, decryptValue } from "./backends/credentials-db.js";
import { ProposalsDB, type ProposalEntry } from "./backends/proposals-db.js";

// ============================================================================
// Helper Functions
// ============================================================================

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

// ============================================================================
// LLM-based Auto-Classifier
// ============================================================================

/** Minimum "other" facts before we run category discovery (avoid noise on tiny sets). */
// ============================================================================
// Plugin Definition
// ============================================================================

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
let embeddings: Embeddings;
let openai: OpenAI;
let credentialsDb: CredentialsDB | null = null;
let wal: WriteAheadLog | null = null;
let proposalsDb: ProposalsDB | null = null;

// Timer references (wrapped in objects so they can be passed by reference)
const timers = {
  pruneTimer: { value: null as ReturnType<typeof setInterval> | null },
  classifyTimer: { value: null as ReturnType<typeof setInterval> | null },
  classifyStartupTimeout: { value: null as ReturnType<typeof setTimeout> | null },
  proposalsPruneTimer: { value: null as ReturnType<typeof setInterval> | null },
  languageKeywordsTimer: { value: null as ReturnType<typeof setInterval> | null },
  languageKeywordsStartupTimeout: { value: null as ReturnType<typeof setTimeout> | null },
  postUpgradeTimeout: { value: null as ReturnType<typeof setTimeout> | null },
};

/** Last progressive index fact IDs (1-based position → fact id) so memory_recall(id: 1) can resolve. */
let lastProgressiveIndexIds: string[] = [];

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

let restartPendingCleared = false;

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
    closeOldDatabases({ factsDb, vectorDb, credentialsDb, proposalsDb });
    credentialsDb = null;
    proposalsDb = null;

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
    // Tools
    // ========================================================================

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
      lastProgressiveIndexIds,
      currentAgentIdRef,
      resolvedSqlitePath,
      timers: { proposalsPruneTimer: timers.proposalsPruneTimer },
      buildToolScopeFilter,
      walWrite,
      walRemove,
      findSimilarByEmbedding,
      runReflection,
      runReflectionRules,
      runReflectionMeta,
    }, api);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:tools" });
      throw err;
    }

    // ========================================================================
    // CLI Commands
    // ========================================================================
    try {
      registerHybridMemCliWithApi(api, {
      factsDb,
      vectorDb,
      embeddings,
      openai,
      cfg,
      credentialsDb,
      wal,
      proposalsDb,
      resolvedSqlitePath,
      resolvedLancePath,
      pluginId: PLUGIN_ID,
      detectCategory,
    });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:cli" });
      throw err;
    }

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    try {
      registerLifecycleHooks({
      factsDb,
      vectorDb,
      embeddings,
      openai,
      cfg,
      credentialsDb,
      wal,
      currentAgentIdRef,
      lastProgressiveIndexIds,
      restartPendingCleared,
      resolvedSqlitePath,
      walWrite: (operation, data, logger) => walWrite(wal, operation, data, logger),
      walRemove: (id, logger) => walRemove(wal, id, logger),
      findSimilarByEmbedding,
      shouldCapture,
      detectCategory,
    }, api);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "registration", operation: "plugin-register:hooks" });
      throw err;
    }

    // ========================================================================
    // Service
    // ========================================================================

    try {
      api.registerService(
      createPluginService({
        PLUGIN_ID,
        factsDb,
        vectorDb,
        credentialsDb,
        proposalsDb,
        wal,
        cfg,
        openai,
        resolvedLancePath,
        resolvedSqlitePath,
        api,
        timers,
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
  normalizeSuggestedLabel,
  unionFind,
  getRoot,
  mergeResults,
  filterByScope,
  safeEmbed,
  // Encryption primitives (used by CredentialsDB)
  deriveKey,
  encryptValue,
  decryptValue,
  // Classes for testing
  FactsDB,
  CredentialsDB,
  ProposalsDB,
  VectorDB,
  Embeddings,
  WriteAheadLog,
  // Classification (for tests)
  parseClassificationResponse,
  findSimilarByEmbedding,
  // Reflection parsing (for tests) - re-exported from service
  parsePatternsFromReflectionResponse,
  normalizeVector,
  cosineSimilarity,
};

export { versionInfo } from "./versionInfo.js";
export { sanitizeMessagesForClaude, type MessageLike } from "./utils/sanitize-messages.js";
export default memoryHybridPlugin;