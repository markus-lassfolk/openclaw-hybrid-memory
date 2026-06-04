import { describe, expect, it } from "vitest";

import { isSelfCorrectionClassification } from "../services/feedback-signal-classifier.js";

describe("feedback-signal-classifier", () => {
  it("accepts correction/frustration above min confidence", () => {
    expect(
      isSelfCorrectionClassification(
        {
          turnIndex: 0,
          verdict: "frustration",
          polarity: "negative",
          confidence: 0.75,
          categories: ["WRONG_APPROACH"],
          explanation: "User rejected premature completion",
          recommendedPipeline: "self-correction",
        },
        0.6,
      ),
    ).toBe(true);
  });

  it("rejects neutral verdict", () => {
    expect(
      isSelfCorrectionClassification(
        {
          turnIndex: 0,
          verdict: "neutral",
          polarity: "neutral",
          confidence: 0.9,
          categories: [],
          explanation: "Routine instruction",
          recommendedPipeline: "none",
        },
        0.6,
      ),
    ).toBe(false);
  });
});
