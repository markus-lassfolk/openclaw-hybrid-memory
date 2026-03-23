/**
 * Memory Tool Registrations
 *
 * Tool definitions for memory recall, storage, promotion, and deletion.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import type OpenAI from "openai";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

import type { BuildToolScopeFilterFn, FindSimilarByEmbeddingFn } from "../api/memory-plugin-api.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { EventLog } from "../backends/event-log.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import { categoryToEventType } from "../backends/event-log.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { AllEmbeddingProvidersFailed } from "../services/embeddings.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import { toFloat32Array } from "../services/embedding-registry.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import { classifyMemoryOperation } from "../services/classification.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import type { ProvenanceService } from "../services/provenance.js";
import { isCredentialLike, tryParseCredentialForVault, VAULT_POINTER_PREFIX } from "../services/auto-capture.js";
import { capturePluginError, addOperationBreadcrumb } from "../services/error-reporter.js";
import { buildExplicitSemanticQueryVector, runExplicitDeepRetrieval } from "../services/retrieval-orchestrator.js";
import { resolveExplicitDeepRetrievalPolicy } from "../services/retrieval-mode-policy.js";
import { QueryExpander } from "../services/query-expander.js";
import { storeAliases, type AliasDB } from "../services/retrieval-aliases.js";
import { expandGraph, formatLinkPath } from "../services/graph-retrieval.js";
import {
  getMemoryCategories,
  DECAY_CLASSES,
  type MemoryCategory,
  type DecayClass,
  type HybridMemoryConfig,
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
  isCompactVerbosity,
} from "../config.js";
import type { MemoryEntry, SearchResult, ScopeFilter } from "../types/memory.js";
import { MEMORY_SCOPES } from "../types/memory.js";
import { truncateForStorage } from "../utils/text.js";
import { extractTags } from "../utils/tags.js";
import { parseSourceDate } from "../utils/dates.js";
import { detectFutureDate } from "../utils/date-detector.js";
import type { VerificationStore } from "../services/verification-store.js";
import { shouldAutoVerify } from "../services/verification-store.js";
import type { VariantGenerationQueue } from "../services/contextual-variants.js";
import { UUID_REGEX } from "../utils/constants.js";
import { formatNarrativeRange, recallNarrativeSummaries } from "../services/narrative-recall.js";

export type BoundWalWriteFn = (
  operation: "store" | "update",
  data: Record<string, unknown>,
  logger: { warn: (msg: string) => void },
) => Promise<string>;

export type BoundWalRemoveFn = (id: string, logger: { warn: (msg: string) => void }) => Promise<void>;

export interface MemoryToolsContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  cfg: HybridMemoryConfig;
  aliasDb?: AliasDB | null;
  embeddings: EmbeddingProvider;
  embeddingRegistry?: EmbeddingRegistry | null;
  openai: OpenAI;
  credentialsDb: CredentialsDB | null;
  eventLog: EventLog | null;
  narrativesDb?: NarrativesDB | null;
  provenanceService?: ProvenanceService | null;
  verificationStore?: VerificationStore | null;
  lastProgressiveIndexIds: string[];
  currentAgentIdRef: { value: string | null };
  pendingLLMWarnings: PendingLLMWarnings;
  variantQueue?: VariantGenerationQueue | null;
  buildToolScopeFilter: BuildToolScopeFilterFn;
  walWrite: BoundWalWriteFn;
  walRemove: BoundWalRemoveFn;
  findSimilarByEmbedding: FindSimilarByEmbeddingFn;
}

type LegacyMemoryToolsContext = Omit<
  MemoryToolsContext,
  "buildToolScopeFilter" | "walWrite" | "walRemove" | "findSimilarByEmbedding"
> & {
  wal?: unknown;
};

function hasBoundMemoryToolHelpers(ctx: MemoryToolsContext | LegacyMemoryToolsContext): ctx is MemoryToolsContext {
  const maybe = ctx as Partial<MemoryToolsContext> & { wal?: unknown };

  const hasAllNewHelpers =
    typeof maybe.buildToolScopeFilter === "function" &&
    typeof maybe.walWrite === "function" &&
    typeof maybe.walRemove === "function" &&
    typeof maybe.findSimilarByEmbedding === "function";

  // If a legacy `wal` helper object is still present, treat this as a legacy context.
  const hasLegacyWal = typeof maybe.wal === "object" && maybe.wal !== null;

  return hasAllNewHelpers && !hasLegacyWal;
}

async function storeRegistryEmbeddings({
  factsDb,
  embeddingRegistry,
  embeddings,
  factId,
  text,
  vector,
  logger,
  operation,
}: {
  factsDb: FactsDB;
  embeddingRegistry: EmbeddingRegistry | null | undefined;
  embeddings: EmbeddingProvider;
  factId: string;
  text: string;
  vector?: number[] | Float32Array;
  logger: { warn: (msg: string) => void };
  operation: string;
}): Promise<void> {
  if (!embeddingRegistry) return;

  const vectors = new Map<string, Float32Array>();

  if (vector && vector.length > 0) {
    vectors.set(embeddings.modelName, toFloat32Array(vector));
  }

  if (embeddingRegistry.isMultiModel()) {
    const models = embeddingRegistry.getModels();
    const tasks = models.map(async (cfg) => ({
      name: cfg.name,
      vec: await embeddingRegistry.embed(text, cfg.name),
    }));
    const settled = await Promise.allSettled(tasks);
    for (const s of settled) {
      if (s.status === "fulfilled") {
        vectors.set(s.value.name, s.value.vec);
      } else {
        capturePluginError(s.reason instanceof Error ? s.reason : new Error(String(s.reason)), {
          subsystem: "embeddings",
          operation,
        });
      }
    }
    if (!vector) {
      try {
        const vec = await embeddingRegistry.embed(text);
        const modelName = embeddings.modelName || embeddingRegistry.getPrimaryModel().name;
        vectors.set(modelName, vec);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "embeddings",
          operation,
        });
      }
    }
  } else if (!vector) {
    try {
      const vec = await embeddingRegistry.embed(text);
      const modelName = embeddings.modelName || embeddingRegistry.getPrimaryModel().name;
      vectors.set(modelName, vec);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "embeddings",
        operation,
      });
    }
  }

  if (vectors.size === 0) return;
  for (const [model, vec] of vectors) {
    try {
      factsDb.storeEmbedding(factId, model, "canonical", vec, vec.length);
    } catch (err) {
      logger.warn(`memory-hybrid: fact_embeddings store failed (${model}): ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "fact-embeddings",
        operation,
      });
    }
  }
}

/**
 * Register all memory-related tools with the plugin API.
 *
 * This includes: memory_recall, memory_recall_procedures, memory_store,
 * memory_promote, and memory_forget.
 */
export function registerMemoryTools(ctx: MemoryToolsContext, api: ClawdbotPluginApi): void;
export function registerMemoryTools(
  ctx: LegacyMemoryToolsContext,
  api: ClawdbotPluginApi,
  buildToolScopeFilter: BuildToolScopeFilterFn,
  walWrite: BoundWalWriteFn,
  walRemove: BoundWalRemoveFn,
  findSimilarByEmbedding: FindSimilarByEmbeddingFn,
): void;
export function registerMemoryTools(
  ctx: MemoryToolsContext | LegacyMemoryToolsContext,
  api: ClawdbotPluginApi,
  legacyBuildToolScopeFilter?: BuildToolScopeFilterFn,
  legacyWalWrite?: BoundWalWriteFn,
  legacyWalRemove?: BoundWalRemoveFn,
  legacyFindSimilarByEmbedding?: FindSimilarByEmbeddingFn,
): void {
  let resolvedContext: MemoryToolsContext;

  if (hasBoundMemoryToolHelpers(ctx)) {
    resolvedContext = ctx;
  } else {
    if (
      typeof legacyBuildToolScopeFilter !== "function" ||
      typeof legacyWalWrite !== "function" ||
      typeof legacyWalRemove !== "function" ||
      typeof legacyFindSimilarByEmbedding !== "function"
    ) {
      throw new Error("registerMemoryTools: Missing required legacy helper functions for memory tools initialization.");
    }
    resolvedContext = {
      ...ctx,
      buildToolScopeFilter: legacyBuildToolScopeFilter,
      walWrite: legacyWalWrite,
      walRemove: legacyWalRemove,
      findSimilarByEmbedding: legacyFindSimilarByEmbedding,
    };
  }

  const {
    factsDb,
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
  } = resolvedContext;

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
        days: Type.Optional(
          Type.Number({
            description: "Look back window in days when sessionId is omitted (default: 7).",
            minimum: 1,
            maximum: 365,
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
        const MAX_DAYS_LOOKBACK = 365;
        const MIN_DAYS_LOOKBACK = 1;
        const MAX_SUMMARY_LIMIT = 50;
        const MIN_SUMMARY_LIMIT = 1;

        const query = typeof params.query === "string" && params.query.trim().length > 0 ? params.query.trim() : null;
        const sessionId =
          typeof params.sessionId === "string" && params.sessionId.trim().length > 0 ? params.sessionId.trim() : null;

        let days = typeof params.days === "number" && params.days > 0 ? Math.floor(params.days) : 7;
        days = Math.min(MAX_DAYS_LOOKBACK, Math.max(MIN_DAYS_LOOKBACK, days));

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
          sinceSec: sessionId ? undefined : nowSec - days * 86_400,
        });

        if (summaries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: sessionId
                  ? `No narrative summary found for session ${sessionId}.`
                  : `No narrative summaries found in the last ${days} day(s).`,
              },
            ],
            details: { count: 0, narratives: [] },
          };
        }

        const lines = summaries.map(
          (summary, index) =>
            `${index + 1}. [${summary.source}] ${formatNarrativeRange(summary.periodStart, summary.periodEnd)} ` +
            `(session: ${summary.sessionId})\n${summary.text}`,
        );

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
  );

  // Internal implementation so we can return from the try block
  async function memoryRecallImpl(params: Record<string, unknown>) {
    const {
      query: queryParam,
      id: idParam,
      limit = 10,
      entity,
      tag,
      includeSuperseded = false,
      asOf: asOfParam,
      includeCold = false,
      userId,
      agentId,
      sessionId,
      expandGraph: expandGraphParam,
      expandDepth: expandDepthParam,
    } = params as {
      query?: string;
      id?: string | number;
      limit?: number;
      entity?: string;
      tag?: string;
      includeSuperseded?: boolean;
      asOf?: string;
      includeCold?: boolean;
      userId?: string;
      agentId?: string;
      sessionId?: string;
      expandGraph?: boolean;
      expandDepth?: number;
    };
    const asOfSec = asOfParam != null && asOfParam !== "" ? parseSourceDate(asOfParam) : undefined;

    // Scope filtering with auto-detection
    // ⚠️ SECURITY WARNING: userId/agentId/sessionId are caller-controlled parameters.
    // In multi-tenant production environments, these should be derived from authenticated
    // identity (via autoRecall.scopeFilter config) rather than accepted as tool parameters.
    // Accepting arbitrary scope filters allows users to access other users' private memories.
    // See docs/MEMORY-SCOPING.md "Secure Multi-Tenant Setup" for proper implementation.
    const scopeFilter = buildToolScopeFilter({ userId, agentId, sessionId }, currentAgentIdRef.value, cfg);
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
          return {
            content: [
              {
                type: "text",
                text: `Memory (id: ${entry.id}):\n\n${text}`,
              },
            ],
            details: {
              count: 1,
              memories: [
                {
                  id: entry.id,
                  text: entry.text,
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

    // Entity-targeted lookup (always runs when entity filter is set; separate from RRF)
    let entityResults: SearchResult[] = [];
    if (entity) {
      entityResults = factsDb.lookup(entity, undefined, tag, { ...recallOpts, limit: 100 });
    }

    // Explicit/deep retrieval owns richer semantic prep, including optional HyDE.
    let queryVector: number[] | null = null;
    let semanticWarning: string | null = null;

    // RRF multi-strategy retrieval pipeline (Issue #152)
    // When tag is set, skip semantic strategy (same behaviour as before).
    let results: SearchResult[] = [];
    try {
      const rrfStrategies = tag ? cfg.retrieval.strategies.filter((s) => s !== "semantic") : cfg.retrieval.strategies;
      const rrfConfig = { ...cfg.retrieval, strategies: rrfStrategies };
      const explicitPolicy = resolveExplicitDeepRetrievalPolicy(rrfConfig);
      if (!tag) {
        const vectorPrep = await buildExplicitSemanticQueryVector({
          query,
          cfg,
          embeddings,
          openai,
          pendingLLMWarnings,
          logger: api.logger,
          policy: explicitPolicy,
        });
        queryVector = vectorPrep.queryVector;
        semanticWarning = vectorPrep.warning;
      }
      const queryExpander =
        cfg.queryExpansion?.enabled && cfg.retrieval.strategies.includes("semantic")
          ? new QueryExpander(cfg.queryExpansion, openai)
          : null;
      const embedFn = queryVector != null ? (text: string) => embeddings.embed(text) : null;
      const rrfOutput = await runExplicitDeepRetrieval(query, queryVector, factsDb.getRawDb(), vectorDb, factsDb, {
        config: rrfConfig,
        policy: explicitPolicy,
        tagFilter: tag ?? undefined,
        includeSuperseded,
        scopeFilter,
        asOf: asOfSec ?? undefined,
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
      const expanded = expandGraph(factsDb, seedInputs, {
        maxDepth: depth,
        maxExpandedResults: cfg.graphRetrieval.maxExpandedResults,
        scopeFilter: scopeFilter ?? undefined,
        asOf: asOfSec ?? undefined,
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
      const connectedIds = factsDb.getConnectedFactIds([...initialIds], cfg.graph.maxTraversalDepth);
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

    if (results.length === 0) {
      logRecall(false);
      return {
        content: [
          {
            type: "text",
            text: semanticWarning
              ? `No relevant memories found.\n\n⚠️ ${semanticWarning}`
              : "No relevant memories found.",
          },
        ],
        details: { count: 0, warning: semanticWarning ?? undefined },
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
        return `${i + 1}. [${r.backend}/${r.entry.category}] ${contradictedPrefix}${tamperedPrefix}${r.entry.text} (${(r.score * 100).toFixed(0)}%)${expansionSuffix}`;
      })
      .join("\n");

    const sanitized = results.map((r) => {
      const meta = expansionMeta.get(r.entry.id);
      return {
        id: r.entry.id,
        text: r.entry.text,
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

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} memories:\n\n${text}${semanticWarning ? `\n\n⚠️ ${semanticWarning}` : ""}`,
        },
      ],
      details: { count: results.length, memories: sanitized, warning: semanticWarning ?? undefined },
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
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const {
              taskDescription,
              limit = 5,
              agentId,
              userId,
              sessionId,
            } = params as {
              taskDescription: string;
              limit?: number;
              agentId?: string;
              userId?: string;
              sessionId?: string;
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
            const scopeFilter = buildToolScopeFilter({ userId, agentId, sessionId }, currentAgentIdRef.value, cfg);

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
                lines.push(`- ${p.taskPattern.slice(0, 80)}…: ${steps} (validated ${p.successCount}x)`);
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
                lines.push(`- ${p.taskPattern.slice(0, 80)}… ${steps ? `(${steps})` : ""}`);
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
  }

  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Stores to both structured (SQLite) and semantic (LanceDB) backends.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        importance: Type.Optional(
          Type.Number({
            description:
              "Importance 0-1 (default: 0.5). Higher values signal facts that should survive longer during decay.",
          }),
        ),
        category: Type.Optional(stringEnum(getMemoryCategories() as unknown as readonly string[])),
        entity: Type.Optional(
          Type.String({
            description: "Entity name (person, project, tool, etc.)",
          }),
        ),
        key: Type.Optional(
          Type.String({
            description: "Structured key (e.g. 'birthday', 'email')",
          }),
        ),
        value: Type.Optional(
          Type.String({
            description: "Structured value (e.g. 'Nov 13', 'john@example.com')",
          }),
        ),
        decayClass: Type.Optional(
          Object.assign(stringEnum(DECAY_CLASSES as unknown as readonly string[]), {
            description:
              "Decay class defining half-life: durable (~3mo), normal (~2w), short (~2d), session (~1d), ephemeral (~4h), permanent (no decay). Legacy aliases: stable=durable, active=normal, checkpoint=ephemeral.",
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Topic tags for sharper retrieval (e.g. nibe, zigbee). Auto-inferred if omitted.",
          }),
        ),
        supersedes: Type.Optional(
          Type.String({
            description:
              "Fact id this one supersedes (replaces). Marks the old fact as superseded and links the new one.",
          }),
        ),
        scope: Type.Optional(stringEnum(MEMORY_SCOPES as unknown as readonly string[])),
        scopeTarget: Type.Optional(
          Type.String({
            description:
              "Scope target (userId, agentId, or sessionId). Required when scope is user, agent, or session.",
          }),
        ),
        verification_tier: Type.Optional(
          Type.String({
            description:
              "Optional verification tier override (e.g. 'critical') to force verification store enrollment.",
          }),
        ),
        decayFreezeUntil: Type.Optional(
          Type.Number({
            description:
              "Unix epoch seconds until which confidence decay is paused. Auto-detected from future dates in text if omitted.",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const {
            text,
            importance = 0.5,
            category = "other",
            entity: paramEntity,
            key: paramKey,
            value: paramValue,
            decayClass: paramDecayClass,
            tags: paramTags,
            supersedes,
            scope: paramScope,
            scopeTarget: paramScopeTarget,
            verification_tier: verificationTier,
            decayFreezeUntil: paramDecayFreezeUntil,
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
            entity?: string;
            key?: string;
            value?: string;
            decayClass?: DecayClass;
            tags?: string[];
            supersedes?: string;
            scope?: "global" | "user" | "agent" | "session";
            scopeTarget?: string;
            verification_tier?: string;
            decayFreezeUntil?: number;
          };

          let textToStore = text;
          textToStore = truncateForStorage(textToStore, cfg.captureMaxChars);
          const provenanceSessionId = api.context?.sessionId ?? null;
          const recordActiveStoreProvenance = (factId: string, sourceText?: string) => {
            if (!provenanceService || !cfg.provenance.enabled) return;
            try {
              provenanceService.addEdge(factId, {
                edgeType: "DERIVED_FROM",
                sourceType: "active_store",
                sourceId: provenanceSessionId ?? "unknown-session",
                sourceText,
              });
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "provenance",
                operation: "memory-store-provenance",
                factId,
              });
            }
          };

          if (factsDb.hasDuplicate(textToStore)) {
            return {
              content: [{ type: "text", text: `Similar memory already exists.` }],
              details: { action: "duplicate" },
            };
          }

          const extracted = extractStructuredFields(textToStore, category as MemoryCategory);
          const entity = paramEntity || extracted.entity;
          const key = paramKey || extracted.key;
          const value = paramValue || extracted.value;

          // FR-006: Compute scope early so it's available for classify-before-write UPDATE path; normal path may overwrite with multiAgent logic below
          let scope: "global" | "user" | "agent" | "session" = paramScope ?? "global";
          let scopeTarget: string | null = scope === "global" ? null : (paramScopeTarget?.trim() ?? null);
          if (scope !== "global" && !scopeTarget) {
            return {
              content: [
                {
                  type: "text",
                  text: `Scope "${scope}" requires scopeTarget (userId, agentId, or sessionId).`,
                },
              ],
              details: { error: "scope_target_required" },
            };
          }

          const explicitVerificationTier = (verificationTier ?? "").trim().toLowerCase();

          const maybeAutoVerify = (
            factId: string,
            factText: string,
            autoTags: string[],
            autoEntity?: string | null,
            autoKey?: string | null,
            autoValue?: string | null,
          ) => {
            if (!cfg.verification.enabled || !verificationStore) return;
            const shouldEnroll =
              explicitVerificationTier === "critical" ||
              (cfg.verification.autoClassify &&
                shouldAutoVerify({
                  text: factText,
                  category,
                  tags: autoTags,
                  entity: autoEntity,
                  key: autoKey,
                  value: autoValue,
                  verificationTier: verificationTier ?? null,
                }));
            if (!shouldEnroll) return;
            try {
              const verifiedBy = explicitVerificationTier === "critical" ? "agent" : "system";
              verificationStore.verify(factId, factText, verifiedBy);
            } catch (err) {
              api.logger.warn?.(`memory-hybrid: auto-verify failed for ${factId}: ${err}`);
            }
          };

          // Dual-mode credentials: vault enabled → store in vault + pointer in memory; vault disabled → store in memory (live behavior).
          // When vault is enabled, credential-like content that fails to parse must not be written to memory (see docs/CREDENTIALS.md).
          if (cfg.credentials.enabled && credentialsDb && isCredentialLike(textToStore, entity, key, value)) {
            const parsed = tryParseCredentialForVault(textToStore, entity, key, value, {
              requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
            });
            if (parsed) {
              const stored = credentialsDb.storeIfNew({
                service: parsed.service,
                type: parsed.type,
                value: parsed.secretValue,
                url: parsed.url,
                notes: parsed.notes,
              });
              if (!stored) {
                return {
                  content: [
                    { type: "text", text: `Credential already in vault for ${parsed.service} (${parsed.type}).` },
                  ],
                  details: { action: "credential_skipped_duplicate", service: parsed.service, type: parsed.type },
                };
              }
              const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}", type="${parsed.type}") to retrieve.`;
              const pointerValue = `${VAULT_POINTER_PREFIX}${parsed.service}:${parsed.type}`;
              const pointerEntry = factsDb.store({
                text: pointerText,
                category: "technical" as MemoryCategory,
                importance,
                entity: "Credentials",
                key: parsed.service,
                value: pointerValue,
                source: "conversation",
                decayClass: paramDecayClass ?? "permanent",
                tags: ["auth", ...extractTags(pointerText, "Credentials")],
                provenanceSession: provenanceSessionId,
                extractionMethod: "active",
                extractionConfidence: importance,
              });
              recordActiveStoreProvenance(pointerEntry.id, pointerText);
              try {
                addOperationBreadcrumb("vector", "store-credential-pointer");
                const vector = await embeddings.embed(pointerText);
                factsDb.setEmbeddingModel(pointerEntry.id, embeddings.modelName);
                if (!(await vectorDb.hasDuplicate(vector))) {
                  await vectorDb.store({
                    text: pointerText,
                    vector,
                    importance,
                    category: "technical",
                    id: pointerEntry.id,
                  });
                }
                await storeRegistryEmbeddings({
                  factsDb,
                  embeddingRegistry,
                  embeddings,
                  factId: pointerEntry.id,
                  text: pointerText,
                  vector,
                  logger: api.logger,
                  operation: "store-credential-pointer",
                });
              } catch (err) {
                // AllEmbeddingProvidersFailed is expected when no providers are configured — don't report to Sentry.
                if (!(err instanceof AllEmbeddingProvidersFailed)) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    subsystem: "vector",
                    operation: "store-credential-pointer",
                    phase: "runtime",
                    backend: "lancedb",
                  });
                }
                api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Credential stored in vault for ${parsed.service} (${parsed.type}). Pointer saved in memory.`,
                  },
                ],
                details: {
                  action: "credential_vault",
                  id: pointerEntry.id,
                  service: parsed.service,
                  type: parsed.type,
                },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: "Credential-like content detected but could not be parsed as a structured credential; not stored (vault is enabled).",
                },
              ],
              details: { action: "credential_skipped" },
            };
          }

          const tags =
            paramTags && paramTags.length > 0
              ? paramTags.map((t) => t.trim().toLowerCase()).filter(Boolean)
              : extractTags(textToStore, entity);

          const summaryThreshold = cfg.autoRecall.summaryThreshold;
          const summary =
            summaryThreshold > 0 && textToStore.length > summaryThreshold
              ? textToStore.slice(0, cfg.autoRecall.summaryMaxChars).trim() + "…"
              : undefined;

          // Generate vector first (needed for WAL and storage)
          let vector: number[] | undefined;
          try {
            vector = await embeddings.embed(textToStore);
          } catch (err) {
            if (err instanceof AllEmbeddingProvidersFailed) {
              // Graceful degradation: store the fact without a vector.
              // The fact is still findable by structured/keyword search.
              api.logger.warn("memory-hybrid: Stored fact without embeddings — all providers unavailable");
            } else {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "embeddings",
                operation: "store-embed",
                phase: "runtime",
              });
              api.logger.warn(`memory-hybrid: embedding generation failed: ${err}`);
            }
          }

          // Classify the operation before storing (use embedding similarity)
          if (cfg.store.classifyBeforeWrite) {
            let similarFacts: MemoryEntry[] = [];
            if (vector) {
              similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5);
            }
            if (similarFacts.length === 0) {
              similarFacts = factsDb.findSimilarForClassification(textToStore, entity, key, 5);
            }
            if (similarFacts.length > 0) {
              const classification = await classifyMemoryOperation(
                textToStore,
                entity,
                key,
                similarFacts,
                openai,
                cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(cfg), "nano"),
                api.logger,
              );

              if (classification.action === "NOOP") {
                return {
                  content: [{ type: "text", text: `Already known: ${classification.reason}` }],
                  details: { action: "noop", reason: classification.reason },
                };
              }

              if (classification.action === "DELETE" && classification.targetId) {
                factsDb.supersede(classification.targetId, null);
                aliasDb?.deleteByFactId(classification.targetId);
                return {
                  content: [
                    { type: "text", text: `Retracted fact ${classification.targetId}: ${classification.reason}` },
                  ],
                  details: { action: "delete", targetId: classification.targetId, reason: classification.reason },
                };
              }

              if (classification.action === "UPDATE" && classification.targetId) {
                const oldFact = factsDb.getById(classification.targetId);
                if (oldFact) {
                  const walEntryId = await walWrite(
                    "update",
                    {
                      text: textToStore,
                      category,
                      importance: Math.max(importance, oldFact.importance),
                      entity: entity || oldFact.entity,
                      key: key || oldFact.key,
                      value: value || oldFact.value,
                      source: "conversation",
                      decayClass: paramDecayClass ?? oldFact.decayClass,
                      summary,
                      tags,
                      vector,
                    },
                    api.logger,
                  );

                  const nowSec = Math.floor(Date.now() / 1000);
                  const newEntry = factsDb.store({
                    text: textToStore,
                    category: category as MemoryCategory,
                    importance: Math.max(importance, oldFact.importance),
                    entity: entity || oldFact.entity,
                    key: key || oldFact.key,
                    value: value || oldFact.value,
                    source: "conversation",
                    decayClass: paramDecayClass ?? oldFact.decayClass,
                    summary,
                    tags,
                    validFrom: nowSec,
                    supersedesId: classification.targetId,
                    scope,
                    scopeTarget,
                    sourceSessions: api.context?.sessionId ?? undefined,
                    provenanceSession: provenanceSessionId,
                    extractionMethod: "active",
                    extractionConfidence: Math.max(importance, oldFact.importance),
                  });
                  recordActiveStoreProvenance(newEntry.id, textToStore);
                  factsDb.supersede(classification.targetId, newEntry.id);
                  aliasDb?.deleteByFactId(classification.targetId);
                  maybeAutoVerify(
                    newEntry.id,
                    textToStore,
                    newEntry.tags ?? tags,
                    newEntry.entity,
                    newEntry.key,
                    newEntry.value,
                  );

                  const finalImportance = Math.max(importance, oldFact.importance);
                  try {
                    if (vector) {
                      factsDb.setEmbeddingModel(newEntry.id, embeddings.modelName);
                      if (!(await vectorDb.hasDuplicate(vector))) {
                        await vectorDb.store({
                          text: textToStore,
                          vector,
                          importance: finalImportance,
                          category,
                          id: newEntry.id,
                        });
                      }
                    }
                    await storeRegistryEmbeddings({
                      factsDb,
                      embeddingRegistry,
                      embeddings,
                      factId: newEntry.id,
                      text: textToStore,
                      vector,
                      logger: api.logger,
                      operation: "store-update-supersede",
                    });
                  } catch (err) {
                    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                      subsystem: "vector",
                      operation: "store-update-supersede",
                      phase: "runtime",
                      backend: "lancedb",
                    });
                    api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
                  }

                  await walRemove(walEntryId, api.logger);

                  // Issue #159: enqueue contextual variant generation (non-blocking)
                  if (variantQueue) {
                    variantQueue.enqueue({ factId: newEntry.id, text: textToStore, category: category as string });
                  }

                  api.logger.info?.(
                    `memory-hybrid: UPDATE — superseded ${classification.targetId} with ${newEntry.id}: ${classification.reason}`,
                  );
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Updated: superseded old fact with "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${newEntry.decayClass}] (reason: ${classification.reason})`,
                      },
                    ],
                    details: {
                      action: "updated",
                      id: newEntry.id,
                      superseded: classification.targetId,
                      reason: classification.reason,
                      backend: "both",
                      decayClass: newEntry.decayClass,
                    },
                  };
                }
              }
              // action === "ADD" falls through to normal store
            }
          }

          const walEntryId = await walWrite(
            "store",
            {
              text: textToStore,
              category,
              importance,
              entity,
              key,
              value,
              source: "conversation",
              decayClass: paramDecayClass,
              summary,
              tags,
              vector,
            },
            api.logger,
          );

          // Now commit to actual storage (optional supersedes for manual supersession; scope)
          // Smart default scope based on agent identity and config (FR-006: overwrite for normal path when not explicit)
          if (paramScope) {
            // Explicit scope parameter always takes precedence
            scope = paramScope;
            scopeTarget = scope === "global" ? null : (paramScopeTarget?.trim() ?? null);
          } else {
            // Auto-determine scope based on multiAgent config
            const agentId = currentAgentIdRef.value || cfg.multiAgent.orchestratorId;
            const isOrchestrator = agentId === cfg.multiAgent.orchestratorId;

            // Strict agent scoping: throw if agent detection failed in agent/auto mode
            if (
              cfg.multiAgent.strictAgentScoping &&
              !currentAgentIdRef.value &&
              (cfg.multiAgent.defaultStoreScope === "agent" || cfg.multiAgent.defaultStoreScope === "auto")
            ) {
              throw new Error(
                `Agent detection failed (currentAgentId is null) and multiAgent.strictAgentScoping is enabled. ` +
                  `Cannot auto-determine scope for defaultStoreScope="${cfg.multiAgent.defaultStoreScope}". ` +
                  `Fix: ensure agent_id is provided in session context, or disable strictAgentScoping.`,
              );
            }

            if (cfg.multiAgent.defaultStoreScope === "global") {
              // Backward compatible: always global
              scope = "global";
              scopeTarget = null;
            } else if (cfg.multiAgent.defaultStoreScope === "agent") {
              // Always agent-scoped (for fully isolated setups)
              scope = "agent";
              scopeTarget = agentId;
            } else {
              // "auto" mode: orchestrator → global, specialists → agent
              if (isOrchestrator) {
                scope = "global";
                scopeTarget = null;
              } else {
                scope = "agent";
                scopeTarget = agentId;
              }
            }
          }

          // Final validation: if scope requires a target but none is available, fall back to global
          // (unless strictAgentScoping already threw above)
          if (scope !== "global" && !scopeTarget) {
            if (paramScope) {
              // User explicitly requested non-global scope but didn't provide target
              return {
                content: [
                  {
                    type: "text",
                    text: `Scope "${scope}" requires scopeTarget (userId, agentId, or sessionId). Provide scopeTarget parameter or use scope="global".`,
                  },
                ],
                details: { error: "scope_target_required" },
              };
            } else {
              // Auto-determined scope ended up without target (shouldn't happen with current logic,
              // but handle gracefully by falling back to global)
              scope = "global";
              scopeTarget = null;
            }
          }
          const decayFreezeUntil =
            paramDecayFreezeUntil != null && Number.isFinite(paramDecayFreezeUntil)
              ? paramDecayFreezeUntil
              : detectFutureDate(textToStore, cfg.futureDateProtection ?? { enabled: false });

          const nowSec = Math.floor(Date.now() / 1000);
          const storeSessionId = api.context?.sessionId ?? null;
          const entry = factsDb.store({
            text: textToStore,
            category: category as MemoryCategory,
            importance,
            entity,
            key,
            value,
            source: "conversation",
            decayClass: paramDecayClass,
            summary,
            tags,
            scope,
            scopeTarget,
            sourceSessions: storeSessionId ?? undefined,
            provenanceSession: provenanceSessionId,
            extractionMethod: "active",
            extractionConfidence: importance,
            decayFreezeUntil: decayFreezeUntil ?? undefined,
            ...(supersedes?.trim() ? { validFrom: nowSec, supersedesId: supersedes.trim() } : {}),
          });
          recordActiveStoreProvenance(entry.id, textToStore);
          if (supersedes?.trim()) {
            factsDb.supersede(supersedes.trim(), entry.id);
            aliasDb?.deleteByFactId(supersedes.trim());
          }

          try {
            addOperationBreadcrumb("vector", "store-fact");
            if (vector) {
              factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
              if (!(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({
                  text: textToStore,
                  vector,
                  importance,
                  category,
                  id: entry.id,
                });
              }
            }
            await storeRegistryEmbeddings({
              factsDb,
              embeddingRegistry,
              embeddings,
              factId: entry.id,
              text: textToStore,
              vector,
              logger: api.logger,
              operation: "store-fact",
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "vector",
              operation: "store-fact",
              phase: "runtime",
              backend: "lancedb",
            });
            api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
          }

          await walRemove(walEntryId, api.logger);

          // Issue #150: write event to episodic event log
          if (eventLog) {
            try {
              const eventType = categoryToEventType(category);
              eventLog.append({
                sessionId: api.context?.sessionId ?? "unknown",
                timestamp: new Date().toISOString(),
                eventType,
                content: {
                  text: textToStore.slice(0, 500),
                  factId: entry.id,
                  category,
                  importance,
                  source: "memory_store",
                },
                entities: entity ? [entity] : undefined,
              });
            } catch {
              // Non-fatal
            }
          }

          // Issue #159: enqueue contextual variant generation (non-blocking)
          if (variantQueue) {
            variantQueue.enqueue({ factId: entry.id, text: textToStore, category: category as string });
          }

          // Issue #149: generate and store retrieval aliases (non-blocking)
          if (cfg.aliases?.enabled && aliasDb && importance >= 0.5) {
            const aliasModel = cfg.aliases.model ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
            void storeAliases(entry.id, textToStore, cfg.aliases, aliasModel, openai, embeddings, aliasDb, (msg) =>
              api.logger.warn(msg),
            ).catch((err) => {
              api.logger.warn(`memory-hybrid: alias generation failed: ${err}`);
            });
          }

          // Contradiction detection (Issue #157): check for same entity+key, different value
          // Pass the stored fact's scope so detection stays within the same scope boundary.
          const contradictions = factsDb.detectContradictions(
            entry.id,
            entity ?? null,
            key ?? null,
            value ?? null,
            entry.scope ?? null,
            entry.scopeTarget ?? null,
          );
          for (const { contradictionId, oldFactId } of contradictions) {
            if (eventLog) {
              eventLog.append({
                sessionId: api.context?.sessionId ?? "unknown",
                timestamp: new Date().toISOString(),
                eventType: "correction",
                content: {
                  type: "contradiction_detected",
                  contradictionId,
                  newFactId: entry.id,
                  oldFactId,
                  entity: entity ?? null,
                  key: key ?? null,
                  newValue: value ?? null,
                },
                entities: entity ? [entity] : undefined,
              });
            }
          }

          // Auto-link to similar facts when enabled
          let autoLinked = 0;
          if (cfg.graph.enabled && cfg.graph.autoLink) {
            const similar = factsDb.findSimilarForClassification(
              textToStore,
              entity ?? null,
              key ?? null,
              cfg.graph.autoLinkLimit,
            );
            for (const s of similar) {
              if (s.id === entry.id) continue;
              factsDb.createLink(entry.id, s.id, "RELATED_TO", cfg.graph.autoLinkMinScore);
              autoLinked++;
            }
          }

          // Entity-based auto-linking (Issue #154): known-entity matching, IP NER,
          // temporal co-occurrence, and supersession detection.
          let entityAutoLinked = 0;
          let autoSupersededIds: string[] = [];
          if (cfg.graph.enabled && cfg.graph.autoLink) {
            const sessionId = api.context?.sessionId ?? null;
            const result = factsDb.autoLinkEntities(
              entry.id,
              textToStore,
              entity ?? null,
              key ?? null,
              sessionId,
              {
                coOccurrenceWeight: cfg.graph.coOccurrenceWeight,
                autoSupersede: cfg.graph.autoSupersede,
              },
              entry.scope ?? null,
              entry.scopeTarget ?? null,
            );
            entityAutoLinked = result.linkedCount;
            autoSupersededIds = result.supersededIds;
            if (autoSupersededIds.length > 0) {
              api.logger.info?.(
                `memory-hybrid: autoSupersede — superseded [${autoSupersededIds.join(", ")}] with ${entry.id}`,
              );
            }
          }

          const totalLinked = autoLinked + entityAutoLinked;
          const verbosity = cfg.verbosity ?? "normal";
          let storedMsg: string;
          if (isCompactVerbosity(verbosity)) {
            // Quiet: only report the ID and any warnings (contradictions are important)
            storedMsg =
              `Stored: ${entry.id}` +
              (contradictions.length > 0
                ? ` (⚠️ contradicts ${contradictions.length} existing fact${contradictions.length === 1 ? "" : "s"})`
                : "");
          } else {
            // normal / verbose: full details (verbose adds scope/category info)
            storedMsg =
              `Stored: "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${entry.decayClass}]` +
              (supersedes?.trim() ? " (supersedes previous fact)" : "") +
              (totalLinked > 0 ? ` (linked to ${totalLinked} related fact${totalLinked === 1 ? "" : "s"})` : "") +
              (autoSupersededIds.length > 0
                ? ` (auto-superseded ${autoSupersededIds.length} fact${autoSupersededIds.length === 1 ? "" : "s"})`
                : "") +
              (contradictions.length > 0
                ? ` (⚠️ contradicts ${contradictions.length} existing fact${contradictions.length === 1 ? "" : "s"})`
                : "");
            if (verbosity === "verbose") {
              storedMsg += ` [id: ${entry.id}]`;
              if (entry.scope)
                storedMsg += ` [scope: ${entry.scope}${entry.scopeTarget ? `/${entry.scopeTarget}` : ""}]`;
            }
          }

          return {
            content: [
              {
                type: "text",
                text: storedMsg,
              },
            ],
            details: {
              action: supersedes?.trim() ? "updated" : "created",
              id: entry.id,
              backend: "both",
              decayClass: entry.decayClass,
              ...(supersedes?.trim() ? { superseded: supersedes.trim() } : {}),
              ...(totalLinked > 0 ? { autoLinked: totalLinked } : {}),
              ...(autoSupersededIds.length > 0 ? { autoSuperseded: autoSupersededIds } : {}),
              ...(contradictions.length > 0
                ? {
                    contradictions: contradictions.map((c) => ({
                      contradictionId: c.contradictionId,
                      oldFactId: c.oldFactId,
                    })),
                  }
                : {}),
              ...(decayFreezeUntil != null ? { decayFreezeUntil } : {}),
            },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "memory",
            operation: "memory-store",
            phase: "runtime",
          });
          throw err;
        }
      },
    },
    { name: "memory_store" },
  );

  api.registerTool(
    {
      name: "memory_promote",
      label: "Memory Promote",
      description: "Promote a session-scoped memory to global or agent scope (so it persists after session end).",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Fact id to promote" }),
        scope: Type.Union([Type.Literal("global"), Type.Literal("agent")], {
          description: "New scope: global (available to all) or agent (this agent only).",
        }),
        scopeTarget: Type.Optional(
          Type.String({
            description: "Required when scope is agent: agent identifier.",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const { memoryId, scope, scopeTarget } = params as {
            memoryId: string;
            scope: "global" | "agent";
            scopeTarget?: string;
          };
          const entry = factsDb.getById(memoryId);
          if (!entry) {
            return {
              content: [{ type: "text", text: `No memory found with id: ${memoryId}.` }],
              details: { error: "not_found" },
            };
          }
          if (scope === "agent" && !scopeTarget?.trim()) {
            return {
              content: [{ type: "text", text: "Scope 'agent' requires scopeTarget (agent identifier)." }],
              details: { error: "scope_target_required" },
            };
          }
          const ok = factsDb.promoteScope(memoryId, scope, scope === "agent" ? scopeTarget!.trim() : null);
          if (!ok) {
            return {
              content: [{ type: "text", text: `Could not promote memory ${memoryId}.` }],
              details: { error: "promote_failed" },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Promoted memory ${memoryId} to scope "${scope}"${scope === "agent" ? ` (agent: ${scopeTarget})` : ""}. It will persist after session end.`,
              },
            ],
            details: {
              action: "promoted",
              id: memoryId,
              scope,
              scopeTarget: scope === "agent" ? scopeTarget : undefined,
            },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "memory",
            operation: "memory-promote",
            phase: "runtime",
          });
          throw err;
        }
      },
    },
    { name: "memory_promote" },
  );

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description: "Delete specific memories from both backends.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Search to find memory" })),
        memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          if (memoryId) {
            // Support prefix matching: if the ID looks truncated (not a full UUID),
            // try to resolve the full ID via prefix search
            let resolvedId = memoryId;
            if (memoryId.length < 36 && !memoryId.includes("-")) {
              const prefixResult = factsDb.findByIdPrefix(memoryId);
              if (prefixResult && "ambiguous" in prefixResult) {
                const countText = prefixResult.count >= 3 ? `${prefixResult.count}+` : `${prefixResult.count}`;
                return {
                  content: [
                    {
                      type: "text",
                      text: `Prefix "${memoryId}" is ambiguous (matches ${countText} facts). Use the full UUID from memory_recall.`,
                    },
                  ],
                  details: { action: "ambiguous", prefix: memoryId, matchCount: prefixResult.count },
                };
              }
              if (prefixResult && "id" in prefixResult) {
                resolvedId = prefixResult.id;
              }
            }

            // Validate that resolvedId is a proper UUID before attempting deletion.
            // LLMs sometimes pass memory text content as the ID instead of the UUID.
            if (!UUID_REGEX.test(resolvedId)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `"${memoryId}" is not a valid memory ID. Use memory_recall to find the memory and get its UUID, then pass the UUID to memory_forget.`,
                  },
                ],
                details: { action: "invalid_id", originalId: memoryId },
              };
            }

            const sqlDeleted = factsDb.delete(resolvedId);
            let lanceDeleted = false;
            let lanceError: string | null = null;
            try {
              lanceDeleted = await vectorDb.delete(resolvedId);
            } catch (err) {
              lanceError = err instanceof Error ? err.message : String(err);
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "vector",
                operation: "forget-delete",
                phase: "runtime",
                backend: "lancedb",
              });
              api.logger.warn(`memory-hybrid: LanceDB delete during tool failed: ${err}`);
            }
            aliasDb?.deleteByFactId(resolvedId);

            if (!sqlDeleted && !lanceDeleted) {
              if (lanceError) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Deletion failed for "${memoryId}": SQLite not found, LanceDB error: ${lanceError}`,
                    },
                  ],
                  details: { action: "error", originalId: memoryId, resolvedId, error: lanceError },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Failed to delete memory "${memoryId}" — not found in either backend. Use the full UUID from memory_recall.`,
                  },
                ],
                details: { action: "not_found", originalId: memoryId, resolvedId },
              };
            }

            const resolveNote = resolvedId !== memoryId ? ` (resolved from prefix "${memoryId}")` : "";
            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${resolvedId} forgotten${resolveNote} (sqlite: ${sqlDeleted}, lance: ${lanceDeleted}).`,
                },
              ],
              details: { action: "deleted", originalId: memoryId, resolvedId },
            };
          }

          if (query) {
            const sqlResults = factsDb.search(query, 5);
            let lanceResults: SearchResult[] = [];
            try {
              const vector = await embeddings.embed(query);
              lanceResults = await vectorDb.search(vector, 5, 0.7);
            } catch (err) {
              // AllEmbeddingProvidersFailed is expected when no providers are configured — don't report to Sentry.
              if (!(err instanceof AllEmbeddingProvidersFailed)) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  subsystem: "vector",
                  operation: "forget-vector-search",
                  phase: "runtime",
                  backend: "lancedb",
                });
              }
              api.logger.warn(`memory-hybrid: vector search failed: ${err}`);
            }

            const results = mergeResults(sqlResults, lanceResults, 5, factsDb);

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No matching memories found." }],
                details: { found: 0 },
              };
            }

            if (results.length === 1 && results[0].score > 0.9) {
              const id = results[0].entry.id;
              factsDb.delete(id);
              try {
                await vectorDb.delete(id);
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  subsystem: "vector",
                  operation: "forget-supersede-delete",
                  phase: "runtime",
                  backend: "lancedb",
                });
                api.logger.warn(`memory-hybrid: LanceDB delete during supersede failed: ${err}`);
              }
              aliasDb?.deleteByFactId(id);
              return {
                content: [
                  {
                    type: "text",
                    text: `Forgotten: "${results[0].entry.text}"`,
                  },
                ],
                details: { action: "deleted", id },
              };
            }

            const list = results
              .map((r) => {
                const normalized = r.entry.text.replace(/\s+/g, " ");
                const preview = normalized.slice(0, 80).trim();
                const ellipsis = normalized.length > 80 ? "…" : "";
                return `- [${r.entry.id}] (${r.backend}) ${preview}${ellipsis}`;
              })
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                },
              ],
              details: {
                action: "candidates",
                candidates: results.map((r) => ({
                  id: r.entry.id,
                  text: r.entry.text,
                  backend: r.backend,
                  score: r.score,
                })),
              },
            };
          }

          return {
            content: [{ type: "text", text: "Provide query or memoryId." }],
            details: { error: "missing_param" },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "memory",
            operation: "memory-forget",
            phase: "runtime",
          });
          throw err;
        }
      },
    },
    { name: "memory_forget" },
  );
}
