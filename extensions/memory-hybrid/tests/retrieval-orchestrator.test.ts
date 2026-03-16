/**
 * Retrieval orchestrator tests (Issue #152).
 * Ensures graph strategy is wired into the RRF pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import { runRetrievalPipeline, DEFAULT_RETRIEVAL_CONFIG } from "../services/retrieval-orchestrator.js";

const { FactsDB } = _testing;

describe("runRetrievalPipeline graph strategy", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rrf-graph-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes graph-expanded facts when graph strategy is enabled", async () => {
    const apple = factsDb.store({
      text: "Apple is tasty",
      category: "fact",
      importance: 0.6,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    const banana = factsDb.store({
      text: "Banana is yellow",
      category: "fact",
      importance: 0.6,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    factsDb.createLink(apple.id, banana.id, "RELATED_TO", 1.0);

    const vectorDb = { search: async () => [] } as unknown as import("../backends/vector-db.js").VectorDB;
    const config = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      strategies: ["fts5", "graph"] as Array<"fts5" | "graph">,
      graphWalkDepth: 1,
      semanticTopK: 5,
      fts5TopK: 5,
    };

    const result = await runRetrievalPipeline("apple", null, factsDb.getRawDb(), vectorDb, factsDb, config, 2000);

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(apple.id);
    expect(ids).toContain(banana.id);
  });
});
