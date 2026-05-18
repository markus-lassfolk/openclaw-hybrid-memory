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

export function registerEdictTools(runtime: MemoryToolRuntime): void {
  const { edictStore, api, isEdictWriteToolEnabled } = runtime;
  // Edict tools — verified ground-truth facts with forced prompt injection (#791)
  // ---------------------------------------------------------------------------

  /** memory_add_edict — create a verified ground-truth fact (human-only; agents propose via GitHub). */
  {
    const _addEdictLabel = "Add Edict";
    const _addEdictParams = Type.Object({
      text: Type.String({ description: "The verified statement of fact to store" }),
      source: Type.Optional(
        Type.String({
          description: "Who or what verified this edict (e.g. 'human:markus', 'ops:runbook')",
        }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Labels for filtering (e.g. ['operations', 'ssh'])" }),
      ),
      ttl: Type.Optional(
        Type.String({
          description: "TTL mode: 'never' (permanent), 'event' (use expiresAt date), or seconds as number",
        }),
      ),
      expiresAt: Type.Optional(
        Type.String({
          description: "ISO 8601 date when this edict expires (for ttl='event')",
        }),
      ),
    });
    const _addEdictDesc =
      "Add a verified ground-truth fact (edict) to memory. Edicts are always injected verbatim into system prompts — the agent does NOT reason about them.\n\n" +
      'NOTE: Agents should NOT create edicts directly. To propose an edict, add a GitHub comment: [EDICT CANDIDATE] text="..." reason="..." tags=[...]. ' +
      "Only Markus (the human) should use this tool directly.";
    const _execAddEdict = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (!isEdictWriteToolEnabled()) {
          return {
            content: [
              {
                type: "text",
                text: 'memory_add_edict is disabled. Propose edicts via GitHub comment: [EDICT CANDIDATE] text="..." reason="..." tags=[...].',
              },
            ],
            details: { error: "forbidden", reason: "edict_write_disabled" },
          };
        }

        const { text, source, tags, ttl, expiresAt } = params as {
          text: string;
          source?: string;
          tags?: string[];
          ttl?: string;
          expiresAt?: string;
        };

        if (!text || text.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Provide the 'text' parameter: the verified statement to store." }],
            details: { error: "missing_text" },
          };
        }

        let ttlValue: "never" | "event" | number = "never";
        if (ttl !== undefined) {
          if (ttl === "never") ttlValue = "never";
          else if (ttl === "event") ttlValue = "event";
          else if (!Number.isNaN(Number(ttl))) ttlValue = Number(ttl);
          else {
            return {
              content: [
                {
                  type: "text",
                  text: "Invalid 'ttl' parameter: must be a positive integer number of seconds, 'never', or 'event'.",
                },
              ],
              details: { error: "invalid_ttl" },
            };
          }
        }
        if (
          typeof ttlValue === "number" &&
          (!Number.isFinite(ttlValue) || ttlValue <= 0 || !Number.isInteger(ttlValue))
        ) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid 'ttl' parameter: must be a positive integer number of seconds, 'never', or 'event'.",
              },
            ],
            details: { error: "invalid_ttl" },
          };
        }
        if (ttlValue === "event" && (!expiresAt || !expiresAt.trim())) {
          return {
            content: [
              {
                type: "text",
                text: "Provide the 'expiresAt' parameter (ISO 8601) when ttl='event'.",
              },
            ],
            details: { error: "missing_expiresAt" },
          };
        }

        const edict = edictStore.add({
          text: text.trim(),
          source,
          tags,
          ttl: ttlValue,
          expiresAt,
        });

        return {
          content: [
            {
              type: "text",
              text: `Edict added: \"${edict.text.slice(0, 80)}${edict.text.length > 80 ? "..." : ""}\" (id: ${edict.id})`,
            },
          ],
          details: { edict },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "add_edict",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_add_edict",
        label: _addEdictLabel,
        description: _addEdictDesc,
        parameters: _addEdictParams,
        execute: _execAddEdict,
      },
      { name: "memory_add_edict" },
    );
  }

  /** memory_list_edicts — list edicts, optionally filtered by tags. */
  {
    const _listEdictsLabel = "List Edicts";
    const _listEdictsParams = Type.Object({
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter to edicts with any of these tags" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 100)" })),
    });
    const _listEdictsDesc = "List all non-expired edicts, optionally filtered by tags.";
    const _execListEdicts = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const { tags, limit } = params as { tags?: string[]; limit?: number };
        const edicts = edictStore.list({ tags, limit });
        if (edicts.length === 0) {
          return {
            content: [{ type: "text", text: "No edicts found." }],
            details: { count: 0, edicts: [] },
          };
        }
        const lines = edicts.map((e) => {
          const tagStr = e.tags.length > 0 ? `[${e.tags[0]}] ` : "";
          return `- ${tagStr}${e.text}${e.expiresAt ? ` (expires: ${e.expiresAt})` : ""} (id: ${e.id})`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Edicts (${edicts.length}):\n${lines.join("\n")}`,
            },
          ],
          details: { count: edicts.length, edicts },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "list_edicts",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_list_edicts",
        label: _listEdictsLabel,
        description: _listEdictsDesc,
        parameters: _listEdictsParams,
        execute: _execListEdicts,
      },
      { name: "memory_list_edicts" },
    );
  }

  /** memory_get_edicts — get edicts formatted for system prompt injection. */
  {
    const _getEdictsLabel = "Get Edicts for Prompt";
    const _getEdictsParams = Type.Object({
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter to edicts with any of these tags" })),
      format: Type.Optional(
        Type.String({ description: "Output format: 'prompt' (Markdown block, default) or 'full' (structured)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 100)" })),
    });
    const _getEdictsDesc =
      "Get all non-expired edicts as a pre-formatted Markdown block for system prompt injection. " +
      "This is called automatically during context compaction — prefer using this tool when you need edicts explicitly.";
    const _execGetEdicts = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const { tags, format, limit } = params as { tags?: string[]; format?: string; limit?: number };
        const result = edictStore.getEdicts({ tags, format: format as "prompt" | "full", limit });
        if (result.edicts.length === 0) {
          return {
            content: [{ type: "text", text: "No edicts found." }],
            details: { count: 0, edicts: [], renderForPrompt: "" },
          };
        }
        return {
          content: [{ type: "text", text: result.renderForPrompt || JSON.stringify(result.edicts, null, 2) }],
          details: { count: result.edicts.length, edicts: result.edicts, renderForPrompt: result.renderForPrompt },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "get_edicts",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_get_edicts",
        label: _getEdictsLabel,
        description: _getEdictsDesc,
        parameters: _getEdictsParams,
        execute: _execGetEdicts,
      },
      { name: "memory_get_edicts" },
    );
  }

  /** memory_update_edict — update an existing edict's text, tags, source, or expiry. */
  {
    const _updateEdictLabel = "Update Edict";
    const _updateEdictParams = Type.Object({
      id: Type.String({ description: "The edict id to update" }),
      text: Type.Optional(Type.String({ description: "New verified statement text" })),
      source: Type.Optional(Type.String({ description: "New or updated source" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Replacement tags array" })),
      ttl: Type.Optional(Type.String({ description: "New TTL mode: 'never', 'event', or seconds as number" })),
      expiresAt: Type.Optional(Type.String({ description: "ISO 8601 expiry date for ttl='event'" })),
    });
    const _updateEdictDesc = "Update the text, tags, source, or expiry of an existing edict.";
    const _execUpdateEdict = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (!isEdictWriteToolEnabled()) {
          return {
            content: [
              {
                type: "text",
                text: 'memory_update_edict is disabled. Propose edicts via GitHub comment: [EDICT CANDIDATE] text="..." reason="..." tags=[...].',
              },
            ],
            details: { error: "forbidden", reason: "edict_write_disabled" },
          };
        }

        const { id, text, source, tags, ttl, expiresAt } = params as {
          id: string;
          text?: string;
          source?: string;
          tags?: string[];
          ttl?: string;
          expiresAt?: string;
        };

        let ttlValue: "never" | "event" | number | undefined;
        if (ttl !== undefined) {
          if (ttl === "never") ttlValue = "never";
          else if (ttl === "event") ttlValue = "event";
          else if (!Number.isNaN(Number(ttl))) ttlValue = Number(ttl);
          else {
            return {
              content: [
                {
                  type: "text",
                  text: "Invalid 'ttl' parameter: must be a positive integer number of seconds, 'never', or 'event'.",
                },
              ],
              details: { error: "invalid_ttl" },
            };
          }
        }
        if (
          typeof ttlValue === "number" &&
          (!Number.isFinite(ttlValue) || ttlValue <= 0 || !Number.isInteger(ttlValue))
        ) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid 'ttl' parameter: must be a positive integer number of seconds, 'never', or 'event'.",
              },
            ],
            details: { error: "invalid_ttl" },
          };
        }
        if (ttlValue === "event" && (!expiresAt || !expiresAt.trim())) {
          return {
            content: [
              {
                type: "text",
                text: "Provide the 'expiresAt' parameter (ISO 8601) when ttl='event'.",
              },
            ],
            details: { error: "missing_expiresAt" },
          };
        }

        const updated = edictStore.update({
          id,
          text,
          source,
          tags,
          ttl: ttlValue,
          expiresAt,
        });

        if (!updated) {
          return {
            content: [{ type: "text", text: `Edict not found: ${id}` }],
            details: { error: "not_found" },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Edict updated: \"${updated.text.slice(0, 80)}${updated.text.length > 80 ? "..." : ""}\" (id: ${updated.id})`,
            },
          ],
          details: { edict: updated },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "update_edict",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_update_edict",
        label: _updateEdictLabel,
        description: _updateEdictDesc,
        parameters: _updateEdictParams,
        execute: _execUpdateEdict,
      },
      { name: "memory_update_edict" },
    );
  }

  /** memory_remove_edict — delete an edict by id. */
  {
    const _removeEdictLabel = "Remove Edict";
    const _removeEdictParams = Type.Object({
      id: Type.String({ description: "The edict id to delete" }),
    });
    const _removeEdictDesc = "Delete an edict from memory by its id.";
    const _execRemoveEdict = async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (!isEdictWriteToolEnabled()) {
          return {
            content: [
              {
                type: "text",
                text: 'memory_remove_edict is disabled. Propose edicts via GitHub comment: [EDICT CANDIDATE] text="..." reason="..." tags=[...].',
              },
            ],
            details: { error: "forbidden", reason: "edict_write_disabled" },
          };
        }

        const { id } = params as { id: string };
        const removed = edictStore.remove(id);
        return {
          content: [
            {
              type: "text",
              text: removed ? `Edict removed: ${id}` : `Edict not found: ${id}`,
            },
          ],
          details: { removed },
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "remove_edict",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_remove_edict",
        label: _removeEdictLabel,
        description: _removeEdictDesc,
        parameters: _removeEdictParams,
        execute: _execRemoveEdict,
      },
      { name: "memory_remove_edict" },
    );
  }

  /** memory_edict_stats — get statistics about the edict store. */
  {
    const _edictStatsLabel = "Edict Stats";
    const _edictStatsParams = Type.Object({});
    const _edictStatsDesc = "Get statistics about the edict store: total, by-tag counts, expired, and expiring soon.";
    const _execEdictStats = async (_toolCallId: string) => {
      try {
        const stats = edictStore.stats();
        const lines = [
          `Total edicts: ${stats.total}`,
          `Expired: ${stats.expired}`,
          `Expiring in 7 days: ${stats.expiringIn7Days}`,
          `By tag: ${
            Object.entries(stats.byTag)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ") || "none"
          }`,
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: stats,
        };
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "memory",
          operation: "edict_stats",
          phase: "runtime",
        });
        throw err;
      }
    };
    api.registerTool(
      {
        name: "memory_edict_stats",
        label: _edictStatsLabel,
        description: _edictStatsDesc,
        parameters: _edictStatsParams,
        execute: _execEdictStats,
      },
      { name: "memory_edict_stats" },
    );
  }
}
