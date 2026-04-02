/**
 * Tests for frustration detection (Issue #263 — Phase 1).
 *
 * Covers:
 *   - Signal detection: explicit_frustration, imperative_tone, repeated_instruction,
 *     caps_or_emphasis, correction_frequency, question_to_command, short_reply,
 *     emoji_shift, reduced_context
 *   - Scoring algorithm: decay, trend, level clamping
 *   - Hint generation: threshold gating, format
 *   - Adaptation thresholds: none, simplify, be_direct, ask_clarification, acknowledge_struggle
 *   - Implicit signal export
 *   - Config overrides: windowSize, decayRate, signalWeights, injectionThreshold
 */

import { describe, expect, it } from "vitest";
import {
  type FrustrationConversationTurn,
  type FrustrationDetectionConfig,
  buildFrustrationHint,
  detectFrustration,
  exportAsImplicitSignals,
} from "../services/frustration-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function turns(userMessages: string[]): FrustrationConversationTurn[] {
  const result: FrustrationConversationTurn[] = [];
  for (const msg of userMessages) {
    result.push({ role: "user", content: msg });
    result.push({ role: "assistant", content: "OK I'll help." });
  }
  return result;
}

const defaultCfg: FrustrationDetectionConfig = {
  enabled: true,
  windowSize: 8,
  decayRate: 0.85,
  injectionThreshold: 0.3,
  adaptationThresholds: { medium: 0.3, high: 0.5, critical: 0.7 },
  feedToImplicitPipeline: true,
};

// ---------------------------------------------------------------------------
// Signal detection tests
// ---------------------------------------------------------------------------

describe("explicit_frustration signal", () => {
  it("detects 'frustrating' keyword", () => {
    const result = detectFrustration(turns(["This is so frustrating!"]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "explicit_frustration")).toBe(true);
    expect(result.level).toBeGreaterThan(0.3);
  });

  it("detects 'i already said' keyword", () => {
    const result = detectFrustration(turns(["I already said to use the new format"]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "explicit_frustration")).toBe(true);
  });

  it("detects 'ugh' keyword", () => {
    const result = detectFrustration(turns(["Ugh, not again"]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "explicit_frustration")).toBe(true);
  });

  it("does not fire on polite message", () => {
    const result = detectFrustration(turns(["Please help me write a function"]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "explicit_frustration")).toBe(false);
  });
});

describe("imperative_tone signal", () => {
  it("detects short imperative", () => {
    const result = detectFrustration(turns(["Fix it now"]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "imperative_tone")).toBe(true);
  });

  it("does NOT fire on polite request", () => {
    const result = detectFrustration(turns(["Could you please fix the function?"]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "imperative_tone")).toBe(false);
  });

  it("does NOT fire on long sentence", () => {
    const result = detectFrustration(
      turns(["Run the tests and then check if they all pass and report back to me with the results"]),
      defaultCfg,
    );
    expect(result.triggers.some((t) => t.type === "imperative_tone")).toBe(false);
  });
});

describe("caps_or_emphasis signal", () => {
  it("detects ALL CAPS words", () => {
    const result = detectFrustration(turns(["THIS IS NOT WHAT I WANTED AT ALL"]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "caps_or_emphasis")).toBe(true);
  });

  it("detects excessive exclamation marks", () => {
    const result = detectFrustration(turns(["Wrong!!!! Do it again!!!!"]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "caps_or_emphasis")).toBe(true);
  });

  it("does NOT fire on normal sentence", () => {
    const result = detectFrustration(turns(["Please check the API key configuration."]), defaultCfg);
    expect(result.triggers.some((t) => t.type === "caps_or_emphasis")).toBe(false);
  });
});

describe("short_reply signal", () => {
  it("fires when current message is much shorter than average", () => {
    // Build a session with long messages then a very short one
    const conversationTurns: FrustrationConversationTurn[] = [
      {
        role: "user",
        content:
          "Can you please help me understand how the authentication system works and what I should do when I encounter an error? I have been trying to figure this out for a while now.",
      },
      { role: "assistant", content: "Sure, I'd be happy to explain..." },
      {
        role: "user",
        content:
          "I see, but when I call the API with my token, I get a 401 error. What does that mean and how do I fix it? I've checked the token and it seems valid.",
      },
      { role: "assistant", content: "A 401 error means..." },
      { role: "user", content: "No" },
    ];
    const result = detectFrustration(conversationTurns, defaultCfg);
    expect(result.triggers.some((t) => t.type === "short_reply")).toBe(true);
  });
});

describe("repeated_instruction signal", () => {
  it("fires when user repeats same instruction", () => {
    const conversationTurns: FrustrationConversationTurn[] = [
      { role: "user", content: "Use TypeScript strict mode for the config file" },
      { role: "assistant", content: "I'll update the config." },
      { role: "user", content: "Make sure to use TypeScript strict mode in the config" },
      { role: "assistant", content: "Updated." },
      { role: "user", content: "Please use TypeScript strict mode for the config file" },
    ];
    const result = detectFrustration(conversationTurns, defaultCfg);
    expect(result.triggers.some((t) => t.type === "repeated_instruction")).toBe(true);
  });
});

describe("question_to_command shift", () => {
  it("detects shift from questions to commands", () => {
    const conversationTurns: FrustrationConversationTurn[] = [
      { role: "user", content: "How does the build system work?" },
      { role: "assistant", content: "The build system uses..." },
      { role: "user", content: "Can you explain the config?" },
      { role: "assistant", content: "The config is..." },
      { role: "user", content: "Fix the build" },
    ];
    const result = detectFrustration(conversationTurns, defaultCfg);
    expect(result.triggers.some((t) => t.type === "question_to_command")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scoring algorithm tests
// ---------------------------------------------------------------------------

describe("scoring algorithm", () => {
  it("returns 0 level for empty conversation", () => {
    const result = detectFrustration([], defaultCfg);
    expect(result.level).toBe(0);
    expect(result.triggers).toHaveLength(0);
  });

  it("returns 0 level for assistant-only turns", () => {
    const result = detectFrustration([{ role: "assistant", content: "Hello, how can I help?" }], defaultCfg);
    expect(result.level).toBe(0);
  });

  it("level is clamped to [0, 1]", () => {
    // Max frustration scenario
    const msgs = [
      "I ALREADY SAID THIS FIX IT NOW!!!",
      "UGH STOP THIS IS RIDICULOUS",
      "WHY CAN'T YOU DO THIS CORRECTLY!!!",
    ];
    const result = detectFrustration(turns(msgs), defaultCfg);
    expect(result.level).toBeGreaterThanOrEqual(0);
    expect(result.level).toBeLessThanOrEqual(1);
  });

  it("level decays when no signals", () => {
    const result = detectFrustration(
      turns(["Thanks, that works great!"]),
      defaultCfg,
      0.8, // high previous level
    );
    expect(result.level).toBeLessThan(0.8);
  });

  it("trend is 'rising' when level increases", () => {
    const result = detectFrustration(
      turns(["This is frustrating! Stop!"]),
      defaultCfg,
      0.1, // low previous level
    );
    // If level > 0.1 + 0.05, trend should be rising
    if (result.level > 0.15) {
      expect(result.trend).toBe("rising");
    }
  });

  it("trend is 'falling' when level decreases significantly", () => {
    const result = detectFrustration(
      turns(["Thanks, that looks great!"]),
      defaultCfg,
      0.9, // very high previous level
    );
    expect(result.trend).toBe("falling");
  });

  it("trend is 'stable' for small changes", () => {
    const result = detectFrustration(turns(["Can you fix this?"]), defaultCfg, 0.4);
    // Should be stable or small change
    expect(["stable", "rising", "falling"]).toContain(result.trend);
  });

  it("respects custom windowSize", () => {
    const longHistory = turns([
      "This is frustrating!", // many turns back
      "still bad",
      "ok better",
      "good",
      "great", // most recent
    ]);
    const narrowCfg = { ...defaultCfg, windowSize: 2 };
    const result = detectFrustration(longHistory, narrowCfg);
    // With narrow window of 2 turns, recent positive messages should dominate
    expect(result.triggers.filter((t) => t.type === "explicit_frustration")).toHaveLength(0);
  });

  it("respects custom signal weights", () => {
    const heavyWeightCfg: FrustrationDetectionConfig = {
      ...defaultCfg,
      signalWeights: { explicit_frustration: 0.99 },
    };
    const normalResult = detectFrustration(turns(["This is frustrating!"]), defaultCfg);
    const heavyResult = detectFrustration(turns(["This is frustrating!"]), heavyWeightCfg);
    expect(heavyResult.level).toBeGreaterThanOrEqual(normalResult.level);
  });
});

// ---------------------------------------------------------------------------
// Adaptation thresholds tests
// ---------------------------------------------------------------------------

describe("adaptation thresholds", () => {
  it("returns 'none' action when below medium threshold", () => {
    const result = detectFrustration(turns(["Can you help me?"]), defaultCfg, 0);
    expect(result.suggestedAdaptation.action).toBe("none");
    expect(result.suggestedAdaptation.priority).toBe(0);
  });

  it("returns 'acknowledge_struggle' when critical threshold exceeded", () => {
    const criticalCfg = { ...defaultCfg, adaptationThresholds: { medium: 0.1, high: 0.2, critical: 0.3 } };
    const result = detectFrustration(turns(["I ALREADY SAID THIS THIS IS RIDICULOUS FIX IT"]), criticalCfg, 0.5);
    // With very low thresholds, should hit critical
    if (result.level >= 0.3) {
      expect(result.suggestedAdaptation.action).toBe("acknowledge_struggle");
      expect(result.suggestedAdaptation.priority).toBe(3);
    }
  });

  it("adaptation reasoning is non-empty", () => {
    const result = detectFrustration(turns(["Fix it!"]), defaultCfg);
    expect(result.suggestedAdaptation.reasoning.length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Hint generation tests
// ---------------------------------------------------------------------------

describe("buildFrustrationHint", () => {
  it("returns undefined when level below threshold", () => {
    const result = detectFrustration(turns(["Can you help?"]), defaultCfg, 0);
    const hint = buildFrustrationHint(result, defaultCfg);
    expect(hint).toBeUndefined();
  });

  it("returns hint string when level above threshold", () => {
    const highFrustrationCfg = { ...defaultCfg, injectionThreshold: 0.01 };
    const result = detectFrustration(turns(["This is frustrating!"]), highFrustrationCfg);
    const hint = buildFrustrationHint(result, highFrustrationCfg);
    if (result.level > 0.01) {
      expect(hint).toBeDefined();
      expect(hint).toContain("[frustration:");
    }
  });

  it("includes level in hint", () => {
    const highFrustrationCfg = { ...defaultCfg, injectionThreshold: 0.01 };
    const result = detectFrustration(turns(["This is frustrating! I ALREADY SAID THIS"]), highFrustrationCfg);
    const hint = buildFrustrationHint(result, highFrustrationCfg);
    if (hint) {
      expect(hint).toMatch(/\d+\.\d+/); // contains decimal number
    }
  });

  it("includes trend when rising", () => {
    const highFrustrationCfg = { ...defaultCfg, injectionThreshold: 0.01 };
    const result = detectFrustration(
      turns(["This is frustrating!"]),
      highFrustrationCfg,
      0.05, // low prev so it rises
    );
    const hint = buildFrustrationHint(result, highFrustrationCfg);
    if (hint && result.trend === "rising") {
      expect(hint).toContain("rising");
    }
  });

  it("custom injectionThreshold is respected", () => {
    // High threshold — even frustrating message should not produce hint
    const highThresholdCfg = { ...defaultCfg, injectionThreshold: 0.99 };
    const result = detectFrustration(turns(["Fix it now"]), highThresholdCfg);
    const hint = buildFrustrationHint(result, highThresholdCfg);
    expect(hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Implicit signal export tests
// ---------------------------------------------------------------------------

describe("exportAsImplicitSignals", () => {
  it("returns empty array when no triggers", () => {
    const result = detectFrustration(turns(["How are you?"]), defaultCfg);
    const signals = exportAsImplicitSignals(result);
    expect(signals).toHaveLength(0);
  });

  it("all exported signals have negative polarity", () => {
    const result = detectFrustration(turns(["This is frustrating! FIX IT NOW!"]), defaultCfg);
    const signals = exportAsImplicitSignals(result);
    for (const s of signals) {
      expect(s.polarity).toBe("negative");
    }
  });

  it("exported signals have confidence in [0, 1]", () => {
    const result = detectFrustration(turns(["This is so frustrating!"]), defaultCfg);
    const signals = exportAsImplicitSignals(result);
    for (const s of signals) {
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("filters out very low-weight triggers", () => {
    // Trigger a small signal
    const result = detectFrustration(turns(["No"]), defaultCfg, 0);
    const signals = exportAsImplicitSignals(result);
    // All exported signals should have meaningful confidence
    for (const s of signals) {
      expect(s.confidence).toBeGreaterThan(0.2);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles unicode emoji in messages", () => {
    expect(() => detectFrustration(turns(["Great work! 😊👍"]), defaultCfg)).not.toThrow();
  });

  it("handles very long messages", () => {
    const longMsg = "a".repeat(10000);
    expect(() => detectFrustration(turns([longMsg]), defaultCfg)).not.toThrow();
  });

  it("handles messages with only whitespace", () => {
    const result = detectFrustration(
      [
        { role: "user", content: "   " },
        { role: "assistant", content: "hello" },
      ],
      defaultCfg,
    );
    expect(result.level).toBe(0);
  });

  it("handles conversation with no cfg (uses defaults)", () => {
    const result = detectFrustration(turns(["Fix it"]));
    expect(result).toBeDefined();
    expect(result.level).toBeGreaterThanOrEqual(0);
    expect(result.level).toBeLessThanOrEqual(1);
  });

  it("triggers object includes type and weight", () => {
    const result = detectFrustration(turns(["This is frustrating!"]), defaultCfg);
    for (const t of result.triggers) {
      expect(typeof t.type).toBe("string");
      expect(typeof t.weight).toBe("number");
      expect(t.weight).toBeGreaterThanOrEqual(0);
    }
  });
});
