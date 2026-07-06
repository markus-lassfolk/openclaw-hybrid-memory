/**
 * Graph Tool Registrations
 *
 * Tool definitions for memory link creation and graph exploration.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { stringEnum } from "../utils/typebox.js";

import type { BuildToolScopeFilterFn } from "../api/memory-plugin-api.js";
import type { FactsDB, MemoryLinkType } from "../backends/facts-db.js";
import { MEMORY_LINK_TYPES } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { findShortestPath, formatPath, resolveInput, type ShortestPathLookup } from "../services/shortest-path.js";

export interface PluginContext {
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
  currentAgentIdRef: { value: string | null };
  buildToolScopeFilter: BuildToolScopeFilterFn;
}

/**
 * Register graph-related tools with the plugin API.
 *
 * This includes: memory_link and memory_graph (when graph is enabled).
 */
export function registerGraphTools(ctx: PluginContext, api: ClawdbotPluginApi): void {
  const { factsDb, cfg, currentAgentIdRef, buildToolScopeFilter } = ctx;

  // Graph tools (when graph enabled)
  if (cfg.graph.enabled) {
    api.registerTool(
      {
        name: "memory_link",
        label: "Memory Link",
        description:
          "Create a typed relationship between two memories. Link types: SUPERSEDES, CAUSED_BY, PART_OF, RELATED_TO, DEPENDS_ON, CONTRADICTS (bidirectional), INSTANCE_OF (type taxonomy). DERIVED_FROM provenance is stored on facts.provenance_json, not memory_links.",
        parameters: Type.Object({
          sourceFact: Type.String({ description: "ID of the source fact" }),
          targetFact: Type.String({ description: "ID of the target fact" }),
          linkType: stringEnum(MEMORY_LINK_TYPES as unknown as readonly string[]),
          strength: Type.Optional(Type.Number({ description: "Link strength 0.0-1.0 (default 1.0)" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const {
            sourceFact,
            targetFact,
            linkType,
            strength = 1.0,
          } = params as {
            sourceFact: string;
            targetFact: string;
            linkType: MemoryLinkType;
            strength?: number;
          };
          // SECURITY: both endpoints must be in-scope before linking — otherwise a caller could
          // tie an out-of-scope (another tenant's) fact into their own graph, or discover its id
          // exists, just by guessing/enumerating ids (mirrors the GraphQL createLink guard).
          const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
          const src = factsDb.getById(sourceFact, { scopeFilter });
          const tgt = factsDb.getById(targetFact, { scopeFilter });
          if (!src) {
            return {
              content: [{ type: "text", text: `Source fact not found: ${sourceFact}` }],
              details: { error: "source_not_found", id: sourceFact },
            };
          }
          if (!tgt) {
            return {
              content: [{ type: "text", text: `Target fact not found: ${targetFact}` }],
              details: { error: "target_not_found", id: targetFact },
            };
          }
          if (linkType === "CONTRADICTS") {
            const contradictionId = factsDb.recordContradiction(sourceFact, targetFact);
            const msg = `Created bidirectional ${linkType} link from "${src.text.slice(0, 50)}${src.text.length > 50 ? "…" : ""}" to "${tgt.text.slice(0, 50)}${tgt.text.length > 50 ? "…" : ""}" and reduced confidence`;
            return {
              content: [{ type: "text", text: msg }],
              details: { contradictionId, sourceFact, targetFact, linkType },
            };
          }
          const linkId = factsDb.createLink(sourceFact, targetFact, linkType, strength);
          const msg = `Created ${linkType} link from "${src.text.slice(0, 50)}${src.text.length > 50 ? "…" : ""}" to "${tgt.text.slice(0, 50)}${tgt.text.length > 50 ? "…" : ""}" (strength: ${strength})`;
          return {
            content: [{ type: "text", text: msg }],
            details: { linkId, sourceFact, targetFact, linkType, strength },
          };
        },
      },
      { name: "memory_link" },
    );

    api.registerTool(
      {
        name: "memory_graph",
        label: "Memory Graph",
        description: "Explore connections from a memory: show direct links and optionally traverse up to depth 3.",
        parameters: Type.Object({
          factId: Type.String({ description: "ID of the fact to explore" }),
          depth: Type.Optional(Type.Number({ description: "Max hops to traverse (default 2, max 3)" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { factId, depth = 2 } = params as { factId: string; depth?: number };
          // SECURITY: memory_links carries no scope column of its own — it connects two
          // independently-scoped facts — so every endpoint (the anchor fact, each direct link's
          // other end, and every BFS-connected id) must be re-checked against the caller's scope
          // rather than trusted just because a link row references it.
          const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
          const fact = factsDb.getById(factId, { scopeFilter });
          if (!fact) {
            return {
              content: [{ type: "text", text: `Fact not found: ${factId}` }],
              details: { error: "not_found", id: factId },
            };
          }
          const maxD = Math.min(3, Math.max(1, depth));
          const lines: string[] = [
            `Fact: "${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}"`,
            "",
            "Direct links:",
          ];
          let outboundVisible = 0;
          for (const l of factsDb.getLinksFrom(factId)) {
            const t = factsDb.getById(l.targetFactId, { scopeFilter });
            if (!t) continue; // out-of-scope (or deleted) — omit rather than leak the raw id
            outboundVisible++;
            lines.push(
              `  → [${l.linkType}] ${t.text.slice(0, 60)}${t.text.length > 60 ? "…" : ""} (strength: ${l.strength.toFixed(2)})`,
            );
          }
          let inboundVisible = 0;
          for (const l of factsDb.getLinksTo(factId)) {
            const s = factsDb.getById(l.sourceFactId, { scopeFilter });
            if (!s) continue;
            inboundVisible++;
            lines.push(
              `  ← [${l.linkType}] ${s.text.slice(0, 60)}${s.text.length > 60 ? "…" : ""} (strength: ${l.strength.toFixed(2)})`,
            );
          }
          const connectedIds = factsDb
            .getConnectedFactIds([factId], maxD, { hubDegreeCap: cfg.graph.hubDegreeCap })
            .filter((id) => factsDb.getById(id, { scopeFilter }) != null);
          lines.push("");
          lines.push(`Total connected facts (depth ${maxD}): ${connectedIds.length}`);
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              factId,
              outbound: outboundVisible,
              inbound: inboundVisible,
              connectedCount: connectedIds.length,
            },
          };
        },
      },
      { name: "memory_graph" },
    );
  }

  // Shortest-path tool (when path is enabled)
  if (cfg.path.enabled) {
    api.registerTool(
      {
        name: "memory_path",
        label: "Memory Path",
        description:
          "Find the shortest path between two memories via BFS on the memory graph. " +
          "Both `from` and `to` accept a fact ID or an entity name (resolved automatically). " +
          "Returns the chain of facts and link types, or reports no path within maxDepth.",
        parameters: Type.Object({
          from: Type.String({ description: "Start fact ID or entity name" }),
          to: Type.String({ description: "End fact ID or entity name" }),
          maxDepth: Type.Optional(
            Type.Number({ description: `Max hops to traverse (default 5, max ${cfg.path.maxPathDepth})` }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const {
            from,
            to,
            maxDepth = 5,
          } = params as {
            from: string;
            to: string;
            maxDepth?: number;
          };

          const depthCap = Math.min(cfg.path.maxPathDepth, Math.max(1, Math.floor(maxDepth)));

          // SECURITY: getNeighbors() in shortest-path.ts already re-validates every candidate hop
          // via db.getById() before accepting it into the BFS frontier (originally to exclude
          // superseded facts) — so binding getById (and entity-name lookup) to the caller's scope
          // here is sufficient to keep the whole traversal from ever entering or resolving to an
          // out-of-scope fact; getLinksFrom/getLinksTo don't need their own scope filter.
          const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
          const scopedLookup: ShortestPathLookup = {
            getById: (id) => factsDb.getById(id, { scopeFilter }),
            getLinksFrom: (id) => factsDb.getLinksFrom(id),
            getLinksTo: (id) => factsDb.getLinksTo(id),
            lookup: (entity) => factsDb.lookup(entity, undefined, undefined, { scopeFilter }),
          };

          const fromId = resolveInput(scopedLookup, from);
          if (!fromId) {
            return {
              content: [
                { type: "text", text: `Could not resolve start: "${from}" (not a known fact ID or entity name)` },
              ],
              details: { error: "from_not_found", from },
            };
          }

          const toId = resolveInput(scopedLookup, to);
          if (!toId) {
            return {
              content: [{ type: "text", text: `Could not resolve end: "${to}" (not a known fact ID or entity name)` }],
              details: { error: "to_not_found", to },
            };
          }

          const result = findShortestPath(scopedLookup, fromId, toId, { maxDepth: depthCap });

          if (!result) {
            return {
              content: [{ type: "text", text: `No path found between "${from}" and "${to}" within ${depthCap} hops.` }],
              details: { found: false, fromId, toId, maxDepth: depthCap },
            };
          }

          const lines: string[] = [
            `Path found: ${result.hops} hop${result.hops === 1 ? "" : "s"}`,
            "",
            formatPath(result.steps),
            "",
            "Chain:",
          ];
          for (let i = 0; i < result.chain.length; i++) {
            const entry = result.chain[i];
            const step = result.steps[i - 1];
            if (step) {
              lines.push(`  —[${step.linkType}]→`);
            }
            lines.push(`  [${entry.id.slice(0, 8)}…] ${entry.text.slice(0, 80)}${entry.text.length > 80 ? "…" : ""}`);
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              found: true,
              fromId,
              toId,
              hops: result.hops,
              steps: result.steps,
            },
          };
        },
      },
      { name: "memory_path" },
    );
  }
}
