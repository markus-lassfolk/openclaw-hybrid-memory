/**
 * Graph Tool Registrations
 *
 * Tool definitions for memory link creation and graph exploration.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

import type { FactsDB, MemoryLinkType } from "../backends/facts-db.js";
import { MEMORY_LINK_TYPES } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { findShortestPath, resolveInput, formatPath } from "../services/shortest-path.js";

export interface PluginContext {
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
}

/**
 * Register graph-related tools with the plugin API.
 *
 * This includes: memory_link and memory_graph (when graph is enabled).
 */
export function registerGraphTools(ctx: PluginContext, api: ClawdbotPluginApi): void {
  const { factsDb, cfg } = ctx;

  // Graph tools (when graph enabled)
  if (cfg.graph.enabled) {
    api.registerTool(
      {
        name: "memory_link",
        label: "Memory Link",
        description:
          "Create a typed relationship between two memories. Link types: SUPERSEDES, CAUSED_BY, PART_OF, RELATED_TO, DEPENDS_ON, CONTRADICTS (bidirectional), INSTANCE_OF (type taxonomy), DERIVED_FROM (provenance).",
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
          const src = factsDb.getById(sourceFact);
          const tgt = factsDb.getById(targetFact);
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
          const fact = factsDb.getById(factId);
          if (!fact) {
            return {
              content: [{ type: "text", text: `Fact not found: ${factId}` }],
              details: { error: "not_found", id: factId },
            };
          }
          const maxD = Math.min(3, Math.max(1, depth));
          const out = factsDb.getLinksFrom(factId);
          const in_ = factsDb.getLinksTo(factId);
          const lines: string[] = [
            `Fact: "${fact.text.slice(0, 80)}${fact.text.length > 80 ? "…" : ""}"`,
            "",
            "Direct links:",
          ];
          for (const l of out) {
            const t = factsDb.getById(l.targetFactId);
            lines.push(
              `  → [${l.linkType}] ${t ? t.text.slice(0, 60) + (t.text.length > 60 ? "…" : "") : l.targetFactId} (strength: ${l.strength.toFixed(2)})`,
            );
          }
          for (const l of in_) {
            const s = factsDb.getById(l.sourceFactId);
            lines.push(
              `  ← [${l.linkType}] ${s ? s.text.slice(0, 60) + (s.text.length > 60 ? "…" : "") : l.sourceFactId} (strength: ${l.strength.toFixed(2)})`,
            );
          }
          const connectedIds = factsDb.getConnectedFactIds([factId], maxD);
          lines.push("");
          lines.push(`Total connected facts (depth ${maxD}): ${connectedIds.length}`);
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              factId,
              outbound: out.length,
              inbound: in_.length,
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

          const fromId = resolveInput(factsDb, from);
          if (!fromId) {
            return {
              content: [
                { type: "text", text: `Could not resolve start: "${from}" (not a known fact ID or entity name)` },
              ],
              details: { error: "from_not_found", from },
            };
          }

          const toId = resolveInput(factsDb, to);
          if (!toId) {
            return {
              content: [{ type: "text", text: `Could not resolve end: "${to}" (not a known fact ID or entity name)` }],
              details: { error: "to_not_found", to },
            };
          }

          const result = findShortestPath(factsDb, fromId, toId, { maxDepth: depthCap });

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
