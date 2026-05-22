/**
 * Unit tests for services/capture-utils.ts (Issue #559, #1560).
 * Covers all short-circuit paths in shouldCapture and all category branches in detectCategory.
 */

import { describe, it, expect } from "vitest";
import { shouldCapture, detectCategory, isPromptArtifactOrReasoningTrace } from "../services/capture-utils.js";
import {
  getCategoryDecisionRegex,
  getCategoryPreferenceRegex,
  getCategoryEntityRegex,
  getCategoryFactRegex,
} from "../utils/language-keywords.js";
import { getMemoryTriggers } from "../services/auto-capture.js";

// ---------------------------------------------------------------------------
// isPromptArtifactOrReasoningTrace (Issue #1560)
// ---------------------------------------------------------------------------

describe("isPromptArtifactOrReasoningTrace", () => {
  describe("rejects think/think markers", () => {
    it("rejects text beginning with 'think '", () => {
      expect(isPromptArtifactOrReasoningTrace("think I should check the config first")).toBe(true);
    });
    it("rejects text beginning with 'think\n'", () => {
      expect(isPromptArtifactOrReasoningTrace("think\nI should check the config first")).toBe(true);
    });
    it("rejects 'think' with leading whitespace", () => {
      expect(isPromptArtifactOrReasoningTrace("  think I should check the config first")).toBe(true);
    });
    it("rejects 'Think I am a helpful assistant' (capitalized think)", () => {
      expect(isPromptArtifactOrReasoningTrace("Think I am a helpful assistant")).toBe(true);
    });
    it("rejects '<think>' wrapper prefix", () => {
      expect(isPromptArtifactOrReasoningTrace("<think>I should check the config first")).toBe(true);
    });
    it("rejects '<thinking>' wrapper prefix", () => {
      expect(isPromptArtifactOrReasoningTrace("<thinking>I should check the config first")).toBe(true);
    });
  });

  describe("rejects Thinking Process headers", () => {
    it('rejects "Thinking Process:"', () => {
      expect(isPromptArtifactOrReasoningTrace("Thinking Process: analyzing the request")).toBe(true);
    });
    it('rejects "Thinking Process;"', () => {
      expect(isPromptArtifactOrReasoningTrace("Thinking Process; analyzing the request")).toBe(true);
    });
    it('rejects "thinking process" case-insensitively', () => {
      expect(isPromptArtifactOrReasoningTrace("THINKING PROCESS: analyzing the request")).toBe(true);
    });
  });

  describe("rejects classifier prompt fragments", () => {
    it('rejects "The user is asking me to classify..."', () => {
      expect(isPromptArtifactOrReasoningTrace("The user is asking me to classify this message as a preference")).toBe(
        true,
      );
    });
    it('rejects "The user is asking me to extract..."', () => {
      expect(isPromptArtifactOrReasoningTrace("The user is asking me to extract entities from this message")).toBe(
        true,
      );
    });
  });

  describe("rejects structured operation markers", () => {
    it('rejects "NOOP |"', () => {
      expect(isPromptArtifactOrReasoningTrace("NOOP | this classification decision is already captured")).toBe(true);
    });
    it('rejects "ADD |"', () => {
      expect(isPromptArtifactOrReasoningTrace("ADD | new preference fact")).toBe(true);
    });
    it('rejects "UPDATE |"', () => {
      expect(isPromptArtifactOrReasoningTrace("UPDATE | existing preference fact")).toBe(true);
    });
  });

  describe("rejects classifier JSON output", () => {
    it('rejects JSON starting with {"action"', () => {
      expect(isPromptArtifactOrReasoningTrace('{"action": "NOOP", "reason": "..."}')).toBe(true);
    });
    it("rejects compact classifier JSON", () => {
      expect(isPromptArtifactOrReasoningTrace('{"action":"UPDATE","targetId":"abc123"}')).toBe(true);
    });
    it('rejects JSON with whitespace after "{" before "action"', () => {
      expect(isPromptArtifactOrReasoningTrace('{ "action": "NOOP", "reason": "..." }')).toBe(true);
    });
  });

  describe("rejects capability-hint markers", () => {
    it("rejects <!-- memory-hybrid: capability hints", () => {
      expect(isPromptArtifactOrReasoningTrace("<!-- memory-hybrid: capability hints -->")).toBe(true);
    });
    it("rejects with leading whitespace", () => {
      expect(isPromptArtifactOrReasoningTrace("  <!-- memory-hybrid: capability hints -->")).toBe(true);
    });
  });

  describe("accepts genuine content", () => {
    it("accepts plain user text", () => {
      expect(isPromptArtifactOrReasoningTrace("I need to update the config file")).toBe(false);
    });
    it("accepts plain assistant text", () => {
      expect(isPromptArtifactOrReasoningTrace("Sure, I can help you with that.")).toBe(false);
    });
    it("accepts text with think in the middle", () => {
      expect(isPromptArtifactOrReasoningTrace("The user thinks it might be broken")).toBe(false);
    });
    it("accepts empty string", () => {
      expect(isPromptArtifactOrReasoningTrace("")).toBe(false);
    });
    it("accepts whitespace-only string", () => {
      expect(isPromptArtifactOrReasoningTrace("   \n\t  ")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// shouldCapture (Issue #559)
// ---------------------------------------------------------------------------

describe("shouldCapture", () => {
  const MAX_CHARS = 500;
  const TRIGGERS = getMemoryTriggers();

  it("rejects text below minimum length (< 10 chars)", () => {
    expect(shouldCapture("short", MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(shouldCapture("", MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text above captureMaxChars", () => {
    const long = "remember ".repeat(100); // well over 500 chars, contains trigger
    expect(shouldCapture(long, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text containing <relevant-memories>", () => {
    const text = "please remember this <relevant-memories>something</relevant-memories>";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects XML-like text (starts with < and contains </)", () => {
    expect(shouldCapture("<tool_result>I prefer dark mode</tool_result>", MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects markdown-formatted text (contains ** and newline-dash)", () => {
    const text = "**remember this**\n- bullet one\n- bullet two";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects emoji-heavy text (more than 3 emojis)", () => {
    const text = "I remember 🎉 you prefer 🚀 the dark 🌙 side 🦄";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("accepts text with exactly 3 emojis and a trigger", () => {
    const text = "I prefer 🎉 dark 🚀 mode 🌙 always";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("rejects text matching a sensitive pattern (password)", () => {
    const text = "remember that the password is hunter2";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (api key)", () => {
    const text = "remember the api_key for this service";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (secret)", () => {
    const text = "remember the client secret value for this application";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (bearer keyword)", () => {
    const text = "remember the bearer token for the API access here";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (authorization header)", () => {
    const text = "remember the authorization header value for the gateway";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text matching a sensitive pattern (credentials keyword)", () => {
    const text = "remember the credentials for the home assistant system";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("rejects text with no trigger match", () => {
    const text = "this text has no memory trigger at all in it here";
    expect(shouldCapture(text, MAX_CHARS, TRIGGERS)).toBe(false);
  });

  it("accepts text that matches a trigger and passes all filters", () => {
    expect(shouldCapture("I prefer dark mode when coding", MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("accepts text matching a second trigger", () => {
    expect(shouldCapture("please remember to use tabs not spaces", MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("accepts text matching 'my name is' trigger", () => {
    expect(shouldCapture("my name is Claude and I like TypeScript", MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("is case-insensitive for trigger match", () => {
    expect(shouldCapture("I PREFER uppercase sometimes", MAX_CHARS, TRIGGERS)).toBe(true);
  });

  it("rejects think-prefixed text via isPromptArtifactOrReasoningTrace guard", () => {
    expect(shouldCapture("think I should fix this", MAX_CHARS, [/./])).toBe(false);
  });

  it("rejects Thinking Process text", () => {
    expect(shouldCapture("Thinking Process: analyzing the request", MAX_CHARS, [/./])).toBe(false);
  });

  it("rejects classifier JSON", () => {
    expect(shouldCapture('{"action": "NOOP"}', MAX_CHARS, [/./])).toBe(false);
  });

  it("rejects classifier JSON with whitespace after opening brace", () => {
    expect(shouldCapture('{ "action": "NOOP" }', MAX_CHARS, [/./])).toBe(false);
  });

  it("rejects <think>-prefixed text via isPromptArtifactOrReasoningTrace guard", () => {
    expect(shouldCapture("<think>I should fix this</think>", MAX_CHARS, [/./])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectCategory (Issue #559)
// ---------------------------------------------------------------------------

describe("detectCategory", () => {
  const decisionRegex = getCategoryDecisionRegex();
  const preferenceRegex = getCategoryPreferenceRegex();
  const entityRegex = getCategoryEntityRegex();
  const factRegex = getCategoryFactRegex();

  it("returns 'decision' for text matching decision keywords", () => {
    expect(
      detectCategory(
        "I decided to use TypeScript for this project",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("decision");
  });

  it("returns 'decision' for 'went with' keyword", () => {
    expect(
      detectCategory("we went with Postgres for the database", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("decision");
  });

  it("returns 'preference' for text matching preference keywords", () => {
    expect(
      detectCategory(
        "I prefer dark mode when working at night",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("preference");
  });

  it("returns 'decision' for 'always use' keyword", () => {
    expect(
      detectCategory("I always use two spaces for indentation", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("decision");
  });

  it("returns 'entity' for text containing a phone-like pattern", () => {
    // +10 digits triggers the phone regex in detectCategory
    expect(
      detectCategory("call me at +12025551234 anytime", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("entity");
  });

  it("returns 'entity' for text with email-like pattern", () => {
    expect(
      detectCategory(
        "reach me at user@example.com for details",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("entity");
  });

  it("returns 'entity' for text matching entity regex", () => {
    expect(
      detectCategory("the project is called Acme Corp", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("entity");
  });

  it("returns 'fact' for text matching fact keywords", () => {
    expect(
      detectCategory("the capital of France is Paris", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("fact");
  });

  it("returns 'fact' for 'has' pattern", () => {
    expect(
      detectCategory(
        "the framework has many features and capabilities",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("fact");
  });

  it("returns 'other' when no category pattern matches", () => {
    expect(
      detectCategory(
        "something entirely generic without keywords",
        decisionRegex,
        preferenceRegex,
        entityRegex,
        factRegex,
      ),
    ).toBe("other");
  });

  it("decision takes priority over preference when both match", () => {
    expect(
      detectCategory("I decided I prefer tabs over spaces", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("decision");
  });

  it("is case-insensitive (uses lowercased text internally)", () => {
    expect(
      detectCategory("We DECIDED to deploy on Friday", decisionRegex, preferenceRegex, entityRegex, factRegex),
    ).toBe("decision");
  });
});
