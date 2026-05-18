/**
 * Memory Tool Registrations
 *
 * Tool definitions for memory recall, storage, promotion, and deletion.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import type OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { stringEnum } from "../../utils/typebox.js";

import type { BuildToolScopeFilterFn, FindSimilarByEmbeddingFn } from "../../api/memory-plugin-api.js";
import type { AuditStore } from "../../backends/audit-store.js";
import type { CredentialsDB } from "../../backends/credentials-db.js";
import type { EdictStore } from "../../backends/edict-store.js";
import type { EventLog } from "../../backends/event-log.js";
import { categoryToEventType } from "../../backends/event-log.js";
import type { FactsDB } from "../../backends/facts-db.js";
import type { NarrativesDB } from "../../backends/narratives-db.js";
import type { VectorDB } from "../../backends/vector-db.js";
import {
  DECAY_CLASSES,
  type DecayClass,
  type HybridMemoryConfig,
  type MemoryCategory,
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
  getMemoryCategories,
  isCompactVerbosity,
} from "../../config.js";
import { VAULT_POINTER_PREFIX, isCredentialLike, tryParseCredentialForVault } from "../../services/auto-capture.js";
import type { PendingLLMWarnings } from "../../services/chat.js";
import { classifyMemoryOperation } from "../../services/classification.js";
import type { VariantGenerationQueue } from "../../services/contextual-variants.js";
import type { EmbeddingRegistry } from "../../services/embedding-registry.js";
import { toFloat32Array } from "../../services/embedding-registry.js";
import type { EmbeddingProvider } from "../../services/embeddings.js";
import { AllEmbeddingProvidersFailed, shouldSuppressEmbeddingError } from "../../services/embeddings.js";
import { extractEntityMentionsWithLlm } from "../../services/entity-enrichment.js";
import { addOperationBreadcrumb, capturePluginError } from "../../services/error-reporter.js";
import { extractStructuredFields } from "../../services/fact-extraction.js";
import { expandGraph, formatLinkPath } from "../../services/graph-retrieval.js";
import { filterByScope, mergeResults } from "../../services/merge-results.js";
import { formatNarrativeRange, recallNarrativeSummaries } from "../../services/narrative-recall.js";
import type { ProvenanceService } from "../../services/provenance.js";
import { QueryExpander } from "../../services/query-expander.js";
import { type AliasDB, storeAliases } from "../../services/retrieval-aliases.js";
import {
  resolveConstrainedRetrievalPolicy,
  resolveExplicitDeepRetrievalPolicy,
  type ConstrainedRetrievalPolicy,
  type ExplicitDeepRetrievalPolicy,
} from "../../services/retrieval-mode-policy.js";
import { buildExplicitSemanticQueryVector, runExplicitDeepRetrieval } from "../../services/retrieval-orchestrator.js";
import { TASK_LEDGER_CATEGORY, refreshActiveTaskProjectionBestEffort } from "../../services/task-ledger-facts.js";
import { validateScopedClassificationTarget } from "../../services/classification-scope.js";
import type { VerificationStore } from "../../services/verification-store.js";
import { shouldAutoVerify } from "../../services/verification-store.js";
import {
  cleanupEvictedVector,
  deleteVectorForFactId,
  storeCanonicalVectorForFact,
} from "../../services/vector-maintenance.js";
import type { Episode, EpisodeOutcome, MemoryEntry, ScopeFilter, SearchResult } from "../../types/memory.js";
import { MEMORY_SCOPES } from "../../types/memory.js";
import { UUID_REGEX, getSessionLogFileSuffix } from "../../utils/constants.js";
import { detectFutureDate } from "../../utils/date-detector.js";
import { parseSourceDate } from "../../utils/dates.js";
import { parseDuration } from "../../utils/duration.js";
import { embedCallWithTimeoutAndRetry } from "../../utils/embed-call.js";
import { getEnv } from "../../utils/env-manager.js";
import { resolveWorkspacePath } from "../../utils/path.js";
import { extractTags } from "../../utils/tags.js";
import { truncateForStorage } from "../../utils/text.js";
import { runActiveTaskCheckpoint } from "../../services/active-task-checkpoint.js";
import type { MemoryToolRuntime } from "./runtime.js";


export function registerRecallTools(runtime: MemoryToolRuntime): void {
  const {
    factsDb,
    edictStore,
    vectorDb,
    cfg,
    embeddings,
    openai,
    credentialsDb,
    eventLog,
    narrativesDb,
    provenanceService,
    aliasDb,
    embeddingRegistry,
    verificationStore,
    lastProgressiveIndexIds,
    currentAgentIdRef,
    pendingLLMWarnings,
    variantQueue,
    buildToolScopeFilter,
    walWrite,
    walRemove,
    findSimilarByEmbedding,
    auditStore,
    api,
    auditAppend,
    agentIdForAudit,
    maybeRefreshProjectActiveTaskProjection,
    storeActiveCanonicalVector,
    storeRegistryEmbeddings,
    isEdictWriteToolEnabled,
    sanitizeScopeParam,
  } = runtime;

  api.registerTool(
    {
      name: "memory_recall",
      label: "Memory Recall",
      description: "Search through long-term memories using both structured (exact) and semantic (fuzzy) search.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({
            description: "Search query (omit when using id to fetch a specific memory)",
          }),
        ),
        id: Type.Optional(
          Type.Union([Type.String(), Type.Number()], {
            description:
              "Fetch a specific memory: fact id (UUID string) or 1-based index from the last progressive index (e.g. 1 for first listed memory).",
          }),
        ),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        entity: Type.Optional(
          Type.String({
            description: "Optional: filter by entity name for exact lookup",
          }),
        ),
        tag: Type.Optional(
          Type.String({
            description: "Optional: filter by topic tag (e.g. nibe, zigbee)",
          }),
        ),
        category: Type.Optional(
          Type.String({
            description: "Optional: constrain results to a specific category/type before ranking.",
          }),
        ),
        source: Type.Optional(
          Type.String({
            description:
              "Optional: constrain results to an exact fact source before ranking (e.g. conversation, ingest, reflection).",
          }),
        ),
        verificationTier: Type.Optional(
          Type.String({
            description:
              "Optional: constrain results to verified facts of a given tier before ranking (e.g. critical).",
          }),
        ),
        validFromSec: Type.Optional(
          Type.Number({
            description:
              "Optional: constrain results to facts whose valid_from is on/after this Unix timestamp before ranking.",
          }),
        ),
        validUntilSec: Type.Optional(
          Type.Number({
            description:
              "Optional: constrain results to facts whose validity extends past this Unix timestamp before ranking.",
          }),
        ),
        sourceSession: Type.Optional(
          Type.String({
            description: "Optional: constrain results to facts linked to a specific source session before ranking.",
          }),
        ),
        retrievalMode: Type.Optional(
          Type.Union(
            [Type.Literal("interactive-recall"), Type.Literal("explicit-deep"), Type.Literal("constrained-recall")],
            {
              description:
                'Optional retrieval strategy selection. Use "constrained-recall" for filter → rank → hydrate searches inside a known boundary.',
            },
          ),
        ),
        includeSuperseded: Type.Optional(
          Type.Boolean({
            description: "Include superseded (historical) facts in results. Default: only current facts.",
          }),
        ),
        asOf: Type.Optional(
          Type.String({
            description:
              "Point-in-time query: ISO date (YYYY-MM-DD) or epoch seconds. Return only facts valid at that time.",
          }),
        ),
        userId: Type.Optional(
          Type.String({
            description:
              "⚠️ SECURITY: Caller-controlled parameter. In multi-tenant environments, derive from authenticated identity instead. Include user-private memories for this user.",
          }),
        ),
        agentId: Type.Optional(
          Type.String({
            description:
              "⚠️ SECURITY: Caller-controlled parameter. In multi-tenant environments, derive from authenticated identity instead. Include agent-specific memories for this agent.",
          }),
        ),
        sessionId: Type.Optional(
          Type.String({
            description:
              "⚠️ SECURITY: Caller-controlled parameter. In multi-tenant environments, derive from authenticated identity instead. Include session-scoped memories for this session.",
          }),
        ),
        confirmCrossTenantScope: Type.Optional(
          Type.Boolean({
            description:
              "When multiAgent.trustToolScopeParams is true, set true to confirm intentional cross-tenant scope use of userId/agentId/sessionId (#874).",
          }),
        ),
        includeCold: Type.Optional(
          Type.Boolean({
            description: "Set true to include COLD tier (slower / deeper retrieval). Default: false (HOT + WARM only).",
          }),
        ),
        expandGraph: Type.Optional(
          Type.Boolean({
            description:
              "When true, run BFS graph expansion from the top results: related facts up to expandDepth hops are included. " +
              "Direct matches score higher than expanded ones. Default: false (or graphRetrieval.defaultExpand from config).",
          }),
        ),
        expandDepth: Type.Optional(
          Type.Number({
            description:
              "Number of BFS hops to expand when expandGraph=true (default: 2, max: graphRetrieval.maxExpandDepth from config).",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          return await memoryRecallImpl(params);
        } catch (err) {
          auditAppend({
            agentId: agentIdForAudit(),
            action: "memory_recall",
            target: undefined,
            outcome: "failed",
            error: err instanceof Error ? err.message : String(err),
            sessionId: api.context?.sessionId ?? undefined,
          });
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "memory",
            operation: "memory-recall",
            phase: "runtime",
          });
          throw err;
        }
      },
    },
    { name: "memory_recall" },
  );

  api.registerTool(
    {
      name: "memory_recall_timeline",
      label: "Memory Recall Timeline",
      description: "Recall chronological summaries of recent sessions, decisions, and attempts.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({
            description: "Optional topic or project query used to rank narrative summaries.",
          }),
        ),
        sessionId: Type.Optional(
          Type.String({
            description:
              "Optional session id to fetch a specific session narrative or event timeline. In multi-tenant environments, only pass a sessionId derived from the authenticated context; never accept arbitrary end-user input here, to avoid cross-session data exposure.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max summaries to return (default: 3).",
            minimum: 1,
            maximum: 50,
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const MAX_SUMMARY_LIMIT = 50;
        const MIN_SUMMARY_LIMIT = 1;

        const query = typeof params.query === "string" && params.query.trim().length > 0 ? params.query.trim() : null;
        const requestedSessionId =
          typeof params.sessionId === "string" && params.sessionId.trim().length > 0 ? params.sessionId.trim() : null;
        const contextSessionId =
          typeof api.context?.sessionId === "string" && api.context.sessionId.trim().length > 0
            ? api.context.sessionId.trim()
            : null;
        if (!contextSessionId) {
          throw new Error("memory_recall_timeline requires an authenticated session context");
        }
        if (requestedSessionId && requestedSessionId !== contextSessionId) {
          throw new Error("memory_recall_timeline sessionId must match the authenticated session context");
        }
        const sessionId = contextSessionId;

        let limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 3;
        limit = Math.min(MAX_SUMMARY_LIMIT, Math.max(MIN_SUMMARY_LIMIT, limit));
        const nowSec = Math.floor(Date.now() / 1000);
        const summaries = recallNarrativeSummaries({
          narrativesDb: narrativesDb ?? null,
          eventLog,
          query,
          sessionId,
          limit,
          nowSec,
          sinceSec: undefined,
        });

        if (summaries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No narrative summary found for session ${sessionId}.`,
              },
            ],
            details: { count: 0, narratives: [] },
          };
        }

        const lines = summaries.map((summary, index) => {
          const agentDir = currentAgentIdRef.value || "main";
          const logPath = `~/.openclaw/agents/${agentDir}/sessions/${summary.sessionId}${getSessionLogFileSuffix()}`;
          return (
            `${index + 1}. [${summary.source}] ${formatNarrativeRange(summary.periodStart, summary.periodEnd)} ` +
            `(sessionKey: ${summary.sessionId}, sessionLogPath: ${logPath})\n${summary.text}`
          );
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${summaries.length} narrative summar${summaries.length === 1 ? "y" : "ies"}:\n\n${lines.join("\n\n")}`,
            },
          ],
          details: {
            count: summaries.length,
            narratives: summaries.map((summary) => ({
              id: summary.id,
              source: summary.source,
              sessionId: summary.sessionId,
              sessionKey: summary.sessionId,
              sessionLogPath: `~/.openclaw/agents/${currentAgentIdRef.value || "main"}/sessions/${summary.sessionId}${getSessionLogFileSuffix()}`,
              periodStart: new Date(summary.periodStart * 1000).toISOString(),
              periodEnd: new Date(summary.periodEnd * 1000).toISOString(),
              tag: summary.tag,
              text: summary.text,
              score: Number(summary.score.toFixed(3)),
            })),
          },
        };
      },
    },
    { name: "memory_recall_timeline" },
    {
      name: "memory_session_observability",
      label: "Memory Session Observability",
      description:
        "Get a unified session observability report: timeline of capture, recall, injection, suppressions, and used-vs-stored analysis. Use sessionId from the session context or pass a specific session id.",
      parameters: Type.Object({
        sessionId: Type.Optional(
          Type.String({
            description: "Session id to report on. Defaults to the current session from context.",
          }),
        ),
        agentId: Type.Optional(
          Type.String({
            description: "Agent id to scope the report to (optional).",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max timeline entries per section (default: 50, max: 200).",
            minimum: 1,
            maximum: 200,
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const sessionId =
          typeof params.sessionId === "string" && params.sessionId.trim().length > 0 ? params.sessionId.trim() : null;
        const agentId =
          typeof params.agentId === "string" && params.agentId.trim().length > 0 ? params.agentId.trim() : null;
        const limit =
          typeof params.limit === "number" && params.limit > 0 ? Math.min(200, Math.floor(params.limit)) : 50;

        // Build report synchronously (factsDb / auditStore are sync interfaces)
        let report;
        try {
          const { buildSessionObservabilityReport } = await import("../../services/session-observability.js");
          report = await buildSessionObservabilityReport({
            factsDb: factsDb as import("../../backends/facts-db.js").FactsDB,
            eventLog: eventLog as import("../../backends/event-log.js").EventLog | null,
            narrativesDb: narrativesDb as import("../../backends/narratives-db.js").NarrativesDB | null,
            auditStore: auditStore ?? null,
            sessionId,
            agentId,
            limit,
          });
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed to build session report: ${String(err)}` }],
            details: { error: String(err) },
          };
        }

        // Human-readable summary line
        const summaryText =
          report.summary ||
          `Session ${sessionId ?? "unknown"}: ${report.timeline.length} timeline entries, ` +
            `${report.capture.factsStored} stored, ${report.capture.duplicatesSuppressed} suppressed, ` +
            `${report.recall.injectedCount} injected.`;

        const detail = {
          sessionId: report.sessionId,
          agentId: report.agentId,
          windowStart: report.windowStart,
          windowEnd: report.windowEnd,
          timelineCount: report.timeline.length,
          capture: {
            factsStored: report.capture.factsStored,
            factsUpdated: report.capture.factsUpdated,
            duplicatesSuppressed: report.capture.duplicatesSuppressed,
            noopSkipped: report.capture.noopSkipped,
            errorsEncountered: report.capture.errorsEncountered,
            entitiesExtracted: report.capture.entitiesExtracted,
            episodesRecorded: report.capture.episodesRecorded,
            proceduresLearned: report.capture.proceduresLearned,
          },
          recall: {
            candidatesFound: report.recall.candidatesFound,
            injectedCount: report.recall.injectedCount,
            omittedCount: report.recall.omittedCount,
            strategies: report.recall.strategies,
            directiveMatches: report.recall.directiveMatches,
            suppressionReasons: report.recall.suppressionReasons,
          },
          injection: {
            totalChars: report.injection.totalChars,
            totalTokensEstimate: report.injection.totalTokensEstimate,
            blocksInjected: report.injection.blocksInjected,
            budgetTokens: report.injection.budgetTokens,
            budgetUsedFraction: Math.round(report.injection.budgetUsedFraction * 100) / 100,
          },
          suppressions: report.suppressions,
          timeline: report.timeline.slice(0, limit).map((e) => ({
            timestamp: e.timestamp,
            kind: e.kind,
            label: e.label,
            description: e.description,
            outcome: e.outcome,
            score: e.score,
          })),
        };

        return {
          content: [{ type: "text" as const, text: summaryText }],
          details: detail,
        };
      },
    },
  );

  // Internal implementation so we can return from the try block
  async function memoryRecallImpl(params: Record<string, unknown>) {
    const recallStartedAt = Date.now();
    const {
      query: queryParam,
      id: idParam,
      limit = 10,
      entity: entityParam,
      tag: tagParam,
      category: categoryParam,
      source: sourceParam,
      verificationTier: verificationTierParam,
      validFromSec,
      validUntilSec,
      sourceSession: sourceSessionParam,
      retrievalMode,
      includeSuperseded = false,
      asOf: asOfParam,
      includeCold = false,
      userId,
      agentId,
      sessionId,
      confirmCrossTenantScope,
      expandGraph: expandGraphParam,
      expandDepth: expandDepthParam,
    } = params as {
      query?: string;
      id?: string | number;
      limit?: number;
      entity?: string;
      tag?: string;
      category?: string;
      source?: string;
      verificationTier?: string;
      validFromSec?: number;
      validUntilSec?: number;
      sourceSession?: string;
      retrievalMode?: "interactive-recall" | "explicit-deep" | "constrained-recall";
      includeSuperseded?: boolean;
      asOf?: string;
      includeCold?: boolean;
      userId?: string;
      agentId?: string;
      sessionId?: string;
      confirmCrossTenantScope?: boolean;
      expandGraph?: boolean;
      expandDepth?: number;
    };
    const normalizeOptionalString = (value: unknown): string | undefined => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const entity = normalizeOptionalString(entityParam);
    const tag = normalizeOptionalString(tagParam);
    const category = normalizeOptionalString(categoryParam);
    const source = normalizeOptionalString(sourceParam);
    const verificationTier = normalizeOptionalString(verificationTierParam);
    const sourceSession = normalizeOptionalString(sourceSessionParam);
    const asOfSec = asOfParam != null && asOfParam !== "" ? parseSourceDate(asOfParam) : undefined;

    // Scope filtering with auto-detection
    // ⚠️ SECURITY WARNING: userId/agentId/sessionId are caller-controlled parameters.
    // In multi-tenant production environments, these should be derived from authenticated
    // identity (via autoRecall.scopeFilter config) rather than accepted as tool parameters.
    // Accepting arbitrary scope filters allows users to access other users' private memories.
    // See docs/MEMORY-SCOPING.md "Secure Multi-Tenant Setup" for proper implementation.
    const scopeFilter = buildToolScopeFilter(
      {
        userId: sanitizeScopeParam("userId", userId),
        agentId: sanitizeScopeParam("agentId", agentId),
        sessionId: sanitizeScopeParam("sessionId", sessionId),
        confirmCrossTenantScope,
      },
      currentAgentIdRef.value,
      cfg,
    );
    const logRecall = (hit: boolean) => {
      const maybeFactsDb = factsDb as { logRecall?: (hit: boolean) => void };
      if (typeof maybeFactsDb.logRecall === "function") {
        try {
          maybeFactsDb.logRecall(hit);
        } catch {
          // Non-fatal: recall logging should never break recall
        }
      }
    };

    // Fetch by id (fact id or 1-based index from last progressive index)
    if (idParam !== undefined && idParam !== null && idParam !== "") {
      let factId: string | null = null;
      if (typeof idParam === "number") {
        const idx = Math.floor(idParam);
        if (idx >= 1 && idx <= lastProgressiveIndexIds.length) {
          factId = lastProgressiveIndexIds[idx - 1] ?? null;
        }
      } else if (typeof idParam === "string" && idParam.trim().length > 0) {
        const trimmed = idParam.trim();
        // Check if it's a numeric string (progressive index position)
        if (/^\d+$/.test(trimmed)) {
          const idx = Number.parseInt(trimmed, 10);
          if (idx >= 1 && idx <= lastProgressiveIndexIds.length) {
            factId = lastProgressiveIndexIds[idx - 1] ?? null;
          }
        } else {
          // Treat as fact ID
          factId = trimmed;
        }
      }
      if (factId) {
        const getByIdOpts = { asOf: asOfSec, scopeFilter };
        const entry = factsDb.getById(
          factId,
          asOfSec != null || scopeFilter ? (getByIdOpts as { asOf?: number; scopeFilter?: ScopeFilter }) : undefined,
        );
        if (entry) {
          // Access boost — update recall_count and last_accessed on fetch by id
          factsDb.refreshAccessedFacts([entry.id]);
          logRecall(true);
          const text = `[${entry.category}] ${entry.text}`;
          const whyLine = entry.why ? `\nWhy: ${entry.why}` : "";
          auditAppend({
            agentId: agentIdForAudit(),
            action: "memory_recall",
            target: `memory #${entry.id}`,
            outcome: "success",
            durationMs: Date.now() - recallStartedAt,
            sessionId: api.context?.sessionId ?? undefined,
          });
          return {
            content: [
              {
                type: "text",
                text: `Memory (id: ${entry.id}):\n\n${text}${whyLine}`,
              },
            ],
            details: {
              count: 1,
              memories: [
                {
                  id: entry.id,
                  text: entry.text,
                  why: entry.why ?? undefined,
                  category: entry.category,
                  entity: entry.entity,
                  importance: entry.importance,
                  score: 1,
                  backend: "sqlite" as const,
                  tags: entry.tags?.length ? entry.tags : undefined,
                  sourceDate: entry.sourceDate
                    ? new Date(entry.sourceDate * 1000).toISOString().slice(0, 10)
                    : undefined,
                },
              ],
            },
          };
        }
      }
      logRecall(false);
      auditAppend({
        agentId: agentIdForAudit(),
        action: "memory_recall",
        target: typeof idParam === "number" ? `index ${idParam}` : `id ${idParam}`,
        outcome: "partial",
        durationMs: Date.now() - recallStartedAt,
        sessionId: api.context?.sessionId ?? undefined,
      });
      return {
        content: [
          {
            type: "text",
            text:
              typeof idParam === "number"
                ? `No memory at index ${idParam}. Use a number between 1 and ${lastProgressiveIndexIds.length} from the index, or provide a fact id.`
                : `No memory found with id: ${idParam}.`,
          },
        ],
        details: { count: 0 },
      };
    }

    const query = typeof queryParam === "string" && queryParam.trim().length > 0 ? queryParam.trim() : null;
    if (!query) {
      logRecall(false);
      auditAppend({
        agentId: agentIdForAudit(),
        action: "memory_recall",
        target: undefined,
        outcome: "partial",
        durationMs: Date.now() - recallStartedAt,
        sessionId: api.context?.sessionId ?? undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: "Provide a search query or an id (fact id or index from the memory index) to recall memories.",
          },
        ],
        details: { count: 0 },
      };
    }

    const tierFilter: "warm" | "all" = includeCold ? "all" : "warm";
    const recallOpts = {
      tag,
      includeSuperseded,
      tierFilter,
      scopeFilter,
      ...(asOfSec != null ? { asOf: asOfSec } : {}),
    };

    const hasAdditionalConstrainedFilters = Boolean(
      category || source || verificationTier || validFromSec != null || validUntilSec != null || sourceSession,
    );
    const shouldUseConstrainedMode =
      retrievalMode === "constrained-recall" || (!retrievalMode && hasAdditionalConstrainedFilters);
    const effectiveMode = shouldUseConstrainedMode ? "constrained-recall" : retrievalMode;
    const constrainedFilters = shouldUseConstrainedMode
      ? {
          ...(entity ? { entity } : {}),
          ...(tag ? { tag } : {}),
          ...(category ? { category } : {}),
          ...(source ? { source } : {}),
          ...(verificationTier ? { verificationTier } : {}),
          ...(typeof validFromSec === "number" ? { validFromSec: Math.floor(validFromSec) } : {}),
          ...(typeof validUntilSec === "number" ? { validUntilSec: Math.floor(validUntilSec) } : {}),
          ...(sourceSession ? { sourceSession } : {}),
        }
      : undefined;

    // Entity-targeted lookup is useful for legacy explicit recall, but it bypasses
    // filter → rank → hydrate semantics, so disable it in constrained mode.
    let entityResults: SearchResult[] = [];
    if (entity && !shouldUseConstrainedMode) {
      entityResults = factsDb.lookup(entity, undefined, tag, { ...recallOpts, limit: 100 });
    }

    // Explicit/deep retrieval owns richer semantic prep, including optional HyDE.
    let queryVector: number[] | null = null;
    let semanticWarning: string | null = null;

    // RRF multi-strategy retrieval pipeline (Issue #152)
    // Legacy tag-only recall skips semantic search; constrained mode keeps semantic ranking
    // because tag/entity/category/etc. are applied before ranking inside the candidate set.
    let results: SearchResult[] = [];
    try {
      const useLegacyTagShortcut = Boolean(tag && !shouldUseConstrainedMode);
      const rrfStrategies = useLegacyTagShortcut
        ? cfg.retrieval.strategies.filter((s) => s !== "semantic")
        : cfg.retrieval.strategies;
      const rrfConfig = { ...cfg.retrieval, strategies: rrfStrategies };
      // interactive-recall uses a different policy with its own vector prep; skip for other modes
      const effectivePolicy =
        effectiveMode !== "interactive-recall"
          ? effectiveMode === "constrained-recall"
            ? resolveConstrainedRetrievalPolicy(rrfConfig)
            : resolveExplicitDeepRetrievalPolicy(rrfConfig)
          : undefined;
      if (!useLegacyTagShortcut && effectivePolicy !== undefined) {
        const vectorPrep = await buildExplicitSemanticQueryVector({
          query,
          cfg,
          embeddings,
          openai,
          pendingLLMWarnings,
          logger: api.logger,
          policy: effectivePolicy as ExplicitDeepRetrievalPolicy,
        });
        queryVector = vectorPrep.queryVector;
        semanticWarning = vectorPrep.warning;
      }
      const queryExpander =
        cfg.queryExpansion?.enabled && rrfStrategies.includes("semantic")
          ? new QueryExpander(cfg.queryExpansion, openai)
          : null;
      const embedFn =
        queryVector != null
          ? (text: string) =>
              embedCallWithTimeoutAndRetry(() => embeddings.embed(text), "memory-tools:rrf-deep-retrieval")
          : null;
      const rrfOutput = await runExplicitDeepRetrieval(query, queryVector, factsDb.getRawDb(), vectorDb, factsDb, {
        config: rrfConfig,
        ...(effectiveMode !== "interactive-recall" && effectivePolicy
          ? { policy: effectivePolicy }
          : effectiveMode === "interactive-recall"
            ? { mode: effectiveMode as "interactive-recall" }
            : {}),
        ...(useLegacyTagShortcut ? { tagFilter: tag ?? undefined } : {}),
        ...(constrainedFilters ? { constrainedFilters } : {}),
        includeSuperseded,
        scopeFilter,
        asOf: asOfSec ?? undefined,
        graphHubDegreeCap: cfg.graph.hubDegreeCap,
        graphHubScorePenalty: cfg.graph.hubScorePenalty,
        aliasDb: cfg.aliases?.enabled ? aliasDb : null,
        clustersConfig: cfg.clusters,
        embeddingRegistry: embeddingRegistry ?? null,
        factsDbForEmbeddings: factsDb,
        queryExpander: queryExpander ?? null,
        embedFn,
        rerankingConfig: cfg.reranking,
        rerankingOpenai: openai,
        adaptiveOpenai: cfg.documentGrading?.enabled ? openai : undefined,
        documentGradingConfig: cfg.documentGrading,
      });

      // Merge entity-lookup results first, then append RRF results (deduped).
      // When packed is non-empty, only include fused results whose factId was packed
      // (avoids including items beyond the token budget). Fall back to the full fused
      // list when packed is empty (e.g. budget too small to pack any).
      // Use a factId→entry Map so entry lookup never depends on loop index alignment.
      const seenIds = new Set<string>(entityResults.map((r) => r.entry.id));
      results = [...entityResults];
      const entryByFactId = new Map<string, MemoryEntry>();
      for (let i = 0; i < rrfOutput.fused.length; i++) {
        const e = rrfOutput.entries[i];
        if (e) entryByFactId.set(rrfOutput.fused[i].factId, e);
      }
      const packedFactIdSet = rrfOutput.packed.length > 0 ? new Set(rrfOutput.packedFactIds) : null;
      for (const fusedResult of rrfOutput.fused) {
        if (packedFactIdSet && !packedFactIdSet.has(fusedResult.factId)) continue;
        if (seenIds.has(fusedResult.factId)) continue;
        const entry = entryByFactId.get(fusedResult.factId);
        if (entry) {
          results.push({ entry, score: fusedResult.finalScore, backend: "sqlite" });
          seenIds.add(fusedResult.factId);
        }
      }
      results.sort((a, b) => b.score - a.score);
      results = results.slice(0, limit);
    } catch (err) {
      // Fallback: use legacy FTS + vector merge if RRF pipeline fails
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "search",
        operation: "rrf-pipeline",
        phase: "runtime",
      });
      api.logger.warn(`memory-hybrid: RRF pipeline failed, falling back to legacy merge: ${err}`);
      const ftsResults = factsDb.search(query, limit, {
        ...recallOpts,
        reinforcementBoost: cfg.distill?.reinforcementBoost ?? 0.1,
        diversityWeight: cfg.reinforcement?.diversityWeight ?? 1.0,
      });
      let lanceResults: SearchResult[] = [];
      if (queryVector) {
        lanceResults = await vectorDb.search(queryVector, limit * 3, 0.3);
        lanceResults = filterByScope(lanceResults, (id, opts) => factsDb.getById(id, opts), scopeFilter);
      }
      results = mergeResults([...entityResults, ...ftsResults], lanceResults, limit, factsDb);
    }

    // Exclude COLD tier when includeCold is false (Lance results may include cold facts)
    if (!includeCold && results.length > 0) {
      const filtered: SearchResult[] = [];
      for (const r of results) {
        const full = factsDb.getById(r.entry.id);
        if (full && full.tier !== "cold") filtered.push({ ...r, entry: full });
      }
      results = filtered.slice(0, limit);
    }

    // When asOf is set, filter so only facts valid at that time (Lance results lack temporal filter)
    if (asOfSec != null && results.length > 0) {
      const filtered: SearchResult[] = [];
      for (const r of results) {
        const full = factsDb.getById(r.entry.id, { asOf: asOfSec });
        if (full) filtered.push({ ...r, entry: full });
      }
      results = filtered.slice(0, limit);
    }

    // Resolve whether to run GraphRAG expansion for this call.
    const useExpandGraph =
      cfg.graphRetrieval.enabled &&
      cfg.graph.enabled &&
      results.length > 0 &&
      (expandGraphParam ?? cfg.graphRetrieval.defaultExpand);

    // GraphRAG expansion — BFS from seed results with path tracking and ranked scoring.
    // When expandGraph=true, replaces the legacy flat-score graph traversal.
    type ExpandedMeta = { expansionSource: "direct" | "graph"; hopCount: number; linkPath: string } | undefined;
    const expansionMeta = new Map<string, ExpandedMeta>();

    if (useExpandGraph) {
      const rawDepth = typeof expandDepthParam === "number" ? expandDepthParam : cfg.retrieval.graphWalkDepth;
      const depth = Math.min(Math.max(0, rawDepth), cfg.graphRetrieval.maxExpandDepth);
      const seedInputs = results.map((r) => ({ factId: r.entry.id, score: r.score, entry: r.entry }));
      const originalBackendMap = new Map<string, "sqlite" | "lancedb">();
      for (const r of results) {
        originalBackendMap.set(r.entry.id, r.backend);
      }
      const { results: expanded } = expandGraph(factsDb, seedInputs, {
        maxDepth: depth,
        maxExpandedResults: cfg.graphRetrieval.maxExpandedResults,
        scopeFilter: scopeFilter ?? undefined,
        asOf: asOfSec ?? undefined,
        hubDegreeCap: cfg.graph.hubDegreeCap,
        hubScorePenalty: cfg.graph.hubScorePenalty,
      });

      // Re-build results from expanded output (preserves scores and dedup).
      const newResults: SearchResult[] = [];
      for (const e of expanded) {
        const backend = e.expansionSource === "direct" ? (originalBackendMap.get(e.factId) ?? "sqlite") : "sqlite";
        newResults.push({ entry: e.entry, score: e.score, backend });
        expansionMeta.set(e.factId, {
          expansionSource: e.expansionSource,
          hopCount: e.hopCount,
          linkPath: formatLinkPath(e.linkPath),
        });
      }
      newResults.sort((a, b) => b.score - a.score);
      results = newResults.slice(0, limit);
    } else if (cfg.graph.enabled && cfg.graph.useInRecall && results.length > 0) {
      // Legacy flat-score graph traversal (backward compatible, no path annotation).
      const initialIds = new Set(results.map((r) => r.entry.id));
      const connectedIds = factsDb.getConnectedFactIds([...initialIds], cfg.graph.maxTraversalDepth, {
        hubDegreeCap: cfg.graph.hubDegreeCap,
      });
      const extraIds = connectedIds.filter((id) => !initialIds.has(id));
      const getByIdOpts = asOfSec != null || scopeFilter ? { asOf: asOfSec, scopeFilter } : undefined;
      for (const id of extraIds) {
        const entry = factsDb.getById(id, getByIdOpts as { asOf?: number; scopeFilter?: ScopeFilter });
        if (entry) {
          results.push({ entry, score: 0.45, backend: "sqlite" });
        }
      }
      results.sort((a, b) => b.score - a.score);
      results = results.slice(0, limit);
    }

    const retrievalExplanation = (() => {
      if (!shouldUseConstrainedMode || !constrainedFilters) return undefined;
      const filterPairs = Object.entries(constrainedFilters)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${String(value)}`);
      return {
        mode: "constrained-recall" as const,
        contract: "filter → rank → hydrate",
        filterBasis: filterPairs,
        rankBasis:
          "semantic rank inside the structured candidate set (with hydrated provenance/context in the final result)",
      };
    })();
    const retrievalExplanationText = retrievalExplanation
      ? `Retrieval: constrained-recall (filter → rank → hydrate)\nFilter basis: ${retrievalExplanation.filterBasis.join(", ")}\nRank basis: ${retrievalExplanation.rankBasis}`
      : undefined;

    if (results.length === 0) {
      logRecall(false);
      const noResultsText = semanticWarning
        ? `No relevant memories found.\n\n⚠️ ${semanticWarning}`
        : "No relevant memories found.";
      return {
        content: [
          {
            type: "text",
            text: retrievalExplanationText ? `${retrievalExplanationText}\n\n${noResultsText}` : noResultsText,
          },
        ],
        details: {
          count: 0,
          warning: semanticWarning ?? undefined,
          retrieval: retrievalExplanation,
        },
      };
    }

    const contradictionStatus = new Map<string, boolean>();
    for (const r of results) {
      contradictionStatus.set(r.entry.id, factsDb.isContradicted(r.entry.id));
    }

    // Check integrity for verified facts (Issue #162): flag tampered results.
    const tamperStatus = new Map<string, boolean>();
    if (verificationStore && cfg.verification.enabled) {
      for (const r of results) {
        try {
          const report = verificationStore.checkIntegrity(r.entry.id);
          if (report.checked > 0 && !report.valid) {
            tamperStatus.set(r.entry.id, true);
          }
        } catch {
          // Don't block retrieval on integrity check failure
        }
      }
    }

    logRecall(true);
    const text = results
      .map((r, i) => {
        const contradicted = contradictionStatus.get(r.entry.id) ?? false;
        const contradictedPrefix = contradicted ? "[⚠️ CONTRADICTED] " : "";
        const tampered = tamperStatus.get(r.entry.id) ?? false;
        const tamperedPrefix = tampered ? "[⚠️ TAMPERED] " : "";
        const meta = expansionMeta.get(r.entry.id);
        const expansionSuffix =
          meta && meta.expansionSource === "graph"
            ? ` [graph+${meta.hopCount}hop${meta.linkPath ? `: ${meta.linkPath}` : ""}]`
            : "";
        const whySuffix = r.entry.why ? `\n   Why: ${r.entry.why}` : "";
        return `${i + 1}. [${r.backend}/${r.entry.category}] ${contradictedPrefix}${tamperedPrefix}${r.entry.text} (${(r.score * 100).toFixed(0)}%)${expansionSuffix}${whySuffix}`;
      })
      .join("\n");

    const sanitized = results.map((r) => {
      const meta = expansionMeta.get(r.entry.id);
      return {
        id: r.entry.id,
        text: r.entry.text,
        why: r.entry.why ?? undefined,
        category: r.entry.category,
        entity: r.entry.entity,
        importance: r.entry.importance,
        score: r.score,
        backend: r.backend,
        tags: r.entry.tags?.length ? r.entry.tags : undefined,
        sourceDate: r.entry.sourceDate ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10) : undefined,
        contradicted: contradictionStatus.get(r.entry.id) || undefined,
        accessCount: r.entry.accessCount ?? 0,
        lastAccessedAt: r.entry.lastAccessedAt ?? null,
        ...(meta
          ? {
              expansionSource: meta.expansionSource,
              hopCount: meta.hopCount,
              linkPath: meta.linkPath || undefined,
            }
          : {}),
      };
    });

    auditAppend({
      agentId: agentIdForAudit(),
      action: "memory_recall",
      target: query ? `query="${query.slice(0, 160)}"` : undefined,
      outcome: "success",
      durationMs: Date.now() - recallStartedAt,
      sessionId: api.context?.sessionId ?? undefined,
      context: { count: results.length },
    });

    return {
      content: [
        {
          type: "text",
          text: `${retrievalExplanationText ? `${retrievalExplanationText}\n\n` : ""}Found ${results.length} memories:\n\n${text}${semanticWarning ? `\n\n⚠️ ${semanticWarning}` : ""}`,
        },
      ],
      details: {
        count: results.length,
        memories: sanitized,
        warning: semanticWarning ?? undefined,
        retrieval: retrievalExplanation,
      },
    };
  }

  if (cfg.procedures.enabled) {
    api.registerTool(
      {
        name: "memory_recall_procedures",
        label: "Recall Procedures",
        description:
          "Search for learned procedures (positive: what worked; negative: known failures) matching a task description.",
        parameters: Type.Object({
          taskDescription: Type.String({
            description: "What you are trying to do (e.g. 'check Moltbook', 'HA health checks')",
          }),
          limit: Type.Optional(Type.Number({ description: "Max procedures to return (default: 5)" })),
          agentId: Type.Optional(
            Type.String({
              description: "⚠️ SECURITY: Caller-controlled parameter. Filter procedures for specific agent.",
            }),
          ),
          userId: Type.Optional(
            Type.String({
              description: "⚠️ SECURITY: Caller-controlled parameter. Filter procedures for specific user.",
            }),
          ),
          sessionId: Type.Optional(
            Type.String({
              description: "⚠️ SECURITY: Caller-controlled parameter. Filter procedures for specific session.",
            }),
          ),
          confirmCrossTenantScope: Type.Optional(
            Type.Boolean({
              description:
                "When multiAgent.trustToolScopeParams is true, set true to confirm intentional cross-tenant scope use of userId/agentId/sessionId (#874).",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const {
              taskDescription,
              limit = 5,
              agentId,
              userId,
              sessionId,
              confirmCrossTenantScope,
            } = params as {
              taskDescription: string;
              limit?: number;
              agentId?: string;
              userId?: string;
              sessionId?: string;
              confirmCrossTenantScope?: boolean;
            };
            const q =
              typeof taskDescription === "string" && taskDescription.trim().length > 0 ? taskDescription.trim() : null;
            if (!q) {
              return {
                content: [{ type: "text" as const, text: "Provide a task description to recall procedures." }],
                details: { count: 0 },
              };
            }

            // Build scope filter (same logic as memory_recall)
            const scopeFilter = buildToolScopeFilter(
              {
                userId: sanitizeScopeParam("userId", userId),
                agentId: sanitizeScopeParam("agentId", agentId),
                sessionId: sanitizeScopeParam("sessionId", sessionId),
                confirmCrossTenantScope,
              },
              currentAgentIdRef.value,
              cfg,
            );

            const procedures = factsDb.searchProcedures(
              q,
              limit,
              cfg.distill?.reinforcementProcedureBoost ?? 0.1,
              scopeFilter,
            );
            const negatives = factsDb.getNegativeProceduresMatching(q, 3, scopeFilter);
            const lines: string[] = [];
            const positiveList = procedures.filter((p) => p.procedureType === "positive");
            if (positiveList.length > 0) {
              lines.push("Last time this worked:");
              for (const p of positiveList) {
                let recipe: unknown;
                try {
                  recipe = JSON.parse(p.recipeJson);
                } catch (err) {
                  capturePluginError(err as Error, {
                    operation: "parse-recipe",
                    severity: "info",
                    subsystem: "tools",
                  });
                  recipe = [];
                }
                const steps = Array.isArray(recipe)
                  ? (recipe as Array<{ tool?: string; args?: Record<string, unknown> }>)
                      .map(
                        (s) =>
                          s.tool +
                          (s.args && Object.keys(s.args).length > 0 ? `(${JSON.stringify(s.args).slice(0, 80)}…)` : ""),
                      )
                      .join(" → ")
                  : p.recipeJson.slice(0, 200);
                const rate = p.successRate !== undefined ? `, rate ${(p.successRate * 100).toFixed(0)}%` : "";
                const ver = p.version !== undefined ? `, v${p.version}` : "";
                const outcome = p.lastOutcome === "failure" ? " ⚠️" : p.lastOutcome === "success" ? " ✅" : "";
                lines.push(
                  `- ${p.taskPattern.slice(0, 80)}…: ${steps} (validated ${p.successCount}x${rate}${ver}${outcome})`,
                );
                if (p.avoidanceNotes && p.avoidanceNotes.length > 0) {
                  for (const note of p.avoidanceNotes.slice(0, 2)) {
                    lines.push(`  ⚠ ${note}`);
                  }
                }
              }
            }
            if (negatives.length > 0) {
              lines.push("");
              lines.push("⚠️ Known issues (avoid):");
              for (const p of negatives) {
                let recipe: unknown;
                try {
                  recipe = JSON.parse(p.recipeJson);
                } catch (err) {
                  capturePluginError(err as Error, {
                    operation: "parse-recipe",
                    severity: "info",
                    subsystem: "tools",
                  });
                  recipe = [];
                }
                const steps = Array.isArray(recipe)
                  ? (recipe as Array<{ tool?: string }>)
                      .map((s) => s.tool)
                      .filter(Boolean)
                      .join(" → ")
                  : "";
                const ver = p.version !== undefined ? ` (v${p.version})` : "";
                lines.push(`- ${p.taskPattern.slice(0, 80)}… ${steps ? `(${steps})` : ""}${ver}`);
                if (p.avoidanceNotes && p.avoidanceNotes.length > 0) {
                  for (const note of p.avoidanceNotes.slice(0, 2)) {
                    lines.push(`  ⚠ ${note}`);
                  }
                }
              }
            }
            if (lines.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No procedures found for this task." }],
                details: { count: 0 },
              };
            }
            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: {
                count: positiveList.length + negatives.length,
                procedures: positiveList.length,
                warnings: negatives.length,
              },
            };
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "memory",
              operation: "memory-recall-procedures",
              phase: "runtime",
            });
            throw err;
          }
        },
      },
      { name: "memory_recall_procedures" },
    );

    // Procedure feedback loop (#782)
    api.registerTool(
      {
        name: "memory_procedure_feedback",
        label: "Procedure Feedback",
        description:
          "Record the outcome of using a procedure — success or failure. On failure, bumps the procedure version, logs the failure context, and creates an episode record. On success, records the validation. Use this whenever a procedure from memory_recall_procedures is attempted.",
        parameters: Type.Object({
          procedureId: Type.String({ description: "ID of the procedure that was used" }),
          success: Type.Boolean({ description: "true if the procedure succeeded, false if it failed" }),
          context: Type.Optional(
            Type.String({
              description: "What happened — error message, environment notes, or a summary of the outcome.",
            }),
          ),
          failedAtStep: Type.Optional(
            Type.Number({
              description: "If failure: which step number failed (1-based).",
            }),
          ),
          duration: Type.Optional(
            Type.Number({
              description: "Optional: how long the procedure took in milliseconds.",
            }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              description: "Optional tags to associate with the episode (e.g. 'production', 'doris').",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const { procedureId, success, context, failedAtStep, duration, tags } = params as {
              procedureId: string;
              success: boolean;
              context?: string;
              failedAtStep?: number;
              duration?: number;
              tags?: string[];
            };

            const result = factsDb.procedureFeedback({
              procedureId,
              success,
              context,
              failedAtStep,
              duration,
              tags,
            });

            if (!result) {
              return {
                content: [{ type: "text" as const, text: `Procedure not found: ${procedureId}` }],
                details: { success: false, error: "procedure_not_found" },
              };
            }

            const lines: string[] = [];
            if (success) {
              lines.push(
                `✅ Procedure validated (now ${result.successCount} successes, confidence: ${(result.confidence ?? 0).toFixed(2)})`,
              );
            } else {
              lines.push(
                `❌ Procedure failure recorded (now ${result.failureCount} failures, version ${result.version ?? 1}, confidence: ${(result.confidence ?? 0).toFixed(2)})`,
              );
              if (context) lines.push(`  Context: ${context}`);
              if (result.avoidanceNotes && result.avoidanceNotes.length > 0) {
                lines.push(`  Avoidance notes: ${result.avoidanceNotes.join("; ")}`);
              }
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: {
                success: true,
                procedureId: result.id,
                version: result.version,
                outcome: success ? "success" : "failure",
                successCount: result.successCount,
                failureCount: result.failureCount,
                successRate: result.successRate,
              },
            };
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "memory",
              operation: "memory-procedure-feedback",
              phase: "runtime",
            });
            throw err;
          }
        },
      },
      { name: "memory_procedure_feedback" },
    );
  }

}
