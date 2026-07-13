/**
 * CLI registration for `provenance <factId>` (issue #2090).
 *
 * `memory_provenance` has been agent-tool-only; operators had no CLI fallback for tracing a
 * fact's provenance chain when Tool Search wrappers were stale/degraded. Thin wrapper over the
 * same ProvenanceService.getProvenance() the tool uses — no scope filter (CLI is an
 * operator-trusted context, same convention as every other hybrid-mem command that touches
 * factsDb/provenanceService directly).
 */

import { type Chainable, withExit } from "../../shared.js";
import type { ManageBindings } from "./bindings.js";

export function registerManageProvenanceTools(mem: Chainable, b: ManageBindings): void {
  const { factsDb, provenanceService, cfg } = b;

  mem
    .command("provenance <factId>")
    .description("Show a fact's provenance chain (source session/turn plus DERIVED_FROM/CONSOLIDATED_FROM edges).")
    .option("--json", "Output as JSON")
    .action(
      withExit(async (factId: string, opts?: { json?: boolean }) => {
        if (cfg.provenance?.enabled === false) {
          throw new Error("Provenance tracking is disabled (provenance.enabled=false).");
        }
        if (!provenanceService) {
          throw new Error("Provenance service is unavailable (provenanceService not configured).");
        }
        if (!factsDb.getById(factId)) {
          throw new Error(`Fact not found: ${factId}`);
        }

        const chain = provenanceService.getProvenance(factId, factsDb.getRawDb());
        if (opts?.json) {
          console.log(JSON.stringify(chain, null, 2));
          return;
        }
        console.log(`Fact: ${chain.fact.text || "(text unavailable)"}`);
        console.log(`  id: ${chain.fact.id}`);
        console.log(`  confidence: ${chain.fact.confidence}`);
        if (chain.source.sessionId) console.log(`  source session: ${chain.source.sessionId}`);
        if (chain.source.turn !== undefined) console.log(`  source turn: ${chain.source.turn}`);
        if (chain.source.extractionMethod) console.log(`  extraction method: ${chain.source.extractionMethod}`);
        if (chain.edges.length === 0) {
          console.log("  edges: (none)");
          return;
        }
        console.log(`  edges (${chain.edges.length}):`);
        for (const edge of chain.edges) {
          console.log(
            `    ${edge.edgeType} <- ${edge.sourceType}:${edge.sourceId}${edge.sourceText ? ` "${edge.sourceText.slice(0, 60)}"` : ""}`,
          );
        }
      }),
    );
}
