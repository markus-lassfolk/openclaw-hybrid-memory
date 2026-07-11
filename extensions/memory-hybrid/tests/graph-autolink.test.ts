import { describe, expect, it, vi } from "vitest";

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { GraphConfig } from "../config.js";
import { autoLinkSemanticallySimilarFacts } from "../services/graph-autolink.js";
import * as vectorSearch from "../services/vector-search.js";

const graph: GraphConfig = {
  enabled: true,
  autoLink: true,
  autoLinkStrength: 0.7,
  autoLinkSimilarityThreshold: 0.85,
  autoLinkMinScore: 0.7,
  linkDecay: { enabled: true, halfLifeDays: 30, floor: 0.05 },
  temporalEdges: true,
  autoLinkBudgetPerMin: 30,
  autoLinkLimit: 3,
  maxTraversalDepth: 2,
  useInRecall: false,
  coOccurrenceWeight: 0.3,
  autoSupersede: true,
  strengthenOnRecall: false,
  hubDegreeCap: 500,
  hubScorePenalty: null,
};

describe("autoLinkSemanticallySimilarFacts (#1994)", () => {
  it("does not fall back to classification when embedding search returns no candidates", async () => {
    vi.spyOn(vectorSearch, "findSimilarByEmbedding").mockResolvedValue([]);
    const findSimilarForClassification = vi.fn(() => []);
    const createOrStrengthenRelatedLink = vi.fn();
    const factsDb = {
      findSimilarForClassification,
      createOrStrengthenRelatedLink,
    } as unknown as FactsDB;

    const linked = await autoLinkSemanticallySimilarFacts(
      {
        factsDb,
        vectorDb: {} as VectorDB,
        vector: [0.1, 0.2, 0.3],
        text: "host name is prod-db",
        entity: "host",
        key: "name",
        newFactId: "new-fact",
      },
      graph,
    );

    expect(linked).toBe(0);
    expect(findSimilarForClassification).not.toHaveBeenCalled();
    expect(createOrStrengthenRelatedLink).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("uses classification fallback only when no store vector is available", async () => {
    const embeddingSpy = vi.spyOn(vectorSearch, "findSimilarByEmbedding");
    const findSimilarForClassification = vi.fn(() => []);
    const factsDb = {
      findSimilarForClassification,
      createOrStrengthenRelatedLink: vi.fn(),
    } as unknown as FactsDB;

    await autoLinkSemanticallySimilarFacts(
      {
        factsDb,
        vectorDb: {} as VectorDB,
        text: "host name is prod-db",
        entity: "host",
        key: "name",
        newFactId: "new-fact",
      },
      graph,
    );

    expect(embeddingSpy).not.toHaveBeenCalled();
    expect(findSimilarForClassification).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
