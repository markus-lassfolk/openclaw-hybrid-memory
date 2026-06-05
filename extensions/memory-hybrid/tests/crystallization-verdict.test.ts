import { describe, expect, it } from "vitest";
import {
  USEFULNESS_BUCKET_GARBAGE,
  USEFULNESS_BUCKET_POTENTIALLY,
  countUsefulnessBuckets,
  pickCrystallizationVerdict,
  usefulnessBucketKey,
} from "../benchmark/offline-qa/crystallization-verdict.js";

const BASE_INPUT = {
  dataGapOk: true,
  liveProdCandidates: 0,
  userFacingCandidates: 1,
  structuralCandidates: 1,
  prodCandidates: 1,
  liveWfStats: null,
  unknownOutcomeShare: 0,
  validationSummary: { deny: 0, allow: 1 },
  usefulnessCounts: {},
};

describe("crystallization verdict helpers", () => {
  it("maps usefulness labels to bucket keys before the em dash detail", () => {
    expect(usefulnessBucketKey("potentially useful — cron echo")).toBe("potentially useful");
    expect(usefulnessBucketKey("garbage")).toBe("garbage");
  });

  it("counts usefulness buckets using label prefixes, not object property aliases", () => {
    const counts = countUsefulnessBuckets([
      "potentially useful — real goal",
      "potentially useful — another goal",
      "garbage — system cron",
    ]);
    expect(counts[USEFULNESS_BUCKET_POTENTIALLY]).toBe(2);
    expect(counts.potentially).toBeUndefined();
    expect(counts[USEFULNESS_BUCKET_GARBAGE]).toBe(1);
  });

  it("returns PROMISING when at least four potentially useful samples exist", () => {
    const verdict = pickCrystallizationVerdict({
      ...BASE_INPUT,
      usefulnessCounts: {
        [USEFULNESS_BUCKET_POTENTIALLY]: 4,
      },
    });
    expect(verdict).toMatch(/^PROMISING —/);
  });

  it("does not reach PROMISING when lookup uses a JS property alias instead of the label key", () => {
    const verdict = pickCrystallizationVerdict({
      ...BASE_INPUT,
      usefulnessCounts: {
        potentially: 4,
      },
    });
    expect(verdict).toBe("MIXED — some structure, but many skills are generic boilerplate.");
  });
});
