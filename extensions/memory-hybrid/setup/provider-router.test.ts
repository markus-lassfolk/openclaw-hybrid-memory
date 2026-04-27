import { describe, expect, it } from "vitest";
import { requiresMaxCompletionTokens, shouldOmitSamplingParams } from "../services/model-capabilities.js";

/**
 * These tests cover the `remapMaxTokensForOpenAI` token-param remapping logic
 * in the provider router without requiring a full HTTP capture or mock server.
 *
 * The router rewrites `max_tokens` → `max_completion_tokens` for models that
 * require it (GPT-5+, GPT-4.1*, o-series), regardless of provider prefix.
 */
describe("remapMaxTokensForOpenAI token-param remapping", () => {
  describe("requiresMaxCompletionTokens model detection", () => {
    it("returns true for gpt-5 models with any prefix", () => {
      expect(requiresMaxCompletionTokens("gpt-5.4-nano")).toBe(true);
      expect(requiresMaxCompletionTokens("openai/gpt-5.4-nano")).toBe(true);
      expect(requiresMaxCompletionTokens("azure-foundry/gpt-5.4-nano")).toBe(true);
    });

    it("returns true for gpt-4.1 models with any prefix", () => {
      expect(requiresMaxCompletionTokens("gpt-4.1-nano")).toBe(true);
      expect(requiresMaxCompletionTokens("openai/gpt-4.1-nano")).toBe(true);
      expect(requiresMaxCompletionTokens("azure-foundry/gpt-4.1-nano")).toBe(true);
    });

    it("returns true for o-series reasoning models with any prefix", () => {
      expect(requiresMaxCompletionTokens("o1")).toBe(true);
      expect(requiresMaxCompletionTokens("o3")).toBe(true);
      expect(requiresMaxCompletionTokens("o4-mini")).toBe(true);
      expect(requiresMaxCompletionTokens("openai/o1")).toBe(true);
      expect(requiresMaxCompletionTokens("azure/o3")).toBe(true);
    });

    it("returns false for older models that use max_tokens", () => {
      expect(requiresMaxCompletionTokens("gpt-4o-mini")).toBe(false);
      expect(requiresMaxCompletionTokens("gpt-4o")).toBe(false);
      expect(requiresMaxCompletionTokens("claude-3-5-sonnet-latest")).toBe(false);
      expect(requiresMaxCompletionTokens("openai/gpt-4o-mini")).toBe(false);
      expect(requiresMaxCompletionTokens("azure/gpt-4o")).toBe(false);
    });
  });

  describe("shouldOmitSamplingParams", () => {
    it("returns true for o-series and gpt-5* (any provider prefix)", () => {
      expect(shouldOmitSamplingParams("o3")).toBe(true);
      expect(shouldOmitSamplingParams("azure-foundry/o3-pro")).toBe(true);
      expect(shouldOmitSamplingParams("gpt-5.5")).toBe(true);
      expect(shouldOmitSamplingParams("azure-foundry/gpt-5.5")).toBe(true);
      expect(shouldOmitSamplingParams("azure-foundry/gpt-5.4-pro")).toBe(true);
    });
    it("returns false for gpt-4* and non-5 chat models", () => {
      expect(shouldOmitSamplingParams("gpt-4o")).toBe(false);
      expect(shouldOmitSamplingParams("azure-foundry/gpt-4.1-mini")).toBe(false);
    });
  });
});
