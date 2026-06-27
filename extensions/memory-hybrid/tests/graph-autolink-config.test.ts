import { describe, expect, it } from "vitest";

import { parseGraphConfig } from "../config/parsers/features.js";
import { warnGraphRecallConfigMisconfiguration } from "../services/graph-recall-config.js";
import type { HybridMemoryConfig } from "../config.js";

describe("parseGraphConfig auto-link fields", () => {
  it("maps legacy autoLinkMinScore to strength and similarity threshold", () => {
    const graph = parseGraphConfig({ graph: { autoLinkMinScore: 0.82 } });
    expect(graph.autoLinkStrength).toBe(0.82);
    expect(graph.autoLinkSimilarityThreshold).toBe(0.82);
    expect(graph.autoLinkMinScore).toBe(0.82);
  });

  it("prefers explicit autoLinkStrength and autoLinkSimilarityThreshold", () => {
    const graph = parseGraphConfig({
      graph: {
        autoLinkStrength: 0.6,
        autoLinkSimilarityThreshold: 0.85,
        autoLinkMinScore: 0.5,
      },
    });
    expect(graph.autoLinkStrength).toBe(0.6);
    expect(graph.autoLinkSimilarityThreshold).toBe(0.85);
    expect(graph.autoLinkMinScore).toBe(0.6);
  });
});

describe("warnGraphRecallConfigMisconfiguration", () => {
  it("warns when defaultExpand and useInRecall are both enabled", () => {
    const warnings: string[] = [];
    warnGraphRecallConfigMisconfiguration(
      {
        graph: {
          enabled: true,
          autoLink: false,
          autoLinkStrength: 0.7,
          autoLinkSimilarityThreshold: 0.7,
          autoLinkMinScore: 0.7,
          autoLinkLimit: 3,
          maxTraversalDepth: 2,
          useInRecall: true,
          coOccurrenceWeight: 0.3,
          autoSupersede: true,
          strengthenOnRecall: false,
          hubDegreeCap: 500,
          hubScorePenalty: null,
        },
        graphRetrieval: {
          enabled: true,
          defaultExpand: true,
          maxExpandDepth: 2,
          maxExpandedResults: 12,
        },
        retrieval: { strategies: ["semantic", "fts5", "graph"] },
      } as HybridMemoryConfig,
      (msg) => warnings.push(msg),
    );
    expect(warnings.some((w) => w.includes("useInRecall is redundant"))).toBe(true);
  });
});
