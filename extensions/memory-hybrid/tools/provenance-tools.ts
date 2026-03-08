/**
 * Provenance Tool Registrations
 *
 * Tool definitions for provenance tracing.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";

import type { FactsDB } from "../backends/facts-db.js";
import type { EventLog } from "../backends/event-log.js";
import type { HybridMemoryConfig } from "../config.js";
import type { ProvenanceEdgeRecord, ProvenanceEdgeType, ProvenanceSourceType, ProvenanceService } from "../services/provenance.js";
import { extractEventText } from "../services/dream-cycle.js";

export interface PluginContext {
  factsDb: FactsDB;
  eventLog: EventLog | null;
  provenanceService: ProvenanceService;
  cfg: HybridMemoryConfig;
}

type DerivedFromEntry = {
  event_id: string;
  event_text: string;
  timestamp?: string;
  source_type?: string;
  fact_chain?: ProvenanceChainOutput | null;
};

type ProvenanceChainOutput = {
  fact: { id: string; text: string; confidence: number };
  source: {
    session_id?: string;
    timestamp?: string;
    turn: number | null;
    extraction_method?: string;
    extraction_confidence?: number;
  };
  derivedFrom: DerivedFromEntry[];
  consolidationChain: ProvenanceChainOutput[];
};

function buildDerivedFrom(
  edges: Array<{ edgeType: ProvenanceEdgeType; sourceType: ProvenanceSourceType; sourceId: string; sourceText?: string; createdAt: string }>,
  factsDb: FactsDB,
  eventLog: EventLog | null,
  provenanceService: ProvenanceService,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
): DerivedFromEntry[] {
  return edges
    .filter((e) => e.edgeType === "DERIVED_FROM")
    .map((edge) => {
      let eventText = edge.sourceText ?? "";
      let timestamp = edge.createdAt;
      if (edge.sourceType === "event_log" && eventLog) {
        const event = eventLog.getById(edge.sourceId);
        if (event) {
          const extracted = extractEventText(event);
          if (extracted) eventText = extracted;
          timestamp = event.timestamp ?? timestamp;
        }
      }

      let factChain: ProvenanceChainOutput | null = null;
      if (depth < maxDepth) {
        const sourceFact = factsDb.getById(edge.sourceId);
        if (sourceFact) {
          factChain = buildProvenanceChain(
            factsDb,
            eventLog,
            provenanceService,
            edge.sourceId,
            visited,
            edge.sourceText ?? sourceFact.text,
            depth + 1,
            maxDepth,
          );
        }
      }

      return {
        event_id: edge.sourceId,
        event_text: eventText,
        timestamp,
        source_type: edge.sourceType,
        fact_chain: factChain,
      };
    });
}

function buildProvenanceChain(
  factsDb: FactsDB,
  eventLog: EventLog | null,
  provenanceService: ProvenanceService,
  factId: string,
  visited: Set<string>,
  fallbackText?: string,
  depth = 0,
  maxDepth = 10,
): ProvenanceChainOutput {
  if (depth >= maxDepth) {
    return {
      fact: { id: factId, text: fallbackText ?? "", confidence: 0 },
      source: { turn: null },
      derivedFrom: [],
      consolidationChain: [],
    };
  }
  if (visited.has(factId)) {
    return {
      fact: { id: factId, text: fallbackText ?? "", confidence: 0 },
      source: { turn: null },
      derivedFrom: [],
      consolidationChain: [],
    };
  }
  visited.add(factId);

  const chain = provenanceService.getProvenance(factId, factsDb.getRawDb());
  const factEntry = factsDb.getById(factId);
  const sourceTimestamp = factEntry
    ? new Date(factEntry.createdAt * 1000).toISOString()
    : undefined;

  const factText = chain.fact.text || fallbackText || "";

  const consolidationChain = chain.edges
    .filter((e) => e.edgeType === "CONSOLIDATED_FROM")
    .map((edge) =>
      buildProvenanceChain(
        factsDb,
        eventLog,
        provenanceService,
        edge.sourceId,
        visited,
        edge.sourceText ?? undefined,
        depth + 1,
        maxDepth,
      ),
    );

  return {
    fact: {
      id: chain.fact.id,
      text: factText,
      confidence: chain.fact.confidence ?? 0,
    },
    source: {
      session_id: chain.source.sessionId,
      timestamp: sourceTimestamp,
      turn: chain.source.turn ?? null,
      extraction_method: chain.source.extractionMethod,
      extraction_confidence: chain.source.extractionConfidence,
    },
    derivedFrom: buildDerivedFrom(
      chain.edges,
      factsDb,
      eventLog,
      provenanceService,
      visited,
      depth,
      maxDepth,
    ),
    consolidationChain,
  };
}

/**
 * Register provenance-related tools with the plugin API.
 */
export function registerProvenanceTools(ctx: PluginContext, api: ClawdbotPluginApi): void {
  const { factsDb, eventLog, provenanceService, cfg } = ctx;

  api.registerTool(
    {
      name: "memory_provenance",
      label: "Memory Provenance",
      description: "Return the full provenance chain for a memory fact.",
      parameters: Type.Object({
        factId: Type.String({ description: "Fact id to trace" }),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        if (!cfg.provenance.enabled) {
          return {
            content: [
              {
                type: "text",
                text: "Provenance tracing is disabled. Enable provenance.enabled to use memory_provenance.",
              },
            ],
            details: { error: "provenance_disabled" },
          };
        }
        const { factId } = params as { factId: string };
        const fact = factsDb.getById(factId);
        if (!fact) {
          return {
            content: [{ type: "text", text: `Fact not found: ${factId}` }],
            details: { error: "not_found", id: factId },
          };
        }

        const chain = buildProvenanceChain(
          factsDb,
          eventLog,
          provenanceService,
          factId,
          new Set<string>(),
        );

        return {
          content: [{ type: "text", text: JSON.stringify(chain, null, 2) }],
          details: { provenance: chain },
        };
      },
    },
    { name: "memory_provenance" },
  );
}
