import { describe, expect, it } from "vitest";

import { isHeavyModel, isLightModel, isNanoModel } from "../utils/model-tier.js";

describe("model-tier classification", () => {
  describe("isNanoModel", () => {
    it("classifies all ollama models as nano", () => {
      expect(isNanoModel("ollama/llama3.1:8b")).toBe(true);
      expect(isNanoModel("OLLAMA/pro-model")).toBe(true);
    });

    it("classifies nano-keyword model names as nano", () => {
      expect(isNanoModel("openai/gpt-5-nano")).toBe(true);
      expect(isNanoModel("anthropic/claude-3-haiku")).toBe(true);
      expect(isNanoModel("provider/turbo-mini")).toBe(true);
      expect(isNanoModel("provider/super-lite")).toBe(true);
      expect(isNanoModel("provider/mini")).toBe(true);
    });

    it("does not misclassify similarly named non-nano models", () => {
      expect(isNanoModel("openai/gpt-4o")).toBe(false);
      expect(isNanoModel("minimax/m2.7")).toBe(false);
    });
  });

  describe("isHeavyModel", () => {
    it("classifies heavy keywords as heavy", () => {
      expect(isHeavyModel("anthropic/claude-opus-4.1")).toBe(true);
      expect(isHeavyModel("openai/gpt-5")).toBe(true);
      expect(isHeavyModel("provider/o3")).toBe(true);
      expect(isHeavyModel("provider/o1")).toBe(true);
      expect(isHeavyModel("provider/ultra-model")).toBe(true);
      expect(isHeavyModel("provider/pro")).toBe(true);
      expect(isHeavyModel("provider/large")).toBe(true);
      expect(isHeavyModel("provider/heavy")).toBe(true);
    });

    it("never classifies ollama models as heavy", () => {
      expect(isHeavyModel("ollama/opus")).toBe(false);
      expect(isHeavyModel("ollama/gpt-5")).toBe(false);
    });

    it("does not misclassify non-heavy models", () => {
      expect(isHeavyModel("anthropic/claude-sonnet-4.5")).toBe(false);
      expect(isHeavyModel("provider/flash")).toBe(false);
      expect(isHeavyModel("provider/prototype")).toBe(false);
    });
  });

  describe("isLightModel", () => {
    it("classifies flash and small models as light", () => {
      expect(isLightModel("google/gemini-2.0-flash")).toBe(true);
      expect(isLightModel("provider/small")).toBe(true);
    });

    it("never classifies ollama models as light", () => {
      expect(isLightModel("ollama/flash")).toBe(false);
      expect(isLightModel("ollama/small")).toBe(false);
    });

    it("does not classify medium/heavy models as light", () => {
      expect(isLightModel("anthropic/claude-sonnet-4.5")).toBe(false);
      expect(isLightModel("openai/gpt-5")).toBe(false);
    });
  });
});
