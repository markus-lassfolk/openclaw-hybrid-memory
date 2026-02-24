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

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { Embeddings } from "../services/embeddings.js";
import { chatCompleteWithRetry, type PendingLLMWarnings } from "../services/chat.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import { classifyMemoryOperation } from "../services/classification.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import {
  isCredentialLike,
  tryParseCredentialForVault,
  VAULT_POINTER_PREFIX,
} from "../services/auto-capture.js";
import { capturePluginError, addOperationBreadcrumb } from "../services/error-reporter.js";
import {
  getMemoryCategories,
  DECAY_CLASSES,
  type MemoryCategory,
  type DecayClass,
  type HybridMemoryConfig,
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
} from "../config.js";
import type { MemoryEntry, SearchResult, ScopeFilter } from "../types/memory.js";
import { MEMORY_SCOPES } from "../types/memory.js";
import { truncateForStorage } from "../utils/text.js";
import { extractTags } from "../utils/tags.js";
import { parseSourceDate } from "../utils/dates.js";

export interface PluginContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  cfg: HybridMemoryConfig;
  embeddings: Embeddings;
  openai: OpenAI;
  wal: WriteAheadLog | null;
  credentialsDb: CredentialsDB | null;
  lastProgressiveIndexIds: string[];
  currentAgentIdRef: { value: string | null };
  pendingLLMWarnings: PendingLLMWarnings;
}

/**
 * Register all memory-related tools with the plugin API.
 *
 * This includes: memory_recall, memory_recall_procedures, memory_store,
 * memory_promote, and memory_forget.
 */
export function registerMemoryTools(
  ctx: PluginContext,
  api: ClawdbotPluginApi,
  buildToolScopeFilter: (
    params: { userId?: string | null; agentId?: string | null; sessionId?: string | null },
    currentAgent: string | null,
    config: { multiAgent: { orchestratorId: string }; autoRecall: { scopeFilter?: ScopeFilter } }
  ) => ScopeFilter | undefined,
  walWrite: (
    operation: "store" | "update",
    data: Record<string, unknown>,
    logger: { warn: (msg: string) => void }
  ) => string,
  walRemove: (id: string, logger: { warn: (msg: string) => void }) => void,
  findSimilarByEmbedding: (
    vectorDb: VectorDB,
    factsDb: { getById(id: string): MemoryEntry | null },
    vector: number[],
    limit: number,
    minScore?: number
  ) => Promise<MemoryEntry[]>
): void {
  const { factsDb, vectorDb, cfg, embeddings, openai, wal, credentialsDb, lastProgressiveIndexIds, currentAgentIdRef, pendingLLMWarnings } = ctx;

  api.registerTool(
    {
      name: "memory_recall",
      label: "Memory Recall",
      description:
        "Search through long-term memories using both structured (exact) and semantic (fuzzy) search.",
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
        limit: Type.Optional(
          Type.Number({ description: "Max results (default: 10)" }),
        ),
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
            description: "Point-in-time query: ISO date (YYYY-MM-DD) or epoch seconds. Return only facts valid at that time.",
          }),
        ),
        userId: Type.Optional(
          Type.String({
            description: "⚠️ SECURITY: Caller-controlled parameter. In multi-tenant environments, derive from authenticated identity instead. Include user-private memories for this user.",
          }),
        ),
        agentId: Type.Optional(
          Type.String({
            description: "⚠️ SECURITY: Caller-controlled parameter. In multi-tenant environments, derive from authenticated identity instead. Include agent-specific memories for this agent.",
          }),
        ),
        sessionId: Type.Optional(
          Type.String({
            description: "⚠️ SECURITY: Caller-controlled parameter. In multi-tenant environments, derive from authenticated identity instead. Include session-scoped memories for this session.",
          }),
        ),
        includeCold: Type.Optional(
          Type.Boolean({
            description: "Set true to include COLD tier (slower / deeper retrieval). Default: false (HOT + WARM only).",
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
        };
        const asOfSec = asOfParam != null && asOfParam !== "" ? parseSourceDate(asOfParam) : undefined;

        // Scope filtering with auto-detection
        // ⚠️ SECURITY WARNING: userId/agentId/sessionId are caller-controlled parameters.
        // In multi-tenant production environments, these should be derived from authenticated
        // identity (via autoRecall.scopeFilter config) rather than accepted as tool parameters.
        // Accepting arbitrary scope filters allows users to access other users' private memories.
        // See docs/MEMORY-SCOPING.md "Secure Multi-Tenant Setup" for proper implementation.
        const scopeFilter = buildToolScopeFilter({ userId, agentId, sessionId }, currentAgentIdRef.value, cfg);

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
              const idx = parseInt(trimmed, 10);
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
            const entry = factsDb.getById(factId, asOfSec != null || scopeFilter ? getByIdOpts as { asOf?: number; scopeFilter?: ScopeFilter } : undefined);
            if (entry) {
              // Access boost — update recall_count and last_accessed on fetch by id
              factsDb.refreshAccessedFacts([entry.id]);
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
        let sqliteResults: SearchResult[] = [];
        if (entity) {
          sqliteResults = factsDb.lookup(entity, undefined, tag, recallOpts);
        }

        const ftsResults = factsDb.search(query, limit, {
          ...recallOpts,
          reinforcementBoost: cfg.distill?.reinforcementBoost ?? 0.1,
        });
        sqliteResults = [...sqliteResults, ...ftsResults];

        let lanceResults: SearchResult[] = [];
        if (!tag) {
          try {
            addOperationBreadcrumb("search", "vector-recall");
            let textToEmbed = query;
            if (cfg.search?.hydeEnabled) {
              try {
                const cronCfg = getCronModelConfig(cfg);
                const pref = getLLMModelPreference(cronCfg, "nano");
                const hydeModel = cfg.search.hydeModel ?? pref[0];
                const fallbackModels = cfg.search.hydeModel ? [] : pref.slice(1);
                const hydeContent = await chatCompleteWithRetry({
                  model: hydeModel,
                  fallbackModels,
                  content: `Write a short factual statement (1-2 sentences) that answers: ${query}\n\nOutput only the statement, no preamble.`,
                  temperature: 0.3,
                  maxTokens: 150,
                  openai,
                  label: "HyDE",
                  timeoutMs: 25_000,
                  pendingWarnings: pendingLLMWarnings,
                });
                const hydeText = hydeContent.trim();
                if (hydeText.length > 10) textToEmbed = hydeText;
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  subsystem: "search",
                  operation: "hyde-generation",
                  phase: "runtime",
                });
                api.logger.warn(`memory-hybrid: HyDE generation failed, using raw query: ${err}`);
              }
            }
            const vector = await embeddings.embed(textToEmbed);
            lanceResults = await vectorDb.search(vector, limit * 3, 0.3);
            lanceResults = filterByScope(lanceResults, (id, opts) => factsDb.getById(id, opts), scopeFilter);
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "search",
              operation: "vector-recall",
              phase: "runtime",
              backend: "lancedb",
            });
            api.logger.warn(`memory-hybrid: vector search failed: ${err}`);
          }
        }

        let results = mergeResults(sqliteResults, lanceResults, limit, factsDb);

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

        // Graph traversal — expand results with connected facts when enabled
        if (cfg.graph.enabled && cfg.graph.useInRecall && results.length > 0) {
          const initialIds = new Set(results.map((r) => r.entry.id));
          const connectedIds = factsDb.getConnectedFactIds([...initialIds], cfg.graph.maxTraversalDepth);
          const extraIds = connectedIds.filter((id) => !initialIds.has(id));
          const getByIdOpts = asOfSec != null || scopeFilter ? { asOf: asOfSec, scopeFilter } : undefined;
          for (const id of extraIds) {
            const entry = factsDb.getById(id, getByIdOpts as { asOf?: number; scopeFilter?: ScopeFilter });
            if (entry) {
              results.push({
                entry,
                score: 0.45,
                backend: "sqlite",
              });
            }
          }
          results.sort((a, b) => b.score - a.score);
          results = results.slice(0, limit);
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
            details: { count: 0 },
          };
        }

        const text = results
          .map(
            (r, i) =>
              `${i + 1}. [${r.backend}/${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`,
          )
          .join("\n");

        const sanitized = results.map((r) => ({
          id: r.entry.id,
          text: r.entry.text,
          category: r.entry.category,
          entity: r.entry.entity,
          importance: r.entry.importance,
          score: r.score,
          backend: r.backend,
          tags: r.entry.tags?.length ? r.entry.tags : undefined,
          sourceDate: r.entry.sourceDate
            ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
            : undefined,
        }));

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} memories:\n\n${text}`,
            },
          ],
          details: { count: results.length, memories: sanitized },
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
          limit: Type.Optional(
            Type.Number({ description: "Max procedures to return (default: 5)" }),
          ),
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
            const { taskDescription, limit = 5, agentId, userId, sessionId } = params as {
              taskDescription: string;
              limit?: number;
              agentId?: string;
              userId?: string;
              sessionId?: string;
            };
            const q = typeof taskDescription === "string" && taskDescription.trim().length > 0
              ? taskDescription.trim()
              : null;
            if (!q) {
              return {
                content: [{ type: "text" as const, text: "Provide a task description to recall procedures." }],
                details: { count: 0 },
              };
            }

          // Build scope filter (same logic as memory_recall)
          const scopeFilter = buildToolScopeFilter({ userId, agentId, sessionId }, currentAgentIdRef.value, cfg);

          const procedures = factsDb.searchProcedures(q, limit, cfg.distill?.reinforcementProcedureBoost ?? 0.1, scopeFilter);
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
                  operation: 'parse-recipe',
                  severity: 'info',
                  subsystem: 'tools'
                });
                recipe = [];
              }
              const steps = Array.isArray(recipe)
                ? (recipe as Array<{ tool?: string; args?: Record<string, unknown> }>).map(
                    (s) => s.tool + (s.args && Object.keys(s.args).length > 0 ? `(${JSON.stringify(s.args).slice(0, 80)}…)` : ""),
                  ).join(" → ")
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
                  operation: 'parse-recipe',
                  severity: 'info',
                  subsystem: 'tools'
                });
                recipe = [];
              }
              const steps = Array.isArray(recipe)
                ? (recipe as Array<{ tool?: string }>).map((s) => s.tool).filter(Boolean).join(" → ")
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
            details: { count: positiveList.length + negatives.length, procedures: positiveList.length, warnings: negatives.length },
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
          Type.Number({ description: "Importance 0-1 (default: 0.7)" }),
        ),
        category: Type.Optional(
          stringEnum(getMemoryCategories() as unknown as readonly string[]),
        ),
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
          stringEnum(DECAY_CLASSES as unknown as readonly string[]),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Topic tags for sharper retrieval (e.g. nibe, zigbee). Auto-inferred if omitted.",
          }),
        ),
        supersedes: Type.Optional(
          Type.String({
            description: "Fact id this one supersedes (replaces). Marks the old fact as superseded and links the new one.",
          }),
        ),
        scope: Type.Optional(
          stringEnum(MEMORY_SCOPES as unknown as readonly string[]),
        ),
        scopeTarget: Type.Optional(
          Type.String({
            description:
              "Scope target (userId, agentId, or sessionId). Required when scope is user, agent, or session.",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const {
            text,
            importance = 0.7,
            category = "other",
            entity: paramEntity,
            key: paramKey,
            value: paramValue,
            decayClass: paramDecayClass,
            tags: paramTags,
            supersedes,
            scope: paramScope,
            scopeTarget: paramScopeTarget,
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
          };

          let textToStore = text;
        textToStore = truncateForStorage(textToStore, cfg.captureMaxChars);

        if (factsDb.hasDuplicate(textToStore)) {
          return {
            content: [
              { type: "text", text: `Similar memory already exists.` },
            ],
            details: { action: "duplicate" },
          };
        }

        const extracted = extractStructuredFields(textToStore, category as MemoryCategory);
        const entity = paramEntity || extracted.entity;
        const key = paramKey || extracted.key;
        const value = paramValue || extracted.value;

        // FR-006: Compute scope early so it's available for classify-before-write UPDATE path; normal path may overwrite with multiAgent logic below
        let scope: "global" | "user" | "agent" | "session" = paramScope ?? "global";
        let scopeTarget: string | null =
          scope === "global"
            ? null
            : (paramScopeTarget?.trim() ?? null);
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
                content: [{ type: "text", text: `Credential already in vault for ${parsed.service} (${parsed.type}).` }],
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
            });
            try {
              addOperationBreadcrumb("vector", "store-credential-pointer");
              const vector = await embeddings.embed(pointerText);
              if (!(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({
                  text: pointerText,
                  vector,
                  importance,
                  category: "technical",
                  id: pointerEntry.id,
                });
              }
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "vector",
                operation: "store-credential-pointer",
                phase: "runtime",
                backend: "lancedb",
              });
              api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
            }
            return {
              content: [{ type: "text", text: `Credential stored in vault for ${parsed.service} (${parsed.type}). Pointer saved in memory.` }],
              details: { action: "credential_vault", id: pointerEntry.id, service: parsed.service, type: parsed.type },
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
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "embeddings",
            operation: "store-embed",
            phase: "runtime",
          });
          api.logger.warn(`memory-hybrid: embedding generation failed: ${err}`);
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
              textToStore, entity, key, similarFacts, openai, cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(cfg), "nano"), api.logger,
            );

            if (classification.action === "NOOP") {
              return {
                content: [{ type: "text", text: `Already known: ${classification.reason}` }],
                details: { action: "noop", reason: classification.reason },
              };
            }

            if (classification.action === "DELETE" && classification.targetId) {
              factsDb.supersede(classification.targetId, null);
              return {
                content: [{ type: "text", text: `Retracted fact ${classification.targetId}: ${classification.reason}` }],
                details: { action: "delete", targetId: classification.targetId, reason: classification.reason },
              };
            }

            if (classification.action === "UPDATE" && classification.targetId) {
              const oldFact = factsDb.getById(classification.targetId);
              if (oldFact) {
                const walEntryId = walWrite("update", {
                  text: textToStore, category, importance: Math.max(importance, oldFact.importance),
                  entity: entity || oldFact.entity, key: key || oldFact.key, value: value || oldFact.value,
                  source: "conversation", decayClass: paramDecayClass ?? oldFact.decayClass, summary, tags, vector,
                }, api.logger);

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
                });
                factsDb.supersede(classification.targetId, newEntry.id);

                const finalImportance = Math.max(importance, oldFact.importance);
                try {
                  if (vector && !(await vectorDb.hasDuplicate(vector))) {
                    await vectorDb.store({ text: textToStore, vector, importance: finalImportance, category, id: newEntry.id });
                  }
                } catch (err) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    subsystem: "vector",
                    operation: "store-update-supersede",
                    phase: "runtime",
                    backend: "lancedb",
                  });
                  api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
                }

                walRemove(walEntryId, api.logger);

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
                  details: { action: "updated", id: newEntry.id, superseded: classification.targetId, reason: classification.reason, backend: "both", decayClass: newEntry.decayClass },
                };
              }
            }
            // action === "ADD" falls through to normal store
          }
        }

        const walEntryId = walWrite("store", {
          text: textToStore, category, importance, entity, key, value,
          source: "conversation", decayClass: paramDecayClass, summary, tags, vector,
        }, api.logger);

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
          if (cfg.multiAgent.strictAgentScoping && !currentAgentIdRef.value &&
              (cfg.multiAgent.defaultStoreScope === "agent" || cfg.multiAgent.defaultStoreScope === "auto")) {
            throw new Error(
              `Agent detection failed (currentAgentId is null) and multiAgent.strictAgentScoping is enabled. ` +
              `Cannot auto-determine scope for defaultStoreScope="${cfg.multiAgent.defaultStoreScope}". ` +
              `Fix: ensure agent_id is provided in session context, or disable strictAgentScoping.`
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
        const nowSec = Math.floor(Date.now() / 1000);
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
          ...(supersedes?.trim()
            ? { validFrom: nowSec, supersedesId: supersedes.trim() }
            : {}),
        });
        if (supersedes?.trim()) {
          factsDb.supersede(supersedes.trim(), entry.id);
        }

        try {
          addOperationBreadcrumb("vector", "store-fact");
          if (vector && !(await vectorDb.hasDuplicate(vector))) {
            await vectorDb.store({
              text: textToStore,
              vector,
              importance,
              category,
              id: entry.id,
            });
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "vector",
            operation: "store-fact",
            phase: "runtime",
            backend: "lancedb",
          });
          api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
        }

        walRemove(walEntryId, api.logger);

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

        const storedMsg =
          `Stored: "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${entry.decayClass}]` +
          (supersedes?.trim() ? " (supersedes previous fact)" : "") +
          (autoLinked > 0 ? ` (linked to ${autoLinked} related fact${autoLinked === 1 ? "" : "s"})` : "");

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
            ...(autoLinked > 0 ? { autoLinked } : {}),
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
      description:
        "Promote a session-scoped memory to global or agent scope (so it persists after session end).",
      parameters: Type.Object({
        memoryId: Type.String({ description: "Fact id to promote" }),
        scope: Type.Union([
          Type.Literal("global"),
          Type.Literal("agent"),
        ], {
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
          details: { action: "promoted", id: memoryId, scope, scopeTarget: scope === "agent" ? scopeTarget : undefined },
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
        query: Type.Optional(
          Type.String({ description: "Search to find memory" }),
        ),
        memoryId: Type.Optional(
          Type.String({ description: "Specific memory ID" }),
        ),
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
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "vector",
              operation: "forget-vector-search",
              phase: "runtime",
              backend: "lancedb",
            });
            api.logger.warn(`memory-hybrid: vector search failed: ${err}`);
          }

          const results = mergeResults(sqlResults, lanceResults, 5, factsDb);

          if (results.length === 0) {
            return {
              content: [
                { type: "text", text: "No matching memories found." },
              ],
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
