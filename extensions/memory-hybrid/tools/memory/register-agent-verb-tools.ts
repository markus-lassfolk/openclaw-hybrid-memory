/**
 * Agent verbs: memory_retrieve, memory_pin, memory_snooze, diary_* (Issue #1911).
 */

import { Type } from "@sinclair/typebox";
import type { HybridMemoryConfig } from "../../config.js";
import { pinFact, resolveFactByIdOrQuery, snoozeFact } from "../../services/fact-lifecycle-verbs.js";
import { createRecallSpan } from "../../services/recall-timing.js";
import { recordIntentDistribution } from "../../services/recall-timing-stats.js";
import { runExplicitDeepRetrieval } from "../../services/retrieval-orchestrator.js";
import { applyRetrievalV2, DEFAULT_RETRIEVAL_V2_CONFIG } from "../../services/retrieval-v2.js";
import { buildToolScopeFilter } from "../../utils/scope-filter.js";
import type { MemoryToolRuntime } from "./runtime.js";

const DEFAULT_SNOOZE_DAYS = 30;

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
      }),
      async execute(_id, args: { query?: string; full?: boolean; limit?: number }) {
        const query = String(args.query ?? "").trim();
        if (!query) return { content: [{ type: "text", text: "Query is required." }] };
        const limit = typeof args.limit === "number" ? Math.min(20, args.limit) : 5;
        const recallId = createRecallSpan("retrieve");

        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });

        const embeddings = runtime.embeddings;
        const queryVector = embeddings ? await embeddings.embed(query) : null;
        const embedFn = embeddings ? (text: string) => embeddings.embed(text) : undefined;

        const result = await runExplicitDeepRetrieval(query, queryVector, factsDb.getRawDb(), vectorDb, factsDb, {
          config: cfg.retrieval,
          rerankingConfig: cfg.reranking,
          rerankingOpenai: openai,
          embedFn,
          scopeFilter,
        });

        const fusedScoreMap = new Map(result.fused.map((f) => [f.factId, f.finalScore]));
        const ftsStub = result.entries.map((e) => ({
          entry: e,
          score: fusedScoreMap.get(e.id) ?? 0,
          backend: "sqlite" as const,
        }));
        const v2 = await applyRetrievalV2({
          query,
          results: ftsStub,
          ftsResults: ftsStub,
          getEntry: (id) => factsDb.getById(id),
          config: resolveRetrievalV2Config(cfg),
          recallId,
          openai,
        });
        recordIntentDistribution(v2.intent.intent);

        const lines = v2.results.slice(0, limit).map((r) => {
          const text = args.full ? r.entry.text : r.entry.text.slice(0, 200);
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
      }),
      async execute(_id, args: { idOrQuery?: string; reason?: string }) {
        const key = String(args.idOrQuery ?? "").trim();
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });
        const fact = resolveFactByIdOrQuery(factsDb, key, scopeFilter);
        if (!fact) return { content: [{ type: "text", text: "No matching fact found." }] };
        pinFact(factsDb, fact.id, args.reason ?? "agent pin");
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
      }),
      async execute(_id, args: { idOrQuery?: string; until?: string }) {
        const key = String(args.idOrQuery ?? "").trim();
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });
        const fact = resolveFactByIdOrQuery(factsDb, key, scopeFilter);
        if (!fact) return { content: [{ type: "text", text: "No matching fact found." }] };
        let untilSec: number;
        if (args.until) {
          const parsed = Date.parse(args.until);
          untilSec = Number.isFinite(parsed)
            ? Math.floor(parsed / 1000)
            : Math.floor(Date.now() / 1000) + DEFAULT_SNOOZE_DAYS * 86_400;
        } else {
          untilSec = Math.floor(Date.now() / 1000) + DEFAULT_SNOOZE_DAYS * 86_400;
        }
        snoozeFact(factsDb, fact.id, untilSec);
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
      async execute(_id, args: { text?: string; tags?: string[] }) {
        const text = String(args.text ?? "").trim();
        if (!text) return { content: [{ type: "text", text: "text is required." }] };
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
      async execute(_id, args: { limit?: number }) {
        const limit = typeof args.limit === "number" ? args.limit : 10;
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, {
          multiAgent: cfg.multiAgent,
          autoRecall: cfg.autoRecall,
        });
        const db = factsDb.getRawDb();
        let sql = `SELECT text FROM facts WHERE category = 'diary' AND superseded_at IS NULL`;
        const params: unknown[] = [];
        if (scopeFilter) {
          if (scopeFilter.sessionId) {
            sql += ` AND scope = 'session' AND scope_target = ?`;
            params.push(scopeFilter.sessionId);
          } else if (scopeFilter.userId) {
            sql += ` AND ((scope = 'user' AND scope_target = ?) OR scope = 'global')`;
            params.push(scopeFilter.userId);
          } else if (scopeFilter.agentId) {
            sql += ` AND ((scope = 'agent' AND scope_target = ?) OR scope = 'global')`;
            params.push(scopeFilter.agentId);
          } else {
            sql += ` AND scope = 'global'`;
          }
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
