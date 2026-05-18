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

export function registerEpisodeTools(runtime: MemoryToolRuntime): void {
  const { factsDb, cfg, currentAgentIdRef, buildToolScopeFilter, api } = runtime;
  // ---------------------------------------------------------------------------
  // Episodic Memory tools (#781)
  // ---------------------------------------------------------------------------

  /** memory_record_episode — store a structured event with explicit outcome. */
  {
    const _recordEpisodeParams = Type.Object({
      event: Type.String({ description: "What happened (e.g. 'deployed openclaw to production')." }),
      outcome: stringEnum(["success", "failure", "partial", "unknown"] as const, {
        description: "Outcome of the event.",
      }),
      timestamp: Type.Optional(
        Type.Number({ description: "Unix epoch seconds when the event occurred. Defaults to now." }),
      ),
      duration: Type.Optional(
        Type.Number({ description: "Duration in milliseconds (e.g. how long a deployment took)." }),
      ),
      context: Type.Optional(Type.String({ description: "Context: environment state, what led up to it, etc." })),
      relatedFactIds: Type.Optional(
        Type.Array(Type.String(), { description: "IDs of related memory facts to link to this episode." }),
      ),
      procedureId: Type.Optional(
        Type.String({ description: "ID of the procedure that triggered this episode, if any." }),
      ),
      importance: Type.Optional(
        Type.Number({ description: "Importance 0–1 (default 0.5). Failures are auto-boosted to ≥0.8." }),
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Topic tags for filtering." })),
      scope: Type.Optional(
        stringEnum(["global", "user", "agent", "session"] as const, {
          description: "Memory scope. Default: global.",
        }),
      ),
      agentId: Type.Optional(Type.String()),
      userId: Type.Optional(Type.String()),
      sessionId: Type.Optional(Type.String()),
    });
    const _recordEpisodeDesc =
      "Record a structured episodic memory: a significant event with an explicit outcome (success/failure/partial/unknown), timestamp, and optional context. Use after deployments, migrations, incidents, or other notable events to build a queryable history of what happened and how it turned out.";
    const _execRecordEpisode = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
        const episode = factsDb.recordEpisode({
          event: params.event as string,
          outcome: params.outcome as EpisodeOutcome,
          timestamp: params.timestamp as number | undefined,
          duration: params.duration as number | undefined,
          context: params.context as string | undefined,
          relatedFactIds: params.relatedFactIds as string[] | undefined,
          procedureId: params.procedureId as string | undefined,
          importance: params.importance as number | undefined,
          tags: params.tags as string[] | undefined,
          decayClass: "normal",
          scope: params.scope as "global" | "user" | "agent" | "session" | undefined,
          scopeTarget: scopeFilter?.sessionId ?? scopeFilter?.userId ?? scopeFilter?.agentId ?? null,
          agentId: (params.agentId as string | undefined) ?? scopeFilter?.agentId ?? undefined,
          userId: (params.userId as string | undefined) ?? scopeFilter?.userId ?? undefined,
          sessionId: (params.sessionId as string | undefined) ?? scopeFilter?.sessionId ?? undefined,
        });

        return {
          content: [
            {
              type: "text",
              text: `Episode recorded: [${episode.outcome}] "${episode.event}" at ${new Date(episode.timestamp * 1000).toISOString()} (id: ${episode.id})`,
            },
          ],
          details: { episode },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "record_episode",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_record_episode",
        description: _recordEpisodeDesc,
        parameters: _recordEpisodeParams,
        execute: _execRecordEpisode,
      },
      { name: "memory_record_episode" },
    );
  }

  /** memory_search_episodes — search structured episodic memories with filters. */
  {
    const _searchEpisodesParams = Type.Object({
      query: Type.Optional(Type.String({ description: "Full-text search over event and context fields." })),
      outcome: Type.Optional(Type.Array(stringEnum(["success", "failure", "partial", "unknown"] as const))),
      since: Type.Optional(Type.Number({ description: "Unix epoch seconds — only events after this time." })),
      until: Type.Optional(Type.Number({ description: "Unix epoch seconds — only events before this time." })),
      procedureId: Type.Optional(Type.String({ description: "Filter to episodes linked to a specific procedure." })),
      limit: Type.Optional(Type.Number({ description: "Max results to return (default 50, max 200)." })),
    });
    const _searchEpisodesDesc =
      "Search episodic memories — structured records of events with outcomes and timestamps. Filter by outcome (success/failure/partial/unknown), time range, or procedure. Returns events ordered by most recent first.";
    const _execSearchEpisodes = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
        const episodes = factsDb.searchEpisodes({
          query: params.query as string | undefined,
          outcome: params.outcome as EpisodeOutcome[] | undefined,
          since: params.since as number | undefined,
          until: params.until as number | undefined,
          procedureId: params.procedureId as string | undefined,
          limit: Math.min((params.limit as number | undefined) ?? 50, 200),
          scopeFilter,
        });

        if (episodes.length === 0) {
          return {
            content: [{ type: "text", text: "No episodes found matching the criteria." }],
            details: { found: 0, episodes: [] },
          };
        }

        const lines = episodes.map((e) => {
          const ts = new Date(e.timestamp * 1000).toLocaleString();
          const tagStr = e.tags.length > 0 ? ` #${e.tags.join(" #")}` : "";
          return `- [${e.outcome}] ${ts}: ${e.event}${tagStr} (id: ${e.id})`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Found ${episodes.length} episode(s):\n${lines.join("\n")}`,
            },
          ],
          details: { found: episodes.length, episodes },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "search_episodes",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_search_episodes",
        description: _searchEpisodesDesc,
        parameters: _searchEpisodesParams,
        execute: _execSearchEpisodes,
      },
      { name: "memory_search_episodes" },
    );
  }

  // ---------------------------------------------------------------------------
}
