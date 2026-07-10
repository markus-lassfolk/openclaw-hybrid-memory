/**
 * Multi-vault recall fan-out and merge (Issue #1917).
 */

import type { DatabaseSync } from "node:sqlite";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryEntry } from "../types/memory.js";
import { capturePluginError } from "./error-reporter.js";
import { runExplicitDeepRetrieval, type RetrievalPipelineOptions } from "./retrieval-orchestrator.js";
import type { FusedResult } from "./rrf-fusion.js";
import type { VaultHandle } from "./vault-registry.js";

type OrchestratorSlice = {
  fused: FusedResult[];
  packed: string[];
  packedFactIds: string[];
  tokensUsed: number;
  entries: MemoryEntry[];
};

export type MultiVaultRetrievalResult = OrchestratorSlice & {
  vaultByFactId: Map<string, string>;
};

function mergeOrchestratorSlices(
  slices: Array<{ vaultName: string; slice: OrchestratorSlice }>,
): MultiVaultRetrievalResult {
  const best = new Map<string, { score: number; vaultName: string; fused: FusedResult; entry: MemoryEntry }>();
  for (const { vaultName, slice } of slices) {
    for (let i = 0; i < slice.fused.length; i++) {
      const fused = slice.fused[i];
      const entry = slice.entries[i];
      if (!fused || !entry) continue;
      const prev = best.get(fused.factId);
      if (!prev || fused.finalScore > prev.score) {
        best.set(fused.factId, { score: fused.finalScore, vaultName, fused, entry });
      }
    }
  }

  const merged = [...best.values()].sort((a, b) => b.score - a.score);
  const vaultByFactId = new Map<string, string>();
  const fused: FusedResult[] = [];
  const entries: MemoryEntry[] = [];
  const packed: string[] = [];
  const packedFactIds: string[] = [];

  for (const item of merged) {
    vaultByFactId.set(item.fused.factId, item.vaultName);
    fused.push(item.fused);
    entries.push(item.entry);
  }

  for (const { vaultName, slice } of slices) {
    for (let i = 0; i < slice.packedFactIds.length; i++) {
      const factId = slice.packedFactIds[i];
      if (!factId || packedFactIds.includes(factId)) continue;
      if (vaultByFactId.get(factId) !== vaultName) continue;
      packedFactIds.push(factId);
      packed.push(slice.packed[i] ?? "");
    }
  }

  const tokensUsed = packed.reduce((sum, line) => sum + Math.ceil(line.length / 4), 0);
  return { fused, packed, packedFactIds, tokensUsed, entries, vaultByFactId };
}

/** Run explicit deep retrieval across one or more vault handles; merges by finalScore. */
export async function runMultiVaultExplicitDeepRetrieval(
  query: string,
  queryVector: number[] | null,
  handles: VaultHandle[],
  options: RetrievalPipelineOptions = {},
): Promise<MultiVaultRetrievalResult> {
  if (handles.length === 0) {
    throw new Error("multi-vault retrieval requires at least one vault handle");
  }
  if (handles.length === 1) {
    const h = handles[0];
    const slice = await runExplicitDeepRetrieval(
      query,
      queryVector,
      h.factsDb.getRawDb(),
      h.vectorDb,
      h.factsDb,
      options,
    );
    const vaultByFactId = new Map<string, string>();
    for (const f of slice.fused) vaultByFactId.set(f.factId, h.name);
    return { ...slice, vaultByFactId };
  }

  // Promise.allSettled (not Promise.all): one vault's SQLite/Lance error must not discard
  // the other vaults' already-completed results -- degrade to the vaults that succeeded
  // instead of failing the whole multi-vault query.
  const settled = await Promise.allSettled(
    handles.map(async (h) => ({
      vaultName: h.name,
      slice: await runExplicitDeepRetrieval(query, queryVector, h.factsDb.getRawDb(), h.vectorDb, h.factsDb, options),
    })),
  );
  const slices: Array<{ vaultName: string; slice: OrchestratorSlice }> = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      slices.push(outcome.value);
    } else {
      capturePluginError(outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)), {
        subsystem: "multi-vault-retrieval",
        operation: "vault-fanout",
        vaultName: handles[i]?.name,
        severity: "warning",
      });
    }
  }
  if (slices.length === 0) {
    throw new Error("multi-vault retrieval: all vaults failed");
  }
  return mergeOrchestratorSlices(slices);
}

export type FactLookupDb = {
  getRawDb(): DatabaseSync;
};

/** Convenience when callers already have resolved factsDb/vectorDb pairs. */
export async function runMultiVaultExplicitDeepRetrievalFromBackends(
  query: string,
  queryVector: number[] | null,
  backends: Array<{ name: string; factsDb: FactsDB; vectorDb: VectorDB }>,
  options: RetrievalPipelineOptions = {},
): Promise<MultiVaultRetrievalResult> {
  const handles: VaultHandle[] = backends.map((b) => ({
    name: b.name,
    factsDb: b.factsDb,
    vectorDb: b.vectorDb,
    sqlitePath: "",
    lancePath: "",
  }));
  return runMultiVaultExplicitDeepRetrieval(query, queryVector, handles, options);
}
