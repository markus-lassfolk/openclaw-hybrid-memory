/**
 * Provenance Tool Registrations
 *
 * Tool definitions for provenance tracing.
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";

import type { BuildToolScopeFilterFn } from "../api/memory-plugin-api.js";
import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { extractEventText } from "../services/dream-cycle.js";
import type { ProvenanceEdgeType, ProvenanceService, ProvenanceSourceType } from "../services/provenance.js";
import type { ScopeFilter } from "../types/memory.js";
import { formatTimestampUtc } from "../utils/dates.js";

interface PluginContext {
  factsDb: FactsDB;
  eventLog: EventLog | null;
  provenanceService: ProvenanceService;
  cfg: HybridMemoryConfig;
  currentAgentIdRef: { value: string | null };
  buildToolScopeFilter: BuildToolScopeFilterFn;
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
  edges: Array<{
    edgeType: ProvenanceEdgeType;
    sourceType: ProvenanceSourceType;
    sourceId: string;
    sourceText?: string;
    createdAt: string;
  }>,
  factsDb: FactsDB,
  eventLog: EventLog | null,
  provenanceService: ProvenanceService,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
  scopeFilter: ScopeFilter | undefined,
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
        // SECURITY: gate recursion on the source fact resolving in-scope — otherwise a
        // DERIVED_FROM edge pointing at another tenant's fact would still be traversed.
        const sourceFact = factsDb.getById(edge.sourceId, { scopeFilter });
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
            scopeFilter,
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
  fallbackText: string | undefined,
  depth: number,
  maxDepth: number,
  scopeFilter: ScopeFilter | undefined,
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

  // SECURITY: getProvenance() reads facts.text via raw SQL, bypassing FactsDB.getById()'s own
  // scope check — scopeFilter must be passed through so it never returns another tenant's text.
  const chain = provenanceService.getProvenance(factId, factsDb.getRawDb(), scopeFilter);
  const factEntry = factsDb.getById(factId, { scopeFilter });
  const sourceTimestamp = factEntry ? formatTimestampUtc(factEntry.createdAt) : undefined;

  const factText = chain.fact.text || fallbackText || "";

  // SECURITY: gate on the source fact resolving in-scope before recursing — otherwise an
  // out-of-scope CONSOLIDATED_FROM edge's own stored sourceText snapshot (independent of the
  // scope-checked live lookup above) would still leak into the fallback text below.
  const consolidationChain = chain.edges
    .filter((e) => e.edgeType === "CONSOLIDATED_FROM" && factsDb.getById(e.sourceId, { scopeFilter }) != null)
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
        scopeFilter,
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
      scopeFilter,
    ),
    consolidationChain,
  };
}

/**
 * Register provenance-related tools with the plugin API.
 */
export function registerProvenanceTools(ctx: PluginContext, api: ClawdbotPluginApi): void {
  const { factsDb, eventLog, provenanceService, cfg, currentAgentIdRef, buildToolScopeFilter } = ctx;

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
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
        const fact = factsDb.getById(factId, { scopeFilter });
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
          undefined,
          0,
          10,
          scopeFilter,
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
