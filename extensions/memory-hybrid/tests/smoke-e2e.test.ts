/**
 * Regression tests for #2088: `runSmokeE2E` exercises the full memory pipeline (SQLite store,
 * embedding cache, LanceDB vector, keyword/semantic recall, graph link + degree counters,
 * episode record/search) with disposable facts and must always leave the store clean.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { runSmokeE2E } from "../services/smoke-e2e.js";

const DIM = 3;

function makeFakeEmbeddings(): EmbeddingProvider {
  return {
    // Deterministic 3-d embedding: text mentioning "companion record" (fact2) gets a distinct
    // vector from everything else (fact1 + its paraphrase), mirroring how a real embedding model
    // would place semantically-related text near each other.
    embed: vi.fn(async (text: string) => (text.includes("companion record") ? [0, 1, 0] : [1, 0, 0])),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map((t) => (t.includes("companion record") ? [0, 1, 0] : [1, 0, 0])),
    ),
    dimensions: DIM,
    modelName: "fake-smoke-embed-3d",
  };
}

function tableRowCounts(vectorDb: VectorDB, factsDb: FactsDB): Promise<{ lance: number; sqlite: number }> {
  return vectorDb.count().then((lance) => ({ lance, sqlite: factsDb.getCount() }));
}

describe("runSmokeE2E (#2088)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;
  let vectorDb: VectorDB;
  let embeddings: EmbeddingProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "smoke-e2e-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), DIM);
    embeddings = makeFakeEmbeddings();
  });

  afterEach(() => {
    factsDb.close();
    vectorDb.close();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes every step and leaves nothing behind on a clean run", async () => {
    const result = await runSmokeE2E({ factsDb, vectorDb, embeddings });

    expect(result.overall).toBe("pass");
    const stepNames = result.steps.map((s) => s.name);
    expect(stepNames).toEqual([
      "store-facts",
      "vector-store",
      "embedding-cache-row",
      "lancedb-vector-row",
      "keyword-recall",
      "semantic-recall",
      "graph-link",
      "episode-record-search",
      "cleanup",
      "cleanup-verify",
      "sync-drift",
    ]);
    for (const step of result.steps) {
      expect(step.status, `step "${step.name}" detail: ${step.detail}`).toBe("pass");
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.leftover).toEqual({ factIds: [], episodeIds: [], linkIds: [] });
    expect(result.runId).toMatch(/^[0-9a-f]{8}$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("actually leaves the store empty, not just self-reporting cleanup", async () => {
    const before = await tableRowCounts(vectorDb, factsDb);
    await runSmokeE2E({ factsDb, vectorDb, embeddings });
    const after = await tableRowCounts(vectorDb, factsDb);

    expect(after.sqlite).toBe(before.sqlite);
    expect(after.lance).toBe(before.lance);
    expect(factsDb.episodesCount()).toBe(0);
  });

  it("uses a fresh run id and marker on each invocation, so repeated runs never collide", async () => {
    const first = await runSmokeE2E({ factsDb, vectorDb, embeddings });
    const second = await runSmokeE2E({ factsDb, vectorDb, embeddings });

    expect(first.runId).not.toBe(second.runId);
    expect(first.overall).toBe("pass");
    expect(second.overall).toBe("pass");
  });

  it("marks LanceDB-dependent steps as skip (not fail) when LanceDB is unavailable, and still cleans up SQLite artifacts", async () => {
    const unavailableVectorDb = {
      isLanceDbAvailable: () => false,
    } as unknown as VectorDB;

    const result = await runSmokeE2E({ factsDb, vectorDb: unavailableVectorDb, embeddings });

    const byName = Object.fromEntries(result.steps.map((s) => [s.name, s]));
    expect(byName["vector-store"].status).toBe("skip");
    expect(byName["embedding-cache-row"].status).toBe("skip");
    expect(byName["lancedb-vector-row"].status).toBe("skip");
    expect(byName["semantic-recall"].status).toBe("skip");
    expect(byName["store-facts"].status).toBe("pass");
    expect(byName["keyword-recall"].status).toBe("pass");
    expect(byName["graph-link"].status).toBe("pass");
    expect(byName["episode-record-search"].status).toBe("pass");
    expect(byName.cleanup.status).toBe("pass");
    expect(byName["cleanup-verify"].status).toBe("pass");
    expect(result.overall).toBe("pass");
    expect(factsDb.getCount()).toBe(0);
  });

  it("reports fail with a clear detail (never throws) when embeddings.embed rejects, and still cleans up what was created", async () => {
    const failingEmbeddings: EmbeddingProvider = {
      ...embeddings,
      embed: vi.fn(async () => {
        throw new Error("embedding provider down");
      }),
    };

    const result = await runSmokeE2E({ factsDb, vectorDb, embeddings: failingEmbeddings });

    expect(result.overall).toBe("fail");
    const vectorStoreStep = result.steps.find((s) => s.name === "vector-store");
    expect(vectorStoreStep?.status).toBe("fail");
    expect(vectorStoreStep?.detail).toContain("embedding provider down");
    // store-facts still succeeded before the embedding failure — cleanup must still remove it.
    const storeFactsStep = result.steps.find((s) => s.name === "store-facts");
    expect(storeFactsStep?.status).toBe("pass");
    expect(factsDb.getCount()).toBe(0);
    expect(result.leftover.factIds).toEqual([]);
  });

  it("does not leave a fact behind in leftover once cleanup confirms deletion", async () => {
    const result = await runSmokeE2E({ factsDb, vectorDb, embeddings });
    expect(result.leftover.factIds).toHaveLength(0);
    expect(result.leftover.linkIds).toHaveLength(0);
    expect(result.leftover.episodeIds).toHaveLength(0);
  });
});
