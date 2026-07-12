/**
 * Built-in end-to-end smoke test (Issue #2088).
 *
 * Exercises the full memory pipeline — SQLite fact storage, the fact_embeddings cache, LanceDB
 * vector storage, keyword recall, semantic/paraphrase recall, graph link creation + degree
 * counters, episode record/search — using disposable, uniquely-tagged test facts, then verifies
 * complete cleanup and that the storage-sync drift state did not regress.
 *
 * Safe to run against a production local memory store: every fact/episode is tagged with a
 * unique run id, decayClass="ephemeral", and cleanup always runs (best-effort, tracked per
 * artifact) regardless of where an earlier step failed.
 */

import { randomUUID } from "node:crypto";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { normalizeVectorId } from "../utils/vector-id.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { collectStorageSyncSnapshot, type StorageSyncSnapshot } from "./storage-sync-diagnostics.js";
import { storeCanonicalVectorForFact } from "./vector-maintenance.js";

export interface SmokeE2EStepResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  durationMs: number;
}

export interface SmokeE2ELeftoverArtifacts {
  factIds: string[];
  episodeIds: string[];
  linkIds: string[];
}

export interface SmokeE2EResult {
  runId: string;
  overall: "pass" | "fail";
  steps: SmokeE2EStepResult[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Non-empty when best-effort cleanup could not remove everything it created. */
  leftover: SmokeE2ELeftoverArtifacts;
}

async function runStep(
  steps: SmokeE2EStepResult[],
  name: string,
  fn: () => Promise<{ ok: boolean; detail: string } | { ok: "skip"; detail: string }>,
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    if (result.ok === "skip") {
      steps.push({ name, status: "skip", detail: result.detail, durationMs });
      return true;
    }
    steps.push({ name, status: result.ok ? "pass" : "fail", detail: result.detail, durationMs });
    return result.ok;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    steps.push({
      name,
      status: "fail",
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs,
    });
    return false;
  }
}

function driftRegressed(before: StorageSyncSnapshot | null, after: StorageSyncSnapshot | null): string | null {
  if (!before || !after) return null; // LanceDB unavailable on one/both sides — nothing to compare.
  if (after.sqliteActiveFacts !== before.sqliteActiveFacts) {
    return `sqliteActiveFacts changed: ${before.sqliteActiveFacts} -> ${after.sqliteActiveFacts}`;
  }
  if (after.lanceRowCount !== before.lanceRowCount) {
    return `lanceRowCount changed: ${before.lanceRowCount} -> ${after.lanceRowCount}`;
  }
  if (after.hasIdSetDrift && !before.hasIdSetDrift) {
    return `hasIdSetDrift newly introduced (vectorOrphans=${after.vectorOrphans.length}, sqliteOrphans=${after.sqliteOrphans.length})`;
  }
  if (after.hasStructuralDrift && !before.hasStructuralDrift) {
    return "hasStructuralDrift newly introduced";
  }
  return null;
}

export async function runSmokeE2E(deps: {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
}): Promise<SmokeE2EResult> {
  const { factsDb, vectorDb, embeddings } = deps;
  const startedAtMs = Date.now();
  const runId = randomUUID().slice(0, 8);
  const marker = `smoke-e2e-${runId}`;
  const steps: SmokeE2EStepResult[] = [];

  const factIds: string[] = [];
  let linkId: string | null = null;
  let episodeId: string | null = null;

  const lanceAvailable = vectorDb.isLanceDbAvailable?.() ?? true;
  const snapshotBefore = await collectStorageSyncSnapshot(factsDb, vectorDb);

  let fact1: { id: string } | undefined;
  let fact2: { id: string } | undefined;

  await runStep(steps, "store-facts", async () => {
    fact1 = factsDb.store({
      text: `Smoke test entity ${marker} was verified successfully during an automated end-to-end pipeline check.`,
      category: "fact",
      importance: 0.5,
      entity: marker,
      key: null,
      value: null,
      source: "smoke-e2e",
      decayClass: "ephemeral",
    });
    fact2 = factsDb.store({
      text: `Smoke test entity ${marker} companion record used to validate graph linking during the same pipeline check.`,
      category: "fact",
      importance: 0.5,
      entity: marker,
      key: null,
      value: null,
      source: "smoke-e2e",
      decayClass: "ephemeral",
    });
    factIds.push(fact1.id, fact2.id);
    const bothStored = Boolean(factsDb.getById(fact1.id)) && Boolean(factsDb.getById(fact2.id));
    return {
      ok: bothStored,
      detail: bothStored
        ? `stored fact1=${fact1.id} fact2=${fact2.id}`
        : "one or both facts missing immediately after store()",
    };
  });

  if (!fact1 || !fact2) {
    return finalize(steps, runId, startedAtMs, { factIds, episodeIds: [], linkIds: [] });
  }
  const f1 = fact1;
  const f2 = fact2;

  await runStep(steps, "vector-store", async () => {
    if (!lanceAvailable) return { ok: "skip", detail: "LanceDB unavailable in this environment" };
    const text1 = factsDb.getById(f1.id)?.text ?? "";
    const text2 = factsDb.getById(f2.id)?.text ?? "";
    const [v1, v2] = await Promise.all([embeddings.embed(text1), embeddings.embed(text2)]);
    await Promise.all([
      storeCanonicalVectorForFact({
        vectorDb,
        factsDb,
        factId: f1.id,
        text: text1,
        vector: v1,
        importance: 0.5,
        category: "fact",
        embeddingModel: embeddings.modelName,
      }),
      storeCanonicalVectorForFact({
        vectorDb,
        factsDb,
        factId: f2.id,
        text: text2,
        vector: v2,
        importance: 0.5,
        category: "fact",
        embeddingModel: embeddings.modelName,
      }),
    ]);
    return { ok: true, detail: `stored vectors for ${f1.id} and ${f2.id}` };
  });

  await runStep(steps, "embedding-cache-row", async () => {
    if (!lanceAvailable) return { ok: "skip", detail: "LanceDB unavailable — no cache row expected" };
    const e1 = factsDb.getEmbeddings(f1.id);
    const e2 = factsDb.getEmbeddings(f2.id);
    const c1 = e1.find((e) => e.variant === "canonical");
    const c2 = e2.find((e) => e.variant === "canonical");
    const ok = Boolean(c1 && c2 && c1.model === embeddings.modelName && c2.model === embeddings.modelName);
    return {
      ok,
      detail: ok
        ? `canonical embedding rows present (model=${embeddings.modelName}, dims=${c1?.embedding.length})`
        : `missing/mismatched canonical fact_embeddings rows (fact1=${JSON.stringify(c1?.model)}, fact2=${JSON.stringify(c2?.model)})`,
    };
  });

  await runStep(steps, "lancedb-vector-row", async () => {
    if (!lanceAvailable) return { ok: "skip", detail: "LanceDB unavailable" };
    const vectors = await vectorDb.getVectorsByFactIds([f1.id, f2.id]);
    const dim = vectorDb.getVectorDim();
    const v1 = vectors.get(normalizeVectorId(f1.id));
    const v2 = vectors.get(normalizeVectorId(f2.id));
    const ok = v1 !== undefined && v2 !== undefined && v1.length === dim && v2.length === dim;
    return {
      ok,
      detail: ok
        ? `both vectors present with expected dimension ${dim}`
        : `fact1 present=${v1 !== undefined}, fact2 present=${v2 !== undefined}, expectedDim=${dim}`,
    };
  });

  await runStep(steps, "keyword-recall", async () => {
    const results = factsDb.search(marker, 5, { tierFilter: "all" });
    const ok = results.some((r) => r.entry.id === f1.id);
    return {
      ok,
      detail: ok
        ? `keyword search found fact1 (${results.length} result(s))`
        : "fact1 not found via FTS keyword search",
    };
  });

  await runStep(steps, "semantic-recall", async () => {
    if (!lanceAvailable) return { ok: "skip", detail: "LanceDB unavailable" };
    const paraphraseQuery = `What entity is used to validate the automated end-to-end memory pipeline check called ${marker}?`;
    const queryVector = await embeddings.embed(paraphraseQuery);
    const results = await vectorDb.search(queryVector, 5, 0.1);
    const ok = results.some((r) => r.entry.id === f1.id);
    return {
      ok,
      detail: ok
        ? `semantic search found fact1 for a paraphrased query (${results.length} result(s))`
        : "fact1 not found via semantic search for a paraphrased query",
    };
  });

  await runStep(steps, "graph-link", async () => {
    linkId = factsDb.createLink(f1.id, f2.id, "RELATED_TO", 1.0);
    const outgoing = factsDb.getLinksFrom(f1.id);
    const incoming = factsDb.getLinksTo(f2.id);
    const linkReadable = outgoing.some((l) => l.id === linkId) && incoming.some((l) => l.id === linkId);
    const raw = factsDb.getRawDb();
    const row1 = raw.prepare("SELECT out_degree, in_degree FROM facts WHERE id = ?").get(f1.id) as
      | { out_degree: number; in_degree: number }
      | undefined;
    const row2 = raw.prepare("SELECT out_degree, in_degree FROM facts WHERE id = ?").get(f2.id) as
      | { out_degree: number; in_degree: number }
      | undefined;
    const degreesOk = (row1?.out_degree ?? 0) >= 1 && (row2?.in_degree ?? 0) >= 1;
    const ok = linkReadable && degreesOk;
    return {
      ok,
      detail: ok
        ? `link ${linkId} readable both directions; degrees out=${row1?.out_degree} in=${row2?.in_degree}`
        : `linkReadable=${linkReadable}, fact1.out_degree=${row1?.out_degree}, fact2.in_degree=${row2?.in_degree}`,
    };
  });

  await runStep(steps, "episode-record-search", async () => {
    const episode = factsDb.recordEpisode({
      event: `smoke-e2e run ${marker} completed a pipeline validation step`,
      outcome: "success",
      relatedFactIds: [f1.id],
      decayClass: "ephemeral",
      importance: 0.3,
      tags: [marker],
    });
    episodeId = episode.id;
    const found = factsDb.searchEpisodes({ query: marker, limit: 5 });
    const ok = found.some((e) => e.id === episode.id);
    return {
      ok,
      detail: ok
        ? `episode ${episode.id} recorded and found via search`
        : `episode ${episode.id} recorded but not found via searchEpisodes`,
    };
  });

  // Cleanup: best-effort, always attempted regardless of which checks above failed. Each artifact
  // is only removed from `leftover` once its deletion is confirmed, not merely attempted.
  const leftover: SmokeE2ELeftoverArtifacts = { factIds: [...factIds], episodeIds: [], linkIds: [] };
  if (episodeId) leftover.episodeIds.push(episodeId);
  if (linkId) leftover.linkIds.push(linkId);

  await runStep(steps, "cleanup", async () => {
    const failures: string[] = [];
    if (linkId) {
      try {
        if (factsDb.deleteLink(linkId)) {
          leftover.linkIds = leftover.linkIds.filter((id) => id !== linkId);
        } else {
          failures.push(`link ${linkId} not deleted`);
        }
      } catch (err) {
        failures.push(`link ${linkId} delete threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (episodeId) {
      try {
        if (factsDb.deleteEpisode(episodeId)) {
          leftover.episodeIds = leftover.episodeIds.filter((id) => id !== episodeId);
        } else {
          failures.push(`episode ${episodeId} not deleted`);
        }
      } catch (err) {
        failures.push(`episode ${episodeId} delete threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const factId of factIds) {
      try {
        factsDb.deleteEmbeddings(factId);
      } catch (err) {
        failures.push(
          `fact ${factId} embedding cache delete threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (lanceAvailable) {
        try {
          await vectorDb.delete(factId);
        } catch (err) {
          failures.push(`fact ${factId} vector delete threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        if (factsDb.delete(factId)) {
          leftover.factIds = leftover.factIds.filter((id) => id !== factId);
        } else {
          failures.push(`fact ${factId} not deleted`);
        }
      } catch (err) {
        failures.push(`fact ${factId} delete threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      ok: failures.length === 0,
      detail: failures.length === 0 ? "all created artifacts deleted" : failures.join("; "),
    };
  });

  await runStep(steps, "cleanup-verify", async () => {
    const problems: string[] = [];
    for (const factId of factIds) {
      if (factsDb.getById(factId)) problems.push(`fact ${factId} still present in SQLite`);
      if (factsDb.getEmbeddings(factId).length > 0) problems.push(`fact ${factId} still has fact_embeddings rows`);
    }
    if (lanceAvailable) {
      const remaining = await vectorDb.getVectorsByFactIds(factIds);
      if (remaining.size > 0) problems.push(`${remaining.size} LanceDB vector row(s) still present`);
    }
    if (factsDb.getLinksFrom(f1.id).length > 0) problems.push("fact1 still has outgoing links");
    if (episodeId && factsDb.getEpisode(episodeId)) problems.push(`episode ${episodeId} still present`);
    return {
      ok: problems.length === 0,
      detail: problems.length === 0 ? "no leftover rows in SQLite/LanceDB/links/cache/episodes" : problems.join("; "),
    };
  });

  await runStep(steps, "sync-drift", async () => {
    const snapshotAfter = await collectStorageSyncSnapshot(factsDb, vectorDb);
    const regression = driftRegressed(snapshotBefore, snapshotAfter);
    return {
      ok: regression === null,
      detail: regression ?? "storage-sync state unchanged (or LanceDB unavailable — nothing to compare)",
    };
  });

  return finalize(steps, runId, startedAtMs, leftover);
}

function finalize(
  steps: SmokeE2EStepResult[],
  runId: string,
  startedAtMs: number,
  leftover: SmokeE2ELeftoverArtifacts,
): SmokeE2EResult {
  const finishedAtMs = Date.now();
  const overall: SmokeE2EResult["overall"] = steps.some((s) => s.status === "fail") ? "fail" : "pass";
  return {
    runId,
    overall,
    steps,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    leftover,
  };
}
