/**
 * Tests for implicit feedback extraction (Issue #262 — Phase 1).
 */

import { describe, it, expect } from "vitest";
import {
  computeSimpleSimilarity,
  extractImplicitSignals,
  detectRephrase,
  detectImmediateAction,
  detectTopicChange,
  detectGratefulClose,
  detectTerseResponse,
  detectExtendedEngagement,
  detectCorrectionCascade,
  detectCopyPaste,
  detectSelfService,
  detectEscalation,
  detectSilenceAfterAction,
  type ConversationTurn,
} from "../services/implicit-feedback-extract.js";
import type { ImplicitFeedbackConfig } from "../config/types/features.js";

const DEFAULT_CONFIG: ImplicitFeedbackConfig = {
  enabled: true,
  minConfidence: 0.0, // allow all for testing
  signalTypes: [] as any,
  rephraseThreshold: 0.8,
  topicChangeThreshold: 0.3,
  terseResponseRatio: 0.4,
  feedToReinforcement: true,
  feedToSelfCorrection: true,
  trajectoryLLMAnalysis: false,
};

// ---------------------------------------------------------------------------
// computeSimpleSimilarity
// ---------------------------------------------------------------------------

describe("computeSimpleSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(computeSimpleSimilarity("hello world foo bar", "hello world foo bar")).toBeCloseTo(1.0, 2);
  });

  it("returns 0 for completely different strings", () => {
    const sim = computeSimpleSimilarity("apple banana orange", "computer network protocol");
    expect(sim).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(computeSimpleSimilarity("", "hello")).toBe(0);
    expect(computeSimpleSimilarity("hello", "")).toBe(0);
  });

  it("returns partial similarity for overlapping words", () => {
    const sim = computeSimpleSimilarity("how do I deploy my app", "how do I install the app");
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(1.0);
  });

  it("ignores stop words", () => {
    // "the a is are" are stop words — after removing them, both are empty
    const sim = computeSimpleSimilarity("the is a are", "the is a are");
    // After removing stop words, empty → 0
    expect(sim).toBe(0);
  });

  it("is symmetric", () => {
    const a = "deploy the application to production";
    const b = "how do we deploy production code";
    expect(computeSimpleSimilarity(a, b)).toBeCloseTo(computeSimpleSimilarity(b, a), 5);
  });
});

// ---------------------------------------------------------------------------
// detectRephrase
// ---------------------------------------------------------------------------

describe("detectRephrase", () => {
  it("detects rephrase when similar user messages appear in sequence", () => {
    // Use messages that share enough unigrams AND bigrams to score above 0.5 with the
    // bigram-enhanced computeSimpleSimilarity (deploy + aws + production shared, plus aws_production bigram).
    const turns: ConversationTurn[] = [
      { role: "user", content: "How do I deploy my application to AWS production environment" },
      { role: "assistant", content: "You can use the AWS CLI or console." },
      { role: "user", content: "How can I deploy my app to AWS production environment" }, // similar topic, slightly different wording
    ];
    const signal = detectRephrase(turns, { rephraseThreshold: 0.5 }, 2);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("rephrase");
    expect(signal?.polarity).toBe("negative");
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("returns null when messages are completely different topics", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "How do I deploy my application to AWS" },
      { role: "assistant", content: "You can use the AWS CLI." },
      { role: "user", content: "What is the weather in Paris today" },
    ];
    const signal = detectRephrase(turns, { rephraseThreshold: 0.8 }, 2);
    expect(signal).toBeNull();
  });

  it("returns null for the first user turn", () => {
    const turns: ConversationTurn[] = [{ role: "user", content: "Hello how are you doing today" }];
    expect(detectRephrase(turns, DEFAULT_CONFIG, 0)).toBeNull();
  });

  it("returns null when messages are identical", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "deploy my app to AWS S3" },
      { role: "assistant", content: "Use aws s3 sync." },
      { role: "user", content: "deploy my app to AWS S3" }, // exact duplicate
    ];
    const signal = detectRephrase(turns, { rephraseThreshold: 0.8 }, 2);
    // Identical messages don't trigger rephrase (user literally copy-pasted)
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectImmediateAction
// ---------------------------------------------------------------------------

describe("detectImmediateAction", () => {
  it("detects positive action words after agent message", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Try running npm install to fix the issue." },
      { role: "user", content: "It worked! Thanks." },
    ];
    const signal = detectImmediateAction(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("immediate_action");
    expect(signal?.polarity).toBe("positive");
    expect(signal?.confidence).toBe(0.7);
  });

  it("detects 'done' keyword", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Run the migration script." },
      { role: "user", content: "Done, the database is updated." },
    ];
    const signal = detectImmediateAction(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("immediate_action");
  });

  it("returns null when no action words present", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Try running npm install." },
      { role: "user", content: "OK I will try that later." },
    ];
    const signal = detectImmediateAction(turns, DEFAULT_CONFIG, 1);
    expect(signal).toBeNull();
  });

  it("returns null when role is not user", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "Please deploy." },
      { role: "assistant", content: "Done deploying." },
    ];
    const signal = detectImmediateAction(turns, DEFAULT_CONFIG, 1);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectTopicChange
// ---------------------------------------------------------------------------

describe("detectTopicChange", () => {
  it("detects topic change when similarity is very low", () => {
    const turns: ConversationTurn[] = [
      {
        role: "assistant",
        content:
          "Here is how to deploy your React application to AWS S3 using the CLI commands and configuration settings.",
      },
      { role: "user", content: "What is the best recipe for chocolate cake?" },
    ];
    const signal = detectTopicChange(turns, { topicChangeThreshold: 0.3 }, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("topic_change");
    expect(signal?.polarity).toBe("negative");
  });

  it("returns null when topics share many keywords (high overlap)", () => {
    // Use messages with strong keyword overlap so similarity is above threshold
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "webpack optimization splitChunks treeshaking production configuration settings." },
      {
        role: "user",
        content: "What webpack optimization splitChunks treeshaking production settings should I adjust?",
      },
    ];
    const signal = detectTopicChange(turns, { topicChangeThreshold: 0.3 }, 1);
    expect(signal).toBeNull();
  });

  it("skips grateful close messages", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Your deployment is complete and the app is running." },
      { role: "user", content: "Thanks!" },
    ];
    // "Thanks" on its own shouldn't trigger topic_change (grateful_close handles it)
    const signal = detectTopicChange(turns, { topicChangeThreshold: 0.3 }, 1);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectGratefulClose
// ---------------------------------------------------------------------------

describe("detectGratefulClose", () => {
  it("detects thanks keyword", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Your application is now deployed successfully." },
      { role: "user", content: "Thanks so much, that helped!" },
    ];
    const signal = detectGratefulClose(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("grateful_close");
    expect(signal?.polarity).toBe("positive");
    expect(signal?.confidence).toBe(0.8);
  });

  it("detects 'perfect' keyword", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Done, here is the result." },
      { role: "user", content: "Perfect, exactly what I needed." },
    ];
    const signal = detectGratefulClose(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("grateful_close");
  });

  it("returns null when no grateful keywords", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Here is the configuration." },
      { role: "user", content: "I still have a problem with this." },
    ];
    const signal = detectGratefulClose(turns, DEFAULT_CONFIG, 1);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectTerseResponse
// ---------------------------------------------------------------------------

describe("detectTerseResponse", () => {
  it("detects terse response when message is much shorter than average", () => {
    const turns: ConversationTurn[] = [
      {
        role: "user",
        content:
          "I need help setting up the webpack configuration for my React application to support TypeScript, CSS modules, and hot reload.",
      },
      { role: "assistant", content: "Here is how you configure webpack." },
      {
        role: "user",
        content:
          "I need to understand how the entry point configuration works in webpack for multiple pages and how it interacts with the output path settings.",
      },
      { role: "assistant", content: "The entry config specifies starting points." },
      {
        role: "user",
        content:
          "I want to configure the optimization settings for production builds with code splitting and tree shaking.",
      },
      { role: "assistant", content: "Use splitChunks and usedExports." },
      { role: "user", content: "ok" }, // very terse
    ];
    const signal = detectTerseResponse(turns, { terseResponseRatio: 0.4 }, 6);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("terse_response");
    expect(signal?.polarity).toBe("negative");
  });

  it("returns null when not enough prior user turns", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "ok" },
    ];
    const signal = detectTerseResponse(turns, DEFAULT_CONFIG, 2);
    expect(signal).toBeNull();
  });

  it("returns null when message length is normal", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "I need help with this configuration please" },
      { role: "assistant", content: "Sure, here is the config." },
      { role: "user", content: "I need help with the next configuration setting" },
      { role: "assistant", content: "Here it is." },
      { role: "user", content: "I need help with one more configuration item" },
      { role: "assistant", content: "OK." },
      { role: "user", content: "Thanks for helping with the configurations" }, // normal length
    ];
    const signal = detectTerseResponse(turns, { terseResponseRatio: 0.4 }, 6);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectExtendedEngagement
// ---------------------------------------------------------------------------

describe("detectExtendedEngagement", () => {
  it("detects extended engagement when multiple follow-ups on same topic", () => {
    // Use highly overlapping messages to ensure similarity > 0.5
    const turns: ConversationTurn[] = [
      { role: "user", content: "webpack splitChunks optimization configuration production settings" },
      { role: "assistant", content: "Use mode: production." },
      { role: "user", content: "webpack splitChunks optimization configuration production bundles" },
      { role: "assistant", content: "Enable tree shaking." },
      { role: "user", content: "webpack splitChunks optimization configuration production chunks" },
      { role: "assistant", content: "Use optimization config." },
      { role: "user", content: "webpack splitChunks optimization configuration production splitting" },
    ];
    const signal = detectExtendedEngagement(turns, DEFAULT_CONFIG, 6);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("extended_engagement");
    expect(signal?.polarity).toBe("positive");
  });

  it("returns null when too few turns", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "How do I configure webpack" },
      { role: "assistant", content: "Use this config." },
      { role: "user", content: "Thanks" },
    ];
    const signal = detectExtendedEngagement(turns, DEFAULT_CONFIG, 2);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectCorrectionCascade
// ---------------------------------------------------------------------------

describe("detectCorrectionCascade", () => {
  it("detects cascade when 2+ corrections in 5 turns", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Here is the solution." },
      { role: "user", content: "No that's wrong, I said I need the TypeScript version." },
      { role: "assistant", content: "Here is the TypeScript version." },
      { role: "user", content: "Wrong again, not what I meant at all." },
      { role: "assistant", content: "Let me try again." },
    ];
    // Check at last user turn (index 3)
    const signal = detectCorrectionCascade(turns, DEFAULT_CONFIG, 3);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("correction_cascade");
    expect(signal?.polarity).toBe("negative");
    expect(signal?.confidence).toBe(0.9);
  });

  it("returns null for single correction", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Here is the solution." },
      { role: "user", content: "No, that is wrong, I need something different." },
      { role: "assistant", content: "Let me try again." },
      { role: "user", content: "Thank you much better now." },
    ];
    const signal = detectCorrectionCascade(turns, DEFAULT_CONFIG, 3);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectCopyPaste
// ---------------------------------------------------------------------------

describe("detectCopyPaste", () => {
  it("detects high overlap between agent output and user message", () => {
    // Create messages with very high keyword overlap (> 0.8 cosine similarity)
    const shared = "deploy application production kubernetes cluster configuration settings optimization scaling";
    const turns: ConversationTurn[] = [
      { role: "assistant", content: shared + " ingress replicas namespace service" },
      { role: "user", content: shared + " ingress replicas namespace service verified" },
    ];
    const signal = detectCopyPaste(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("copy_paste");
    expect(signal?.polarity).toBe("positive");
  });

  it("returns null for short messages", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Run npm install." },
      { role: "user", content: "Run npm install done." },
    ];
    const signal = detectCopyPaste(turns, DEFAULT_CONFIG, 1);
    // Both messages too short (< 50 chars)
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectSelfService
// ---------------------------------------------------------------------------

describe("detectSelfService", () => {
  it("detects 'I'll do it myself'", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "I can help you configure the deployment pipeline." },
      { role: "user", content: "Never mind, I'll do it myself." },
    ];
    const signal = detectSelfService(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("self_service");
    expect(signal?.polarity).toBe("negative");
  });

  it("detects 'forget it'", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Let me look into this for you." },
      { role: "user", content: "Forget it, I'll figure it out myself." },
    ];
    const signal = detectSelfService(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("self_service");
  });

  it("returns null for normal messages", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Here is the solution." },
      { role: "user", content: "Great, let me try that approach." },
    ];
    const signal = detectSelfService(turns, DEFAULT_CONFIG, 1);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectEscalation
// ---------------------------------------------------------------------------

describe("detectEscalation", () => {
  it("detects 'I'll ask someone'", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "I'm not sure about the exact configuration for your setup." },
      { role: "user", content: "I'll ask my colleague about this." },
    ];
    const signal = detectEscalation(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("escalation");
    expect(signal?.polarity).toBe("negative");
    expect(signal?.confidence).toBe(0.5);
  });

  it("detects 'going to ask someone else'", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Here is what I think." },
      { role: "user", content: "I'll ask someone else about this issue." },
    ];
    const signal = detectEscalation(turns, DEFAULT_CONFIG, 1);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("escalation");
  });

  it("returns null for normal messages", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Here is the answer." },
      { role: "user", content: "That makes sense, let me try it." },
    ];
    const signal = detectEscalation(turns, DEFAULT_CONFIG, 1);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectSilenceAfterAction
// ---------------------------------------------------------------------------

describe("detectSilenceAfterAction", () => {
  it("detects silence after tool call without user acknowledgment", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "Please deploy the application." },
      { role: "assistant", content: "Deploying now...", toolCalls: ["exec", "write"] },
      { role: "assistant", content: "Deployment complete. The app is now running." },
    ];
    const signal = detectSilenceAfterAction(turns, DEFAULT_CONFIG, 2);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("silence_after_action");
    expect(signal?.polarity).toBe("negative");
    expect(signal?.confidence).toBe(0.3);
  });

  it("returns null when user acknowledged the action", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "Please deploy." },
      { role: "assistant", content: "Deploying...", toolCalls: ["exec"] },
      { role: "user", content: "Great thanks!" },
      { role: "assistant", content: "You're welcome." },
    ];
    const signal = detectSilenceAfterAction(turns, DEFAULT_CONFIG, 3);
    expect(signal).toBeNull();
  });

  it("returns null on user turns", () => {
    const turns: ConversationTurn[] = [{ role: "user", content: "deploy please" }];
    const signal = detectSilenceAfterAction(turns, DEFAULT_CONFIG, 0);
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractImplicitSignals — integration
// ---------------------------------------------------------------------------

describe("extractImplicitSignals", () => {
  it("returns empty when disabled", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "No that's wrong, not what I meant." },
      { role: "assistant", content: "Let me fix that." },
      { role: "user", content: "Wrong again, I said something different." },
    ];
    const signals = extractImplicitSignals(turns, { enabled: false });
    expect(signals).toHaveLength(0);
  });

  it("filters signals below minConfidence", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "Please deploy." },
      { role: "assistant", content: "Deploying.", toolCalls: ["exec"] },
      { role: "assistant", content: "Done." },
    ];
    // silence_after_action has confidence 0.3; set threshold above it
    const signals = extractImplicitSignals(turns, { minConfidence: 0.5 }, "test.jsonl");
    const silenceSignals = signals.filter((s) => s.type === "silence_after_action");
    expect(silenceSignals).toHaveLength(0);
  });

  it("only emits enabled signal types", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Your deployment is complete." },
      { role: "user", content: "Thanks so much, that helped!" },
    ];
    const signals = extractImplicitSignals(
      turns,
      { signalTypes: ["correction_cascade"], minConfidence: 0.0 },
      "test.jsonl",
    );
    expect(signals.every((s) => s.type === "correction_cascade")).toBe(true);
    expect(signals.filter((s) => s.type === "grateful_close")).toHaveLength(0);
  });

  it("attaches sessionFile to all signals", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Your deployment is complete." },
      { role: "user", content: "Thanks so much for the help!" },
    ];
    const signals = extractImplicitSignals(turns, { minConfidence: 0.0 }, "my-session.jsonl");
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.context.sessionFile === "my-session.jsonl")).toBe(true);
  });

  it("detects correction_cascade in a mixed conversation", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "Please write a TypeScript function to sort an array." },
      { role: "assistant", content: "Here is a JavaScript function..." },
      { role: "user", content: "No that's wrong, I said TypeScript not JavaScript." },
      { role: "assistant", content: "Here is TypeScript." },
      { role: "user", content: "Wrong again, not quite what I meant." },
    ];
    const signals = extractImplicitSignals(turns, { minConfidence: 0.0 }, "session.jsonl");
    const cascade = signals.find((s) => s.type === "correction_cascade");
    expect(cascade).not.toBeUndefined();
    expect(cascade?.polarity).toBe("negative");
  });

  it("detects grateful_close as positive signal", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Here is the complete implementation you requested." },
      { role: "user", content: "Perfect, exactly what I needed, thank you!" },
    ];
    const signals = extractImplicitSignals(turns, { minConfidence: 0.0 }, "session.jsonl");
    const grateful = signals.find((s) => s.type === "grateful_close");
    expect(grateful).not.toBeUndefined();
    expect(grateful?.polarity).toBe("positive");
  });

  it("does not emit duplicate signals for same turn and type", () => {
    const turns: ConversationTurn[] = [
      { role: "assistant", content: "Result here." },
      { role: "user", content: "Thanks, brilliant!" },
    ];
    const signals = extractImplicitSignals(turns, { minConfidence: 0.0 }, "s.jsonl");
    const typeCounts = new Map<string, number>();
    for (const s of signals) {
      typeCounts.set(s.type, (typeCounts.get(s.type) ?? 0) + 1);
    }
    // grateful_close should not be emitted twice for the same turn
    expect(typeCounts.get("grateful_close") ?? 0).toBeLessThanOrEqual(1);
  });
});
