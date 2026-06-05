/**
 * Fact mutation Gateway RPC methods — bidirectional editing from memory-wiki,
 * Workboard, or any Gateway client (CLI, WebUI).
 *
 * Registered under the `hybrid-mem.facts.*` namespace.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { pluginLogger } from "../utils/logger.js";
import type { MemoryEntry } from "../types/memory.js";

export interface FactMutationGatewayContext {
  cfg: HybridMemoryConfig;
  factsDb: FactsDB;
  api: ClawdbotPluginApi;
}

type GatewayRespond = (ok: boolean, payload?: unknown, error?: { message: string }) => void;
type GatewayHandler = (opts: {
  params: Record<string, unknown>;
  respond: GatewayRespond;
}) => void | Promise<void>;

export function registerFactMutationGatewayMethods(ctx: FactMutationGatewayContext): void {
  if (!ctx.cfg.wikiIntegration.mutations.enabled) return;

  const register = (ctx.api as { registerGatewayMethod?: (method: string, handler: GatewayHandler) => void })
    .registerGatewayMethod;
  if (typeof register !== "function") {
    pluginLogger.debug("memory-hybrid: registerGatewayMethod unavailable; skipping fact mutation RPC methods");
    return;
  }

  register("hybrid-mem.facts.list", async ({ params, respond }) => {
    try {
      const query = typeof params.query === "string" ? params.query : "";
      const limit = typeof params.limit === "number" ? Math.min(params.limit, 100) : 20;
      const entity = typeof params.entity === "string" ? params.entity : undefined;
      const key = typeof params.key === "string" ? params.key : undefined;

      let results: { entry: MemoryEntry; score: number }[];
      if (entity) {
        results = ctx.factsDb.lookup(entity, key, undefined, { limit });
      } else if (query) {
        results = ctx.factsDb.search(query, limit, {
          tierFilter: "all",
          deferAccessRefresh: true,
        });
      } else {
        results = ctx.factsDb.search("*", limit, {
          tierFilter: "all",
          deferAccessRefresh: true,
        });
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
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) return respond(false, undefined, { message: "missing id" });

      const entry = ctx.factsDb.getById(id);
      if (!entry) return respond(false, undefined, { message: "not found" });
      respond(true, { fact: factToWireFormat(entry) });
    } catch (err) {
      respond(false, undefined, { message: errMsg(err) });
    }
  });

  register("hybrid-mem.facts.update", async ({ params, respond }) => {
    try {
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) return respond(false, undefined, { message: "missing id" });

      const existing = ctx.factsDb.getById(id);
      if (!existing) return respond(false, undefined, { message: "not found" });

      const text = typeof params.text === "string" ? params.text : undefined;
      const confidence = typeof params.confidence === "number" ? params.confidence : undefined;
      const entity = typeof params.entity === "string" ? params.entity : undefined;
      const key = typeof params.key === "string" ? params.key : undefined;
      const value = typeof params.value === "string" ? params.value : undefined;
      const tags = Array.isArray(params.tags)
        ? (params.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined;

      const hasStructuralChange =
        text !== undefined || entity !== undefined || key !== undefined || value !== undefined || tags !== undefined;

      if (hasStructuralChange) {
        // FactsDB doesn't support in-place text/field edits — supersede with a corrected copy.
        const stored = ctx.factsDb.store({
          text: text ?? existing.text,
          category: existing.category,
          importance: existing.importance,
          source: "wiki-edit",
          entity: entity ?? existing.entity ?? undefined,
          key: key ?? existing.key ?? undefined,
          value: value ?? existing.value ?? undefined,
          confidence: confidence !== undefined ? Math.max(0, Math.min(1, confidence)) : existing.confidence,
          tags: tags ?? existing.tags ?? undefined,
        });
        ctx.factsDb.supersede(id, stored.entry.id);
        const updated = ctx.factsDb.getById(stored.entry.id);
        respond(true, { fact: updated ? factToWireFormat(updated) : null, superseded: id });
        pluginLogger.info(`memory-hybrid: fact ${id} updated (superseded → ${stored.entry.id}) via gateway RPC`);
      } else if (confidence !== undefined) {
        ctx.factsDb.setConfidenceTo(id, Math.max(0, Math.min(1, confidence)));
        const updated = ctx.factsDb.getById(id);
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
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) return respond(false, undefined, { message: "missing id" });

      const existing = ctx.factsDb.getById(id);
      if (!existing) return respond(false, undefined, { message: "not found" });

      const replacement = typeof params.replacementText === "string" ? params.replacementText : undefined;
      if (replacement) {
        const stored = ctx.factsDb.store({
          text: replacement,
          category: existing.category,
          importance: existing.importance,
          source: "wiki-edit",
          entity: existing.entity ?? undefined,
          key: existing.key ?? undefined,
          value: existing.value ?? undefined,
          confidence: existing.confidence,
          tags: existing.tags ?? undefined,
        });
        ctx.factsDb.supersede(id, stored.entry.id);
        respond(true, {
          superseded: id,
          newFact: factToWireFormat(stored.entry),
        });
        pluginLogger.info(`memory-hybrid: fact ${id} superseded by ${stored.entry.id} via gateway RPC`);
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
      const text = typeof params.text === "string" ? params.text?.trim() : "";
      if (!text) return respond(false, undefined, { message: "missing text" });

      const category = typeof params.category === "string" ? params.category : "general";
      const importance = typeof params.importance === "number" ? params.importance : 0.5;
      const entity = typeof params.entity === "string" ? params.entity : undefined;
      const key = typeof params.key === "string" ? params.key : undefined;
      const value = typeof params.value === "string" ? params.value : undefined;
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
      });

      respond(true, { fact: factToWireFormat(stored.entry) });
      pluginLogger.info(`memory-hybrid: fact ${stored.entry.id} created via gateway RPC`);
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
