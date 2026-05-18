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


export function registerCheckpointTools(runtime: MemoryToolRuntime): void {
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

  // ---------------------------------------------------------------------------
  // Active-task checkpoint tool (#1270)
  // ---------------------------------------------------------------------------

  {
    const _activeTaskCheckpointParams = Type.Object({
      entity: Type.String({ description: "Stable task entity/label (category:project row key)." }),
      status: Type.Optional(
        Type.String({
          description:
            "Task status: open|in_progress|blocked|waiting|done|completed|closed|cancelled|abandoned|failed.",
        }),
      ),
      owner: Type.Optional(Type.String({ description: "Task owner (free-form, e.g. subagent/session/role)." })),
      next: Type.Optional(Type.String({ description: "Next concrete action for safe resume." })),
      relatedSession: Type.Optional(Type.String({ description: "Related OpenClaw session key/id." })),
      title: Type.Optional(
        Type.String({ description: "Human-readable task title (defaults to existing or Project task)." }),
      ),
      resumeAt: Type.Optional(
        Type.String({
          description: "Optional future ISO timestamp for wake/reminder scheduling via cron jobs store.",
        }),
      ),
      state: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Structured checkpoint state object (serialized into facts + episode context).",
        }),
      ),
      scheduleWake: Type.Optional(
        Type.Boolean({ description: "When true (default), schedule wake job when resumeAt is supplied." }),
      ),
      refreshProjection: Type.Optional(
        Type.Boolean({
          description: "When true, best-effort refresh ACTIVE-TASKS.md projection (activeTask.ledger=facts only).",
        }),
      ),
      recordEpisode: Type.Optional(
        Type.Boolean({ description: "When true (default), record an episode audit trail for the checkpoint." }),
      ),
    });
    const _activeTaskCheckpointDesc =
      "Best-effort checkpoint active task state for reliable resume. One call updates project facts (status/next/owner/related_session/task_updated/title), records an episode audit trail, optionally schedules wake/reminder from resumeAt, and optionally refreshes ACTIVE-TASKS.md projection. Returns structured partial-failure details when later steps fail.";
    const _execActiveTaskCheckpoint = async (_toolCallId: string, params: Record<string, unknown>) => {
      const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
      try {
        const result = await runActiveTaskCheckpoint(
          {
            factsDb,
            vectorDb,
            embeddings,
            cfg,
            logger: api.logger,
            episodeScopeFilter: scopeFilter,
          },
          params as {
            entity?: string;
            status?: string;
            owner?: string;
            next?: string;
            relatedSession?: string;
            title?: string;
            resumeAt?: string;
            state?: Record<string, unknown>;
            scheduleWake?: boolean;
            refreshProjection?: boolean;
            recordEpisode?: boolean;
          },
        );

        return {
          content: [{ type: "text", text: result.message }],
          details: result,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "active_task_checkpoint",
          phase: "runtime",
        });
        return {
          content: [{ type: "text", text: `active_task_checkpoint failed: ${String(err)}` }],
          details: {
            ok: false,
            partial: false,
            error: String(err),
          },
        };
      }
    };
    api.registerTool(
      {
        name: "active_task_checkpoint",
        description: _activeTaskCheckpointDesc,
        parameters: _activeTaskCheckpointParams,
        execute: _execActiveTaskCheckpoint,
      },
      { name: "active_task_checkpoint" },
    );
  }

}
