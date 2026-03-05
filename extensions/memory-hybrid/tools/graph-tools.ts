/**
 * Graph Tool Registrations
 *
 * Tool definitions for memory link creation, graph exploration, and knowledge gap analysis.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

import type { FactsDB, MemoryLinkType } from "../backends/facts-db.js";
import { MEMORY_LINK_TYPES } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "../services/embeddings.js";
import type { HybridMemoryConfig } from "../config.js";
import { analyzeKnowledgeGaps, type GapMode } from "../services/knowledge-gaps.js";

export interface PluginContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: Embeddings;
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
  const { factsDb, vectorDb, embeddings, cfg } = ctx;

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

    // memory_gaps tool (when gaps detection is enabled)
    if (cfg.gaps.enabled) {
      api.registerTool(
        {
          name: "memory_gaps",
          label: "Memory Gaps",
          description:
            "Detect knowledge gaps in the memory graph. Reports orphan facts (zero links), " +
            "weak facts (only 1 link), and suggested connections between semantically similar " +
            "but currently unlinked facts. Results are ranked by age × isolation score.",
          parameters: Type.Object({
            mode: Type.Optional(
              stringEnum(["orphans", "weak", "all"] as const),
            ),
            limit: Type.Optional(
              Type.Number({
                description: "Max results per category (default: 20)",
              }),
            ),
          }),
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const mode: GapMode = (params.mode as GapMode | undefined) ?? "all";
            const limit =
              typeof params.limit === "number" && params.limit > 0
                ? Math.min(100, Math.floor(params.limit))
                : 20;
            const threshold = cfg.gaps.similarityThreshold;

            const report = await analyzeKnowledgeGaps(
              factsDb,
              vectorDb,
              embeddings,
              mode,
              limit,
              threshold,
            );

            const lines: string[] = [];

            if (report.orphans.length > 0) {
              lines.push(`Orphan facts (${report.orphans.length} — zero links):`);
              for (const g of report.orphans) {
                lines.push(
                  `  [${g.factId.slice(0, 8)}] score=${g.rankScore.toFixed(2)} "${g.text.slice(0, 70)}${g.text.length > 70 ? "…" : ""}"`,
                );
              }
              lines.push("");
            }

            if (report.weak.length > 0) {
              lines.push(`Weak facts (${report.weak.length} — only 1 link):`);
              for (const g of report.weak) {
                lines.push(
                  `  [${g.factId.slice(0, 8)}] score=${g.rankScore.toFixed(2)} "${g.text.slice(0, 70)}${g.text.length > 70 ? "…" : ""}"`,
                );
              }
              lines.push("");
            }

            if (report.suggestedLinks.length > 0) {
              lines.push(`Suggested links (${report.suggestedLinks.length} — similar but unlinked):`);
              for (const s of report.suggestedLinks) {
                lines.push(
                  `  sim=${s.similarity.toFixed(3)}: [${s.sourceId.slice(0, 8)}] "${s.sourceText.slice(0, 50)}${s.sourceText.length > 50 ? "…" : ""}" ↔ [${s.targetId.slice(0, 8)}] "${s.targetText.slice(0, 50)}${s.targetText.length > 50 ? "…" : ""}"`,
                );
              }
              lines.push("");
            }

            if (lines.length === 0) {
              lines.push("No knowledge gaps detected.");
            }

            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: {
                mode,
                limit,
                threshold,
                orphanCount: report.orphans.length,
                weakCount: report.weak.length,
                suggestedLinkCount: report.suggestedLinks.length,
              },
            };
          },
        },
        { name: "memory_gaps" },
      );
    }
  }
}
