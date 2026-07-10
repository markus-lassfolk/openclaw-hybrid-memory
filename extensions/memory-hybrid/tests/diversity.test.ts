import { describe, expect, it } from "vitest";
import { applyDiversityDemotion, jaccardBigramSimilarity } from "../services/diversity.js";

describe("applyDiversityDemotion ordering", () => {
  it("preserves relative order among demoted items", () => {
    const items = [
      { text: "alpha one unique anchor text", tag: "rank-1" },
      { text: "alpha one unique anchor text copy variant", tag: "rank-2-demoted" },
      { text: "beta completely different topic here", tag: "rank-3" },
      { text: "alpha one unique anchor text another copy", tag: "rank-4-demoted" },
      { text: "gamma another unrelated topic entirely", tag: "rank-5" },
    ];
    const { items: out, demotedCount } = applyDiversityDemotion(items, {
      enabled: true,
      maxSimilarity: 0.5,
    });
    expect(demotedCount).toBe(2);

    const idxRank2 = out.findIndex((x) => x.tag === "rank-2-demoted");
    const idxRank4 = out.findIndex((x) => x.tag === "rank-4-demoted");
    expect(idxRank2).toBeGreaterThanOrEqual(0);
    expect(idxRank4).toBeGreaterThanOrEqual(0);
    expect(idxRank2).toBeLessThan(idxRank4);
  });
});

describe("jaccardBigramSimilarity short-text handling (regression)", () => {
  it("does not treat two distinct single-character texts as maximally similar", () => {
    expect(jaccardBigramSimilarity("5", "9")).toBe(0);
    expect(jaccardBigramSimilarity("a", "b")).toBe(0);
  });

  it("still treats two equal single-character texts as maximally similar", () => {
    expect(jaccardBigramSimilarity("5", "5")).toBe(1);
  });

  it("does not demote unrelated short-text facts sharing no content", () => {
    const items = [
      { text: "5", tag: "rank-1" },
      { text: "9", tag: "rank-2" },
      { text: "3", tag: "rank-3" },
    ];
    const { demotedCount } = applyDiversityDemotion(items, {
      enabled: true,
      maxSimilarity: 0.6,
    });
    expect(demotedCount).toBe(0);
  });
});
