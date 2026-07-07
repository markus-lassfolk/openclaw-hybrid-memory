/**
 * Fact mutation Gateway RPC methods — bidirectional editing from memory-wiki,
 * Workboard, or any Gateway client (CLI, WebUI).
 *
 * Registered under the `hybrid-mem.facts.*` namespace.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../backends/facts-db.js";
import { isValidCategory } from "../config.js";
import type { HybridMemoryConfig } from "../config.js";
import { pluginLogger } from "../utils/logger.js";
import { resolveGatewayScopeFilter, scopeFieldsFromEntry, scopeFieldsFromFilter } from "../utils/scope-filter.js";
import type { MemoryEntry } from "../types/memory.js";
import type { ScopeFilter } from "../types/memory.js";

export interface FactMutationGatewayContext {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  api: ClawdbotPluginApi;
}

type GatewayRespond = (ok: boolean, payload?: unknown, error?: { message: string }) => void;
type GatewayHandler = (opts: { params: Record<string, unknown>; respond: GatewayRespond }) => void | Promise<void>;

export function registerFactMutationGatewayMethods(ctx: FactMutationGatewayContext): void {
  if (!ctx.cfg.wikiIntegration.mutations.enabled) return;

  const register = (ctx.api as { registerGatewayMethod?: (method: string, handler: GatewayHandler) => void })
    .registerGatewayMethod;
  if (typeof register !== "function") {
    pluginLogger.debug("memory-hybrid: registerGatewayMethod unavailable; skipping fact mutation RPC methods");
    return;
  }

  const scopeFilter = (): ScopeFilter => resolveGatewayScopeFilter(ctx.api, ctx.cfg);

  register("hybrid-mem.facts.list", async ({ params, respond }) => {
    try {
      const filter = scopeFilter();
      const query = typeof params.query === "string" ? params.query : "";
      const limit = typeof params.limit === "number" ? Math.min(params.limit, 100) : 20;
      const entity = typeof params.entity === "string" ? params.entity : undefined;
      const key = typeof params.key === "string" ? params.key : undefined;

      let results: { entry: MemoryEntry; score: number }[];
      if (entity) {
        results = ctx.factsDb.lookup(entity, key, undefined, { limit, scopeFilter: filter });
      } else if (query) {
        results = ctx.factsDb.search(query, limit, {
          tierFilter: "all",
          scopeFilter: filter,
          deferAccessRefresh: true,
        });
      } else {
        results = ctx.factsDb
          .getAll({ scopeFilter: filter })
          .slice(0, limit)
          .map((entry) => ({ entry, score: 1 }));
      }

      respond(true, {
        facts: results.map((r) => factToWireFormat(r.entry, r.score)),
        count: results.length,
      });
    } catch (err) {
      respond(false, undefined, { message: errMsg(err) });
    }
  });

  register("hybrid-mem.facts.get", async ({ params, respond }) => {
    try {
      const filter = scopeFilter();
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) return respond(false, undefined, { message: "missing id" });

      const entry = ctx.factsDb.getById(id, { scopeFilter: filter });
      if (!entry) return respond(false, undefined, { message: "not found" });
      respond(true, { fact: factToWireFormat(entry) });
    } catch (err) {
      respond(false, undefined, { message: errMsg(err) });
    }
  });

  register("hybrid-mem.facts.update", async ({ params, respond }) => {
    try {
      const filter = scopeFilter();
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) return respond(false, undefined, { message: "missing id" });

      const existing = ctx.factsDb.getById(id, { scopeFilter: filter });
      if (!existing) return respond(false, undefined, { message: "not found" });

      const text = typeof params.text === "string" ? params.text : null;
      const confidence = typeof params.confidence === "number" ? params.confidence : null;
      const entity = typeof params.entity === "string" ? params.entity : null;
      const key = typeof params.key === "string" ? params.key : null;
      const value = typeof params.value === "string" ? params.value : null;
      const tags = Array.isArray(params.tags)
        ? (params.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined;

      const hasStructuralChange =
        text !== null || entity !== null || key !== null || value !== null || tags !== undefined;

      if (hasStructuralChange) {
        const stored = ctx.factsDb.store({
          text: text ?? existing.text,
          category: existing.category,
          importance: existing.importance,
          source: "wiki-edit",
          entity: entity ?? existing.entity,
          key: key ?? existing.key,
          value: value ?? existing.value,
          confidence: confidence !== null ? Math.max(0, Math.min(1, confidence)) : existing.confidence,
          tags: tags ?? existing.tags ?? undefined,
          ...scopeFieldsFromEntry(existing),
        });
        ctx.factsDb.supersede(id, stored.id);
        const updated = ctx.factsDb.getById(stored.id, { scopeFilter: filter });
        respond(true, { fact: updated ? factToWireFormat(updated) : null, superseded: id });
        pluginLogger.info(`memory-hybrid: fact ${id} updated (superseded → ${stored.id}) via gateway RPC`);
      } else if (confidence !== null) {
        ctx.factsDb.setConfidenceTo(id, Math.max(0, Math.min(1, confidence)));
        const updated = ctx.factsDb.getById(id, { scopeFilter: filter });
        respond(true, { fact: updated ? factToWireFormat(updated) : null });
        pluginLogger.info(`memory-hybrid: fact ${id} confidence updated via gateway RPC`);
      } else {
        respond(true, { fact: factToWireFormat(existing), noop: true });
      }
    } catch (err) {
      respond(false, undefined, { message: errMsg(err) });
    }
  });

  register("hybrid-mem.facts.supersede", async ({ params, respond }) => {
    try {
      const filter = scopeFilter();
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) return respond(false, undefined, { message: "missing id" });

      const existing = ctx.factsDb.getById(id, { scopeFilter: filter });
      if (!existing) return respond(false, undefined, { message: "not found" });

      const replacement = typeof params.replacementText === "string" ? params.replacementText : undefined;
      if (replacement) {
        const stored = ctx.factsDb.store({
          text: replacement,
          category: existing.category,
          importance: existing.importance,
          source: "wiki-edit",
          entity: existing.entity ?? null,
          key: existing.key ?? null,
          value: existing.value ?? null,
          confidence: existing.confidence,
          tags: existing.tags ?? undefined,
          ...scopeFieldsFromEntry(existing),
        });
        ctx.factsDb.supersede(id, stored.id);
        respond(true, {
          superseded: id,
          newFact: factToWireFormat(stored),
        });
        pluginLogger.info(`memory-hybrid: fact ${id} superseded by ${stored.id} via gateway RPC`);
      } else {
        ctx.factsDb.supersede(id, null);
        respond(true, { superseded: id });
        pluginLogger.info(`memory-hybrid: fact ${id} superseded (removed) via gateway RPC`);
      }
    } catch (err) {
      respond(false, undefined, { message: errMsg(err) });
    }
  });

  register("hybrid-mem.facts.create", async ({ params, respond }) => {
    try {
      const filter = scopeFilter();
      const text = typeof params.text === "string" ? params.text?.trim() : "";
      if (!text) return respond(false, undefined, { message: "missing text" });

      const categoryParam = typeof params.category === "string" ? params.category.trim() : "";
      const category = categoryParam || "other";
      if (!isValidCategory(category)) {
        return respond(false, undefined, { message: `invalid category "${category}"` });
      }
      const importance =
        typeof params.importance === "number" ? Math.max(0, Math.min(1, params.importance)) : 0.5;
      const entity = typeof params.entity === "string" ? params.entity : null;
      const key = typeof params.key === "string" ? params.key : null;
      const value = typeof params.value === "string" ? params.value : null;
      const confidence = typeof params.confidence === "number" ? Math.max(0, Math.min(1, params.confidence)) : 0.8;
      const tags = Array.isArray(params.tags)
        ? (params.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined;

      const stored = ctx.factsDb.store({
        text,
        category: category as import("../config.js").MemoryCategory,
        importance,
        source: "wiki-create",
        entity,
        key,
        value,
        confidence,
        tags,
        ...scopeFieldsFromFilter(filter),
      });

      respond(true, { fact: factToWireFormat(stored) });
      pluginLogger.info(`memory-hybrid: fact ${stored.id} created via gateway RPC`);
    } catch (err) {
      respond(false, undefined, { message: errMsg(err) });
    }
  });

  pluginLogger.info("memory-hybrid: registered hybrid-mem.facts.* gateway RPC methods");
}

function factToWireFormat(entry: MemoryEntry, score?: number): Record<string, unknown> {
  return {
    id: entry.id,
    text: entry.text,
    category: entry.category,
    entity: entry.entity,
    key: entry.key,
    value: entry.value,
    confidence: entry.confidence,
    importance: entry.importance,
    source: entry.source,
    tags: entry.tags,
    createdAt: entry.createdAt,
    sourceDate: entry.sourceDate,
    expiresAt: entry.expiresAt,
    supersededAt: (entry as Record<string, unknown>).supersededAt ?? null,
    ...(score !== undefined ? { score } : {}),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
