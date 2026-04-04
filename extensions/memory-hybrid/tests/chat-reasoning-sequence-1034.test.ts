import { describe, expect, it } from "vitest";
import { isReasoningModel, requiresMaxCompletionTokens } from "../services/model-capabilities.js";
import { isResponsesReasoningSequenceError, LLMRetryError } from "../services/chat.js";

/** Verifies #1034: Azure/Responses intermittent "reasoning without following item" 400 detection. */
describe("isResponsesReasoningSequenceError (#1034)", () => {
  it("matches the provider error body from issue #1034", () => {
    const msg =
      "400 Item 'rs_06a083b597e564790069ce10ee4a7c81908287c5fa6994ebe3' of type 'reasoning' was provided without its required following item.";
    expect(isResponsesReasoningSequenceError(new Error(msg))).toBe(true);
  });

  it("matches without 'its' before required (variant phrasing)", () => {
    const msg = "Item 'rs_abc' of type 'reasoning' was provided without required following item.";
    expect(isResponsesReasoningSequenceError(new Error(msg))).toBe(true);
  });

  it("returns false for unrelated 400 messages", () => {
    expect(isResponsesReasoningSequenceError(new Error("400 invalid_request_error"))).toBe(false);
    expect(isResponsesReasoningSequenceError(new Error("context length exceeded"))).toBe(false);
  });

  it("unwraps LLMRetryError cause so wrapped gateway errors still match", () => {
    const inner = new Error(
      "400 Item 'rs_x' of type 'reasoning' was provided without its required following item.",
    );
    const wrapped = new LLMRetryError(`Failed after 2 attempts: ${inner.message}`, inner, 2);
    expect(isResponsesReasoningSequenceError(wrapped)).toBe(true);
  });
});

/** o3-pro: reasoning model — same token / temperature rules as other o* models in chat.ts. */
describe("azure-foundry/o3-pro (reasoning tier)", () => {
  it("is treated as a reasoning model (max_completion_tokens path)", () => {
    expect(isReasoningModel("azure-foundry/o3-pro")).toBe(true);
    expect(requiresMaxCompletionTokens("azure-foundry/o3-pro")).toBe(true);
  });
});
