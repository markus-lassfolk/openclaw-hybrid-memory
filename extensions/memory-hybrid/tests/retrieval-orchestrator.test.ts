/**
 * Retrieval orchestrator tests (Issue #152).
 * Ensures graph strategy is wired into the RRF pipeline.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { RETRIEVAL_MODE } from "../services/retrieval-mode-policy.js";
import { DEFAULT_RETRIEVAL_CONFIG, runRetrievalPipeline } from "../services/retrieval-orchestrator.js";

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

    const result = await runRetrievalPipeline("apple", null, factsDb.getRawDb(), vectorDb, factsDb, {
      config,
      budgetTokens: 2000,
    });

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(apple.id);
    expect(ids).toContain(banana.id);
  });

  it("disables graph expansion in interactive recall mode", async () => {
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

    const result = await runRetrievalPipeline("apple", null, factsDb.getRawDb(), vectorDb, factsDb, {
      mode: RETRIEVAL_MODE.INTERACTIVE_RECALL,
      config,
      budgetTokens: 2000,
    });

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(apple.id);
    expect(ids).not.toContain(banana.id);
  });
});
