// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  detectCategory,
  isPromptArtifactOrReasoningTrace,
  shouldCapture,
} from "../services/capture-utils.js";

describe("isPromptArtifactOrReasoningTrace", () => {
  const True = () => true;

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
      expect(
        isPromptArtifactOrReasoningTrace("The user is asking me to classify this message as a preference"),
      ).toBe(true);
    });
    it('rejects "The user is asking me to extract..."', () => {
      expect(
        isPromptArtifactOrReasoningTrace("The user is asking me to extract entities from this message"),
      ).toBe(true);
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

describe("shouldCapture with reasoning trace guard", () => {
  const alwaysTrigger = [/./];

  it("rejects think-prefixed text via isPromptArtifactOrReasoningTrace guard", () => {
    expect(shouldCapture("think I should fix this", 5000, alwaysTrigger)).toBe(false);
  });
  it("rejects Thinking Process text", () => {
    expect(shouldCapture("Thinking Process: analyzing the request", 5000, alwaysTrigger)).toBe(false);
  });
  it("rejects classifier JSON", () => {
    expect(shouldCapture('{"action": "NOOP"}', 5000, alwaysTrigger)).toBe(false);
  });
  it("accepts genuine content that matches memory triggers", () => {
    expect(shouldCapture("I prefer to use the config file", 5000, [/prefer/])).toBe(true);
  });
});
