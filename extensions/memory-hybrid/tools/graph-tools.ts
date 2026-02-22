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

export interface PluginContext {
  factsDb: FactsDB;
  cfg: HybridMemoryConfig;
}

/**
 * Register graph-related tools with the plugin API.
 *
 * This includes: memory_link and memory_graph (when graph is enabled).
 */
export function registerGraphTools(
  ctx: PluginContext,
  api: ClawdbotPluginApi,
): void {
  const { factsDb, cfg } = ctx;

  // Graph tools (when graph enabled)
  if (cfg.graph.enabled) {
    api.registerTool(
      {
        name: "memory_link",
        label: "Memory Link",
        description:
          "Create a typed relationship between two memories. Link types: SUPERSEDES, CAUSED_BY, PART_OF, RELATED_TO, DEPENDS_ON.",
        parameters: Type.Object({
          sourceFact: Type.String({ description: "ID of the source fact" }),
          targetFact: Type.String({ description: "ID of the target fact" }),
          linkType: stringEnum(MEMORY_LINK_TYPES as unknown as readonly string[]),
          strength: Type.Optional(
            Type.Number({ description: "Link strength 0.0-1.0 (default 1.0)" }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { sourceFact, targetFact, linkType, strength = 1.0 } = params as {
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
          depth: Type.Optional(
            Type.Number({ description: "Max hops to traverse (default 2, max 3)" }),
          ),
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
            lines.push(`  → [${l.linkType}] ${t ? t.text.slice(0, 60) + (t.text.length > 60 ? "…" : "") : l.targetFactId} (strength: ${l.strength.toFixed(2)})`);
          }
          for (const l of in_) {
            const s = factsDb.getById(l.sourceFactId);
            lines.push(`  ← [${l.linkType}] ${s ? s.text.slice(0, 60) + (s.text.length > 60 ? "…" : "") : l.sourceFactId} (strength: ${l.strength.toFixed(2)})`);
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
}
