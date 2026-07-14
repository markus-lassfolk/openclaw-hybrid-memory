/**
 * Agent verbs: memory_retrieve, memory_pin, memory_snooze, diary_* (Issue #1911).
 */

import { Type } from "@sinclair/typebox";
import type { SQLInputValue } from "node:sqlite";
import type { HybridMemoryConfig } from "../../config.js";
import {
  pinFact,
  resolveFactByIdOrQuery,
  snoozeFact,
  checkPinQuota,
  DEFAULT_PIN_QUOTA,
} from "../../services/fact-lifecycle-verbs.js";
import { createRecallSpan } from "../../services/recall-timing.js";
import { recordIntentDistribution } from "../../services/recall-timing-stats.js";
import { runExplicitDeepRetrieval } from "../../services/retrieval-orchestrator.js";
import {
  runMultiVaultExplicitDeepRetrieval,
  type MultiVaultRetrievalResult,
} from "../../services/multi-vault-retrieval.js";
import { applyRetrievalV2, DEFAULT_RETRIEVAL_V2_CONFIG } from "../../services/retrieval-v2.js";
import { applyFragmentRecallPostProcess, resolveRecallInjectionText } from "../../services/fragment-recall.js";
import { buildToolScopeFilter, scopeFieldsFromFilter } from "../../utils/scope-filter.js";
import { guardAgainstWrapperArgsDropped } from "../../services/tool-args-guard.js";
import type { MemoryToolRuntime } from "./runtime.js";
import { resolveToolVaultBackends, listToolVaultHandles } from "./vault-resolve.js";

const DEFAULT_SNOOZE_DAYS = 30;

function resolveFactInToolVaults(
  runtime: MemoryToolRuntime,
  vaultParam: string | undefined,
  idOrQuery: string,
  scopeFilter: ReturnType<typeof buildToolScopeFilter>,
): { fact: NonNullable<ReturnType<typeof resolveFactByIdOrQuery>>; factsDb: typeof runtime.factsDb } | null {
  const trimmed = vaultParam?.trim();
  if (trimmed && trimmed !== "default" && trimmed !== "all") {
    const { factsDb } = resolveToolVaultBackends(runtime, trimmed);
    const fact = resolveFactByIdOrQuery(factsDb, idOrQuery, scopeFilter);
    return fact ? { fact, factsDb } : null;
  }
  if (trimmed === "all" && runtime.resolveAllVaults) {
    for (const handle of runtime.resolveAllVaults()) {
      const fact = resolveFactByIdOrQuery(handle.factsDb, idOrQuery, scopeFilter);
      if (fact) return { fact, factsDb: handle.factsDb };
    }
    return null;
  }
  const fact = resolveFactByIdOrQuery(runtime.factsDb, idOrQuery, scopeFilter);
  return fact ? { fact, factsDb: runtime.factsDb } : null;
}

function resolveRetrievalV2Config(cfg: HybridMemoryConfig) {
  const r = cfg.retrieval;
  return {
    intentRouter: r.intentRouter ?? DEFAULT_RETRIEVAL_V2_CONFIG.intentRouter,
    compositeScore: {
      version: (r.compositeScore?.v ?? 1) as 1 | 2,
      pinBoostDefault: r.compositeScore?.pinBoostDefault ?? 0.3,
      pinBoostCap: r.compositeScore?.pinBoostCap ?? 1.0,
    },
    diversity: r.diversity ?? DEFAULT_RETRIEVAL_V2_CONFIG.diversity,
    bypass: r.bypass ?? DEFAULT_RETRIEVAL_V2_CONFIG.bypass,
  };
}

export function registerAgentVerbTools(runtime: MemoryToolRuntime): void {
  const { api, cfg, factsDb, vectorDb, openai, currentAgentIdRef } = runtime;

  api.registerTool(
    {
      name: "memory_retrieve",
      label: "Memory Retrieve",
      description: "Auto-routing recall with intent classification. Returns compact summaries by default.",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language recall query" }),
        full: Type.Optional(Type.Boolean({ description: "Return full fact text" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
        vault: Type.Optional(
          Type.String({ description: "Named vault from plugin config vaults map, or 'all' to fan out" }),
        ),
      }),
      async execute(_toolCallId: string, args: { query?: string; full?: boolean; limit?: number; vault?: string }) {
        const dropped = guardAgainstWrapperArgsDropped("memory_retrieve", args, api.logger);
        if (dropped) return dropped;
        const query = String(args.query ?? "").trim();
        if (!query) return { content: [{ type: "text", text: "Query is required." }] };
        const limit = typeof args.limit === "number" ? Math.min(20, args.limit) : 5;
        const { factsDb: activeFactsDb, vectorDb: activeVectorDb } = resolveToolVaultBackends(runtime, args.vault);
        const vaultHandles = listToolVaultHandles(runtime, args.vault);
        const recallId = createRecallSpan("retrieve");

        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });

        const embeddings = runtime.embeddings;
        const queryVector = embeddings ? await embeddings.embed(query) : null;
        const embedFn = embeddings ? (text: string) => embeddings.embed(text) : undefined;

        const pipelineOpts = {
          config: cfg.retrieval,
          rerankingConfig: cfg.reranking,
          rerankingOpenai: openai,
          embedFn,
          scopeFilter,
        };
        const result =
          vaultHandles.length > 1
            ? await runMultiVaultExplicitDeepRetrieval(query, queryVector, vaultHandles, pipelineOpts)
            : await runExplicitDeepRetrieval(
                query,
                queryVector,
                activeFactsDb.getRawDb(),
                activeVectorDb,
                activeFactsDb,
                pipelineOpts,
              );

        const fusedScoreMap = new Map(result.fused.map((f) => [f.factId, f.finalScore]));
        const ftsStub = result.entries.map((e) => ({
          entry: e,
          score: fusedScoreMap.get(e.id) ?? 0,
          backend: "sqlite" as const,
        }));

        const vaultByFactId: Map<string, string> =
          "vaultByFactId" in result ? (result as MultiVaultRetrievalResult).vaultByFactId : new Map<string, string>();
        const vaultHandleByName = new Map(vaultHandles.map((h) => [h.name, h]));
        // SECURITY: scope-check even though ids reaching getEntry are normally already scope-vetted
        // by the initial retrieval — a multi-vault fan-out (vault="all") id collision across two
        // tenants' vaults would otherwise let the unscoped fallback substitute a different-scope
        // fact's text into the response.
        const getEntry = (id: string) => {
          const vaultName = vaultByFactId.get(id);
          if (vaultName) {
            const handle = vaultHandleByName.get(vaultName);
            if (handle) return handle.factsDb.getById(id, { scopeFilter });
          }
          return activeFactsDb.getById(id, { scopeFilter });
        };

        const v2 = await applyRetrievalV2({
          query,
          results: ftsStub,
          ftsResults: ftsStub,
          getEntry,
          factsDb: activeFactsDb,
          config: resolveRetrievalV2Config(cfg),
          recallId,
          openai,
          closedLoop: cfg.closedLoop,
        });
        recordIntentDistribution(v2.intent.intent);

        const ranked = applyFragmentRecallPostProcess(v2.results);
        const lines = ranked.slice(0, limit).map((r) => {
          const vaultName = vaultByFactId.get(r.entry.id);
          const factsDbForEntry = vaultName
            ? (vaultHandleByName.get(vaultName)?.factsDb ?? activeFactsDb)
            : activeFactsDb;
          const text = args.full
            ? resolveRecallInjectionText(r.entry, factsDbForEntry, false, scopeFilter)
            : resolveRecallInjectionText(r.entry, factsDbForEntry, true, scopeFilter).slice(0, 200);
          return `- [${r.entry.category}] ${text} (id=${r.entry.id})`;
        });
        const escalate =
          v2.intent.confidence < 0.6 ? "\nescalate_to: memory_recall mode=hybrid for deeper retrieval" : "";
        return {
          content: [
            {
              type: "text",
              text: `intent=${v2.intent.intent} confidence=${v2.intent.confidence.toFixed(2)}\n${lines.join("\n")}${escalate}`,
            },
          ],
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "memory_pin",
      label: "Memory Pin",
      description: "Pin a fact for higher recall ranking.",
      parameters: Type.Object({
        idOrQuery: Type.String(),
        reason: Type.Optional(Type.String()),
        vault: Type.Optional(
          Type.String({ description: "Named vault from plugin config vaults map, or 'all' to fan out" }),
        ),
      }),
      async execute(_toolCallId: string, args: { idOrQuery?: string; reason?: string; vault?: string }) {
        const key = String(args.idOrQuery ?? "").trim();
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });
        const resolved = resolveFactInToolVaults(runtime, args.vault, key, scopeFilter);
        if (!resolved) return { content: [{ type: "text", text: "No matching fact found." }] };
        const { fact, factsDb: vaultFactsDb } = resolved;
        const quota = cfg.retrieval?.recallFeedback?.pinQuota ?? DEFAULT_PIN_QUOTA;
        const { allowed, current } = checkPinQuota(vaultFactsDb, quota, scopeFilter);
        if (!allowed) {
          return {
            content: [
              {
                type: "text",
                text: `Pin quota exceeded (${current}/${quota}). Unpin stale facts before pinning more.`,
              },
            ],
          };
        }
        const success = pinFact(vaultFactsDb, fact.id, args.reason ?? "agent pin", api.context?.sessionId ?? undefined);
        if (!success) {
          return { content: [{ type: "text", text: `Failed to pin fact ${fact.id} (may be superseded or missing)` }] };
        }
        return { content: [{ type: "text", text: `Pinned fact ${fact.id}` }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "memory_snooze",
      label: "Memory Snooze",
      description: "Hide a fact from auto-recall until a date.",
      parameters: Type.Object({
        idOrQuery: Type.String(),
        until: Type.Optional(Type.String({ description: "ISO date" })),
        vault: Type.Optional(
          Type.String({ description: "Named vault from plugin config vaults map, or 'all' to fan out" }),
        ),
      }),
      async execute(_toolCallId: string, args: { idOrQuery?: string; until?: string; vault?: string }) {
        const key = String(args.idOrQuery ?? "").trim();
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });
        const resolved = resolveFactInToolVaults(runtime, args.vault, key, scopeFilter);
        if (!resolved) return { content: [{ type: "text", text: "No matching fact found." }] };
        const { fact, factsDb: vaultFactsDb } = resolved;
        let untilSec: number;
        if (args.until) {
          const parsed = Date.parse(args.until);
          untilSec = Number.isFinite(parsed)
            ? Math.floor(parsed / 1000)
            : Math.floor(Date.now() / 1000) + DEFAULT_SNOOZE_DAYS * 86_400;
        } else {
          untilSec = Math.floor(Date.now() / 1000) + DEFAULT_SNOOZE_DAYS * 86_400;
        }
        const success = snoozeFact(vaultFactsDb, fact.id, untilSec);
        if (!success) {
          return {
            content: [{ type: "text", text: `Failed to snooze fact ${fact.id} (may be superseded or missing)` }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Snoozed ${fact.id} until ${new Date(untilSec * 1000).toISOString()}`,
            },
          ],
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "diary_write",
      label: "Diary Write",
      description: "Write a deliberate diary entry.",
      parameters: Type.Object({
        text: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId: string, args: { text?: string; tags?: string[] }) {
        const text = String(args.text ?? "").trim();
        if (!text) return { content: [{ type: "text", text: "text is required." }] };
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });
        const { scope, scopeTarget } = scopeFilter
          ? scopeFieldsFromFilter(scopeFilter)
          : { scope: "global" as const, scopeTarget: undefined };
        const result = factsDb.storeWithResult({
          text,
          category: "diary",
          importance: 0.7,
          entity: null,
          key: null,
          value: null,
          source: "diary_write",
          confidence: 0.9,
          tags: args.tags,
          scope,
          scopeTarget,
        });

        if (result.skipped) {
          return { content: [{ type: "text", text: "Diary entry was not stored (filtered or duplicate)." }] };
        }

        if (result.evictedFactId) {
          const { cleanupEvictedVector } = await import("../../services/vector-maintenance.js");
          await cleanupEvictedVector({
            vectorDb,
            evictedFactId: result.evictedFactId,
            context: "diary_write",
          });
        }

        if (runtime.embeddings && result.newlyStored) {
          try {
            const vector = await runtime.embeddings.embed(text);
            factsDb.setEmbeddingModel(result.entry.id, runtime.embeddings.modelName);
            await vectorDb.store({
              text,
              vector,
              importance: 0.7,
              category: "diary",
              id: result.entry.id,
            });
          } catch (err) {
            api.logger.warn?.(`diary_write: failed to embed fact ${result.entry.id}: ${err}`);
          }
        }

        return { content: [{ type: "text", text: `Diary entry stored: ${result.entry.id}` }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "diary_read",
      label: "Diary Read",
      description: "Read recent diary entries.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_toolCallId: string, args: { limit?: number }) {
        const limit = typeof args.limit === "number" ? Math.min(50, Math.max(1, args.limit)) : 10;
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });
        const { scope, scopeTarget } = scopeFilter
          ? scopeFieldsFromFilter(scopeFilter)
          : { scope: "global" as const, scopeTarget: undefined };
        const db = factsDb.getRawDb();
        let sql = `SELECT text FROM facts WHERE category = 'diary' AND superseded_at IS NULL`;
        const params: SQLInputValue[] = [];
        if (scope === "global") {
          sql += ` AND scope = 'global'`;
        } else {
          sql += ` AND scope = ? AND scope_target IS ?`;
          params.push(scope, scopeTarget ?? null);
        }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        const rows = db.prepare(sql).all(...params) as Array<{ text: string }>;
        const lines = rows.map((r) => `- ${r.text.slice(0, 300)}`);
        return { content: [{ type: "text", text: lines.join("\n") || "No diary entries." }] };
      },
    },
    { optional: true },
  );
}
