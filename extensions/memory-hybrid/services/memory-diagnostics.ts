import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "./embeddings.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { SearchResult, ScopeFilter } from "../types/memory.js";
import { mergeResults, filterByScope } from "./merge-results.js";
import { capturePluginError } from "./error-reporter.js";

export type MemoryDiagnosticsResult = {
  markerId: string;
  markerText: string;
  structured: { ok: boolean; count: number };
  semantic: { ok: boolean; count: number };
  hybrid: { ok: boolean; count: number };
  autoRecall: { ok: boolean; count: number };
};

export async function runMemoryDiagnostics(opts: {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  scopeFilter?: ScopeFilter | null;
  minScore?: number;
  autoRecallLimit?: number;
}): Promise<MemoryDiagnosticsResult> {
  const { factsDb, vectorDb, embeddings, scopeFilter, minScore = 0.3, autoRecallLimit = 10 } = opts;
  const markerText = `__hybrid_mem_diag__ ${randomUUID()}`;
  let markerId = "";

  try {
    const entry = factsDb.store({
      text: markerText,
      category: "fact",
      importance: 0.5,
      source: "diagnostic",
      entity: null,
      key: null,
      value: null,
    });
    markerId = entry.id;

    const vector = await embeddings.embed(markerText);
    await vectorDb.store({
      text: markerText,
      vector,
      importance: entry.importance ?? 0.5,
      category: entry.category,
      id: entry.id,
    });

    const structuredResults = factsDb.search(markerText, 5, {
      tierFilter: "all",
      scopeFilter: scopeFilter ?? undefined,
    });

    let semanticResults: SearchResult[] = [];
    try {
      semanticResults = await vectorDb.search(vector, 5, minScore);
      semanticResults = filterByScope(semanticResults, (id, opts) => factsDb.getById(id, opts), scopeFilter ?? undefined);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "diagnostics",
        operation: "semantic-search",
      });
    }

    const hybridResults = mergeResults(structuredResults, semanticResults, 5, factsDb);
    const autoRecallResults = mergeResults(structuredResults, semanticResults, autoRecallLimit, factsDb);

    return {
      markerId: entry.id,
      markerText,
      structured: { ok: structuredResults.some((r) => r.entry.id === entry.id), count: structuredResults.length },
      semantic: { ok: semanticResults.some((r) => r.entry.id === entry.id), count: semanticResults.length },
      hybrid: { ok: hybridResults.some((r) => r.entry.id === entry.id), count: hybridResults.length },
      autoRecall: { ok: autoRecallResults.some((r) => r.entry.id === entry.id), count: autoRecallResults.length },
    };
  } finally {
    try {
      if (markerId) {
        factsDb.delete(markerId);
        await vectorDb.delete(markerId);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "diagnostics",
        operation: "cleanup",
      });
    }
  }
}
