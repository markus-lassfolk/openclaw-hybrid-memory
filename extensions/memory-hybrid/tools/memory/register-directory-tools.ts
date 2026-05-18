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


export function registerDirectoryTools(runtime: MemoryToolRuntime): void {
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
      name: "memory_directory",
      label: "Memory directory",
      description:
        "Structured contacts and organizations (from NER + contact layer). Use list_contacts to browse people; org_view returns fact ids and people for an organization — stable views, not a single ranked memory_recall.",
      parameters: Type.Object({
        operation: stringEnum(["list_contacts", "org_view"] as const),
        name_prefix: Type.Optional(
          Type.String({ description: "For list_contacts: filter by display name prefix (optional)." }),
        ),
        org_name: Type.Optional(
          Type.String({
            description: "For org_view: organization name or key (resolves canonical org).",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max rows (default 40, max 100).",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const operation = params.operation as string;
          const limitRaw = params.limit;
          const cap = Math.min(100, Math.max(1, typeof limitRaw === "number" ? Math.floor(limitRaw) : 40));
          if (operation === "list_contacts") {
            const prefix = typeof params.name_prefix === "string" ? params.name_prefix : "";
            const rows = factsDb.listContactsByNamePrefix(prefix, cap);
            const lines = rows.map(
              (c) =>
                `- ${c.displayName} (id=${c.id})${c.primaryOrgId ? ` [org: ${c.primaryOrgId}]` : ""}${c.email ? ` email=${c.email}` : ""}`,
            );
            return {
              content: [
                {
                  type: "text",
                  text: rows.length === 0 ? "No contacts found." : `Contacts (${rows.length}):\n${lines.join("\n")}`,
                },
              ],
              details: { operation: "list_contacts", count: rows.length, contacts: rows },
            };
          }
          if (operation === "org_view") {
            const orgName = typeof params.org_name === "string" ? params.org_name.trim() : "";
            if (!orgName) {
              return {
                content: [{ type: "text", text: "org_view requires org_name." }],
                details: { error: "org_name_required" },
              };
            }
            const org = factsDb.lookupOrganization(orgName);
            if (!org) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No organization matched "${orgName}". Try the exact name from a fact or a shorter key.`,
                  },
                ],
                details: { error: "org_not_found", query: orgName },
              };
            }
            const people = factsDb.listContactsForOrganization(org.id, cap);
            const factIds = factsDb.listFactIdsLinkedToOrg(org.id, cap);
            const factSummaries = factIds.map((id) => {
              const f = factsDb.getById(id);
              return f
                ? { id: f.id, text: f.text.slice(0, 240), category: f.category }
                : { id, text: "(missing)", category: "?" };
            });
            const peopleLines = people.map((p) => `- ${p.displayName} (contact id=${p.id})`);
            const factLines = factSummaries.map((f) => `- [${f.id}] ${f.text}${f.text.length >= 240 ? "…" : ""}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Organization: ${org.displayName} (id=${org.id}, key=${org.canonicalKey})\n\nPeople (${people.length}):\n${people.length ? peopleLines.join("\n") : "(none)"}\n\nFacts linked (${factSummaries.length}):\n${factSummaries.length ? factLines.join("\n") : "(none)"}`,
                },
              ],
              details: {
                operation: "org_view",
                organization: org,
                people,
                facts: factSummaries,
              },
            };
          }
          return {
            content: [{ type: "text", text: `Unknown operation: ${operation}` }],
            details: { error: "bad_operation" },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "memory",
            operation: "memory-directory",
            phase: "runtime",
          });
          throw err;
        }
      },
    },
    { name: "memory_directory" },
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
          const scopeTargetValue = scope === "agent" ? (scopeTarget?.trim() ?? null) : null;
          const ok = factsDb.promoteScope(memoryId, scope, scopeTargetValue);
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
              const vector = await embedCallWithTimeoutAndRetry(
                () => embeddings.embed(query),
                "memory-tools:forget-vector-search",
              );
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
