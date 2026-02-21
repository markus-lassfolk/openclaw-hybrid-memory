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
  getMemoryCategories,
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
import { registerHybridMemCli, type BackfillCliResult, type BackfillCliSink, type ConfigCliResult, type DistillCliResult, type DistillCliSink, type DistillWindowResult, type ExtractDailyResult, type ExtractDailySink, type ExtractProceduresResult, type GenerateAutoSkillsResult, type IngestFilesResult, type IngestFilesSink, type InstallCliResult, type MigrateToVaultResult, type RecordDistillResult, type StoreCliOpts, type StoreCliResult, type UninstallCliResult, type UpgradeCliResult, type VerifyCliSink } from "./cli/register.js";
import { Embeddings, safeEmbed } from "./services/embeddings.js";
import { chatComplete, distillBatchTokenLimit, distillMaxOutputTokens } from "./services/chat.js";
import { extractProceduresFromSessions } from "./services/procedure-extractor.js";
import { generateAutoSkills } from "./services/procedure-skill-generator.js";
import { mergeResults, filterByScope } from "./services/merge-results.js";
import { gatherIngestFiles } from "./services/ingest-utils.js";
import { runExport } from "./services/export-memory.js";
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
import { initErrorReporter, capturePluginError, isErrorReporterActive, addOperationBreadcrumb, flushErrorReporter } from "./services/error-reporter.js";
import { insertRulesUnderSection } from "./services/tools-md-section.js";
import { tryExtractionFromTemplates } from "./utils/extraction-from-template.js";
import { extractCredentialsFromToolCalls, type ToolCallCredential } from "./services/credential-scanner.js";
import { runBuildLanguageKeywords as runBuildLanguageKeywordsService } from "./services/language-keywords-build.js";
import { runDirectiveExtract, type DirectiveExtractResult, type DirectiveIncident } from "./services/directive-extract.js";
import { runReinforcementExtract, type ReinforcementExtractResult, type ReinforcementIncident } from "./services/reinforcement-extract.js";
import { getDirectiveSignalRegex, getReinforcementSignalRegex } from "./utils/language-keywords.js";
import { detectAuthFailure, buildCredentialQuery, formatCredentialHint, DEFAULT_AUTH_FAILURE_PATTERNS, type AuthFailurePattern } from "./services/auth-failure-detect.js";
import { classifyMemoryOperation, parseClassificationResponse, type MemoryClassification } from "./services/classification.js";
import { extractStructuredFields } from "./services/fact-extraction.js";
import { getMemoryTriggers, detectCredentialPatterns, extractCredentialMatch, isCredentialLike, tryParseCredentialForVault, VAULT_POINTER_PREFIX, inferServiceFromText, SENSITIVE_PATTERNS } from "./services/auto-capture.js";
import { runAutoClassify, runClassifyForCli, normalizeSuggestedLabel } from "./services/auto-classifier.js";
import { runConsolidate, unionFind, getRoot, isStructuredForConsolidation } from "./services/consolidation.js";
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
import { runFindDuplicates } from "./services/find-duplicates.js";
import { findSimilarByEmbedding } from "./services/vector-search.js";
import { migrateCredentialsToVault, CREDENTIAL_REDACTION_MIGRATION_FLAG } from "./services/credential-migration.js";
import { registerMemoryTools, type PluginContext as MemoryToolsContext } from "./tools/memory-tools.js";
import { registerCredentialTools } from "./tools/credential-tools.js";
import { registerGraphTools } from "./tools/graph-tools.js";
import { registerPersonaTools } from "./tools/persona-tools.js";
import { registerUtilityTools } from "./tools/utility-tools.js";
import { createLifecycleHooks, type LifecycleContext } from "./lifecycle/hooks.js";
import { registerProposalsCli, type ProposalsCliContext } from "./cli/proposals.js";
import { createPluginService, type PluginServiceContext } from "./setup/plugin-service.js";

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
let currentAgentId: string | null = null;


const PLUGIN_ID = "openclaw-hybrid-memory";

/** Path to marker file written by config-mode/config-set; cleared when gateway loads plugin. */
function getRestartPendingPath(): string {
  return join(homedir(), ".openclaw", ".restart-pending.openclaw-hybrid-memory");
}
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
    if (typeof factsDb?.close === "function") {
      try {
        factsDb.close();
      } catch {
        // ignore
      }
    }
    if (typeof vectorDb?.close === "function") {
      try {
        vectorDb.close();
      } catch {
        // ignore
      }
    }
    if (credentialsDb) {
      try {
        credentialsDb.close();
      } catch {
        // ignore
      }
      credentialsDb = null;
    }
    if (proposalsDb) {
      try {
        proposalsDb.close();
      } catch {
        // ignore
      }
      proposalsDb = null;
    }

    cfg = hybridConfigSchema.parse(api.pluginConfig);
    resolvedLancePath = api.resolvePath(cfg.lanceDbPath);
    resolvedSqlitePath = api.resolvePath(cfg.sqlitePath);
    setKeywordsPath(dirname(resolvedSqlitePath));
    const vectorDim = vectorDimsForModel(cfg.embedding.model);

    factsDb = new FactsDB(resolvedSqlitePath, { fuzzyDedupe: cfg.store.fuzzyDedupe });
    vectorDb = new VectorDB(resolvedLancePath, vectorDim);
    vectorDb.setLogger(api.logger);
    embeddings = new Embeddings(cfg.embedding.apiKey, cfg.embedding.model);
    openai = new OpenAI({ apiKey: cfg.embedding.apiKey });

    if (cfg.credentials.enabled) {
      const credPath = join(dirname(resolvedSqlitePath), "credentials.db");
      credentialsDb = new CredentialsDB(credPath, cfg.credentials.encryptionKey ?? "");
      const encrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
      api.logger.info(
        encrypted
          ? `memory-hybrid: credentials vault enabled (encrypted) (${credPath})`
          : `memory-hybrid: credentials vault enabled (plaintext; secure by other means) (${credPath})`
      );
    } else {
      credentialsDb = null;
    }

    // Initialize Write-Ahead Log for crash resilience
    if (cfg.wal.enabled) {
      const walPath = cfg.wal.walPath || join(dirname(resolvedSqlitePath), "memory.wal");
      wal = new WriteAheadLog(walPath, cfg.wal.maxAge);
      api.logger.info(`memory-hybrid: WAL enabled (${walPath})`);
    } else {
      wal = null;
    }

    if (cfg.personaProposals.enabled) {
      const proposalsPath = join(dirname(resolvedSqlitePath), "proposals.db");
      proposalsDb = new ProposalsDB(proposalsPath);
      api.logger.info(`memory-hybrid: persona proposals enabled (${proposalsPath})`);
    } else {
      proposalsDb = null;
    }

    // Load previously discovered categories so they remain available after restart
    const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
    if (existsSync(discoveredPath)) {
      try {
        const loaded = JSON.parse(readFileSync(discoveredPath, "utf-8")) as string[];
        if (Array.isArray(loaded) && loaded.length > 0) {
          setMemoryCategories([...getMemoryCategories(), ...loaded]);
          api.logger.info(`memory-hybrid: loaded ${loaded.length} discovered categories`);
        }
      } catch {
        // ignore invalid or missing file
      }
    }

    api.logger.info(
      `memory-hybrid: registered (v${versionInfo.pluginVersion}, memory-manager ${versionInfo.memoryManagerVersion}) sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath}`,
    );

    // Prerequisite checks (async, non-blocking): verify keys and model access so user gets clear errors
    void (async () => {
      try {
        await embeddings.embed("verify");
        api.logger.info("memory-hybrid: embedding API check OK");
      } catch (e) {
        capturePluginError(e instanceof Error ? e : new Error(String(e)), {
          subsystem: "embeddings",
          operation: "init-verify",
          phase: "initialization",
          backend: "openai",
        });
        api.logger.error(
          `memory-hybrid: Embedding API check failed — ${String(e)}. ` +
            "Set a valid embedding.apiKey in plugin config and ensure the model is accessible. Run 'openclaw hybrid-mem verify' for details.",
        );
      }
      if (cfg.credentials.enabled && credentialsDb) {
        try {
          const items = credentialsDb.list();
          if (items.length > 0) {
            const first = items[0];
            credentialsDb.get(first.service, first.type as CredentialType);
          }
          api.logger.info("memory-hybrid: credentials vault check OK");
        } catch (e) {
          capturePluginError(e instanceof Error ? e : new Error(String(e)), {
            subsystem: "credentials",
            operation: "vault-verify",
            phase: "initialization",
            backend: "sqlite",
          });
          api.logger.error(
            `memory-hybrid: Credentials vault check failed — ${String(e)}. ` +
              "Check OPENCLAW_CRED_KEY (or credentials.encryptionKey). Wrong key or corrupted DB. Run 'openclaw hybrid-mem verify' for details.",
          );
        }
        // When vault is enabled: once per install, move existing credential facts into vault and redact from memory
        const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
        if (!existsSync(migrationFlagPath)) {
          try {
            const result = await migrateCredentialsToVault({
              factsDb,
              vectorDb,
              embeddings,
              credentialsDb,
              migrationFlagPath,
              markDone: true,
            });
            if (result.migrated > 0) {
              api.logger.info(`memory-hybrid: migrated ${result.migrated} credential(s) from memory into vault`);
            }
            if (result.errors.length > 0) {
              api.logger.warn(`memory-hybrid: credential migration had ${result.errors.length} error(s): ${result.errors.join("; ")}`);
            }
          } catch (e) {
            capturePluginError(e instanceof Error ? e : new Error(String(e)), {
              subsystem: "credentials",
              operation: "migration-to-vault",
              phase: "initialization",
              backend: "sqlite",
            });
            api.logger.warn(`memory-hybrid: credential migration failed: ${e}`);
          }
        }
      }
    })();

    // ========================================================================
    // Tools
    // ========================================================================

    // Register all tools using extracted modules
    registerMemoryTools(
      { factsDb, vectorDb, cfg, embeddings, openai, wal, credentialsDb, lastProgressiveIndexIds, currentAgentId },
      api,
      buildToolScopeFilter,
      (operation, data, logger) => walWrite(wal, operation, data, logger),
      (id, logger) => walRemove(wal, id, logger),
      findSimilarByEmbedding
    );

    if (cfg.graph.enabled) {
      registerGraphTools({ factsDb, cfg }, api);
    }

    if (cfg.credentials.enabled && credentialsDb) {
      registerCredentialTools({ credentialsDb, cfg, api }, api);
    }

    if (cfg.personaProposals.enabled && proposalsDb) {
      registerPersonaTools({ proposalsDb, cfg, resolvedSqlitePath }, api);

      // NOTE: persona_proposal_review and persona_proposal_apply are intentionally
      // NOT registered as agent-callable tools. They are CLI-only commands to ensure
      // human approval is required. This prevents agents from self-approving and
      // applying their own proposals, maintaining the security guarantee.

      // Periodic cleanup of expired proposals (stored in module-level variable for cleanup on stop)
      timers.proposalsPruneTimer.value = setInterval(() => {
        try {
          if (proposalsDb) {
            const pruned = proposalsDb.pruneExpired();
            if (pruned > 0) {
              api.logger.info(`memory-hybrid: pruned ${pruned} expired proposal(s)`);
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "proposals",
            operation: "periodic-prune",
          });
          api.logger.warn(`memory-hybrid: proposal prune failed: ${err}`);
        }
      }, 24 * 60 * 60_000); // daily

      // Register CLI commands for human-only review/apply operations
      api.registerCli(({ program }) => {
        registerProposalsCli(program, {
          proposalsDb: proposalsDb!,
          cfg,
          resolvedSqlitePath,
          api,
        });
      });
    }

    registerUtilityTools(
      { factsDb, vectorDb, embeddings, openai, cfg, wal, resolvedSqlitePath },
      api,
      runReflection,
      runReflectionRules,
      runReflectionMeta,
      (operation, data) => walWrite(wal, operation, data, api.logger),
      (id) => walRemove(wal, id, api.logger)
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const mem = program.command("hybrid-mem")
          .description("Hybrid memory plugin commands");

        async function runStoreForCli(opts: StoreCliOpts, log: { warn: (m: string) => void }): Promise<StoreCliResult> {
          const text = opts.text;
          if (factsDb.hasDuplicate(text)) return { outcome: "duplicate" };
          const sourceDate = opts.sourceDate ? parseSourceDate(opts.sourceDate) : null;
          const extracted = extractStructuredFields(text, (opts.category ?? "other") as MemoryCategory);
          const entity = opts.entity ?? extracted.entity ?? null;
          const key = opts.key ?? extracted.key ?? null;
          const value = opts.value ?? extracted.value ?? null;

          if (cfg.credentials.enabled && credentialsDb && isCredentialLike(text, entity, key, value)) {
            const parsed = tryParseCredentialForVault(text, entity, key, value);
            if (parsed) {
              credentialsDb.store({
                service: parsed.service,
                type: parsed.type,
                value: parsed.secretValue,
                url: parsed.url,
                notes: parsed.notes,
              });
              const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
              const pointerValue = VAULT_POINTER_PREFIX + parsed.service;
              const pointerEntry = factsDb.store({
                text: pointerText,
                category: "technical" as MemoryCategory,
                importance: CLI_STORE_IMPORTANCE,
                entity: "Credentials",
                key: parsed.service,
                value: pointerValue,
                source: "cli",
                sourceDate,
                tags: ["auth", ...extractTags(pointerText, "Credentials")],
              });
              try {
                const vector = await embeddings.embed(pointerText);
                if (!(await vectorDb.hasDuplicate(vector))) {
                  await vectorDb.store({ text: pointerText, vector, importance: CLI_STORE_IMPORTANCE, category: "technical", id: pointerEntry.id });
                }
              } catch (err) {
                log.warn(`memory-hybrid: vector store failed: ${err}`);
              }
              return { outcome: "credential", id: pointerEntry.id, service: parsed.service, type: parsed.type };
            }
            return { outcome: "credential_parse_error" };
          }

          const tags = opts.tags
            ? opts.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
            : undefined;
          const category = (opts.category ?? "other") as MemoryCategory;

          // FR-006: Compute scope early so it's available for classify-before-write UPDATE path
          const scope = opts.scope ?? "global";
          const scopeTarget = scope === "global" ? null : (opts.scopeTarget?.trim() ?? null);

          if (cfg.store.classifyBeforeWrite) {
            let vector: number[] | undefined;
            try {
              vector = await embeddings.embed(text);
            } catch (err) {
              log.warn(`memory-hybrid: CLI store embedding failed: ${err}`);
            }
            if (vector) {
              let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5);
              if (similarFacts.length === 0) {
                similarFacts = factsDb.findSimilarForClassification(text, entity, key, 5);
              }
              if (similarFacts.length > 0) {
                try {
                  const classification = await classifyMemoryOperation(
                    text, entity, key, similarFacts, openai, cfg.store.classifyModel ?? "gpt-4o-mini", log,
                  );
                  if (classification.action === "NOOP") return { outcome: "noop", reason: classification.reason ?? "" };
                  if (classification.action === "DELETE" && classification.targetId) {
                    factsDb.supersede(classification.targetId, null);
                    return { outcome: "retracted", targetId: classification.targetId, reason: classification.reason ?? "" };
                  }
                  if (classification.action === "UPDATE" && classification.targetId) {
                    const oldFact = factsDb.getById(classification.targetId);
                    if (oldFact) {
                      const nowSec = Math.floor(Date.now() / 1000);
                      const newEntry = factsDb.store({
                        text,
                        category,
                        importance: CLI_STORE_IMPORTANCE,
                        entity: entity ?? oldFact.entity,
                        key: opts.key ?? extracted.key ?? oldFact.key ?? null,
                        value: opts.value ?? extracted.value ?? oldFact.value ?? null,
                        source: "cli",
                        sourceDate,
                        tags: tags ?? extractTags(text, entity),
                        validFrom: sourceDate ?? nowSec,
                        supersedesId: classification.targetId,
                        scope,
                        scopeTarget,
                      });
                      factsDb.supersede(classification.targetId, newEntry.id);
                      try {
                        if (!(await vectorDb.hasDuplicate(vector))) {
                          await vectorDb.store({ text, vector, importance: CLI_STORE_IMPORTANCE, category, id: newEntry.id });
                        }
                      } catch (err) {
                        log.warn(`memory-hybrid: vector store failed: ${err}`);
                      }
                      return { outcome: "updated", id: newEntry.id, supersededId: classification.targetId, reason: classification.reason ?? "" };
                    }
                  }
                } catch (err) {
                  log.warn(`memory-hybrid: CLI store classification failed: ${err}`);
                }
              }
            }
          }

          // FR-006: scope already computed above
          const supersedesId = opts.supersedes?.trim();
          const nowSec = supersedesId ? Math.floor(Date.now() / 1000) : undefined;
          const entry = factsDb.store({
            text,
            category,
            importance: CLI_STORE_IMPORTANCE,
            entity,
            key: opts.key ?? extracted.key ?? null,
            value: opts.value ?? extracted.value ?? null,
            source: "cli",
            sourceDate,
            tags: tags ?? extractTags(text, entity),
            scope,
            scopeTarget,
            ...(supersedesId ? { validFrom: nowSec, supersedesId } : {}),
          });
          if (supersedesId) factsDb.supersede(supersedesId, entry.id);
          try {
            const vector = await embeddings.embed(text);
            if (!(await vectorDb.hasDuplicate(vector))) {
              await vectorDb.store({ text, vector, importance: CLI_STORE_IMPORTANCE, category: opts.category ?? "other", id: entry.id });
            }
          } catch (err) {
            log.warn(`memory-hybrid: vector store failed: ${err}`);
          }
          return { outcome: "stored", id: entry.id, textPreview: text.slice(0, 80) + (text.length > 80 ? "..." : ""), ...(supersedesId ? { supersededId: supersedesId } : {}) };
        }

        function runInstallForCli(opts: { dryRun: boolean }): InstallCliResult {
          const openclawDir = join(homedir(), ".openclaw");
          const configPath = join(openclawDir, "openclaw.json");
          mkdirSync(openclawDir, { recursive: true });
          mkdirSync(join(openclawDir, "memory"), { recursive: true });

          const fullDefaults = {
            memory: { backend: "builtin" as const, citations: "auto" as const },
            plugins: {
              slots: { memory: PLUGIN_ID },
              entries: {
                "memory-core": { enabled: true },
                [PLUGIN_ID]: {
                  enabled: true,
                  config: {
                    embedding: { apiKey: "YOUR_OPENAI_API_KEY", model: "text-embedding-3-small" },
                    distill: { defaultModel: "gemini-3-pro-preview" },
                    autoCapture: true,
                    autoRecall: true,
                    captureMaxChars: 5000,
                    store: { fuzzyDedupe: false },
                    autoClassify: { enabled: true, model: "gpt-4o-mini", batchSize: 20 },
                    categories: [] as string[],
                    credentials: { enabled: false, store: "sqlite" as const, encryptionKey: "", autoDetect: false, expiryWarningDays: 7 },
                    languageKeywords: { autoBuild: true, weeklyIntervalDays: 7 },
                    reflection: { enabled: true, model: "gpt-4o-mini", defaultWindow: 14, minObservations: 2 },
                    selfCorrection: {
                      semanticDedup: true,
                      semanticDedupThreshold: 0.92,
                      toolsSection: "Self-correction rules",
                      applyToolsByDefault: true,
                      autoRewriteTools: false,
                    },
                  },
                },
              },
            },
            agents: {
              defaults: {
                bootstrapMaxChars: 15000,
                bootstrapTotalMaxChars: 50000,
                memorySearch: {
                  enabled: true,
                  sources: ["memory"],
                  provider: "openai",
                  model: "text-embedding-3-small",
                  sync: { onSessionStart: true, onSearch: true, watch: true },
                  chunking: { tokens: 500, overlap: 50 },
                  query: { maxResults: 8, minScore: 0.3, hybrid: { enabled: true } },
                },
                compaction: {
                  mode: "default",
                  memoryFlush: {
                    enabled: true,
                    softThresholdTokens: 4000,
                    systemPrompt: "Session nearing compaction. You MUST save all important context NOW using BOTH memory systems before it is lost. This is your last chance to preserve this information.",
                    prompt: "URGENT: Context is about to be compacted. Scan the full conversation and:\n1. Use memory_store for each important fact, preference, decision, or entity (structured storage survives compaction)\n2. Write a session summary to memory/YYYY-MM-DD.md with key topics, decisions, and open items\n3. Update any relevant memory/ files if project state or technical details changed\n\nDo NOT skip this. Reply NO_REPLY only if there is truly nothing worth saving.",
                  },
                },
              },
            },
          };

          function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
            for (const key of Object.keys(source)) {
              const srcVal = source[key];
              const tgtVal = target[key];
              if (srcVal !== null && typeof srcVal === "object" && !Array.isArray(srcVal) && tgtVal !== null && typeof tgtVal === "object" && !Array.isArray(tgtVal)) {
                deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
              } else if (tgtVal === undefined && !Array.isArray(srcVal)) {
                (target as Record<string, unknown>)[key] = srcVal;
              }
            }
          }

          let config: Record<string, unknown> = {};
          if (existsSync(configPath)) {
            try {
              config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
            } catch (e) {
              return { ok: false, error: `Could not read ${configPath}: ${e}` };
            }
          }
          const existingApiKey = (config?.plugins as Record<string, unknown>)?.["entries"] && ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)?.[PLUGIN_ID] && (((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>)?.config && ((((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>).config as Record<string, unknown>)?.embedding && (((((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>).config as Record<string, unknown>).embedding as Record<string, unknown>)?.apiKey;
          const isRealKey = typeof existingApiKey === "string" && existingApiKey.length >= 10 && existingApiKey !== "YOUR_OPENAI_API_KEY" && existingApiKey !== "<OPENAI_API_KEY>";

          if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
          if (!(config.agents && typeof config.agents === "object")) config.agents = { defaults: {} };
          deepMerge(config, fullDefaults as unknown as Record<string, unknown>);
          if (isRealKey) {
            const entries = (config.plugins as Record<string, unknown>).entries as Record<string, unknown>;
            const mh = entries[PLUGIN_ID] as Record<string, unknown>;
            const cfg = mh?.config as Record<string, unknown>;
            const emb = cfg?.embedding as Record<string, unknown>;
            if (emb) emb.apiKey = existingApiKey;
          }
          const after = JSON.stringify(config, null, 2);

          if (opts.dryRun) {
            return { ok: true, configPath, dryRun: true, written: false, configJson: after, pluginId: PLUGIN_ID };
          }
          writeFileSync(configPath, after, "utf-8");
          // Create maintenance cron jobs on fresh install (same definitions as verify --fix, no re-enable)
          try {
            const cronDir = join(openclawDir, "cron");
            const cronStorePath = join(cronDir, "jobs.json");
            const prefix = "hybrid-mem:";
            const installJobs = [
              { pluginJobId: prefix + "nightly-distill", name: "nightly-memory-sweep", schedule: "0 2 * * *", channel: "system", message: "Check if distill is enabled (config distill.enabled !== false). If enabled, run nightly session distillation for last 3 days, then run openclaw hybrid-mem record-distill. Exit 0 if disabled.", isolated: true, model: "gemini", enabled: true },
              { pluginJobId: prefix + "weekly-reflection", name: "weekly-reflection", schedule: "0 3 * * 0", channel: "system", message: "Check if reflection is enabled (config reflection.enabled !== false). If enabled, run: openclaw hybrid-mem reflect && openclaw hybrid-mem reflect-rules && openclaw hybrid-mem reflect-meta. Exit 0 if disabled.", isolated: true, model: "gemini", enabled: true },
              { pluginJobId: prefix + "weekly-extract-procedures", name: "weekly-extract-procedures", schedule: "0 4 * * 0", channel: "system", message: "Check if procedures are enabled (config procedures.enabled !== false). If enabled, run openclaw hybrid-mem extract-procedures --days 7. Exit 0 if disabled.", isolated: true, model: "gemini", enabled: true },
              { pluginJobId: prefix + "self-correction-analysis", name: "self-correction-analysis", schedule: "30 2 * * *", channel: "system", message: "Check if self-correction is enabled (config selfCorrection is truthy). If enabled, run openclaw hybrid-mem self-correction-run. Exit 0 if disabled.", isolated: true, model: "sonnet", enabled: true },
              { pluginJobId: prefix + "weekly-deep-maintenance", name: "weekly-deep-maintenance", schedule: "0 4 * * 6", channel: "system", message: "Weekly deep maintenance: run extract-procedures, extract-directives, extract-reinforcement, self-correction-run, scope promote, compact. Check feature configs before each step. Exit 0 if all disabled.", isolated: true, model: "sonnet", enabled: true },
              { pluginJobId: prefix + "monthly-consolidation", name: "monthly-consolidation", schedule: "0 5 1 * *", channel: "system", message: "Monthly consolidation: run consolidate, build-languages, generate-auto-skills, backfill-decay. Check feature configs before each step. Exit 0 if all disabled.", isolated: true, model: "sonnet", enabled: true },
            ] as Array<Record<string, unknown>>;
            const legacyMatch: Record<string, (j: Record<string, unknown>) => boolean> = {
              [prefix + "nightly-distill"]: (j) => String(j.name ?? "").toLowerCase().includes("nightly-memory-sweep"),
              [prefix + "weekly-reflection"]: (j) => /weekly-reflection|memory reflection|pattern synthesis/.test(String(j.name ?? "")),
              [prefix + "weekly-extract-procedures"]: (j) => /extract-procedures|weekly-extract-procedures|procedural memory/i.test(String(j.name ?? "")),
              [prefix + "self-correction-analysis"]: (j) => /self-correction-analysis|self-correction\b/i.test(String(j.name ?? "")),
              [prefix + "weekly-deep-maintenance"]: (j) => /weekly-deep-maintenance|deep maintenance/i.test(String(j.name ?? "")),
              [prefix + "monthly-consolidation"]: (j) => /monthly-consolidation/i.test(String(j.name ?? "")),
            };
            mkdirSync(cronDir, { recursive: true });
            let store: { jobs?: unknown[] } = existsSync(cronStorePath) ? JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] } : {};
            if (!Array.isArray(store.jobs)) store.jobs = [];
            const jobsArr = store.jobs as Array<Record<string, unknown>>;
            for (const def of installJobs) {
              const id = def.pluginJobId as string;
              if (!jobsArr.some((j) => j && (j.pluginJobId === id || legacyMatch[id]?.(j)))) {
                jobsArr.push({ ...def });
              }
            }
            writeFileSync(cronStorePath, JSON.stringify(store, null, 2), "utf-8");
            let rootConfig = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
            if (!Array.isArray(rootConfig.jobs)) rootConfig.jobs = [];
            const rootJobsArr = rootConfig.jobs as Array<Record<string, unknown>>;
            for (const def of installJobs) {
              const id = def.pluginJobId as string;
              if (!rootJobsArr.some((j) => j && (j.pluginJobId === id || legacyMatch[id]?.(j)))) {
                rootJobsArr.push({ ...def });
              }
            }
            writeFileSync(configPath, JSON.stringify(rootConfig, null, 2), "utf-8");
          } catch {
            // non-fatal: cron jobs optional on install
          }
          return { ok: true, configPath, dryRun: false, written: true, pluginId: PLUGIN_ID };
        }

        async function runVerifyForCli(opts: { fix: boolean; logFile?: string }, sink: VerifyCliSink): Promise<void> {
          const log = sink.log;
          const err = sink.error ?? sink.log;
          const issues: string[] = [];
          const fixes: string[] = [];
          let configOk = true;
          let sqliteOk = false;
          let lanceOk = false;
          let embeddingOk = false;
          const loadBlocking: string[] = [];
          if (!cfg.embedding.apiKey || cfg.embedding.apiKey === "YOUR_OPENAI_API_KEY" || cfg.embedding.apiKey.length < 10) {
            issues.push("embedding.apiKey is missing, placeholder, or too short");
            loadBlocking.push("embedding.apiKey is missing, placeholder, or too short");
            fixes.push(`LOAD-BLOCKING: Set plugins.entries["${PLUGIN_ID}"].config.embedding.apiKey to a valid OpenAI key (and embedding.model to "text-embedding-3-small"). Edit ~/.openclaw/openclaw.json or set OPENAI_API_KEY and use env:OPENAI_API_KEY in config.`);
            configOk = false;
          }
          if (!cfg.embedding.model) {
            issues.push("embedding.model is missing");
            loadBlocking.push("embedding.model is missing");
            fixes.push('Set "embedding.model" to "text-embedding-3-small" or "text-embedding-3-large" in plugin config');
            configOk = false;
          }
          const openclawDir = join(homedir(), ".openclaw");
          const defaultConfigPath = join(openclawDir, "openclaw.json");
          if (configOk) log("Config: embedding.apiKey and model present");
          else log("Config: issues found");
          const extDir = dirname(fileURLToPath(import.meta.url));
          const isBindingsError = (msg: string) =>
            /bindings|better_sqlite3\.node|compiled against|ABI|NODE_MODULE_VERSION|@lancedb\/lancedb|Cannot find module/.test(msg);
          let sqliteBindingsFailed = false;
          let lanceBindingsFailed = false;
          try {
            const n = factsDb.count();
            sqliteOk = true;
            log(`SQLite: OK (${resolvedSqlitePath}, ${n} facts)`);
          } catch (e) {
            const msg = String(e);
            issues.push(`SQLite: ${msg}`);
            if (isBindingsError(msg)) {
              sqliteBindingsFailed = true;
              fixes.push(`Native module (better-sqlite3) needs rebuild. Run: cd ${extDir} && npm rebuild better-sqlite3`);
            } else {
              fixes.push(`SQLite: Ensure path is writable and not corrupted. Path: ${resolvedSqlitePath}. If corrupted, back up and remove the file to recreate, or run from a process with write access.`);
            }
            log(`SQLite: FAIL — ${msg}`);
          }
          try {
            const n = await vectorDb.count();
            lanceOk = true;
            log(`LanceDB: OK (${resolvedLancePath}, ${n} vectors)`);
          } catch (e) {
            const msg = String(e);
            issues.push(`LanceDB: ${msg}`);
            if (isBindingsError(msg)) {
              lanceBindingsFailed = true;
              fixes.push(`Native module (@lancedb/lancedb) needs rebuild. Run: cd ${extDir} && npm rebuild @lancedb/lancedb`);
            } else {
              fixes.push(`LanceDB: Ensure path is writable. Path: ${resolvedLancePath}. If corrupted, back up and remove the directory to recreate. Restart gateway after fix.`);
            }
            log(`LanceDB: FAIL — ${msg}`);
          }
          try {
            await embeddings.embed("verify test");
            embeddingOk = true;
            log("Embedding API: OK");
          } catch (e) {
            issues.push(`Embedding API: ${String(e)}`);
            fixes.push(`Embedding API: Check key at platform.openai.com; ensure it has access to the embedding model (${cfg.embedding.model}). Set plugins.entries[\"openclaw-hybrid-memory\"].config.embedding.apiKey and restart. 401/403 = invalid or revoked key.`);
            log(`Embedding API: FAIL — ${String(e)}`);
          }
          const bool = (b: boolean) => String(b);
          const restartPending = existsSync(getRestartPendingPath());
          const modeLabel = cfg.mode 
            ? cfg.mode === "custom" 
              ? "Mode: Custom" 
              : `Mode: ${cfg.mode.charAt(0).toUpperCase() + cfg.mode.slice(1)} (preset)` 
            : "Mode: Custom";
          log(`\n${modeLabel}${restartPending ? " — restart pending" : ""}`);
          log("\nFeatures (all on/off toggles, values match config true/false):");
          log(`  autoCapture: ${bool(cfg.autoCapture)}`);
          log(`  autoRecall: ${bool(cfg.autoRecall.enabled)}`);
          log(`  autoClassify: ${cfg.autoClassify.enabled ? cfg.autoClassify.model : "false"}`);
          log(`  autoClassify.suggestCategories: ${bool(cfg.autoClassify.suggestCategories !== false)}`);
          log(`  credentials: ${bool(cfg.credentials.enabled)}`);
          if (cfg.credentials.enabled) {
            log(`  credentials.autoDetect: ${bool(cfg.credentials.autoDetect === true)}`);
            log(`  credentials.autoCapture.toolCalls (tool I/O): ${bool(cfg.credentials.autoCapture?.toolCalls === true)}`);
            const vaultEncrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
            log(`  → Credentials vault: ${vaultEncrypted ? "encrypted" : "plaintext (secure by other means)"}`);
          } else if (cfg.mode === "expert" || cfg.mode === "full") {
            log(`  → Credentials (vault): off — set credentials.enabled to use vault (optionally set credentials.encryptionKey for encryption).`);
          }
          log(`  store.fuzzyDedupe: ${bool(cfg.store.fuzzyDedupe)}`);
          log(`  store.classifyBeforeWrite: ${bool(cfg.store.classifyBeforeWrite === true)}`);
          log(`  graph: ${bool(cfg.graph.enabled)}`);
          if (cfg.graph.enabled) {
            log(`  graph.autoLink: ${bool(cfg.graph.autoLink)}`);
            log(`  graph.useInRecall: ${bool(cfg.graph.useInRecall)}`);
          }
          log(`  procedures: ${bool(cfg.procedures.enabled)}`);
          log(`  procedures.requireApprovalForPromote: ${bool(cfg.procedures.requireApprovalForPromote)}`);
          log(`  reflection: ${bool(cfg.reflection.enabled)}`);
          log(`  wal: ${bool(cfg.wal.enabled)}`);
          log(`  languageKeywords.autoBuild: ${bool(cfg.languageKeywords.autoBuild)}`);
          log(`  personaProposals: ${bool(cfg.personaProposals.enabled)}`);
          log(`  memoryTiering: ${bool(cfg.memoryTiering.enabled)}`);
          log(`  memoryTiering.compactionOnSessionEnd: ${bool(cfg.memoryTiering.compactionOnSessionEnd)}`);
          if (cfg.selfCorrection) {
            log(`  selfCorrection: true`);
            log(`  selfCorrection.semanticDedup: ${bool(cfg.selfCorrection.semanticDedup)}`);
            log(`  selfCorrection.applyToolsByDefault: ${bool(cfg.selfCorrection.applyToolsByDefault)}`);
            log(`  selfCorrection.autoRewriteTools: ${bool(cfg.selfCorrection.autoRewriteTools)}`);
            log(`  selfCorrection.analyzeViaSpawn: ${bool(cfg.selfCorrection.analyzeViaSpawn)}`);
          } else {
            log(`  selfCorrection: false`);
          }
          log(`  autoRecall.entityLookup: ${bool(cfg.autoRecall.entityLookup.enabled)}`);
          log(`  autoRecall.authFailure (reactive recall): ${bool(cfg.autoRecall.authFailure.enabled)}`);
          if (cfg.search) {
            log(`  search.hydeEnabled: ${bool(cfg.search.hydeEnabled)}`);
          }
          if (cfg.ingest) {
            log(`  ingest (paths configured): true`);
          }
          if (cfg.distill) {
            log(`  distill.extractDirectives: ${bool(cfg.distill.extractDirectives !== false)}`);
            log(`  distill.extractReinforcement: ${bool(cfg.distill.extractReinforcement !== false)}`);
          }
          if (cfg.errorReporting) {
            log(`  errorReporting: ${bool(cfg.errorReporting.enabled)}`);
          }
          let credentialsOk = true;
          if (cfg.credentials.enabled) {
            if (credentialsDb) {
              try {
                const items = credentialsDb.list();
                if (items.length > 0) {
                  const first = items[0];
                  credentialsDb.get(first.service, first.type as CredentialType);
                }
                const encrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
                log(`\nCredentials (vault): OK (${items.length} stored)${encrypted ? " [encrypted]" : " [plaintext]"}`);
              } catch (e) {
                issues.push(`Credentials vault: ${String(e)}`);
                const encrypted = (cfg.credentials.encryptionKey?.length ?? 0) >= 16;
                if (encrypted) {
                  fixes.push(`Credentials vault: Wrong encryption key or corrupted DB. Set OPENCLAW_CRED_KEY to the key used when credentials were stored, or use a new vault path for plaintext. See docs/CREDENTIALS.md.`);
                } else {
                  fixes.push(`Credentials vault: ${String(e)}. If this vault was created with encryption, set credentials.encryptionKey. See docs/CREDENTIALS.md.`);
                }
                credentialsOk = false;
                log(`\nCredentials (vault): FAIL — ${String(e)}`);
              }
            } else {
              log("\nCredentials (vault): enabled (vault not opened in this process)");
            }
          }
          const memoryDir = dirname(resolvedSqlitePath);
          const distillLastRunPath = join(memoryDir, ".distill_last_run");
          if (existsSync(distillLastRunPath)) {
            try {
              const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
              log(`\nSession distillation: last run recorded ${line ? `— ${line}` : "(empty file)"}`);
            } catch {
              log("\nSession distillation: last run file present but unreadable");
            }
          } else {
            log("\nSession distillation: last run not recorded (optional).");
            log("  If you use session distillation (extracting facts from old logs): after each run, run: openclaw hybrid-mem record-distill");
            log("  If you have a nightly distillation cron job: add a final step to that job to run openclaw hybrid-mem record-distill so this is recorded.");
            log("  If you don't use it, ignore this.");
          }
          let nightlySweepDefined = false;
          let nightlySweepEnabled = true;
          const cronStorePath = join(openclawDir, "cron", "jobs.json");
          if (existsSync(cronStorePath)) {
            try {
              const raw = readFileSync(cronStorePath, "utf-8");
              const store = JSON.parse(raw) as Record<string, unknown>;
              const jobs = store.jobs;
              if (Array.isArray(jobs)) {
                const nightly = jobs.find((j: unknown) => {
                  if (typeof j !== "object" || j === null) return false;
                  const name = String((j as Record<string, unknown>).name ?? "").toLowerCase();
                  const pl = (j as Record<string, unknown>).payload as Record<string, unknown> | undefined;
                  const msg = String(pl?.message ?? (j as Record<string, unknown>).message ?? "").toLowerCase();
                  return /nightly-memory-sweep|memory distillation.*nightly|nightly.*memory.*distill/.test(name) || /nightly memory distillation|memory distillation pipeline/.test(msg);
                }) as Record<string, unknown> | undefined;
                if (nightly) {
                  nightlySweepDefined = true;
                  nightlySweepEnabled = nightly.enabled !== false;
                }
              }
            } catch {
              // ignore
            }
          }
          if (!nightlySweepDefined && existsSync(defaultConfigPath)) {
            try {
              const raw = readFileSync(defaultConfigPath, "utf-8");
              const root = JSON.parse(raw) as Record<string, unknown>;
              const jobs = root.jobs;
              if (Array.isArray(jobs)) {
                const nightly = jobs.find((j: unknown) => typeof j === "object" && j !== null && (j as Record<string, unknown>).name === "nightly-memory-sweep") as Record<string, unknown> | undefined;
                if (nightly) {
                  nightlySweepDefined = true;
                  nightlySweepEnabled = nightly.enabled !== false;
                }
              } else if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
                const nightly = (jobs as Record<string, unknown>)["nightly-memory-sweep"];
                if (nightly && typeof nightly === "object") {
                  nightlySweepDefined = true;
                  nightlySweepEnabled = (nightly as Record<string, unknown>).enabled !== false;
                }
              }
            } catch {
              // ignore
            }
          }
          let weeklyReflectionDefined = false;
          if (existsSync(cronStorePath)) {
            try {
              const raw = readFileSync(cronStorePath, "utf-8");
              const store = JSON.parse(raw) as Record<string, unknown>;
              const jobs = store.jobs;
              if (Array.isArray(jobs)) {
                const weekly = jobs.find((j: unknown) => /weekly-reflection|memory reflection|pattern synthesis/.test(String((j as Record<string, unknown>)?.name ?? ""))) as Record<string, unknown> | undefined;
                if (weekly) weeklyReflectionDefined = true;
              }
            } catch { /* ignore */ }
          }
          if (!weeklyReflectionDefined && existsSync(defaultConfigPath)) {
            try {
              const raw = readFileSync(defaultConfigPath, "utf-8");
              const root = JSON.parse(raw) as Record<string, unknown>;
              const jobs = root.jobs;
              if (Array.isArray(jobs)) {
                const weekly = jobs.find((j: unknown) => (j as Record<string, unknown>)?.name === "weekly-reflection");
                if (weekly) weeklyReflectionDefined = true;
              }
            } catch { /* ignore */ }
          }
          let extractProceduresDefined = false;
          let selfCorrectionDefined = false;
          let weeklyDeepMaintenanceDefined = false;
          let monthlyConsolidationDefined = false;
          const extractProceduresRe = /extract-procedures|weekly-extract-procedures|procedural memory/i;
          const selfCorrectionRe = /self-correction-analysis|self-correction\b/i;
          const weeklyDeepMaintenanceRe = /weekly-deep-maintenance|deep maintenance/i;
          const monthlyConsolidationRe = /monthly-consolidation/i;
          if (existsSync(cronStorePath)) {
            try {
              const raw = readFileSync(cronStorePath, "utf-8");
              const store = JSON.parse(raw) as Record<string, unknown>;
              const jobs = store.jobs;
              if (Array.isArray(jobs)) {
                if (jobs.some((j: unknown) => extractProceduresRe.test(String((j as Record<string, unknown>)?.name ?? "")))) extractProceduresDefined = true;
                if (jobs.some((j: unknown) => selfCorrectionRe.test(String((j as Record<string, unknown>)?.name ?? "")))) selfCorrectionDefined = true;
                if (jobs.some((j: unknown) => weeklyDeepMaintenanceRe.test(String((j as Record<string, unknown>)?.name ?? "")))) weeklyDeepMaintenanceDefined = true;
                if (jobs.some((j: unknown) => monthlyConsolidationRe.test(String((j as Record<string, unknown>)?.name ?? "")))) monthlyConsolidationDefined = true;
              }
            } catch { /* ignore */ }
          }
          if (existsSync(defaultConfigPath)) {
            try {
              const raw = readFileSync(defaultConfigPath, "utf-8");
              const root = JSON.parse(raw) as Record<string, unknown>;
              const jobs = root.jobs;
              if (Array.isArray(jobs)) {
                if (jobs.some((j: unknown) => extractProceduresRe.test(String((j as Record<string, unknown>)?.name ?? "")))) extractProceduresDefined = true;
                if (jobs.some((j: unknown) => selfCorrectionRe.test(String((j as Record<string, unknown>)?.name ?? "")))) selfCorrectionDefined = true;
                if (jobs.some((j: unknown) => weeklyDeepMaintenanceRe.test(String((j as Record<string, unknown>)?.name ?? "")))) weeklyDeepMaintenanceDefined = true;
                if (jobs.some((j: unknown) => monthlyConsolidationRe.test(String((j as Record<string, unknown>)?.name ?? "")))) monthlyConsolidationDefined = true;
              } else if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
                const keyed = jobs as Record<string, unknown>;
                if (Object.keys(keyed).some((k) => extractProceduresRe.test(k))) extractProceduresDefined = true;
                if (Object.keys(keyed).some((k) => selfCorrectionRe.test(k))) selfCorrectionDefined = true;
                if (Object.keys(keyed).some((k) => weeklyDeepMaintenanceRe.test(k))) weeklyDeepMaintenanceDefined = true;
                if (Object.keys(keyed).some((k) => monthlyConsolidationRe.test(k))) monthlyConsolidationDefined = true;
              }
            } catch { /* ignore */ }
          }
          log("\nOptional / suggested jobs (cron store or openclaw.json):");
          if (nightlySweepDefined) {
            log(`  nightly-memory-sweep (session distillation): defined, ${nightlySweepEnabled ? "true" : "false"}`);
          } else {
            log("  nightly-memory-sweep (session distillation): not defined");
            fixes.push("Optional: Set up nightly session distillation via OpenClaw's scheduled jobs (e.g. cron store or UI) or system cron. See docs/SESSION-DISTILLATION.md § Nightly Cron Setup.");
          }
          if (weeklyReflectionDefined) {
            log("  weekly-reflection (pattern synthesis): defined");
          } else {
            log("  weekly-reflection (pattern synthesis): not defined");
            fixes.push("Optional: Set up weekly reflection via jobs. See docs/REFLECTION.md § Scheduled Job. Run 'openclaw hybrid-mem verify --fix' to add.");
          }
          if (extractProceduresDefined) {
            log("  weekly-extract-procedures (procedural memory): defined");
          } else {
            log("  weekly-extract-procedures (procedural memory): not defined");
            fixes.push("Optional: Set up procedural memory extraction via jobs. See docs/PROCEDURAL-MEMORY.md. Run 'openclaw hybrid-mem verify --fix' to add.");
          }
          if (selfCorrectionDefined) {
            log("  self-correction-analysis: defined");
          } else {
            log("  self-correction-analysis: not defined");
            fixes.push("Optional: Set up self-correction analysis via jobs. See docs/SELF-CORRECTION-PIPELINE.md. Run 'openclaw hybrid-mem verify --fix' to add.");
          }
          if (weeklyDeepMaintenanceDefined) {
            log("  weekly-deep-maintenance: defined");
          } else {
            log("  weekly-deep-maintenance: not defined");
            fixes.push("Optional: Set up weekly deep maintenance via jobs. Run 'openclaw hybrid-mem verify --fix' to add.");
          }
          if (monthlyConsolidationDefined) {
            log("  monthly-consolidation: defined");
          } else {
            log("  monthly-consolidation: not defined");
            fixes.push("Optional: Set up monthly consolidation via jobs. Run 'openclaw hybrid-mem verify --fix' to add.");
          }
          log("\nBackground jobs (when gateway is running): prune every 60min, auto-classify every 24h if enabled. No external cron required.");
          if (opts.logFile && existsSync(opts.logFile)) {
            const content = readFileSync(opts.logFile, "utf-8");
            const lines = content.split("\n").filter((l) => /memory-hybrid|prune|auto-classify|periodic|failed/.test(l));
            const errLines = lines.filter((l) => /error|fail|warn/i.test(l));
            if (errLines.length > 0) {
              log(`\nRecent log lines mentioning memory-hybrid/errors (last ${errLines.length}):`);
              errLines.slice(-10).forEach((l) => log(`  ${l.slice(0, 120)}`));
            } else if (lines.length > 0) {
              log(`\nLog file: ${lines.length} relevant lines (no errors in sample)`);
            }
          } else if (opts.logFile) {
            log(`\nLog file not found: ${opts.logFile}`);
          }
          const allOk = configOk && sqliteOk && lanceOk && embeddingOk && (!cfg.credentials.enabled || credentialsOk);
          if (allOk) {
            log("\nAll checks passed.");
            if (restartPending) {
              process.exitCode = 2; // Scripting: 2 = restart pending (gateway restart recommended)
            }
            log("Note: If you see 'plugins.allow is empty' above, it is from OpenClaw. Optional: set plugins.allow to [\"openclaw-hybrid-memory\"] in openclaw.json for an explicit allow-list.");
            if (!nightlySweepDefined) {
              log("Optional: Set up nightly session distillation via OpenClaw's scheduled jobs or system cron. See docs/SESSION-DISTILLATION.md.");
            }
          } else {
            log("\n--- Issues ---");
            if (loadBlocking.length > 0) {
              log("Load-blocking (prevent OpenClaw / plugin from loading):");
              loadBlocking.forEach((i) => log(`  - ${i}`));
            }
            const other = issues.filter((i) => !loadBlocking.includes(i));
            if (other.length > 0) {
              log(other.length > 0 && loadBlocking.length > 0 ? "Other:" : "Issues:");
              other.forEach((i) => log(`  - ${i}`));
            }
            log("\n--- Fixes for detected issues ---");
            fixes.forEach((f) => log(`  • ${f}`));
            log("\nEdit config: " + defaultConfigPath + " (or OPENCLAW_HOME/openclaw.json). Restart gateway after changing plugin config.");
          }
          if (opts.fix) {
            const applied: string[] = [];
            if (sqliteBindingsFailed || lanceBindingsFailed) {
              const { spawnSync } = await import("node:child_process");
              const pkgs = [
                ...(sqliteBindingsFailed ? ["better-sqlite3"] : []),
                ...(lanceBindingsFailed ? ["@lancedb/lancedb"] : []),
              ];
              for (const pkg of pkgs) {
                const r = spawnSync("npm", ["rebuild", pkg], { cwd: extDir, shell: true });
                if (r.status === 0) {
                  applied.push(`Rebuilt native module: ${pkg}`);
                } else {
                  log(`Rebuild ${pkg} failed (exit ${r.status}). Run manually: cd ${extDir} && npm rebuild ${pkg}`);
                }
              }
            }
            if (existsSync(defaultConfigPath)) {
              try {
                const raw = readFileSync(defaultConfigPath, "utf-8");
                const fixConfig = JSON.parse(raw) as Record<string, unknown>;
                let changed = false;
                if (!fixConfig.plugins || typeof fixConfig.plugins !== "object") fixConfig.plugins = {};
                const plugins = fixConfig.plugins as Record<string, unknown>;
                if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
                const entries = plugins.entries as Record<string, unknown>;
                if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = { enabled: true, config: {} };
                const mh = entries[PLUGIN_ID] as Record<string, unknown>;
                if (!mh.config || typeof mh.config !== "object") mh.config = {};
                const cfgFix = mh.config as Record<string, unknown>;
                if (!cfgFix.embedding || typeof cfgFix.embedding !== "object") cfgFix.embedding = {};
                const emb = cfgFix.embedding as Record<string, unknown>;
                const curKey = emb.apiKey;
                const placeholder = typeof curKey !== "string" || curKey.length < 10 || curKey === "YOUR_OPENAI_API_KEY" || curKey === "<OPENAI_API_KEY>";
                if (placeholder) {
                  emb.apiKey = "YOUR_OPENAI_API_KEY";
                  emb.model = emb.model || "text-embedding-3-small";
                  changed = true;
                  applied.push("Set embedding.apiKey and model (use your key or ${OPENAI_API_KEY} in config)");
                }
                const memoryDirPath = dirname(resolvedSqlitePath);
                if (!existsSync(memoryDirPath)) {
                  mkdirSync(memoryDirPath, { recursive: true });
                  applied.push("Created memory directory: " + memoryDirPath);
                }
                const cronDir = join(openclawDir, "cron");
                const cronStorePath = join(cronDir, "jobs.json");
                const PLUGIN_JOB_ID_PREFIX = "hybrid-mem:";
                const nightlyJob = {
                  pluginJobId: PLUGIN_JOB_ID_PREFIX + "nightly-distill",
                  name: "nightly-memory-sweep",
                  schedule: "0 2 * * *",
                  channel: "system",
                  message: "Check if distill is enabled (config distill.enabled !== false). If enabled, run nightly session distillation for last 3 days, then run openclaw hybrid-mem record-distill. Exit 0 if disabled.",
                  isolated: true,
                  model: "gemini",
                  enabled: true,
                };
                const weeklyJob = {
                  pluginJobId: PLUGIN_JOB_ID_PREFIX + "weekly-reflection",
                  name: "weekly-reflection",
                  schedule: "0 3 * * 0",
                  channel: "system",
                  message: "Check if reflection is enabled (config reflection.enabled !== false). If enabled, run: openclaw hybrid-mem reflect && openclaw hybrid-mem reflect-rules && openclaw hybrid-mem reflect-meta. Exit 0 if disabled.",
                  isolated: true,
                  model: "gemini",
                  enabled: true,
                };
                const weeklyExtractProceduresJob = {
                  pluginJobId: PLUGIN_JOB_ID_PREFIX + "weekly-extract-procedures",
                  name: "weekly-extract-procedures",
                  schedule: "0 4 * * 0",
                  channel: "system",
                  message: "Check if procedures are enabled (config procedures.enabled !== false). If enabled, run openclaw hybrid-mem extract-procedures --days 7. Exit 0 if disabled.",
                  isolated: true,
                  model: "gemini",
                  enabled: true,
                };
                const selfCorrectionJob = {
                  pluginJobId: PLUGIN_JOB_ID_PREFIX + "self-correction-analysis",
                  name: "self-correction-analysis",
                  schedule: "30 2 * * *",
                  channel: "system",
                  message: "Check if self-correction is enabled (config selfCorrection is truthy). If enabled, run openclaw hybrid-mem self-correction-run. Exit 0 if disabled.",
                  isolated: true,
                  model: "sonnet",
                  enabled: true,
                };
                const weeklyDeepMaintenanceJob = {
                  pluginJobId: PLUGIN_JOB_ID_PREFIX + "weekly-deep-maintenance",
                  name: "weekly-deep-maintenance",
                  schedule: "0 4 * * 6",
                  channel: "system",
                  message: "Weekly deep maintenance: run extract-procedures, extract-directives, extract-reinforcement, self-correction-run, scope promote, compact. Check feature configs before each step. Exit 0 if all disabled.",
                  isolated: true,
                  model: "sonnet",
                  enabled: true,
                };
                const monthlyConsolidationJob = {
                  pluginJobId: PLUGIN_JOB_ID_PREFIX + "monthly-consolidation",
                  name: "monthly-consolidation",
                  schedule: "0 5 1 * *",
                  channel: "system",
                  message: "Monthly consolidation: run consolidate, build-languages, generate-auto-skills, backfill-decay. Check feature configs before each step. Exit 0 if all disabled.",
                  isolated: true,
                  model: "sonnet",
                  enabled: true,
                };
                const definedJobs = [nightlyJob, weeklyJob, weeklyExtractProceduresJob, selfCorrectionJob, weeklyDeepMaintenanceJob, monthlyConsolidationJob] as Array<Record<string, unknown>>;
                const legacyNameMatch: Record<string, (j: Record<string, unknown>) => boolean> = {
                  [PLUGIN_JOB_ID_PREFIX + "nightly-distill"]: (j) => String(j.name ?? "").toLowerCase().includes("nightly-memory-sweep"),
                  [PLUGIN_JOB_ID_PREFIX + "weekly-reflection"]: (j) => /weekly-reflection|memory reflection|pattern synthesis/.test(String(j.name ?? "")),
                  [PLUGIN_JOB_ID_PREFIX + "weekly-extract-procedures"]: (j) => /extract-procedures|weekly-extract-procedures|procedural memory/i.test(String(j.name ?? "")),
                  [PLUGIN_JOB_ID_PREFIX + "self-correction-analysis"]: (j) => /self-correction-analysis|self-correction\b/i.test(String(j.name ?? "")),
                  [PLUGIN_JOB_ID_PREFIX + "weekly-deep-maintenance"]: (j) => /weekly-deep-maintenance|deep maintenance/i.test(String(j.name ?? "")),
                  [PLUGIN_JOB_ID_PREFIX + "monthly-consolidation"]: (j) => /monthly-consolidation/i.test(String(j.name ?? "")),
                };
                try {
                  mkdirSync(cronDir, { recursive: true });
                  let store: { jobs?: unknown[] } = {};
                  if (existsSync(cronStorePath)) {
                    store = JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] };
                  }
                  if (!Array.isArray(store.jobs)) store.jobs = [];
                  const jobs = store.jobs as Array<Record<string, unknown>>;
                  let jobsChanged = false;
                  for (const def of definedJobs) {
                    const id = def.pluginJobId as string;
                    const existing = jobs.find((j) => j && (j.pluginJobId === id || legacyNameMatch[id]?.(j)));
                    if (existing) {
                      if (opts.fix && existing.enabled === false) {
                        existing.enabled = true;
                        jobsChanged = true;
                        applied.push(`Re-enabled job ${def.name} (${id})`);
                      }
                      if (!existing.pluginJobId) {
                        existing.pluginJobId = id;
                        jobsChanged = true;
                      }
                    } else {
                      jobs.push({ ...def });
                      jobsChanged = true;
                      applied.push(`Added ${def.name} job to ${cronStorePath}`);
                    }
                  }
                  if (jobsChanged) {
                    writeFileSync(cronStorePath, JSON.stringify(store, null, 2), "utf-8");
                  }
                } catch (e) {
                  log("Could not add optional jobs to cron store: " + String(e));
                }
                // Also add missing jobs to openclaw.json so schedulers that read from there see them
                try {
                  let rootJobs = fixConfig.jobs;
                  if (!Array.isArray(rootJobs)) rootJobs = [];
                  fixConfig.jobs = rootJobs;
                  const arr = rootJobs as Array<Record<string, unknown>>;
                  const legacyNameMatch: Record<string, (j: Record<string, unknown>) => boolean> = {
                    [PLUGIN_JOB_ID_PREFIX + "nightly-distill"]: (j) => String(j.name).toLowerCase().includes("nightly-memory-sweep"),
                    [PLUGIN_JOB_ID_PREFIX + "weekly-reflection"]: (j) => /weekly-reflection|memory reflection|pattern synthesis/.test(String(j.name ?? "")),
                    [PLUGIN_JOB_ID_PREFIX + "weekly-extract-procedures"]: (j) => /extract-procedures|weekly-extract-procedures|procedural memory/i.test(String(j.name ?? "")),
                    [PLUGIN_JOB_ID_PREFIX + "self-correction-analysis"]: (j) => /self-correction-analysis|self-correction\b/i.test(String(j.name ?? "")),
                    [PLUGIN_JOB_ID_PREFIX + "weekly-deep-maintenance"]: (j) => /weekly-deep-maintenance|deep maintenance/i.test(String(j.name ?? "")),
                    [PLUGIN_JOB_ID_PREFIX + "monthly-consolidation"]: (j) => /monthly-consolidation/i.test(String(j.name ?? "")),
                  };
                  for (const def of definedJobs) {
                    const id = def.pluginJobId as string;
                    const existing = arr.find((j) => j && (j.pluginJobId === id || legacyNameMatch[id]?.(j)));
                    if (existing) {
                      if (opts.fix && existing.enabled === false) {
                        existing.enabled = true;
                        changed = true;
                        applied.push(`Re-enabled job ${def.name} (${id}) in ${defaultConfigPath}`);
                      }
                      if (!existing.pluginJobId) {
                        existing.pluginJobId = id;
                        changed = true;
                      }
                    } else {
                      arr.push({ ...def });
                      changed = true;
                      applied.push("Added " + (def.name as string) + " job to " + defaultConfigPath);
                    }
                  }
                } catch (e) {
                  log("Could not add optional jobs to openclaw.json: " + String(e));
                }
                if (changed) {
                  writeFileSync(defaultConfigPath, JSON.stringify(fixConfig, null, 2), "utf-8");
                }
                if (applied.length > 0) {
                  log("\n--- Applied fixes ---");
                  applied.forEach((a) => log("  • " + a));
                  if (changed) log("Config written: " + defaultConfigPath + ". Restart the gateway and run verify again.");
                }
              } catch (e) {
                log("\nCould not apply fixes to config: " + String(e));
                const snippet = {
                  embedding: { apiKey: "<set your key or use ${OPENAI_API_KEY}>", model: "text-embedding-3-small" },
                  autoCapture: true,
                  autoRecall: true,
                  captureMaxChars: 5000,
                  store: { fuzzyDedupe: false },
                };
                log(`Minimal config snippet to merge into plugins.entries["${PLUGIN_ID}"].config:`);
                log(JSON.stringify(snippet, null, 2));
              }
            } else {
              log("\n--- Fix (--fix) ---");
              log("Config file not found. Run 'openclaw hybrid-mem install' to create it with full defaults, then set your API key and restart.");
            }
          }
        }

        const FULL_DISTILL_MAX_DAYS = 90;
        const INCREMENTAL_MIN_DAYS = 3;

        function runDistillWindowForCli(_opts: { json: boolean }): DistillWindowResult {
          const memoryDir = dirname(resolvedSqlitePath);
          const distillLastRunPath = join(memoryDir, ".distill_last_run");
          const now = new Date();
          const today = now.toISOString().slice(0, 10);
          let mode: "full" | "incremental";
          let startDate: string;
          const endDate = today;
          let mtimeDays: number;
          if (!existsSync(distillLastRunPath)) {
            mode = "full";
            const start = new Date(now);
            start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
            startDate = start.toISOString().slice(0, 10);
            mtimeDays = FULL_DISTILL_MAX_DAYS;
          } else {
            try {
              const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
              if (!line) {
                mode = "full";
                const start = new Date(now);
                start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
                startDate = start.toISOString().slice(0, 10);
                mtimeDays = FULL_DISTILL_MAX_DAYS;
              } else {
                const lastRun = new Date(line);
                if (Number.isNaN(lastRun.getTime())) {
                  mode = "full";
                  const start = new Date(now);
                  start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
                  startDate = start.toISOString().slice(0, 10);
                  mtimeDays = FULL_DISTILL_MAX_DAYS;
                } else {
                  mode = "incremental";
                  const lastRunDate = lastRun.toISOString().slice(0, 10);
                  const threeDaysAgo = new Date(now);
                  threeDaysAgo.setDate(threeDaysAgo.getDate() - INCREMENTAL_MIN_DAYS);
                  const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);
                  startDate = lastRunDate < threeDaysAgoStr ? lastRunDate : threeDaysAgoStr;
                  const start = new Date(startDate);
                  mtimeDays = Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
                  if (mtimeDays < 1) mtimeDays = 1;
                }
              }
            } catch {
              mode = "full";
              const start = new Date(now);
              start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
              startDate = start.toISOString().slice(0, 10);
              mtimeDays = FULL_DISTILL_MAX_DAYS;
            }
          }
          return { mode, startDate, endDate, mtimeDays };
        }

        function runRecordDistillForCli(): RecordDistillResult {
          const memoryDir = dirname(resolvedSqlitePath);
          mkdirSync(memoryDir, { recursive: true });
          const path = join(memoryDir, ".distill_last_run");
          const ts = new Date().toISOString();
          writeFileSync(path, ts + "\n", "utf-8");
          return { path, timestamp: ts };
        }

        /** Returns session .jsonl file paths modified within the last `days` days. Shared by procedure/directive/reinforcement extraction. */
        async function getSessionFilePathsSince(sessionDir: string, days: number): Promise<string[]> {
          const fs = await import("node:fs");
          const pathMod = await import("node:path");
          if (!fs.existsSync(sessionDir)) return [];
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
          const files = fs.readdirSync(sessionDir);
          return files
            .filter((f) => f.endsWith(".jsonl") && !f.startsWith(".deleted"))
            .map((f) => pathMod.join(sessionDir, f))
            .filter((p) => {
              try {
                return fs.statSync(p).mtimeMs >= cutoff;
              } catch {
                return false;
              }
            });
        }

        async function runExtractProceduresForCli(
          opts: { sessionDir?: string; days?: number; dryRun: boolean },
        ): Promise<ExtractProceduresResult> {
          if (cfg.procedures?.enabled === false) {
            return { sessionsScanned: 0, proceduresStored: 0, positiveCount: 0, negativeCount: 0, dryRun: opts.dryRun };
          }
          const sessionDir = opts.sessionDir ?? cfg.procedures.sessionsDir;
          let filePaths: string[] | undefined;
          if (opts.days != null && opts.days > 0) {
            filePaths = await getSessionFilePathsSince(sessionDir, opts.days);
          }
          return extractProceduresFromSessions(
            factsDb,
            {
              sessionDir: filePaths ? undefined : sessionDir,
              filePaths,
              minSteps: cfg.procedures.minSteps,
              dryRun: opts.dryRun,
            },
            { info: (s) => api.logger.info?.(s) ?? console.log(s), warn: (s) => api.logger.warn?.(s) ?? console.warn(s) },
          );
        }

        async function runGenerateAutoSkillsForCli(
          opts: { dryRun: boolean },
        ): Promise<GenerateAutoSkillsResult> {
          return generateAutoSkills(
            factsDb,
            {
              skillsAutoPath: cfg.procedures.skillsAutoPath,
              validationThreshold: cfg.procedures.validationThreshold,
              skillTTLDays: cfg.procedures.skillTTLDays,
              dryRun: opts.dryRun,
            },
            { info: (s) => api.logger.info?.(s) ?? console.log(s), warn: (s) => api.logger.warn?.(s) ?? console.warn(s) },
          );
        }

        async function runExtractDirectivesForCli(
          opts: { days?: number; verbose?: boolean; dryRun?: boolean },
        ): Promise<DirectiveExtractResult> {
          const sessionDir = cfg.procedures.sessionsDir;
          const days = opts.days ?? 3;
          const filePaths = await getSessionFilePathsSince(sessionDir, days);

          const directiveRegex = getDirectiveSignalRegex();
          const result = runDirectiveExtract({ filePaths, directiveRegex });
          
          if (opts.verbose) {
            for (const incident of result.incidents) {
              console.log(`[${incident.sessionFile}] ${incident.categories.join(", ")}: ${incident.extractedRule}`);
            }
          }
          
          // Store directives as facts if not dry-run
          if (!opts.dryRun) {
            for (const incident of result.incidents) {
              const category = incident.categories.includes("preference") ? "preference" : 
                              incident.categories.includes("absolute_rule") ? "rule" :
                              incident.categories.includes("conditional_rule") ? "rule" :
                              incident.categories.includes("warning") ? "rule" :
                              incident.categories.includes("future_behavior") ? "rule" :
                              incident.categories.includes("procedural") ? "pattern" :
                              incident.categories.includes("correction") ? "decision" :
                              incident.categories.includes("implicit_correction") ? "decision" :
                              incident.categories.includes("explicit_memory") ? "fact" : "other";
              factsDb.store({
                text: incident.extractedRule,
                category: category as MemoryCategory,
                importance: 0.8,
                entity: null,
                key: null,
                value: null,
                source: `directive:${incident.sessionFile}`,
                confidence: incident.confidence,
              });
            }
          }
          
          return result;
        }

        async function runExtractReinforcementForCli(
          opts: { days?: number; verbose?: boolean; dryRun?: boolean },
        ): Promise<ReinforcementExtractResult> {
          const sessionDir = cfg.procedures.sessionsDir;
          const days = opts.days ?? 3;
          const filePaths = await getSessionFilePathsSince(sessionDir, days);

          const reinforcementRegex = getReinforcementSignalRegex();
          const result = runReinforcementExtract({ filePaths, reinforcementRegex });
          
          if (opts.verbose) {
            for (const incident of result.incidents) {
              console.log(`[${incident.sessionFile}] Confidence ${incident.confidence.toFixed(2)}: ${incident.userMessage.slice(0, 80)}`);
            }
          }
          
          // Annotate facts/procedures with reinforcement if not dry-run
          if (!opts.dryRun) {
            for (const incident of result.incidents) {
              // Reinforce recalled memories
              for (const memId of incident.recalledMemoryIds) {
                factsDb.reinforceFact(memId, incident.userMessage);
              }
              
              // Reinforce procedures based on tool call sequence
              if (incident.toolCallSequence.length >= 2) {
                const taskPattern = incident.toolCallSequence.join(" -> ");
                const procedures = factsDb.searchProcedures(taskPattern, 3, cfg.distill?.reinforcementProcedureBoost ?? 0.1);
                for (const proc of procedures) {
                  factsDb.reinforceProcedure(proc.id, incident.userMessage, cfg.distill?.reinforcementPromotionThreshold ?? 2);
                }
              }
            }
          }
          
          return result;
        }

        async function runExtractDailyForCli(
          opts: { days: number; dryRun: boolean },
          sink: ExtractDailySink,
        ): Promise<ExtractDailyResult> {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const { homedir: getHomedir } = await import("node:os");
          const memoryDir = path.join(getHomedir(), ".openclaw", "memory");
          const daysBack = opts.days;
          let totalExtracted = 0;
          let totalStored = 0;
          for (let d = 0; d < daysBack; d++) {
            const date = new Date();
            date.setDate(date.getDate() - d);
            const dateStr = date.toISOString().split("T")[0];
            const filePath = path.join(memoryDir, `${dateStr}.md`);
            if (!fs.existsSync(filePath)) continue;
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split("\n").filter((l: string) => l.trim().length > 10);
            sink.log(`\nScanning ${dateStr} (${lines.length} lines)...`);
            for (const line of lines) {
              const trimmed = line.replace(/^[-*#>\s]+/, "").trim();
              if (trimmed.length < 15 || trimmed.length > 500) continue;
              const category = detectCategory(trimmed);
              const extracted = extractStructuredFields(trimmed, category);
              if (isCredentialLike(trimmed, extracted.entity, extracted.key, extracted.value)) {
                if (cfg.credentials.enabled && credentialsDb) {
                  const parsed = tryParseCredentialForVault(trimmed, extracted.entity, extracted.key, extracted.value);
                  if (parsed) {
                    if (!opts.dryRun) {
                      credentialsDb.store({
                        service: parsed.service,
                        type: parsed.type,
                        value: parsed.secretValue,
                        url: parsed.url,
                        notes: parsed.notes,
                      });
                      const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
                      const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
                      const pointerEntry = factsDb.store({
                        text: pointerText,
                        category: "technical",
                        importance: BATCH_STORE_IMPORTANCE,
                        entity: "Credentials",
                        key: parsed.service,
                        value: VAULT_POINTER_PREFIX + parsed.service,
                        source: `daily-scan:${dateStr}`,
                        sourceDate: sourceDateSec,
                        tags: ["auth", ...extractTags(pointerText, "Credentials")],
                      });
                      try {
                        const vector = await embeddings.embed(pointerText);
                        if (!(await vectorDb.hasDuplicate(vector))) {
                          await vectorDb.store({ text: pointerText, vector, importance: BATCH_STORE_IMPORTANCE, category: "technical", id: pointerEntry.id });
                        }
                      } catch (err) {
                        sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                      }
                      totalStored++;
                    } else {
                      totalExtracted++;
                    }
                    continue;
                  }
                  continue;
                }
              }
              if (!extracted.entity && !extracted.key && category !== "decision") continue;
              totalExtracted++;
              if (opts.dryRun) {
                sink.log(
                  `  [${category}] ${extracted.entity || "?"} / ${extracted.key || "?"} = ${
                    extracted.value || trimmed.slice(0, 60)
                  }`,
                );
                continue;
              }
              if (factsDb.hasDuplicate(trimmed)) continue;
              const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
              const storePayload = {
                text: trimmed,
                category,
                importance: BATCH_STORE_IMPORTANCE,
                entity: extracted.entity,
                key: extracted.key,
                value: extracted.value,
                source: `daily-scan:${dateStr}` as const,
                sourceDate: sourceDateSec,
                tags: extractTags(trimmed, extracted.entity),
              };
              let vecForStore: number[] | undefined;
              if (cfg.store.classifyBeforeWrite) {
                try {
                  vecForStore = await embeddings.embed(trimmed);
                } catch (err) {
                  sink.warn(`memory-hybrid: extract-daily embedding failed: ${err}`);
                }
                if (vecForStore) {
                  let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vecForStore, 3);
                  if (similarFacts.length === 0) {
                    similarFacts = factsDb.findSimilarForClassification(trimmed, extracted.entity, extracted.key, 3);
                  }
                  if (similarFacts.length > 0) {
                    try {
                      const classification = await classifyMemoryOperation(
                        trimmed, extracted.entity, extracted.key, similarFacts,
                        openai, cfg.store.classifyModel ?? "gpt-4o-mini", sink,
                      );
                      if (classification.action === "NOOP") continue;
                      if (classification.action === "DELETE" && classification.targetId) {
                        factsDb.supersede(classification.targetId, null);
                        continue;
                      }
                      if (classification.action === "UPDATE" && classification.targetId) {
                        const oldFact = factsDb.getById(classification.targetId);
                        if (oldFact) {
                          const newEntry = factsDb.store({
                            ...storePayload,
                            entity: extracted.entity ?? oldFact.entity,
                            key: extracted.key ?? oldFact.key,
                            value: extracted.value ?? oldFact.value,
                            validFrom: sourceDateSec,
                            supersedesId: classification.targetId,
                          });
                          factsDb.supersede(classification.targetId, newEntry.id);
                          try {
                            if (!(await vectorDb.hasDuplicate(vecForStore))) {
                              await vectorDb.store({ text: trimmed, vector: vecForStore, importance: BATCH_STORE_IMPORTANCE, category, id: newEntry.id });
                            }
                          } catch (err) {
                            sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                          }
                          totalStored++;
                          continue;
                        }
                      }
                    } catch (err) {
                      sink.warn(`memory-hybrid: extract-daily classification failed: ${err}`);
                    }
                  }
                }
              }
              const entry = factsDb.store(storePayload);
              try {
                const vector = vecForStore ?? await embeddings.embed(trimmed);
                if (!(await vectorDb.hasDuplicate(vector))) {
                  await vectorDb.store({ text: trimmed, vector, importance: BATCH_STORE_IMPORTANCE, category, id: entry.id });
                }
              } catch (err) {
                sink.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
              }
              totalStored++;
            }
          }
          return { totalExtracted, totalStored, daysBack, dryRun: opts.dryRun };
        }

        function gatherBackfillFiles(workspaceRoot: string): Array<{ path: string; label: string }> {
          const memoryDir = join(workspaceRoot, "memory");
          const memoryMd = join(workspaceRoot, "MEMORY.md");
          const out: Array<{ path: string; label: string }> = [];
          if (existsSync(memoryMd)) out.push({ path: memoryMd, label: "MEMORY.md" });
          if (!existsSync(memoryDir)) return out;
          function walk(dir: string, rel = "memory"): void {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              const full = join(dir, e.name);
              const relPath = join(rel, e.name);
              if (e.isDirectory()) {
                try { walk(full, relPath); } catch { /* ignore */ }
              } else if (e.name.endsWith(".md")) out.push({ path: full, label: relPath });
            }
          }
          walk(memoryDir);
          return out;
        }

        function extractBackfillFact(line: string): { text: string; category: string; entity: string | null; key: string | null; value: string; source_date: string | null } | null {
          let t = line.replace(/^[-*#>\s]+/, "").trim();
          const datePrefix = /^\[(\d{4}-\d{2}-\d{2})\]\s*/;
          let source_date: string | null = null;
          const match = t.match(datePrefix);
          if (match) {
            source_date = match[1];
            t = t.slice(match[0].length).trim();
          }
          if (t.length < 10 || t.length > 500) return null;
          const lower = t.toLowerCase();
          if (/\b(api[_-]?key|password|secret|token)\s*[:=]/i.test(t)) return null;
          if (/^(see\s|---|```|\s*$)/.test(t) || t.split(/\s+/).length < 2) return null;

          let entity: string | null = null;
          let key: string | null = null;
          let value: string;
          let category = "other";

          const decisionMatch = t.match(
            /(?:decided|chose|picked|went with)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for)\s+(.+?))?\.?$/i
          );
          const decisionMatchSv = t.match(
            /(?:bestämde|valde)\s+(?:att\s+(?:använda\s+)?)?(.+?)(?:\s+(?:eftersom|för att)\s+(.+?))?\.?$/i
          );
          if (decisionMatch) {
            entity = "decision";
            key = decisionMatch[1].trim().slice(0, 100);
            value = (decisionMatch[2] || "no rationale").trim();
            category = "decision";
          } else if (decisionMatchSv) {
            entity = "decision";
            key = decisionMatchSv[1].trim().slice(0, 100);
            value = (decisionMatchSv[2] || "no rationale").trim();
            category = "decision";
          } else {
            const ruleMatch = t.match(/(?:always|never|alltid|aldrig)\s+(.+?)\.?$/i);
            if (ruleMatch) {
              entity = "convention";
              key = ruleMatch[1].trim().slice(0, 100);
              value = lower.includes("never") || lower.includes("aldrig") ? "never" : "always";
              category = "preference";
            } else {
              const possessiveMatch = t.match(
                /(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/
              );
              const possessiveMatchSv = t.match(/(?:mitt|min)\s+(\S+)\s+är\s+(.+?)\.?$/i);
              if (possessiveMatch) {
                entity = possessiveMatch[1] || "user";
                key = possessiveMatch[2].trim();
                value = possessiveMatch[3].trim();
                category = "fact";
              } else if (possessiveMatchSv) {
                entity = "user";
                key = possessiveMatchSv[1].trim();
                value = possessiveMatchSv[2].trim();
                category = "fact";
              } else {
                const preferMatch = t.match(
                  /[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/
                );
                const preferMatchSv = t.match(/jag\s+(föredrar|gillar|ogillar|vill ha|behöver)\s+(.+?)\.?$/i);
                if (preferMatch) {
                  entity = "user";
                  key = preferMatch[1];
                  value = preferMatch[2].trim();
                  category = "preference";
                } else if (preferMatchSv) {
                  entity = "user";
                  key = preferMatchSv[1];
                  value = preferMatchSv[2].trim();
                  category = "preference";
                } else {
                  const templateResult = tryExtractionFromTemplates(getExtractionTemplates(), t);
                  if (templateResult && templateResult.entity && templateResult.value) {
                    entity = templateResult.entity;
                    key = templateResult.key;
                    value = templateResult.value;
                    if (entity === "decision") category = "decision";
                    else if (entity === "convention") category = "preference";
                    else if (entity === "user" && key) category = "preference";
                    else category = "fact";
                  } else {
                    value = t.slice(0, 200);
                  }
                }
              }
            }
          }
          return { text: t, category, entity, key, value, source_date };
        }

        async function runBackfillForCli(
          opts: { dryRun: boolean; workspace?: string; limit?: number },
          sink: BackfillCliSink,
        ): Promise<BackfillCliResult> {
          const workspaceRoot = opts.workspace ?? process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
          const files = gatherBackfillFiles(workspaceRoot);
          if (files.length === 0) {
            sink.log(`No MEMORY.md or memory/**/*.md under ${workspaceRoot}`);
            return { stored: 0, skipped: 0, candidates: 0, files: 0, dryRun: opts.dryRun };
          }
          const allCandidates: Array<{ text: string; category: string; entity: string | null; key: string | null; value: string; source_date: string | null; source: string }> = [];
          for (const { path: filePath, label } of files) {
            const content = readFileSync(filePath, "utf-8");
            const lines = content.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) continue;
              const fact = extractBackfillFact(trimmed);
              if (fact) allCandidates.push({ ...fact, source: label });
            }
          }
          if (opts.dryRun) {
            sink.log(`Would process ${allCandidates.length} facts from ${files.length} files under ${workspaceRoot}`);
            return { stored: 0, skipped: 0, candidates: allCandidates.length, files: files.length, dryRun: true };
          }
          const limit = opts.limit ?? 0;
          let stored = 0;
          let skipped = 0;
          const totalCandidates = limit > 0 ? Math.min(allCandidates.length, limit) : allCandidates.length;
          const progress = createProgressReporter(sink, totalCandidates, "Backfilling");
          const sourceDateSec = (s: string | null) => {
            if (!s || typeof s !== "string") return null;
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
            if (!m) return null;
            const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
            const sec = Math.floor(ms / 1000);
            return isNaN(sec) ? null : sec;
          };
          let processed = 0;
          for (const fact of allCandidates) {
            if (limit > 0 && stored >= limit) break;
            progress.update(processed + 1);
            if (factsDb.hasDuplicate(fact.text)) {
              skipped++;
              processed++;
              continue;
            }
            const entry = factsDb.store({
              text: fact.text,
              category: fact.category as MemoryCategory,
              importance: 0.8,
              entity: fact.entity,
              key: fact.key,
              value: fact.value,
              source: `backfill:${fact.source}`,
              sourceDate: sourceDateSec(fact.source_date),
            });
            try {
              const vector = await embeddings.embed(fact.text);
              if (!(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({
                  text: fact.text,
                  vector,
                  importance: 0.8,
                  category: fact.category,
                  id: entry.id,
                });
              }
            } catch (err) {
              sink.warn(`memory-hybrid: backfill vector store failed for "${fact.text.slice(0, 50)}...": ${err}`);
            }
            stored++;
            processed++;
          }
          progress.done();
          return { stored, skipped, candidates: allCandidates.length, files: files.length, dryRun: opts.dryRun };
        }

        const DEFAULT_INGEST_PATHS = ["skills/**/*.md", "TOOLS.md", "AGENTS.md"];
        const DISTILL_DEDUP_THRESHOLD = 0.85;

        async function runIngestFilesForCli(
          opts: { dryRun: boolean; workspace?: string; paths?: string[] },
          sink: IngestFilesSink,
        ): Promise<IngestFilesResult> {
          const workspaceRoot = opts.workspace ?? process.env.OPENCLAW_WORKSPACE ?? process.cwd();
          const ingestCfg = cfg.ingest;
          const patterns = opts.paths?.length
            ? opts.paths
            : ingestCfg?.paths?.length
              ? ingestCfg.paths
              : DEFAULT_INGEST_PATHS;
          const chunkSize = ingestCfg?.chunkSize ?? 800;
          const overlap = ingestCfg?.overlap ?? 100;

          const files = gatherIngestFiles(workspaceRoot, patterns);
          if (files.length === 0) {
            sink.log(`No markdown files found for patterns: ${patterns.join(", ")} under ${workspaceRoot}`);
            return { stored: 0, skipped: 0, extracted: 0, files: 0, dryRun: opts.dryRun };
          }

          const model = cfg.distill?.defaultModel ?? "gemini-3-pro-preview";
          const ingestPrompt = loadPrompt("ingest-files");
          const batches: string[] = [];
          let currentBatch = "";
          const batchTokenLimit = distillBatchTokenLimit(model);

          for (const fp of files) {
            const content = readFileSync(fp, "utf-8");
            if (!content.trim()) continue;
            const relPath = fp.startsWith(workspaceRoot) ? fp.slice(workspaceRoot.length).replace(/^\//, "") : basename(fp);
            const chunks = chunkTextByChars(content, chunkSize, overlap);
            for (let c = 0; c < chunks.length; c++) {
              const header =
                chunks.length === 1
                  ? `\n--- FILE: ${relPath} ---\n\n`
                  : `\n--- FILE: ${relPath} (chunk ${c + 1}/${chunks.length}) ---\n\n`;
              const block = header + chunks[c];
              const blockTokens = Math.ceil(block.length / 4);
              if (currentBatch.length > 0 && estimateTokens(currentBatch) + blockTokens > batchTokenLimit) {
                batches.push(currentBatch);
                currentBatch = block;
              } else {
                currentBatch += (currentBatch ? "\n" : "") + block;
              }
            }
          }
          if (currentBatch.trim()) batches.push(currentBatch);

          const allFacts: Array<{ category: string; text: string; entity?: string; key?: string; value?: string; tags?: string[] }> = [];
          for (let b = 0; b < batches.length; b++) {
            sink.log(`Processing batch ${b + 1}/${batches.length}...`);
            const userContent = ingestPrompt + "\n\n" + batches[b];
            try {
              const content = await chatComplete({
                model,
                content: userContent,
                temperature: 0.2,
                maxTokens: distillMaxOutputTokens(model),
                openai,
                geminiApiKey: cfg.distill?.apiKey,
              });
              const lines = content.split("\n").filter((l) => l.trim());
              for (const line of lines) {
                const jsonMatch = line.match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                try {
                  const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
                  const category = String(obj.category || "technical").toLowerCase();
                  const text = String(obj.text || "").trim();
                  if (!text || text.length < 10) continue;
                  const entity = typeof obj.entity === "string" ? obj.entity : null;
                  const key = typeof obj.key === "string" ? obj.key : null;
                  const value = typeof obj.value === "string" ? obj.value : (entity && key ? text.slice(0, 200) : "");
                  const tags = Array.isArray(obj.tags) ? (obj.tags as string[]).filter((t) => typeof t === "string") : [];
                  allFacts.push({
                    category: isValidCategory(category) ? category : "technical",
                    text,
                    entity: entity ?? undefined,
                    key: key ?? undefined,
                    value,
                    tags: [...tags, "ingest"],
                  });
                } catch { /* skip malformed JSON */ }
              }
            } catch (err) {
              sink.warn(`memory-hybrid: ingest-files LLM batch ${b + 1} failed: ${err}`);
            }
          }

          if (opts.dryRun) {
            sink.log(`Would extract ${allFacts.length} facts from ${files.length} files`);
            return { stored: 0, skipped: 0, extracted: allFacts.length, files: files.length, dryRun: true };
          }

          let stored = 0;
          let skipped = 0;
          for (const fact of allFacts) {
            if (factsDb.hasDuplicate(fact.text)) {
              skipped++;
              continue;
            }
            try {
              const vector = await embeddings.embed(fact.text);
              if (await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD)) {
                skipped++;
                continue;
              }
              const entry = factsDb.store({
                text: fact.text,
                category: (isValidCategory(fact.category) ? fact.category : "technical") as MemoryCategory,
                importance: BATCH_STORE_IMPORTANCE,
                entity: fact.entity ?? null,
                key: fact.key ?? null,
                value: fact.value ?? fact.text.slice(0, 200),
                source: "ingest",
                decayClass: "stable",
                tags: fact.tags,
              });
              await vectorDb.store({
                text: fact.text,
                vector,
                importance: BATCH_STORE_IMPORTANCE,
                category: fact.category,
                id: entry.id,
              });
              stored++;
            } catch (err) {
              sink.warn(`memory-hybrid: ingest-files store failed for "${fact.text.slice(0, 40)}...": ${err}`);
            }
          }
          return { stored, skipped, extracted: allFacts.length, files: files.length, dryRun: false };
        }

        function gatherSessionFiles(opts: { all?: boolean; days?: number; since?: string }): Array<{ path: string; mtime: number }> {
          const openclawDir = join(homedir(), ".openclaw");
          const agentsDir = join(openclawDir, "agents");
          if (!existsSync(agentsDir)) return [];
          const cutoffMs =
            opts.since
              ? new Date(opts.since).getTime()
              : Date.now() - (opts.all ? 90 : (opts.days ?? 3)) * 24 * 60 * 60 * 1000;
          const out: Array<{ path: string; mtime: number }> = [];
          for (const agentName of readdirSync(agentsDir, { withFileTypes: true })) {
            if (!agentName.isDirectory()) continue;
            const sessionsDir = join(agentsDir, agentName.name, "sessions");
            if (!existsSync(sessionsDir)) continue;
            for (const f of readdirSync(sessionsDir, { withFileTypes: true })) {
              if (!f.isFile() || !f.name.endsWith(".jsonl") || f.name.startsWith(".deleted.")) continue;
              const fp = join(sessionsDir, f.name);
              try {
                const stat = statSync(fp);
                if (stat.mtimeMs >= cutoffMs) out.push({ path: fp, mtime: stat.mtimeMs });
              } catch { /* ignore */ }
            }
          }
          out.sort((a, b) => a.mtime - b.mtime);
          return out;
        }

        function extractTextFromSessionJsonl(filePath: string): string {
          const lines = readFileSync(filePath, "utf-8").split("\n");
          const parts: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const obj = JSON.parse(trimmed) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
              if (obj.type !== "message" || !obj.message) continue;
              const msg = obj.message;
              if (msg.role !== "user" && msg.role !== "assistant") continue;
              const content = msg.content;
              if (!Array.isArray(content)) continue;
              for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
                  parts.push(block.text.trim());
                }
              }
            } catch { /* skip malformed lines */ }
          }
          return parts.join("\n\n");
        }

        async function runDistillForCli(
          opts: { dryRun: boolean; all?: boolean; days?: number; since?: string; model?: string; verbose?: boolean; maxSessions?: number; maxSessionTokens?: number },
          sink: DistillCliSink,
        ): Promise<DistillCliResult> {
          // Feature-gating: exit 0 if distill is disabled
          if (cfg.distill?.enabled === false) {
            return { sessionsScanned: 0, factsExtracted: 0, stored: 0, skipped: 0, dryRun: opts.dryRun };
          }
          const sessionFiles = gatherSessionFiles({
            all: opts.all,
            days: opts.days ?? (opts.all ? 90 : 3),
            since: opts.since,
          });
          const maxSessions = opts.maxSessions ?? 0;
          const filesToProcess = maxSessions > 0 ? sessionFiles.slice(0, maxSessions) : sessionFiles;
          if (filesToProcess.length === 0) {
            sink.log("No session files found under ~/.openclaw/agents/*/sessions/");
            return { sessionsScanned: 0, factsExtracted: 0, stored: 0, skipped: 0, dryRun: opts.dryRun };
          }
          const model = opts.model ?? cfg.distill?.defaultModel ?? "gemini-3-pro-preview";
          const batches: string[] = [];
          let currentBatch = "";
          const batchTokenLimit = distillBatchTokenLimit(model);
          const maxSessionTokens = opts.maxSessionTokens ?? batchTokenLimit;
          for (let i = 0; i < filesToProcess.length; i++) {
            const { path: fp } = filesToProcess[i];
            const text = extractTextFromSessionJsonl(fp);
            if (!text.trim()) continue;
            const chunks = chunkSessionText(text, maxSessionTokens);
            for (let c = 0; c < chunks.length; c++) {
              const header =
                chunks.length === 1
                  ? `\n--- SESSION: ${basename(fp)} ---\n\n`
                  : `\n--- SESSION: ${basename(fp)} (chunk ${c + 1}/${chunks.length}) ---\n\n`;
              const block = header + chunks[c];
              const blockTokens = Math.ceil(block.length / 4);
              if (currentBatch.length > 0 && (estimateTokens(currentBatch) + blockTokens > batchTokenLimit)) {
                batches.push(currentBatch);
                currentBatch = block;
              } else {
                currentBatch += (currentBatch ? "\n" : "") + block;
              }
            }
          }
          if (currentBatch.trim()) batches.push(currentBatch);
          const distillPrompt = loadPrompt("distill-sessions");
          const allFacts: Array<{ category: string; text: string; entity?: string; key?: string; value?: string; source_date?: string; tags?: string[] }> = [];
          const progress = createProgressReporter(sink, batches.length, "Distilling sessions");
          for (let b = 0; b < batches.length; b++) {
            progress.update(b + 1);
            const userContent = distillPrompt + "\n\n" + batches[b];
            try {
              const content = await chatComplete({
                model,
                content: userContent,
                temperature: 0.2,
                maxTokens: distillMaxOutputTokens(model),
                openai,
                geminiApiKey: cfg.distill?.apiKey,
              });
              const lines = content.split("\n").filter((l) => l.trim());
              for (const line of lines) {
                const jsonMatch = line.match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                try {
                  const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
                  const category = String(obj.category || "other").toLowerCase();
                  const text = String(obj.text || "").trim();
                  if (!text || text.length < 10) continue;
                  const entity = typeof obj.entity === "string" ? obj.entity : null;
                  const key = typeof obj.key === "string" ? obj.key : null;
                  const value = typeof obj.value === "string" ? obj.value : (entity && key ? text.slice(0, 200) : "");
                  const source_date = typeof obj.source_date === "string" ? obj.source_date : null;
                  const tags = Array.isArray(obj.tags) ? (obj.tags as string[]).filter((t) => typeof t === "string") : undefined;
                  allFacts.push({ category, text, entity: entity ?? undefined, key: key ?? undefined, value, source_date: source_date ?? undefined, tags });
                } catch { /* skip malformed JSON */ }
              }
            } catch (err) {
              sink.warn(`memory-hybrid: distill LLM batch ${b + 1} failed: ${err}`);
            }
          }
          progress.done();
          if (opts.dryRun) {
            sink.log(`Would extract ${allFacts.length} facts from ${filesToProcess.length} sessions`);
            return { sessionsScanned: filesToProcess.length, factsExtracted: allFacts.length, stored: 0, skipped: 0, dryRun: true };
          }
          const sourceDateSec = (s: string | null | undefined) => {
            if (!s || typeof s !== "string") return null;
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
            if (!m) return null;
            return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
          };
          let stored = 0;
          let skipped = 0;
          for (const fact of allFacts) {
            const isCred = fact.entity === "Credentials" || (fact.key && /^(api_key|token|password|secret)/i.test(fact.key));
            if (isCred && cfg.credentials.enabled && credentialsDb) {
              const parsed = tryParseCredentialForVault(fact.text, fact.entity ?? null, fact.key ?? null, fact.value);
              if (parsed) {
                if (!opts.dryRun) {
                  credentialsDb.store({ service: parsed.service, type: parsed.type, value: parsed.secretValue, url: parsed.url, notes: parsed.notes });
                  const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in vault.`;
                  const entry = factsDb.store({
                    text: pointerText,
                    category: "technical",
                    importance: BATCH_STORE_IMPORTANCE,
                    entity: "Credentials",
                    key: parsed.service,
                    value: VAULT_POINTER_PREFIX + parsed.service,
                    source: "distillation",
                    sourceDate: sourceDateSec(fact.source_date),
                  });
                  try {
                    const vector = await embeddings.embed(pointerText);
                    if (!(await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD))) {
                      await vectorDb.store({ text: pointerText, vector, importance: BATCH_STORE_IMPORTANCE, category: "technical", id: entry.id });
                    }
                  } catch { /* ignore */ }
                  stored++;
                  if (opts.verbose) sink.log(`  stored credential: ${parsed.service}`);
                }
                continue;
              }
            }
            if (factsDb.hasDuplicate(fact.text)) {
              skipped++;
              continue;
            }
            try {
              const vector = await embeddings.embed(fact.text);
              if (await vectorDb.hasDuplicate(vector, DISTILL_DEDUP_THRESHOLD)) {
                skipped++;
                continue;
              }
              const entry = factsDb.store({
                text: fact.text,
                category: (isValidCategory(fact.category) ? fact.category : "other") as MemoryCategory,
                importance: BATCH_STORE_IMPORTANCE,
                entity: fact.entity ?? null,
                key: fact.key ?? null,
                value: fact.value ?? fact.text.slice(0, 200),
                source: "distillation",
                sourceDate: sourceDateSec(fact.source_date),
                tags: fact.tags?.length ? fact.tags : extractTags(fact.text, fact.entity ?? undefined),
              });
              await vectorDb.store({ text: fact.text, vector, importance: BATCH_STORE_IMPORTANCE, category: fact.category, id: entry.id });
              stored++;
              if (opts.verbose) sink.log(`  stored: [${fact.category}] ${fact.text.slice(0, 60)}...`);
            } catch (err) {
              sink.warn(`memory-hybrid: distill store failed for "${fact.text.slice(0, 40)}...": ${err}`);
            }
          }
          runRecordDistillForCli();
          return { sessionsScanned: filesToProcess.length, factsExtracted: allFacts.length, stored, skipped, dryRun: false };
        }

        async function runMigrateToVaultForCli(): Promise<MigrateToVaultResult | null> {
          if (!credentialsDb) return null;
          const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
          return migrateCredentialsToVault({
            factsDb,
            vectorDb,
            embeddings,
            credentialsDb,
            migrationFlagPath,
            markDone: true,
          });
        }

        const SELF_CORRECTION_CAP = 5;

        function runSelfCorrectionExtractForCli(opts: {
          days?: number;
          outputPath?: string;
        }): SelfCorrectionExtractResult {
          const sessionFiles = gatherSessionFiles({
            days: opts.days ?? 3,
          });
          const filePaths = sessionFiles.map((f) => f.path);
          if (filePaths.length === 0) {
            return { incidents: [], sessionsScanned: 0 };
          }
          const result = runSelfCorrectionExtract({
            filePaths,
            correctionRegex: getCorrectionSignalRegex(),
          });
          if (opts.outputPath && result.incidents.length > 0) {
            try {
              mkdirSync(dirname(opts.outputPath), { recursive: true });
              writeFileSync(opts.outputPath, JSON.stringify(result.incidents, null, 2), "utf-8");
            } catch (e) {
              api.logger.warn?.(`memory-hybrid: could not write self-correction extract: ${e}`);
            }
          }
          return result;
        }

        type SelfCorrectionRunResult = {
          incidentsFound: number;
          analysed: number;
          autoFixed: number;
          proposals: string[];
          reportPath: string | null;
          toolsSuggestions?: string[];
          toolsApplied?: number;
          error?: string;
        };

        const DEFAULT_SELF_CORRECTION = {
          semanticDedup: true,
          semanticDedupThreshold: 0.92,
          toolsSection: "Self-correction rules",
          applyToolsByDefault: true,
          autoRewriteTools: false,
          analyzeViaSpawn: false,
          spawnThreshold: 15,
          spawnModel: "gemini",
        } as const;

        async function runSelfCorrectionRunForCli(opts: {
          extractPath?: string;
          incidents?: CorrectionIncident[];
          workspace?: string;
          dryRun?: boolean;
          model?: string;
          approve?: boolean;
          noApplyTools?: boolean;
        }): Promise<SelfCorrectionRunResult> {
          if (!cfg.selfCorrection) {
            return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath: null };
          }
          const workspaceRoot = opts.workspace ?? process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
          const scCfg = cfg.selfCorrection ?? DEFAULT_SELF_CORRECTION;
          const reportDir = join(workspaceRoot, "memory", "reports");
          const today = new Date().toISOString().slice(0, 10);
          const reportPath = join(reportDir, `self-correction-${today}.md`);
          let incidents: CorrectionIncident[];
          if (opts.incidents && opts.incidents.length > 0) {
            incidents = opts.incidents;
          } else if (opts.extractPath) {
            try {
              const raw = readFileSync(opts.extractPath, "utf-8");
              incidents = JSON.parse(raw) as CorrectionIncident[];
            } catch (e) {
              return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath: null, error: String(e) };
            }
          } else {
            const extractResult = runSelfCorrectionExtractForCli({ days: 3 });
            incidents = extractResult.incidents;
          }
          if (incidents.length === 0) {
            const emptyReport = `# Self-Correction Analysis (${today})\n\nScanned sessions: 3 days.\nIncidents found: 0.\n`;
            try {
              mkdirSync(reportDir, { recursive: true });
              writeFileSync(reportPath, emptyReport, "utf-8");
            } catch { /* ignore */ }
            return { incidentsFound: 0, analysed: 0, autoFixed: 0, proposals: [], reportPath };
          }
          const prompt = fillPrompt(loadPrompt("self-correction-analyze"), {
            incidents_json: JSON.stringify(incidents),
          });
          const model = opts.model ?? cfg.distill?.defaultModel ?? "gemini-3-pro-preview";
          let analysed: Array<{
            category: string;
            severity: string;
            remediationType: string;
            remediationContent: string | { text?: string; entity?: string; key?: string; tags?: string[] };
            repeated?: boolean;
          }> = [];
          const useSpawn = scCfg.analyzeViaSpawn && incidents.length > scCfg.spawnThreshold;
          try {
            let content: string;
            if (useSpawn) {
              const { spawnSync } = await import("node:child_process");
              const { tmpdir: osTmp } = await import("node:os");
              const promptPath = join(osTmp(), `self-correction-prompt-${Date.now()}.txt`);
              writeFileSync(promptPath, prompt, "utf-8");
              const spawnModel = scCfg.spawnModel ?? "gemini";
              const r = spawnSync(
                "openclaw",
                ["sessions", "spawn", "--model", spawnModel, "--message", "Analyze the attached incidents and output ONLY a JSON array (no markdown, no code fences). Use the instructions in the attached file.", "--attach", promptPath],
                { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
              );
              try {
                if (existsSync(promptPath)) rmSync(promptPath, { force: true });
              } catch { /* ignore */ }
              content = (r.stdout ?? "") + (r.stderr ?? "");
              if (r.status !== 0) throw new Error(`sessions spawn exited ${r.status}: ${content.slice(0, 500)}`);
            } else {
              content = await chatComplete({
                model,
                content: prompt,
                temperature: 0.2,
                maxTokens: distillMaxOutputTokens(model),
                openai,
                geminiApiKey: cfg.distill?.apiKey,
              });
            }
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              analysed = JSON.parse(jsonMatch[0]) as typeof analysed;
            }
          } catch (e) {
            return {
              incidentsFound: incidents.length,
              analysed: 0,
              autoFixed: 0,
              proposals: [],
              reportPath: null,
              error: String(e),
            };
          }
          const proposals: string[] = [];
          const toolsSuggestions: string[] = [];
          let autoFixed = 0;
          let toolsApplied = 0;
          const toApply = analysed.filter((a) => a.remediationType !== "NO_ACTION" && !a.repeated).slice(0, SELF_CORRECTION_CAP);
          const toolsPath = join(workspaceRoot, "TOOLS.md");
          const toolsSection = scCfg.toolsSection;
          const semanticThreshold = scCfg.semanticDedupThreshold ?? 0.92;

          for (const a of toApply) {
            if (a.remediationType === "MEMORY_STORE") {
              const c = a.remediationContent;
              const obj = typeof c === "object" && c && "text" in c ? c : { text: String(c), entity: "Fact", tags: [] as string[] };
              const text = (obj.text ?? "").trim();
              if (!text || factsDb.hasDuplicate(text)) continue;
              let vector: number[] | null = null;
              if (scCfg.semanticDedup || !opts.dryRun) {
                try {
                  vector = await embeddings.embed(text);
                  if (scCfg.semanticDedup && (await vectorDb.hasDuplicate(vector, semanticThreshold))) continue;
                } catch (err) {
                  api.logger.warn?.(`memory-hybrid: self-correction embed/semantic dedup failed: ${err}`);
                  continue;
                }
              }
              if (opts.dryRun) continue;
              try {
                const entry = factsDb.store({
                  text,
                  category: "technical",
                  importance: CLI_STORE_IMPORTANCE,
                  entity: obj.entity ?? null,
                  key: typeof obj.key === "string" ? obj.key : null,
                  value: text.slice(0, 200),
                  source: "self-correction",
                  tags: Array.isArray(obj.tags) ? obj.tags : [],
                });
                if (vector) await vectorDb.store({ text, vector, importance: CLI_STORE_IMPORTANCE, category: "technical", id: entry.id });
                autoFixed++;
              } catch (err) {
                api.logger.warn?.(`memory-hybrid: self-correction MEMORY_STORE failed: ${err}`);
              }
            } else if (a.remediationType === "TOOLS_RULE") {
              const line = typeof a.remediationContent === "string" ? a.remediationContent : (a.remediationContent as { text?: string })?.text ?? "";
              if (line.trim()) toolsSuggestions.push(line.trim());
            } else if (a.remediationType === "AGENTS_RULE" || a.remediationType === "SKILL_UPDATE") {
              const line = typeof a.remediationContent === "string" ? a.remediationContent : (a.remediationContent as { text?: string })?.text ?? "";
              if (line.trim()) proposals.push(`[${a.remediationType}] ${line.trim()}`);
            }
          }

          const shouldApplyTools = !opts.dryRun && (scCfg.applyToolsByDefault !== false || opts.approve) && !opts.noApplyTools;
          if (toolsSuggestions.length > 0 && !opts.dryRun) {
            if (scCfg.autoRewriteTools && existsSync(toolsPath)) {
              try {
                const currentTools = readFileSync(toolsPath, "utf-8");
                const rewritePrompt = fillPrompt(loadPrompt("self-correction-rewrite-tools"), {
                  current_tools: currentTools,
                  new_rules: toolsSuggestions.join("\n"),
                });
                const rewritten = await chatComplete({
                  model: opts.model ?? cfg.distill?.defaultModel ?? "gemini-3-pro-preview",
                  content: rewritePrompt,
                  temperature: 0.2,
                  maxTokens: 16000,
                  openai,
                  geminiApiKey: cfg.distill?.apiKey,
                });
                const cleaned = rewritten.trim().replace(/^```\w*\n?|```\s*$/g, "").trim();
                if (cleaned.length > 50) {
                  writeFileSync(toolsPath, cleaned, "utf-8");
                  toolsApplied = toolsSuggestions.length;
                  autoFixed += toolsApplied;
                }
              } catch (err) {
                api.logger.warn?.(`memory-hybrid: self-correction TOOLS rewrite failed: ${err}`);
              }
            } else if (shouldApplyTools && existsSync(toolsPath)) {
              const { inserted } = insertRulesUnderSection(toolsPath, toolsSection, toolsSuggestions);
              toolsApplied = inserted;
              autoFixed += inserted;
            }
          }

          const reportLines = [
            `# Self-Correction Analysis (${today})`,
            "",
            `Scanned: last 3 days. Incidents found: ${incidents.length}.`,
            `Analysed: ${analysed.length}. Auto-fixed: ${autoFixed}. Needs review: ${proposals.length}.`,
            "",
            ...(autoFixed > 0 ? ["## Auto-applied", "", `- ${autoFixed} memory store(s) and/or TOOLS.md rule(s).`, ""] : []),
            ...(toolsSuggestions.length > 0 && toolsApplied === 0 && !scCfg.autoRewriteTools
              ? [
                  "## Suggested TOOLS.md rules (not applied this run). To apply: config applyToolsByDefault is true by default, or use --approve. To skip applying: --no-apply-tools.",
                  "",
                  ...toolsSuggestions.map((s) => `- ${s}`),
                  "",
                ]
              : []),
            ...(toolsApplied > 0 ? ["## TOOLS.md updated", "", `- ${toolsApplied} rule(s) inserted under section \"${toolsSection}\".`, ""] : []),
            ...(proposals.length > 0 ? ["## Proposed (review before applying)", "", ...proposals.map((p) => `- ${p}`), ""] : []),
          ];
          try {
            mkdirSync(reportDir, { recursive: true });
            writeFileSync(reportPath, reportLines.join("\n"), "utf-8");
          } catch (e) {
            api.logger.warn?.(`memory-hybrid: could not write report: ${e}`);
          }
          return {
            incidentsFound: incidents.length,
            analysed: analysed.length,
            autoFixed,
            proposals,
            reportPath,
            toolsSuggestions: toolsSuggestions.length > 0 ? toolsSuggestions : undefined,
            toolsApplied: toolsApplied > 0 ? toolsApplied : undefined,
          };
        }

        async function runUpgradeForCli(requestedVersion?: string): Promise<UpgradeCliResult> {
          const extDir = dirname(fileURLToPath(import.meta.url));
          const { spawnSync } = await import("node:child_process");
          const version = requestedVersion?.trim() || "latest";
          try {
            rmSync(extDir, { recursive: true, force: true });
          } catch (e) {
            return {
              ok: false,
              error: `Could not remove plugin directory: ${e}. Use standalone installer: npx -y openclaw-hybrid-memory-install ${version}`,
            };
          }
          // Use standalone installer so upgrade works even when config is invalid (plugin missing).
          const npxArgs = ["-y", "openclaw-hybrid-memory-install", version];
          const r = spawnSync("npx", npxArgs, {
            stdio: "inherit",
            cwd: homedir(),
            shell: true,
          });
          if (r.status !== 0) {
            return {
              ok: false,
              error: `Install failed (exit ${r.status}). Run manually: npx -y openclaw-hybrid-memory-install ${version}`,
            };
          }
          let installedVersion = version;
          try {
            const pkgPath = join(extDir, "package.json");
            if (existsSync(pkgPath)) {
              const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
              installedVersion = pkg.version ?? installedVersion;
            }
          } catch {
            // ignore
          }
          return { ok: true, version: installedVersion, pluginDir: extDir };
        }

        function getPluginConfigFromFile(configPath: string): { config: Record<string, unknown>; root: Record<string, unknown> } | { error: string } {
          if (!existsSync(configPath)) return { error: `Config not found: ${configPath}` };
          let root: Record<string, unknown>;
          try {
            root = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
          } catch (e) {
            return { error: `Could not read config: ${e}` };
          }
          if (!root.plugins || typeof root.plugins !== "object") root.plugins = {};
          const plugins = root.plugins as Record<string, unknown>;
          if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
          const entries = plugins.entries as Record<string, unknown>;
          if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = { enabled: true, config: {} };
          const entry = entries[PLUGIN_ID] as Record<string, unknown>;
          if (!entry.config || typeof entry.config !== "object") entry.config = {};
          const config = entry.config as Record<string, unknown>;
          // Repair: credentials must be an object (schema). If written as boolean, normalize so next write is valid.
          if (config.credentials === true || config.credentials === false) {
            config.credentials = { enabled: config.credentials };
          }
          return { config, root };
        }

        function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
          const parts = path.split(".");
          let cur: Record<string, unknown> = obj;
          for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            if (!(p in cur) || typeof (cur as any)[p] !== "object" || (cur as any)[p] === null) (cur as any)[p] = {};
            cur = (cur as any)[p] as Record<string, unknown>;
          }
          const last = parts[parts.length - 1];
          const v =
            value === "true" || value === "enabled"
              ? true
              : value === "false" || value === "disabled"
                ? false
                : value === "null"
                  ? null
                  : /^-?\d+$/.test(String(value))
                    ? parseInt(String(value), 10)
                    : /^-?\d*\.\d+$/.test(String(value))
                      ? parseFloat(String(value))
                      : value;
          (cur as any)[last] = v;
        }

        function getNested(obj: Record<string, unknown>, path: string): unknown {
          const parts = path.split(".");
          let cur: unknown = obj;
          for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
          return cur;
        }

        const MAX_DESC_LEN = 280;

        function runConfigSetHelpForCli(key: string): ConfigCliResult {
          const k = key.trim();
          if (!k) return { ok: false, error: "Key is required (e.g. autoCapture, credentials.enabled)" };
          const openclawDir = join(homedir(), ".openclaw");
          const configPath = join(openclawDir, "openclaw.json");
          const out = getPluginConfigFromFile(configPath);
          if ("error" in out) return { ok: false, error: out.error };
          const current = getNested(out.config, k);
          const currentStr = current === undefined ? "(not set)" : typeof current === "string" ? current : JSON.stringify(current);
          let desc = "";
          try {
            const extDir = dirname(fileURLToPath(import.meta.url));
            const pluginPath = join(extDir, "openclaw.plugin.json");
            if (existsSync(pluginPath)) {
              const plugin = JSON.parse(readFileSync(pluginPath, "utf-8")) as { uiHints?: Record<string, { help?: string; label?: string }> };
              const hint = plugin.uiHints?.[k];
              if (hint?.help) {
                desc = hint.help.length > MAX_DESC_LEN ? hint.help.slice(0, MAX_DESC_LEN - 3) + "..." : hint.help;
              } else if (hint?.label) {
                desc = hint.label;
              }
            }
          } catch {
            // ignore
          }
          if (!desc) desc = "No description for this key.";
          const lines = [`${k} = ${currentStr}`, "", desc];
          return { ok: true, configPath, message: lines.join("\n") };
        }

        function runConfigModeForCli(mode: string): ConfigCliResult {
          const valid: ConfigMode[] = ["essential", "normal", "expert", "full"];
          if (!valid.includes(mode as ConfigMode)) {
            return { ok: false, error: `Invalid mode: ${mode}. Use one of: ${valid.join(", ")}` };
          }
          const openclawDir = join(homedir(), ".openclaw");
          const configPath = join(openclawDir, "openclaw.json");
          const out = getPluginConfigFromFile(configPath);
          if ("error" in out) return { ok: false, error: out.error };
          out.config.mode = mode;
          try {
            writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
            writeFileSync(getRestartPendingPath(), "", "utf-8");
          } catch (e) {
            return { ok: false, error: `Could not write config: ${e}` };
          }
          return { ok: true, configPath, message: `Set mode to "${mode}". Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
        }

        function runConfigSetForCli(key: string, value: string): ConfigCliResult {
          if (!key.trim()) return { ok: false, error: "Key is required (e.g. autoCapture, credentials.enabled, store.fuzzyDedupe)" };
          const k = key.trim();
          const openclawDir = join(homedir(), ".openclaw");
          const configPath = join(openclawDir, "openclaw.json");
          const out = getPluginConfigFromFile(configPath);
          if ("error" in out) return { ok: false, error: out.error };
          // credentials must stay an object (schema); "config-set credentials true" → credentials.enabled = true
          if (k === "credentials" && !k.includes(".")) {
            const boolVal = value === "true" || value === "enabled";
            const cred = out.config.credentials as Record<string, unknown> | undefined;
            if (typeof cred !== "object" || cred === null) {
              out.config.credentials = { enabled: boolVal };
            } else {
              (out.config.credentials as Record<string, unknown>).enabled = boolVal;
            }
            const written = (out.config.credentials as Record<string, unknown>).enabled;
            try {
              writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
              writeFileSync(getRestartPendingPath(), "", "utf-8");
            } catch (e) {
              return { ok: false, error: `Could not write config: ${e}` };
            }
            return { ok: true, configPath, message: `Set credentials.enabled = ${written}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
          }
          setNested(out.config, k, value);
          const written = getNested(out.config, k);
          const writtenStr = typeof written === "string" ? written : JSON.stringify(written);
          
          // Validate config against schema before writing
          try {
            hybridConfigSchema.parse(out.config);
          } catch (schemaErr: unknown) {
            return { ok: false, error: `Invalid config value: ${schemaErr}` };
          }
          
          try {
            writeFileSync(configPath, JSON.stringify(out.root, null, 2), "utf-8");
            writeFileSync(getRestartPendingPath(), "", "utf-8");
          } catch (e) {
            return { ok: false, error: `Could not write config: ${e}` };
          }
          return { ok: true, configPath, message: `Set ${key} = ${writtenStr}. Restart the gateway for changes to take effect. Run openclaw hybrid-mem verify to confirm.` };
        }

        function runUninstallForCli(opts: { cleanAll: boolean; leaveConfig: boolean }): UninstallCliResult {
          const openclawDir = join(homedir(), ".openclaw");
          const configPath = join(openclawDir, "openclaw.json");
          const cleaned: string[] = [];
          let outcome: UninstallCliResult["outcome"];
          let error = "";

          if (!opts.leaveConfig && existsSync(configPath)) {
            try {
              const raw = readFileSync(configPath, "utf-8");
              const config = JSON.parse(raw) as Record<string, unknown>;
              if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
              const plugins = config.plugins as Record<string, unknown>;
              if (!plugins.slots || typeof plugins.slots !== "object") plugins.slots = {};
              (plugins.slots as Record<string, string>).memory = "memory-core";
              if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
              const entries = plugins.entries as Record<string, unknown>;
              if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = {};
              (entries[PLUGIN_ID] as Record<string, boolean>).enabled = false;
              writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
              outcome = "config_updated";
            } catch (e) {
              outcome = "config_error";
              error = String(e);
            }
          } else if (!opts.leaveConfig) {
            outcome = "config_not_found";
          } else {
            outcome = "leave_config";
          }

          if (opts.cleanAll) {
            if (existsSync(resolvedSqlitePath)) {
              try {
                rmSync(resolvedSqlitePath, { force: true });
                cleaned.push(resolvedSqlitePath);
              } catch {
                // ignore
              }
            }
            if (existsSync(resolvedLancePath)) {
              try {
                rmSync(resolvedLancePath, { recursive: true, force: true });
                cleaned.push(resolvedLancePath);
              } catch {
                // ignore
              }
            }
          }

          const base = { pluginId: PLUGIN_ID, cleaned };
          if (outcome === "config_error") return { ...base, outcome, error };
          return { ...base, outcome } as UninstallCliResult;
        }

        registerHybridMemCli(mem, {
          factsDb,
          vectorDb,
          versionInfo,
          embeddings,
          mergeResults,
          parseSourceDate,
          getMemoryCategories: () => [...getMemoryCategories()],
          cfg,
          runStore: (opts) => runStoreForCli(opts, api.logger),
          runInstall: (opts) => Promise.resolve(runInstallForCli(opts)),
          runVerify: (opts, sink) => runVerifyForCli(opts, sink),
          runDistillWindow: (opts) => Promise.resolve(runDistillWindowForCli(opts)),
          runRecordDistill: () => Promise.resolve(runRecordDistillForCli()),
          runExtractDaily: (opts, sink) => runExtractDailyForCli(opts, sink),
          runExtractProcedures: (opts) => runExtractProceduresForCli(opts),
          runGenerateAutoSkills: (opts) => runGenerateAutoSkillsForCli(opts),
          runBackfill: (opts, sink) => runBackfillForCli(opts, sink),
          runIngestFiles: (opts, sink) => runIngestFilesForCli(opts, sink),
          runExport: (opts) =>
            Promise.resolve(runExport(factsDb, opts, { pluginVersion: versionInfo.pluginVersion, schemaVersion: versionInfo.schemaVersion })),
          runDistill: (opts, sink) => runDistillForCli(opts, sink),
          runMigrateToVault: () => runMigrateToVaultForCli(),
          runUninstall: (opts) => Promise.resolve(runUninstallForCli(opts)),
          runUpgrade: (v?: string) => runUpgradeForCli(v),
          runConfigMode: (mode) => Promise.resolve(runConfigModeForCli(mode)),
          runConfigSet: (key, value) => Promise.resolve(runConfigSetForCli(key, value)),
          runConfigSetHelp: (key) => Promise.resolve(runConfigSetHelpForCli(key)),
          runFindDuplicates: (opts) =>
            runFindDuplicates(factsDb, vectorDb, embeddings, safeEmbed, opts, api.logger),
          runConsolidate: (opts) => {
            if (!cfg.embedding?.apiKey || cfg.embedding.apiKey.length < 10) {
              return Promise.resolve({ clustersFound: 0, merged: 0, deleted: 0 });
            }
            return runConsolidate(factsDb, vectorDb, embeddings, openai, opts, api.logger);
          },
          runReflection: (opts) =>
            runReflection(
              factsDb,
              vectorDb,
              embeddings,
              openai,
              { defaultWindow: cfg.reflection.defaultWindow, minObservations: cfg.reflection.minObservations, enabled: cfg.reflection.enabled },
              opts,
              api.logger,
            ),
          runReflectionRules: (opts) =>
            runReflectionRules(factsDb, vectorDb, embeddings, openai, opts, api.logger),
          runReflectionMeta: (opts) =>
            runReflectionMeta(factsDb, vectorDb, embeddings, openai, opts, api.logger),
          reflectionConfig: cfg.reflection,
          runClassify: (opts) => {
            return runClassifyForCli(
              factsDb,
              openai,
              cfg.autoClassify,
              opts,
              join(dirname(resolvedSqlitePath), ".discovered-categories.json"),
              { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) },
              undefined,
            );
          },
          autoClassifyConfig: cfg.autoClassify,
          runCompaction: () =>
            Promise.resolve(
              factsDb.runCompaction({
                inactivePreferenceDays: cfg.memoryTiering.inactivePreferenceDays,
                hotMaxTokens: cfg.memoryTiering.hotMaxTokens,
                hotMaxFacts: cfg.memoryTiering.hotMaxFacts,
              }),
            ),
          runBuildLanguageKeywords: (opts: { model?: string; dryRun?: boolean }) =>
            runBuildLanguageKeywordsService(
              factsDb.getFactsForConsolidation(300),
              openai,
              dirname(resolvedSqlitePath),
              { model: opts.model ?? cfg.autoClassify.model, dryRun: opts.dryRun },
            ),
          runSelfCorrectionExtract: (opts: { days?: number; outputPath?: string }) =>
            Promise.resolve(runSelfCorrectionExtractForCli(opts)),
          runSelfCorrectionRun: (opts: {
            extractPath?: string;
            incidents?: CorrectionIncident[];
            workspace?: string;
            dryRun?: boolean;
            model?: string;
          }) => runSelfCorrectionRunForCli(opts),
          runExtractDirectives: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) =>
            runExtractDirectivesForCli(opts),
          runExtractReinforcement: (opts: { days?: number; verbose?: boolean; dryRun?: boolean }) =>
            runExtractReinforcementForCli(opts),
          richStatsExtras: (() => {
            const memoryDir = dirname(resolvedSqlitePath);
            async function dirSizeAsync(p: string): Promise<number> {
              try {
                // Try using du -sk for faster directory size calculation (Linux/macOS)
                const { execFile } = await import("node:child_process");
                return await new Promise<number>((resolve) => {
                  execFile("du", ["-sk", p], (error, stdout) => {
                    if (error) {
                      // Fallback to statSync if du fails (e.g., on Windows)
                      try {
                        const st = statSync(p);
                        resolve(st.isDirectory() ? 0 : st.size);
                      } catch {
                        resolve(0);
                      }
                      return;
                    }
                    const match = /^(\d+)/.exec(stdout.trim());
                    resolve(match ? parseInt(match[1], 10) * 1024 : 0);
                  });
                });
              } catch {
                return 0;
              }
            }
            return {
              getCredentialsCount: () => (credentialsDb ? credentialsDb.list().length : 0),
              getProposalsPending: () =>
                proposalsDb ? proposalsDb.list({ status: "pending" }).length : 0,
              getWalPending: () => (wal ? wal.getValidEntries().length : 0),
              getLastRunTimestamps: () => {
                const out: { distill?: string; reflect?: string; compact?: string } = {};
                for (const [key, file] of [
                  ["distill", ".distill_last_run"],
                  ["reflect", ".reflect_last_run"],
                  ["compact", ".compact_last_run"],
                ] as const) {
                  const path = join(memoryDir, file);
                  if (existsSync(path)) {
                    try {
                      const line = readFileSync(path, "utf-8").split("\n")[0]?.trim() ?? "";
                      if (line) out[key] = line;
                    } catch {
                      /* ignore */
                    }
                  }
                }
                return out;
              },
              getStorageSizes: async () => {
                let sqliteBytes: number | undefined;
                let lanceBytes: number | undefined;
                try {
                  if (existsSync(resolvedSqlitePath)) sqliteBytes = statSync(resolvedSqlitePath).size;
                } catch {
                  /* ignore */
                }
                try {
                  if (existsSync(resolvedLancePath)) lanceBytes = await dirSizeAsync(resolvedLancePath);
                } catch {
                  /* ignore */
                }
                return { sqliteBytes, lanceBytes };
              },
            };
          })(),
          listCommands: (() => {
            const workspaceRoot = () => process.env.OPENCLAW_WORKSPACE ?? join(homedir(), ".openclaw", "workspace");
            const reportDir = (workspace?: string) => join(workspace ?? workspaceRoot(), "memory", "reports");

            /** Parse report: items from "Suggested TOOLS.md rules" and "Proposed (review before applying)" for display. */
            function parseReportProposedSections(content: string): string[] {
              const lines = content.split("\n");
              const items: string[] = [];
              let inSection = false;
              for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (trimmed.startsWith("## Suggested TOOLS.md rules") || trimmed === "## Proposed (review before applying)") {
                  inSection = true;
                  continue;
                }
                if (trimmed.startsWith("## ")) {
                  inSection = false;
                  continue;
                }
                if (inSection && trimmed.startsWith("- ") && trimmed.length > 2) items.push(trimmed.slice(2).trim());
              }
              return items;
            }

            /** Parse only "Suggested TOOLS.md rules" bullet lines (for applying to TOOLS.md). */
            function parseReportSuggestedTools(content: string): string[] {
              const lines = content.split("\n");
              const items: string[] = [];
              let inSuggested = false;
              for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (trimmed.startsWith("## Suggested TOOLS.md rules")) {
                  inSuggested = true;
                  continue;
                }
                if (trimmed.startsWith("## ")) inSuggested = false;
                if (inSuggested && trimmed.startsWith("- ") && trimmed.length > 2) items.push(trimmed.slice(2).trim());
              }
              return items;
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
              } catch {
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
                proposalsDb.updateStatus(id, "approved");
                return { ok: true };
              },
              proposalReject: async (id: string, reason?: string) => {
                if (!proposalsDb) return { ok: false, error: "Proposals not available" };
                const p = proposalsDb.get(id);
                if (!p) return { ok: false, error: `Proposal ${id} not found` };
                if (p.status !== "pending") return { ok: false, error: `Proposal is already ${p.status}` };
                proposalsDb.updateStatus(id, "rejected", undefined, reason);
                return { ok: true };
              },
              listCorrections: async (opts: { workspace?: string }) => {
                const report = getLatestCorrectionReport(opts.workspace);
                if (!report) return { reportPath: null, items: [] };
                const items = parseReportProposedSections(report.content);
                return { reportPath: report.path, items };
              },
              correctionsApproveAll: async (opts: { workspace?: string }) => {
                const report = getLatestCorrectionReport(opts.workspace);
                if (!report) return { applied: 0, error: "No self-correction report found" };
                const items = parseReportSuggestedTools(report.content);
                if (items.length === 0) return { applied: 0, error: "No suggested TOOLS rules in report (run self-correction-run first)" };
                const toolsPath = join(opts.workspace ?? workspaceRoot(), "TOOLS.md");
                if (!existsSync(toolsPath)) return { applied: 0, error: "TOOLS.md not found in workspace" };
                const scCfg = cfg.selfCorrection ?? { toolsSection: "Self-correction rules" };
                const section = typeof scCfg === "object" && scCfg && "toolsSection" in scCfg ? (scCfg.toolsSection as string) : "Self-correction rules";
                const { inserted } = insertRulesUnderSection(toolsPath, section, items);
                return { applied: inserted };
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
            };
          })(),
          tieringEnabled: cfg.memoryTiering.enabled,
        });

      },
      { commands: ["hybrid-mem", "hybrid-mem install", "hybrid-mem stats", "hybrid-mem compact", "hybrid-mem prune", "hybrid-mem checkpoint", "hybrid-mem backfill-decay", "hybrid-mem backfill", "hybrid-mem ingest-files", "hybrid-mem distill", "hybrid-mem extract-daily", "hybrid-mem extract-procedures", "hybrid-mem generate-auto-skills", "hybrid-mem extract-directives", "hybrid-mem extract-reinforcement", "hybrid-mem search", "hybrid-mem lookup", "hybrid-mem list", "hybrid-mem show", "hybrid-mem proposals list", "hybrid-mem proposals approve", "hybrid-mem proposals reject", "hybrid-mem corrections list", "hybrid-mem corrections approve", "hybrid-mem review", "hybrid-mem store", "hybrid-mem classify", "hybrid-mem build-languages", "hybrid-mem self-correction-extract", "hybrid-mem self-correction-run", "hybrid-mem categories", "hybrid-mem find-duplicates", "hybrid-mem consolidate", "hybrid-mem reflect", "hybrid-mem reflect-rules", "hybrid-mem reflect-meta", "hybrid-mem verify", "hybrid-mem credentials migrate-to-vault", "hybrid-mem distill-window", "hybrid-mem record-distill", "hybrid-mem scope prune-session", "hybrid-mem scope promote", "hybrid-mem uninstall"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    const lifecycleContext: LifecycleContext = {
      factsDb,
      vectorDb,
      embeddings,
      openai,
      cfg,
      credentialsDb,
      wal,
      currentAgentId,
      lastProgressiveIndexIds,
      restartPendingCleared,
      resolvedSqlitePath,
      walWrite: (operation, data, logger) => walWrite(wal, operation, data, logger),
      walRemove: (id, logger) => walRemove(wal, id, logger),
      findSimilarByEmbedding,
      shouldCapture,
      detectCategory,
    };

    const hooks = createLifecycleHooks(lifecycleContext);
    hooks.onAgentStart(api);
    hooks.onAgentEnd(api);

    // Update context refs from hooks (they may have been mutated)
    // Note: This is a workaround for the fact that the hooks need to update these values
    // but we can't easily pass them by reference in TypeScript without using objects.
    // The hooks update ctx.currentAgentId and ctx.lastProgressiveIndexIds internally.
    // ========================================================================
    // Service
    // ========================================================================

    // Register plugin service with lifecycle handlers
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
export default memoryHybridPlugin;