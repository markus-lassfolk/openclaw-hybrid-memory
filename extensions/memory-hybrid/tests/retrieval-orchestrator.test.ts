/**
 * Retrieval orchestrator tests (Issue #152).
 * Ensures graph strategy is wired into the RRF pipeline.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { IssueStore } from "../backends/issue-store.js";
import { RETRIEVAL_MODE } from "../services/retrieval-mode-policy.js";
import { DEFAULT_RETRIEVAL_CONFIG, runRetrievalPipeline } from "../services/retrieval-orchestrator.js";

const { FactsDB } = _testing;

const makeVec = (n = 4): Float32Array => new Float32Array(new Array(n).fill(0).map((_, i) => (i === 0 ? 1 : 0)));

describe("runRetrievalPipeline explicit-deep + issueStore integration", () => {
  let tmpDir: string;
  let issueTmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let issueStore: IssueStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rrf-explicit-issue-"));
    issueTmpDir = mkdtempSync(join(tmpdir(), "rrf-explicit-issue-store-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    issueStore = new IssueStore(join(issueTmpDir, "issues.db"));
  });

  afterEach(() => {
    issueStore.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(issueTmpDir, { recursive: true, force: true });
  });

  function seedIssueLinkedCorpus() {
    const issueFact = factsDb.store({
      text: "Critical LanceDB vector index corruption on deploy",
      category: "fact",
      importance: 0.9,
      entity: "openclaw-hybrid-memory",
      key: null,
      value: null,
      source: "conversation",
    });
    const unrelatedFact = factsDb.store({
      text: "Unique zebra migration pattern for explicit deep recall test",
      category: "fact",
      importance: 0.6,
      entity: "wildlife",
      key: null,
      value: null,
      source: "conversation",
    });
    const noiseFacts = Array.from({ length: 12 }, (_, i) =>
      factsDb.store({
        text: `Unrelated filler fact number ${i} about gardening tools`,
        category: "fact",
        importance: 0.4,
        entity: "misc",
        key: null,
        value: null,
        source: "conversation",
      }),
    );

    const issue = issueStore.create({
      title: "LanceDB corruption on deploy",
      symptoms: ["vector index corrupt", "deploy regression"],
      severity: "critical",
    });
    issueStore.linkFact(issue.id, issueFact.id);

    factsDb.storeEmbedding(unrelatedFact.id, "test-model", "canonical", makeVec(), 4);
    factsDb.storeEmbedding(issueFact.id, "test-model", "canonical", makeVec(), 4);
    for (const fact of noiseFacts) {
      factsDb.storeEmbedding(fact.id, "test-model", "canonical", makeVec(), 4);
    }

    return { issueFact, unrelatedFact, noiseFacts, issue };
  }

  it("does not restrict FTS to issue-linked facts when query is unrelated", async () => {
    const { issueFact, unrelatedFact } = seedIssueLinkedCorpus();

    const vectorDb = { search: async () => [] } as unknown as import("../backends/vector-db.js").VectorDB;
    const config = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      strategies: ["fts5"] as Array<"fts5">,
      fts5TopK: 20,
    };

    const result = await runRetrievalPipeline("zebra migration pattern", null, factsDb.getRawDb(), vectorDb, factsDb, {
      mode: RETRIEVAL_MODE.EXPLICIT_DEEP,
      issueStore,
      config,
      budgetTokens: 2000,
    });

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(unrelatedFact.id);
    expect(ids).not.toContain(issueFact.id);
  });

  it("does not restrict semantic search to issue-linked facts when issueStore is present", async () => {
    const { issueFact, unrelatedFact } = seedIssueLinkedCorpus();

    const vectorDb = {
      search: async () => [
        { entry: factsDb.getById(unrelatedFact.id)!, score: 0.98 },
        { entry: factsDb.getById(issueFact.id)!, score: 0.55 },
      ],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const config = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      strategies: ["semantic"] as Array<"semantic">,
      semanticTopK: 10,
    };

    const result = await runRetrievalPipeline(
      "zebra migration pattern",
      [1, 0, 0, 0],
      factsDb.getRawDb(),
      vectorDb,
      factsDb,
      {
        mode: RETRIEVAL_MODE.EXPLICIT_DEEP,
        issueStore,
        config,
        budgetTokens: 2000,
      },
    );

    const ids = result.fused.map((r) => r.factId);
    expect(ids[0]).toBe(unrelatedFact.id);
    expect(result.fused[0]?.sources.some((s) => s.strategy === "semantic")).toBe(true);
  });

  it("contributes issue-linked facts via the issues RRF strategy on error-context queries", async () => {
    const { issueFact } = seedIssueLinkedCorpus();

    const vectorDb = { search: async () => [] } as unknown as import("../backends/vector-db.js").VectorDB;
    const config = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      strategies: ["fts5"] as Array<"fts5">,
      fts5TopK: 10,
    };

    const result = await runRetrievalPipeline(
      "we have a regression in deploy",
      null,
      factsDb.getRawDb(),
      vectorDb,
      factsDb,
      {
        mode: RETRIEVAL_MODE.EXPLICIT_DEEP,
        issueStore,
        config,
        budgetTokens: 2000,
      },
    );

    const issueRow = result.fused.find((r) => r.factId === issueFact.id);
    expect(issueRow).toBeDefined();
    expect(issueRow?.sources.some((s) => s.strategy === "issues")).toBe(true);
  });

  it("fuses issue strategy results with fts5 hits in explicit-deep mode", async () => {
    const { issueFact, unrelatedFact } = seedIssueLinkedCorpus();

    const vectorDb = { search: async () => [] } as unknown as import("../backends/vector-db.js").VectorDB;
    const config = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      strategies: ["fts5"] as Array<"fts5">,
      fts5TopK: 20,
    };

    const result = await runRetrievalPipeline(
      "zebra migration regression deploy",
      null,
      factsDb.getRawDb(),
      vectorDb,
      factsDb,
      {
        mode: RETRIEVAL_MODE.EXPLICIT_DEEP,
        issueStore,
        config,
        budgetTokens: 4000,
      },
    );

    const byId = new Map(result.fused.map((r) => [r.factId, r]));
    expect(byId.has(unrelatedFact.id)).toBe(true);
    expect(byId.has(issueFact.id)).toBe(true);

    const unrelatedRow = byId.get(unrelatedFact.id)!;
    const issueRow = byId.get(issueFact.id)!;
    expect(unrelatedRow.sources.some((s) => s.strategy === "fts5")).toBe(true);
    expect(issueRow.sources.some((s) => s.strategy === "issues")).toBe(true);
    expect(result.packed.length).toBeGreaterThan(0);
    expect(result.entries.length).toBe(result.fused.length);
  });
});

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
