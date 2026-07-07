/**
 * Memory Tool Registrations
 *
 * Tool definitions for memory recall, storage, promotion, and deletion.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import type { RetrievalConfig } from "../../config.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { guardAgainstWrapperArgsDropped } from "../../services/tool-args-guard.js";
import { expandGraph, formatLinkPath, type GraphExpandedResult } from "../../services/graph-retrieval.js";
import { formatNarrativeRange, recallNarrativeSummaries } from "../../services/narrative-recall.js";
import { QueryExpander } from "../../services/query-expander.js";
import { resolveRecallRrfStrategies } from "../../services/recall-rrf-strategies.js";
import {
  resolveConstrainedRetrievalPolicy,
  resolveExplicitDeepRetrievalPolicy,
  type ExplicitDeepRetrievalPolicy,
} from "../../services/retrieval-mode-policy.js";
import { buildExplicitSemanticQueryVector, runExplicitDeepRetrieval } from "../../services/retrieval-orchestrator.js";
import {
  runMultiVaultExplicitDeepRetrieval,
  type MultiVaultRetrievalResult,
} from "../../services/multi-vault-retrieval.js";
import { runScopedFtsVectorFallback } from "../../services/retrieval-scoped-fallback.js";
import { searchFts } from "../../services/fts-search.js";
import {
  isInQuietWindow,
  listWorkerLeases,
  quietWindowEndEpochSec,
  resolveWorkerLeasesConfig,
} from "../../services/worker-lease.js";
import { emitFeatureTelemetry } from "../../services/feature-telemetry.js";
import { executeProcedureFeedbackTool } from "../../services/procedure-feedback-tool.js";
import { inferEntityFilterFromQuery, inferRetrievalModeFromQuery } from "../../services/retrieval-mode-selector.js";
import {
  getFactIdsForEntitySurfaces,
  loadKnownEntitySurfaces,
  matchEntitySurfacesInText,
} from "../../services/entity-retrieval.js";
import {
  formatMemoryRecallToolLine,
  memoryRecallToolBoundaryPrefix,
  sanitizeMemoryField,
  sanitizeProcedureText,
} from "../../services/recalled-context-assembler.js";
import type { MemoryEntry, ScopeFilter, SearchResult } from "../../types/memory.js";
import { getSessionLogFileSuffix } from "../../utils/constants.js";
import { formatDateUtc, formatTimestampUtc } from "../../utils/dates.js";
import { getProgressiveIndexIds, resolveProgressiveIndexSessionKey } from "../../utils/progressive-index-session.js";
import { parseSourceDate } from "../../utils/dates.js";
import { embedCallWithTimeoutAndRetry } from "../../utils/embed-call.js";
import type { MemoryToolRuntime } from "./runtime.js";
import { resolveToolVaultBackends, listToolVaultHandles, groupByResultVault } from "./vault-resolve.js";

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
    progressiveIndexBySession,
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
    issueStore,
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
        vault: Type.Optional(
          Type.String({ description: "Named vault from plugin config vaults map, or 'all' to fan out across vaults" }),
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
        mode: Type.Optional(
          Type.Union([Type.Literal("semantic"), Type.Literal("hybrid"), Type.Literal("keyword")], {
            description:
              'Recall mode. When omitted, uses retrieval.defaultRecallMode from config (default: "hybrid" for backward compatibility with multi-strategy RRF fusion).',
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
        // Security invariant: if the caller specifies a sessionId, it MUST match the
        // authenticated context session. If the caller does NOT specify a sessionId,
        // we fall back to cross-session timeline recall (recency-windowed, default
        // 14 days) so the tool still works in OpenClaw gateway invocations that do
        // not inject an authenticated sessionId. We only reject when a caller
        // supplied sessionId cannot be verified against the authenticated context.
        if (requestedSessionId) {
          if (!contextSessionId) {
            throw new Error(
              "memory_recall_timeline: a sessionId parameter was supplied but no authenticated " +
                "session context is available; pass the same sessionId the gateway exposed in " +
                "api.context.sessionId, or omit sessionId to recall across recent sessions.",
            );
          }
          if (requestedSessionId !== contextSessionId) {
            throw new Error("memory_recall_timeline sessionId must match the authenticated session context");
          }
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
          const scopeMsg = sessionId
            ? `for session ${sessionId}`
            : "across recent sessions (last ~14 days)";
          return {
            content: [
              {
                type: "text" as const,
                text: `No narrative summary found ${scopeMsg}.`,
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
              periodStart: formatTimestampUtc(summary.periodStart),
              periodEnd: formatTimestampUtc(summary.periodEnd),
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
        const requestedSessionId =
          typeof params.sessionId === "string" && params.sessionId.trim().length > 0 ? params.sessionId.trim() : null;
        const contextSessionId =
          typeof api.context?.sessionId === "string" && api.context.sessionId.trim().length > 0
            ? api.context.sessionId.trim()
            : null;
        // Session observability is per-session and requires authenticated context.
        if (!contextSessionId) {
          throw new Error(
            "memory_session_observability requires an authenticated session context " +
              "(api.context.sessionId). Invoke the tool from an authenticated OpenClaw session.",
          );
        }
        if (requestedSessionId && requestedSessionId !== contextSessionId) {
          throw new Error("memory_session_observability sessionId must match the authenticated session context");
        }
        const sessionId = requestedSessionId ?? contextSessionId;
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
  function keywordRecallResults(
    query: string,
    recallLimit: number,
    opts: {
      entity?: string;
      tag?: string;
      includeSuperseded?: boolean;
      asOfSec?: number;
      scopeFilter?: ScopeFilter;
    },
    // Defaults to the plugin's primary vault; callers that resolved a specific vault (the
    // `vault` param on memory_recall) must pass that vault's factsDb explicitly — otherwise
    // this silently searches the wrong vault's database (#storage-recall-review).
    searchFactsDb: typeof factsDb = factsDb,
  ): SearchResult[] {
    const ftsHits =
      typeof searchFactsDb.getRawDb === "function"
        ? searchFts(searchFactsDb.getRawDb(), query, {
            limit: recallLimit,
            entityFilter: opts.entity,
            tagFilter: opts.tag,
            includeSuperseded: opts.includeSuperseded,
            asOf: opts.asOfSec,
            // Filter by scope inside searchFts's own SQL (before its internal row limit), not
            // just here afterward -- otherwise scoped-out hits would still consume slots in the
            // capped FTS candidate window, silently under-returning results in multi-tenant
            // deployments even though more in-scope matches exist beyond that window.
            scopeFilter: opts.scopeFilter,
          })
        : [];
    const out: SearchResult[] = [];
    for (const hit of ftsHits) {
      const getByIdOpts =
        opts.asOfSec != null || opts.scopeFilter
          ? ({ asOf: opts.asOfSec, scopeFilter: opts.scopeFilter } as { asOf?: number; scopeFilter?: ScopeFilter })
          : undefined;
      const entry = searchFactsDb.getById(hit.factId, getByIdOpts);
      if (entry) {
        // FTS5 rank is negative (closer to 0 is better); invert for descending sort.
        out.push({ entry, score: -hit.rank, backend: "sqlite" });
      }
    }
    return out.slice(0, recallLimit);
  }

  async function memoryRecallImpl(params: Record<string, unknown>) {
    const dropped = guardAgainstWrapperArgsDropped("memory_recall", params, api.logger);
    if (dropped) return dropped;
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
      mode: recallModeParam,
      vault: vaultParam,
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
      mode?: "semantic" | "hybrid" | "keyword";
      vault?: string;
    };
    const recallMode =
      recallModeParam === "semantic" || recallModeParam === "hybrid" || recallModeParam === "keyword"
        ? recallModeParam
        : cfg.retrieval.defaultRecallMode;
    let recallFallback = false;
    const recallBudgetMs = cfg.retrieval.recallLatencyWarnMs;
    const normalizeOptionalString = (value: unknown): string | undefined => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const vaultBackends = resolveToolVaultBackends(runtime, normalizeOptionalString(vaultParam));
    const recallFactsDb = vaultBackends.factsDb;
    const recallVectorDb = vaultBackends.vectorDb;
    const vaultHandles = listToolVaultHandles(runtime, normalizeOptionalString(vaultParam));
    const entity = normalizeOptionalString(entityParam);
    const tag = normalizeOptionalString(tagParam);
    const category = normalizeOptionalString(categoryParam);
    const source = normalizeOptionalString(sourceParam);
    const verificationTier = normalizeOptionalString(verificationTierParam);
    const sourceSession = normalizeOptionalString(sourceSessionParam);
    const asOfSec = (asOfParam != null && asOfParam !== "" ? parseSourceDate(asOfParam) : undefined) ?? undefined;

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
      const maybeFactsDb = recallFactsDb as { logRecall?: (hit: boolean) => void };
      if (typeof maybeFactsDb.logRecall === "function") {
        try {
          maybeFactsDb.logRecall(hit);
        } catch {
          // Non-fatal: recall logging should never break recall
        }
      }
    };

    // Fetch by id (fact id or 1-based index from last progressive index for this session)
    if (idParam !== undefined && idParam !== null && idParam !== "") {
      const progressiveSessionKey = resolveProgressiveIndexSessionKey(api);
      const sessionProgressiveIndexIds = getProgressiveIndexIds(progressiveIndexBySession, progressiveSessionKey);
      let factId: string | null = null;
      if (typeof idParam === "number") {
        const idx = Math.floor(idParam);
        if (idx >= 1 && idx <= sessionProgressiveIndexIds.length) {
          factId = sessionProgressiveIndexIds[idx - 1] ?? null;
        }
      } else if (typeof idParam === "string" && idParam.trim().length > 0) {
        const trimmed = idParam.trim();
        // Check if it's a numeric string (progressive index position)
        if (/^\d+$/.test(trimmed)) {
          const idx = Number.parseInt(trimmed, 10);
          if (idx >= 1 && idx <= sessionProgressiveIndexIds.length) {
            factId = sessionProgressiveIndexIds[idx - 1] ?? null;
          }
        } else {
          // Treat as fact ID
          factId = trimmed;
        }
      }
      if (factId) {
        const getByIdOpts = { asOf: asOfSec, scopeFilter };
        const entry = recallFactsDb.getById(
          factId,
          asOfSec != null || scopeFilter ? (getByIdOpts as { asOf?: number; scopeFilter?: ScopeFilter }) : undefined,
        );
        if (entry) {
          // Access boost — update recall_count and last_accessed on fetch by id
          recallFactsDb.refreshAccessedFacts([entry.id]);
          logRecall(true);
          const line = formatMemoryRecallToolLine(entry);
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
                text: `${memoryRecallToolBoundaryPrefix()}Memory (id: ${entry.id}):\n\n${line}`,
              },
            ],
            details: {
              count: 1,
              memories: [
                {
                  id: entry.id,
                  text: sanitizeMemoryField(entry.text),
                  why: entry.why ? sanitizeMemoryField(entry.why) : undefined,
                  category: sanitizeMemoryField(entry.category),
                  entity: entry.entity ? sanitizeMemoryField(entry.entity) : entry.entity,
                  importance: entry.importance,
                  score: 1,
                  backend: "sqlite" as const,
                  tags: entry.tags?.length ? entry.tags : undefined,
                  sourceDate: entry.sourceDate ? formatDateUtc(entry.sourceDate) : undefined,
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
                ? `No memory at index ${idParam}. Use a number between 1 and ${sessionProgressiveIndexIds.length} from the index, or provide a fact id.`
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
            text:
              "Provide a search query or an id (fact id or index from the memory index) to recall memories. " +
              "If you intended to store something, use memory_store instead. " +
              "If this error repeats with empty args, retry via top-level tools (Tool Search wrapper bug #96115).",
          },
        ],
        details: { count: 0, error: "missing_query_or_id" },
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

    if (recallMode === "keyword") {
      let results = keywordRecallResults(
        query,
        limit,
        {
          entity,
          tag,
          includeSuperseded,
          asOfSec,
          scopeFilter,
        },
        recallFactsDb,
      );
      if (!includeCold && results.length > 0) {
        const coldFilterOpts = asOfSec != null || scopeFilter ? { asOf: asOfSec, scopeFilter } : undefined;
        results = results.filter((r) => {
          const full = recallFactsDb.getById(r.entry.id, coldFilterOpts);
          return full && full.tier !== "cold";
        });
      }
      logRecall(results.length > 0);
      const lines = results.map((r) => formatMemoryRecallToolLine(r.entry));
      return {
        content: [
          {
            type: "text" as const,
            text:
              results.length > 0
                ? `${memoryRecallToolBoundaryPrefix()}Found ${results.length} keyword match(es):\n\n${lines.join("\n\n")}`
                : "No memories found for keyword query.",
          },
        ],
        details: {
          count: results.length,
          mode: "keyword",
          fallback: recallFallback,
          memories: results.map((r) => ({
            id: r.entry.id,
            text: sanitizeMemoryField(r.entry.text),
            score: r.score,
            backend: r.backend,
          })),
        },
      };
    }

    const hasAdditionalConstrainedFilters = Boolean(
      category || source || verificationTier || validFromSec != null || validUntilSec != null || sourceSession,
    );
    const inferredMode = inferRetrievalModeFromQuery(query, {
      entity,
      tag,
      category,
      source,
      verificationTier,
      sourceSession,
      validFromSec,
      validUntilSec,
    });
    const inferredEntity = entity ?? inferEntityFilterFromQuery(query);
    const shouldUseConstrainedMode =
      retrievalMode === "constrained-recall" ||
      (!retrievalMode && (hasAdditionalConstrainedFilters || inferredMode === "constrained-recall"));
    const effectiveMode = shouldUseConstrainedMode
      ? "constrained-recall"
      : (retrievalMode ?? inferredMode ?? "explicit-deep");
    const constrainedFilters = shouldUseConstrainedMode
      ? {
          ...(inferredEntity ? { entity: inferredEntity } : {}),
          ...(tag ? { tag } : {}),
          ...(category ? { category } : {}),
          ...(source ? { source } : {}),
          ...(verificationTier ? { verificationTier } : {}),
          ...(typeof validFromSec === "number" ? { validFromSec: Math.floor(validFromSec) } : {}),
          ...(typeof validUntilSec === "number" ? { validUntilSec: Math.floor(validUntilSec) } : {}),
          ...(sourceSession ? { sourceSession } : {}),
        }
      : undefined;

    if (shouldUseConstrainedMode && Object.keys(constrainedFilters ?? {}).length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "constrained-recall requires at least one filter (entity, tag, category, source, verificationTier, sourceSession, or validFrom/validUntil).",
          },
        ],
        details: { count: 0, error: "missing_constrained_filters" },
      };
    }

    // Entity-layer pre-filter: when NER tables match query surfaces, narrow constrained candidates.
    let entityLayerFactIds: string[] | undefined;
    if (shouldUseConstrainedMode && typeof recallFactsDb.getRawDb === "function") {
      try {
        const surfaces = loadKnownEntitySurfaces(recallFactsDb.getRawDb(), 300);
        const matched = matchEntitySurfacesInText(query, surfaces);
        if (matched.length > 0) {
          entityLayerFactIds = getFactIdsForEntitySurfaces(recallFactsDb.getRawDb(), matched, 80);
        }
      } catch {
        /* non-fatal */
      }
    }

    // Entity-targeted lookup is useful for legacy explicit recall, but it bypasses
    // filter → rank → hydrate semantics, so disable it in constrained mode.
    let entityResults: SearchResult[] = [];
    let recallOutcome: "success" | "degraded_fallback" = "success";
    if (entity && !shouldUseConstrainedMode) {
      entityResults = recallFactsDb.lookup(entity, undefined, tag, { ...recallOpts, limit: 100 });
    }

    // Explicit/deep retrieval owns richer semantic prep, including optional HyDE.
    let queryVector: number[] | null = null;
    let semanticWarning: string | null = null;

    // RRF multi-strategy retrieval pipeline (Issue #152)
    // Legacy tag-only recall skips semantic search; constrained mode keeps semantic ranking
    // because tag/entity/category/etc. are applied before ranking inside the candidate set.
    let results: SearchResult[] = [];
    // Populated only for multi-vault fan-out (vaultHandles.length > 1): maps each RRF result's
    // factId to the vault it actually came from, so post-RRF per-ID refinements below (cold-tier
    // filter, asOf filter) look it up in the right vault's factsDb instead of unconditionally
    // recallFactsDb (the resolved `vault` param / default vault), which would silently drop every
    // non-default-vault result whenever includeCold is false (the default).
    let vaultByFactId: Map<string, string> | undefined;
    const getByIdInResultVault = (
      id: string,
      opts?: { asOf?: number; scopeFilter?: ScopeFilter },
    ): MemoryEntry | null => {
      const vaultName = vaultByFactId?.get(id);
      if (vaultName) {
        const handle = vaultHandles.find((h) => h.name === vaultName);
        if (handle) return handle.factsDb.getById(id, opts);
      }
      return recallFactsDb.getById(id, opts);
    };
    const isContradictedInResultVault = (id: string): boolean => {
      const vaultName = vaultByFactId?.get(id);
      if (vaultName) {
        const handle = vaultHandles.find((h) => h.name === vaultName);
        if (handle) return handle.factsDb.isContradicted(id);
      }
      return recallFactsDb.isContradicted(id);
    };
    try {
      const useLegacyTagShortcut = Boolean(tag && !shouldUseConstrainedMode && recallMode !== "semantic");
      const rrfStrategies = resolveRecallRrfStrategies(recallMode, cfg.retrieval.strategies, useLegacyTagShortcut);
      const rrfConfig: RetrievalConfig = {
        ...cfg.retrieval,
        strategies: rrfStrategies as RetrievalConfig["strategies"],
      };
      // interactive-recall uses a different policy with its own vector prep; skip for other modes
      const effectivePolicy =
        effectiveMode !== "interactive-recall"
          ? effectiveMode === "constrained-recall"
            ? resolveConstrainedRetrievalPolicy(rrfConfig)
            : resolveExplicitDeepRetrievalPolicy(rrfConfig)
          : undefined;
      const embedPolicy =
        effectivePolicy ??
        (effectiveMode === "interactive-recall" && rrfStrategies.includes("semantic")
          ? resolveExplicitDeepRetrievalPolicy(rrfConfig)
          : undefined);
      if (!useLegacyTagShortcut && embedPolicy) {
        const vectorPrep = await buildExplicitSemanticQueryVector({
          query,
          cfg,
          embeddings,
          openai,
          pendingLLMWarnings,
          logger: api.logger,
          policy:
            embedPolicy.mode === "constrained-recall"
              ? resolveExplicitDeepRetrievalPolicy(rrfConfig)
              : (embedPolicy as ExplicitDeepRetrievalPolicy),
        });
        queryVector = vectorPrep.queryVector;
        semanticWarning = vectorPrep.warning;
        if (recallMode !== "semantic" && queryVector == null && semanticWarning) {
          recallFallback = true;
          results = keywordRecallResults(
            query,
            limit,
            { entity, tag, includeSuperseded, asOfSec, scopeFilter },
            recallFactsDb,
          );
        }
      }
      if (!recallFallback) {
        const queryExpander =
          cfg.queryExpansion?.enabled && rrfStrategies.includes("semantic")
            ? new QueryExpander(cfg.queryExpansion, openai)
            : null;
        const embedFn =
          queryVector != null
            ? (text: string) =>
                embedCallWithTimeoutAndRetry(() => embeddings.embed(text), "memory-tools:rrf-deep-retrieval")
            : null;
        const rrfOutput =
          vaultHandles.length > 1
            ? await runMultiVaultExplicitDeepRetrieval(query, queryVector, vaultHandles, {
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
                factsDbForEmbeddings: recallFactsDb,
                queryExpander: queryExpander ?? null,
                embedFn,
                rerankingConfig: cfg.reranking,
                rerankingOpenai: openai,
                adaptiveOpenai: cfg.documentGrading?.enabled ? openai : undefined,
                documentGradingConfig: cfg.documentGrading,
                issueStore: issueStore ?? null,
                ...(entityLayerFactIds?.length ? { entityLayerCandidateIds: entityLayerFactIds } : {}),
                warmTierOnly: !includeCold && cfg.memoryTiering.enabled,
              })
            : await runExplicitDeepRetrieval(
                query,
                queryVector,
                recallFactsDb.getRawDb(),
                recallVectorDb,
                recallFactsDb,
                {
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
                  factsDbForEmbeddings: recallFactsDb,
                  queryExpander: queryExpander ?? null,
                  embedFn,
                  rerankingConfig: cfg.reranking,
                  rerankingOpenai: openai,
                  adaptiveOpenai: cfg.documentGrading?.enabled ? openai : undefined,
                  documentGradingConfig: cfg.documentGrading,
                  issueStore: issueStore ?? null,
                  ...(entityLayerFactIds?.length ? { entityLayerCandidateIds: entityLayerFactIds } : {}),
                  warmTierOnly: !includeCold && cfg.memoryTiering.enabled,
                },
              );
        if ("vaultByFactId" in rrfOutput) {
          vaultByFactId = (rrfOutput as MultiVaultRetrievalResult).vaultByFactId;
        }

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
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "search",
        operation: "rrf-pipeline",
        phase: "runtime",
      });
      if (shouldUseConstrainedMode) {
        api.logger.warn(
          `memory-hybrid: constrained-recall pipeline failed — not falling back to full-corpus search: ${err}`,
        );
        results = [...entityResults];
      } else {
        api.logger.warn(`memory-hybrid: RRF pipeline failed, falling back to scoped FTS+vector merge: ${err}`);
        recallOutcome = "degraded_fallback";
        results = await runScopedFtsVectorFallback({
          query,
          limit,
          queryVector,
          factsDb: recallFactsDb,
          vectorDb: recallVectorDb,
          recallOpts,
          scopeFilter,
          warmTierOnly: !includeCold && cfg.memoryTiering.enabled,
          seedResults: entityResults,
          reinforcementBoost: cfg.distill?.reinforcementBoost ?? 0.1,
          diversityWeight: cfg.reinforcement?.diversityWeight ?? 1.0,
        });
      }
    }

    // Exclude COLD tier when includeCold is false (Lance results may include cold facts)
    if (!includeCold && results.length > 0) {
      const filtered: SearchResult[] = [];
      for (const r of results) {
        const full = getByIdInResultVault(r.entry.id);
        if (full && full.tier !== "cold") filtered.push({ ...r, entry: full });
      }
      results = filtered.slice(0, limit);
    }

    // When asOf is set, filter so only facts valid at that time (Lance results lack temporal filter)
    if (asOfSec != null && results.length > 0) {
      const filtered: SearchResult[] = [];
      for (const r of results) {
        const full = getByIdInResultVault(r.entry.id, { asOf: asOfSec });
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
      const originalBackendMap = new Map<string, "sqlite" | "lancedb">();
      for (const r of results) {
        originalBackendMap.set(r.entry.id, r.backend);
      }

      // Multi-vault fan-out: group seeds by their OWN vault and expand each group against that
      // vault's factsDb, then merge — expandGraph traverses a single factsDb's memory_links
      // table, so a shared recallFactsDb call would silently drop expansion for every
      // non-default-vault seed. In single-vault mode every seed maps to the same recallFactsDb,
      // so this is a no-op grouping (one group, unchanged behavior).
      const seedGroups = groupByResultVault(
        results.map((r) => ({ factId: r.entry.id, score: r.score, entry: r.entry })),
        (s) => s.factId,
        vaultByFactId,
        vaultHandles,
        recallFactsDb,
      );
      const expanded: GraphExpandedResult[] = [];
      for (const [vaultFactsDb, seeds] of seedGroups) {
        const { results: vaultExpanded } = expandGraph(vaultFactsDb, seeds, {
          maxDepth: depth,
          maxExpandedResults: cfg.graphRetrieval.maxExpandedResults,
          scopeFilter: scopeFilter ?? undefined,
          asOf: asOfSec ?? undefined,
          hubDegreeCap: cfg.graph.hubDegreeCap,
          hubScorePenalty: cfg.graph.hubScorePenalty,
        });
        expanded.push(...vaultExpanded);
      }

      // Re-build results from expanded output (preserves scores and dedup).
      const newResults: SearchResult[] = [];
      const seenExpandedIds = new Set<string>();
      for (const e of expanded) {
        if (seenExpandedIds.has(e.factId)) continue;
        seenExpandedIds.add(e.factId);
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
      // Same per-vault grouping as the expandGraph branch above — getConnectedFactIds/getById
      // must be called against each seed's own vault, not unconditionally recallFactsDb.
      const initialIds = new Set(results.map((r) => r.entry.id));
      const getByIdOpts = asOfSec != null || scopeFilter ? { asOf: asOfSec, scopeFilter } : undefined;
      const idGroups = groupByResultVault(initialIds, (id) => id, vaultByFactId, vaultHandles, recallFactsDb);
      for (const [vaultFactsDb, ids] of idGroups) {
        const connectedIds = vaultFactsDb.getConnectedFactIds(ids, cfg.graph.maxTraversalDepth, {
          hubDegreeCap: cfg.graph.hubDegreeCap,
        });
        for (const cid of connectedIds) {
          if (initialIds.has(cid)) continue;
          const entry = vaultFactsDb.getById(cid, getByIdOpts as { asOf?: number; scopeFilter?: ScopeFilter });
          if (entry) {
            results.push({ entry, score: 0.45, backend: "sqlite" });
            initialIds.add(cid);
          }
        }
      }
      results.sort((a, b) => b.score - a.score);
      results = results.slice(0, limit);
    }

    // The includeCold=false filter above runs BEFORE graph expansion — re-apply it, since
    // neither expandGraph() nor the legacy getConnectedFactIds()/getById() traversal above
    // checks tier, and both can append cold-tier facts reached via a warm/hot seed's links.
    if (!includeCold && results.length > 0) {
      results = results.filter((r) => r.entry.tier !== "cold").slice(0, limit);
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
      contradictionStatus.set(r.entry.id, isContradictedInResultVault(r.entry.id));
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
            ? ` [graph+${meta.hopCount}hop${meta.linkPath ? `: ${sanitizeMemoryField(meta.linkPath)}` : ""}]`
            : "";
        return formatMemoryRecallToolLine(r.entry, {
          backend: r.backend,
          linePrefix: `${i + 1}. ${contradictedPrefix}${tamperedPrefix}`,
          scorePct: `${(r.score * 100).toFixed(0)}%`,
          extraSuffix: expansionSuffix,
        });
      })
      .join("\n");

    const sanitized = results.map((r) => {
      const meta = expansionMeta.get(r.entry.id);
      return {
        id: r.entry.id,
        text: sanitizeMemoryField(r.entry.text),
        why: r.entry.why ? sanitizeMemoryField(r.entry.why) : undefined,
        category: sanitizeMemoryField(r.entry.category),
        entity: r.entry.entity ? sanitizeMemoryField(r.entry.entity) : r.entry.entity,
        importance: r.entry.importance,
        score: r.score,
        backend: r.backend,
        tags: r.entry.tags?.length ? r.entry.tags : undefined,
        sourceDate: r.entry.sourceDate ? formatDateUtc(r.entry.sourceDate) : undefined,
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
      outcome: recallOutcome === "degraded_fallback" ? "partial" : recallOutcome,
      durationMs: Date.now() - recallStartedAt,
      sessionId: api.context?.sessionId ?? undefined,
      context: {
        count: results.length,
        ...(recallOutcome === "degraded_fallback" ? { degradedFallback: true } : {}),
      },
    });

    const recallDurationMs = Date.now() - recallStartedAt;
    emitFeatureTelemetry(api.logger, {
      feature: "recall",
      operation: "memory_recall",
      durationMs: recallDurationMs,
      warnBudgetMs: recallBudgetMs,
      outcome: recallFallback || recallOutcome === "degraded_fallback" ? "degraded" : "ok",
      fields: {
        mode: recallMode,
        fallback: recallFallback || recallOutcome === "degraded_fallback",
        result_count: results.length,
        query_len: query.length,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: `${retrievalExplanationText ? `${retrievalExplanationText}\n\n` : ""}${memoryRecallToolBoundaryPrefix()}Found ${results.length} memories:\n\n${text}${semanticWarning ? `\n\n⚠️ ${semanticWarning}` : ""}`,
        },
      ],
      details: {
        count: results.length,
        memories: sanitized,
        warning: semanticWarning ?? undefined,
        retrieval: retrievalExplanation,
        mode: recallMode,
        fallback: recallFallback || recallOutcome === "degraded_fallback",
      },
    };
  }

  api.registerTool(
    {
      name: "memory_keyword_recall",
      label: "Keyword Memory Recall",
      description: "Pure BM25/FTS5 keyword search over facts (no embedding round-trip).",
      parameters: Type.Object({
        query: Type.String({ description: "Search query (exact phrase and proper-noun friendly)." }),
        limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        entity: Type.Optional(Type.String({ description: "Optional entity filter." })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tag filters." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const dropped = guardAgainstWrapperArgsDropped("memory_keyword_recall", params, api.logger);
        if (dropped) return dropped;
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) {
          return { content: [{ type: "text", text: "Provide a query." }], details: { count: 0 } };
        }
        const limit =
          typeof params.limit === "number" && params.limit > 0 ? Math.min(100, Math.floor(params.limit)) : 10;
        const entity = typeof params.entity === "string" ? params.entity.trim() : undefined;
        const tag = Array.isArray(params.tags) && params.tags.length > 0 ? String(params.tags[0]) : undefined;
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
        const results = keywordRecallResults(query, limit, { entity, tag, scopeFilter });
        const lines = results.map((r) => formatMemoryRecallToolLine(r.entry));
        return {
          content: [
            {
              type: "text",
              text:
                results.length > 0
                  ? `Found ${results.length} keyword match(es):\n\n${lines.join("\n\n")}`
                  : "No keyword matches.",
            },
          ],
          details: {
            count: results.length,
            mode: "keyword",
            memories: results.map((r) => ({
              id: r.entry.id,
              text: sanitizeMemoryField(r.entry.text),
              score: r.score,
              entity: r.entry.entity,
              key: r.entry.key,
              tags: r.entry.tags,
            })),
          },
        };
      },
    },
    { name: "memory_keyword_recall" },
  );

  api.registerTool(
    {
      name: "memory_worker_status",
      label: "Worker Lease Status",
      description: "Returns current background worker lease holders, expiry, and eligibility windows.",
      parameters: Type.Object({}),
      async execute() {
        const workerLeases = resolveWorkerLeasesConfig(cfg.maintenance.orchestrator?.workerLeases);
        const now = Math.floor(Date.now() / 1000);
        if (typeof factsDb.getRawDb !== "function") {
          return {
            content: [{ type: "text", text: "Worker lease status unavailable (factsDb has no raw DB handle)." }],
            details: { workers: [] },
          };
        }
        const leases = listWorkerLeases(factsDb.getRawDb());
        const workers = leases.map((l) => {
          const quietEnd = isInQuietWindow(workerLeases) ? quietWindowEndEpochSec(workerLeases) : null;
          const nextEligibleAt = Math.max(l.expiresAt, quietEnd ?? 0);
          const staleThreshold = workerLeases.heartbeatIntervalSeconds * 2;
          return {
            workerId: l.workerId,
            ownerSessionId: l.ownerSessionId,
            pid: l.pid,
            host: l.host,
            acquiredAt: l.acquiredAt,
            lastHeartbeatAt: l.lastHeartbeatAt,
            expiresAt: l.expiresAt,
            nextEligibleAt,
            stateJson: l.stateJson,
            isStale: l.lastHeartbeatAt < now - staleThreshold,
          };
        });
        return {
          content: [
            {
              type: "text",
              text:
                workers.length === 0
                  ? "No active worker leases."
                  : workers.map((w) => `${w.workerId}: owner=${w.ownerSessionId} expires=${w.expiresAt}`).join("\n"),
            },
          ],
          details: { workers },
        };
      },
    },
    { name: "memory_worker_status" },
  );

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
                      .map((s) => {
                        const tool = sanitizeProcedureText(String(s.tool ?? ""));
                        if (!tool) return "";
                        const args =
                          s.args && Object.keys(s.args).length > 0
                            ? `(${sanitizeProcedureText(JSON.stringify(s.args).slice(0, 80))}…)`
                            : "";
                        return `${tool}${args}`;
                      })
                      .filter(Boolean)
                      .join(" → ")
                  : sanitizeProcedureText(p.recipeJson.slice(0, 200));
                const rate = p.successRate !== undefined ? `, rate ${(p.successRate * 100).toFixed(0)}%` : "";
                const ver = p.version !== undefined ? `, v${p.version}` : "";
                const outcome = p.lastOutcome === "failure" ? " ⚠️" : p.lastOutcome === "success" ? " ✅" : "";
                const pattern = sanitizeProcedureText(p.taskPattern);
                lines.push(
                  `- ${pattern.slice(0, 80)}…: ${steps} (validated ${p.successCount}x${rate}${ver}${outcome})`,
                );
                if (p.avoidanceNotes && p.avoidanceNotes.length > 0) {
                  for (const note of p.avoidanceNotes.slice(0, 2)) {
                    lines.push(`  ⚠ ${sanitizeProcedureText(note)}`);
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
                      .map((s) => sanitizeProcedureText(String(s.tool ?? "")))
                      .filter(Boolean)
                      .join(" → ")
                  : "";
                const ver = p.version !== undefined ? ` (v${p.version})` : "";
                const pattern = sanitizeProcedureText(p.taskPattern);
                lines.push(`- ${pattern.slice(0, 80)}… ${steps ? `(${steps})` : ""}${ver}`);
                if (p.avoidanceNotes && p.avoidanceNotes.length > 0) {
                  for (const note of p.avoidanceNotes.slice(0, 2)) {
                    lines.push(`  ⚠ ${sanitizeProcedureText(note)}`);
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
              content: [
                {
                  type: "text" as const,
                  text: `${memoryRecallToolBoundaryPrefix()}${lines.join("\n")}`,
                },
              ],
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

    // Procedure feedback loop (#782, #1965–#1967)
    api.registerTool(
      {
        name: "memory_procedure_feedback",
        label: "Procedure Feedback",
        description:
          "Record success/failure for a procedure that already exists in procedural memory. Prerequisite: call memory_recall_procedures first and use the returned id. Do not invent slug ids. For first-time run capture without a stored procedure, set registerIfMissing with taskPattern and steps, or use memory_record_episode (+ memory_store for facts). Procedures are also extracted asynchronously by maintenance extract-procedures.",
        parameters: Type.Object({
          procedureId: Type.String({
            description:
              "Exact id from memory_recall_procedures or the procedures DB — not an invented slug unless registerIfMissing is true.",
          }),
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
          registerIfMissing: Type.Optional(
            Type.Boolean({
              description:
                "When true and procedureId is not found: register a draft procedure from taskPattern + steps, then record feedback. Use for first successful greenfield runs.",
            }),
          ),
          taskPattern: Type.Optional(
            Type.String({
              description: "Required with registerIfMissing: short label for the workflow (max ~300 chars).",
            }),
          ),
          steps: Type.Optional(
            Type.Array(
              Type.Object({
                tool: Type.String({ description: "Tool or action name for this step" }),
                summary: Type.Optional(Type.String()),
                args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
              }),
              { description: "Required with registerIfMissing: ordered steps for the procedure recipe." },
            ),
          ),
          procedureType: Type.Optional(
            Type.Union([Type.Literal("positive"), Type.Literal("negative")], {
              description: "Procedure type when registerIfMissing creates a new row (default: derived from success).",
            }),
          ),
          agentId: Type.Optional(
            Type.String({
              description: "⚠️ SECURITY: Caller-controlled parameter. Restrict feedback to a specific agent's scope.",
            }),
          ),
          userId: Type.Optional(
            Type.String({
              description: "⚠️ SECURITY: Caller-controlled parameter. Restrict feedback to a specific user's scope.",
            }),
          ),
          sessionId: Type.Optional(
            Type.String({
              description: "⚠️ SECURITY: Caller-controlled parameter. Restrict feedback to a specific session's scope.",
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
              procedureId,
              success,
              context,
              failedAtStep,
              duration,
              tags,
              registerIfMissing,
              taskPattern,
              steps,
              procedureType,
              agentId,
              userId,
              sessionId,
              confirmCrossTenantScope,
            } = params as {
              procedureId: string;
              success: boolean;
              context?: string;
              failedAtStep?: number;
              duration?: number;
              tags?: string[];
              registerIfMissing?: boolean;
              taskPattern?: string;
              steps?: Array<{ tool: string; summary?: string; args?: Record<string, unknown> }>;
              procedureType?: "positive" | "negative";
              agentId?: string;
              userId?: string;
              sessionId?: string;
              confirmCrossTenantScope?: boolean;
            };

            // Same scope resolution as memory_recall_procedures — restricts feedback (and the
            // getProcedureById lookup behind it) to the caller's own scope bucket (#154 follow-up).
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

            return executeProcedureFeedbackTool(factsDb, {
              procedureId,
              success,
              context,
              failedAtStep,
              duration,
              tags,
              registerIfMissing,
              taskPattern,
              steps,
              procedureType,
              scopeFilter,
            });
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
