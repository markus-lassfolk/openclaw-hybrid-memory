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
import {
  ClusterCache,
  DEFAULT_RETRIEVAL_CONFIG,
  type FactLookup,
  runRetrievalPipeline,
} from "../services/retrieval-orchestrator.js";
import type { ClusterFactLookup } from "../services/topic-clusters.js";

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

describe("ClusterCache", () => {
  function fakeFactsDb(
    linksCount: number,
    factIds: string[],
    links: Array<{ sourceFactId: string; targetFactId: string }>,
  ): FactLookup & ClusterFactLookup {
    const idSet = new Set(factIds);
    return {
      // detectClusters (loop iteration 106) now scope-checks every linked fact via getById
      // before it can enter a cluster, not just for label generation — so this mock must return
      // a real entry for known ids (matching how the production FactsDB.getById behaves when no
      // scopeFilter is applied) rather than unconditionally null, or every fact gets filtered out.
      getById: (id: string) =>
        idSet.has(id)
          ? {
              id,
              text: `fake fact ${id}`,
              category: "fact",
              importance: 0.5,
              entity: null,
              key: null,
              value: null,
              source: "test",
              createdAt: 0,
              decayClass: "stable",
              expiresAt: null,
              lastConfirmedAt: 0,
              confidence: 0.5,
            }
          : null,
      getAllLinkedFactIds: () => factIds,
      getAllLinks: () => links,
      linksCount: () => linksCount,
    };
  }

  it("does not leak cluster assignments between different FactsDB instances sharing the same linksCount (#47)", () => {
    const cache = new ClusterCache();
    // Two distinct FactsDB-like instances with the SAME linksCount() and minClusterSize — the
    // exact collision condition the old single-slot module cache keyed on, which would return
    // one instance's cluster map to the other.
    const dbA = fakeFactsDb(2, ["a1", "a2"], [{ sourceFactId: "a1", targetFactId: "a2" }]);
    const dbB = fakeFactsDb(2, ["b1", "b2"], [{ sourceFactId: "b1", targetFactId: "b2" }]);

    const clustersA = cache.getClusterMap(dbA, 1);
    const clustersB = cache.getClusterMap(dbB, 1);
    expect(Array.from(clustersA.keys()).sort()).toEqual(["a1", "a2"]);
    expect(Array.from(clustersB.keys()).sort()).toEqual(["b1", "b2"]);

    // Re-fetching dbA after dbB was cached must still return dbA's own clusters.
    const clustersA2 = cache.getClusterMap(dbA, 1);
    expect(Array.from(clustersA2.keys()).sort()).toEqual(["a1", "a2"]);
  });

  it("invalidate() clears cached clusters for all instances", () => {
    const cache = new ClusterCache();
    const dbA = fakeFactsDb(2, ["a1", "a2"], [{ sourceFactId: "a1", targetFactId: "a2" }]);
    const first = cache.getClusterMap(dbA, 1);
    cache.invalidate();
    const second = cache.getClusterMap(dbA, 1);
    expect(first).not.toBe(second);
    expect(Array.from(second.keys()).sort()).toEqual(["a1", "a2"]);
  });

  it("does not leak one tenant's cluster assignments to another tenant sharing the same FactsDB instance (regression)", () => {
    // A single shared FactsDB instance (the realistic case: one vault, many tenants), with
    // memory_links spanning two tenants' facts. getById is scope-aware, matching how the real
    // FactsDB.getById(id, { scopeFilter }) behaves -- returns null for facts outside scope.
    const factOwners = new Map<string, string>([
      ["a1", "tenant-a"],
      ["a2", "tenant-a"],
      ["b1", "tenant-b"],
      ["b2", "tenant-b"],
    ]);
    const allFactIds = [...factOwners.keys()];
    const allLinks = [
      { sourceFactId: "a1", targetFactId: "a2" },
      { sourceFactId: "b1", targetFactId: "b2" },
    ];
    const sharedDb: FactLookup & ClusterFactLookup = {
      getById: (id: string, options?: { scopeFilter?: { userId?: string | null } | null }) => {
        const owner = factOwners.get(id);
        if (!owner) return null;
        const requestedTenant = options?.scopeFilter?.userId;
        if (requestedTenant && requestedTenant !== owner) return null;
        return {
          id,
          text: `fake fact ${id}`,
          category: "fact",
          importance: 0.5,
          entity: null,
          key: null,
          value: null,
          source: "test",
          createdAt: 0,
          decayClass: "stable",
          expiresAt: null,
          lastConfirmedAt: 0,
          confidence: 0.5,
        };
      },
      getAllLinkedFactIds: () => allFactIds,
      getAllLinks: () => allLinks,
      linksCount: () => allLinks.length,
    };

    const cache = new ClusterCache();
    const tenantAView = cache.getClusterMap(sharedDb, 1, { userId: "tenant-a" });
    expect(Array.from(tenantAView.keys()).sort()).toEqual(["a1", "a2"]);

    const tenantBView = cache.getClusterMap(sharedDb, 1, { userId: "tenant-b" });
    expect(Array.from(tenantBView.keys()).sort()).toEqual(["b1", "b2"]);

    // Re-requesting tenant A's view (within the TTL window, after tenant B's request populated
    // the cache) must still return only tenant A's own facts -- not tenant B's cached clusters,
    // and not an unscoped mix of both.
    const tenantAViewAgain = cache.getClusterMap(sharedDb, 1, { userId: "tenant-a" });
    expect(Array.from(tenantAViewAgain.keys()).sort()).toEqual(["a1", "a2"]);
  });
});
