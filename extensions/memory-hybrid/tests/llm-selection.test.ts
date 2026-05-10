import { describe, expect, it } from "vitest";
import { resolveModelFromTier, resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import type { HybridMemoryConfig } from "../config.js";

describe("llm-selection", () => {
  describe("resolveTierPreferenceWithSources", () => {
    it("should use explicitly configured tier list", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: ["openai/gpt-4.1-nano", "anthropic/claude-3.5-haiku"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      expect(result.tier).toBe("nano");
      expect(result.models).toContain("openai/gpt-4.1-nano");
      expect(result.explicit).toBe(true);
      expect(result.sources[0]).toBe("llm.nano[0]");
    });

    it("should fall back to default tier when specific tier not configured", () => {
      const config: HybridMemoryConfig = {
        llm: {
          default: ["openai/gpt-4.1-mini"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      expect(result.tier).toBe("nano");
      expect(result.explicit).toBe(false);
      expect(result.sources[0]).toBe("llm.default[0]");
    });

    it("should use built-in defaults when nothing configured", () => {
      const config: HybridMemoryConfig = {} as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      expect(result.tier).toBe("nano");
      expect(result.explicit).toBe(false);
      expect(result.sources[0]).toBe("built-in");
    });

    it("should handle maintenance tier", () => {
      const config: HybridMemoryConfig = {
        llm: {
          maintenance: ["openai/gpt-4.1-mini"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "maintenance");

      expect(result.tier).toBe("maintenance");
      expect(result.models[0]).toBe("openai/gpt-4.1-mini");
      expect(result.explicit).toBe(true);
    });

    it("should handle heavy tier", () => {
      const config: HybridMemoryConfig = {
        llm: {
          heavy: ["openai/gpt-4.1"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "heavy");

      expect(result.tier).toBe("heavy");
      expect(result.models[0]).toBe("openai/gpt-4.1");
      expect(result.explicit).toBe(true);
    });

    it("should handle default tier", () => {
      const config: HybridMemoryConfig = {
        llm: {
          default: ["openai/gpt-4.1-mini", "anthropic/claude-3.5-sonnet"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "default");

      expect(result.tier).toBe("default");
      expect(result.models).toHaveLength(2);
      expect(result.explicit).toBe(true);
    });

    it("should filter out empty string models", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: ["openai/gpt-4.1-nano", "", "  ", "anthropic/claude-3.5-haiku"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      expect(result.models).toEqual(["openai/gpt-4.1-nano", "anthropic/claude-3.5-haiku"]);
    });

    it("should trim whitespace from model names", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: ["  openai/gpt-4.1-nano  ", " anthropic/claude-3.5-haiku"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      expect(result.models[0]).toBe("openai/gpt-4.1-nano");
      expect(result.models[1]).toBe("anthropic/claude-3.5-haiku");
    });

    it("should handle multiple models with source tracking", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: ["model-1", "model-2", "model-3"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      expect(result.models).toHaveLength(3);
      expect(result.sources).toHaveLength(3);
      expect(result.sources[0]).toBe("llm.nano[0]");
      expect(result.sources[1]).toBe("llm.nano[1]");
      expect(result.sources[2]).toBe("llm.nano[2]");
    });

    it("should use default fallback for nano when tier not configured", () => {
      const config: HybridMemoryConfig = {
        llm: {
          default: ["default-model"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      expect(result.explicit).toBe(false);
      expect(result.sources[0]).toBe("llm.default[0]");
    });

    it("should use default fallback for maintenance when tier not configured", () => {
      const config: HybridMemoryConfig = {
        llm: {
          default: ["default-model"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "maintenance");

      expect(result.explicit).toBe(false);
      expect(result.sources[0]).toBe("llm.default[0]");
    });

    it("should not use default fallback for heavy tier", () => {
      const config: HybridMemoryConfig = {
        llm: {
          default: ["default-model"],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "heavy");

      // Heavy tier doesn't fall back to default, uses built-in
      expect(result.sources[0]).toBe("built-in");
    });

    it("should handle empty array in config", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: [] as string[],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      // Empty array is treated as not configured
      expect(result.explicit).toBe(false);
      expect(result.sources[0]).toBe("built-in");
    });

    it("should handle non-array tier value", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: "not-an-array" as unknown as string[],
        },
      } as HybridMemoryConfig;

      const result = resolveTierPreferenceWithSources(config, "nano");

      expect(result.explicit).toBe(false);
    });
  });

  describe("resolveModelFromTier", () => {
    it("should return first model from configured list", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: ["openai/gpt-4.1-nano", "anthropic/claude-3.5-haiku"],
        },
      } as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "nano");

      expect(result.model).toBe("openai/gpt-4.1-nano");
      expect(result.source).toBe("llm.nano[0]");
    });

    it("should return default model when tier not configured", () => {
      const config: HybridMemoryConfig = {} as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "nano");

      // Should return built-in default
      expect(result.model).toBeDefined();
      expect(result.source).toBe("built-in");
    });

    it("should handle maintenance tier", () => {
      const config: HybridMemoryConfig = {
        llm: {
          maintenance: ["openai/gpt-4.1-mini"],
        },
      } as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "maintenance");

      expect(result.model).toBe("openai/gpt-4.1-mini");
      expect(result.source).toBe("llm.maintenance[0]");
    });

    it("should handle heavy tier", () => {
      const config: HybridMemoryConfig = {
        llm: {
          heavy: ["openai/gpt-4.1"],
        },
      } as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "heavy");

      expect(result.model).toBe("openai/gpt-4.1");
      expect(result.source).toBe("llm.heavy[0]");
    });

    it("should handle default tier", () => {
      const config: HybridMemoryConfig = {
        llm: {
          default: ["custom-default-model"],
        },
      } as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "default");

      expect(result.model).toBe("custom-default-model");
      expect(result.source).toBe("llm.default[0]");
    });

    it("should use default tier as fallback for nano", () => {
      const config: HybridMemoryConfig = {
        llm: {
          default: ["fallback-model"],
        },
      } as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "nano");

      expect(result.model).toBe("fallback-model");
      expect(result.source).toBe("llm.default[0]");
    });

    it("should handle empty configuration", () => {
      const config: HybridMemoryConfig = {} as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "default");

      // Should have a built-in default
      expect(result.model).toBeDefined();
      expect(result.model.length).toBeGreaterThan(0);
      expect(result.source).toBe("built-in");
    });

    it("should return model and source as object", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: ["test-model"],
        },
      } as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "nano");

      expect(result).toHaveProperty("model");
      expect(result).toHaveProperty("source");
      expect(typeof result.model).toBe("string");
      expect(typeof result.source).toBe("string");
    });
  });

  describe("Integration scenarios", () => {
    it("should handle complete tier configuration", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: ["nano-model-1", "nano-model-2"],
          maintenance: ["maintenance-model"],
          default: ["default-model"],
          heavy: ["heavy-model"],
        },
      } as HybridMemoryConfig;

      const nano = resolveModelFromTier(config, "nano");
      const maintenance = resolveModelFromTier(config, "maintenance");
      const defaultResult = resolveModelFromTier(config, "default");
      const heavy = resolveModelFromTier(config, "heavy");

      expect(nano.model).toBe("nano-model-1");
      expect(maintenance.model).toBe("maintenance-model");
      expect(defaultResult.model).toBe("default-model");
      expect(heavy.model).toBe("heavy-model");
    });

    it("should handle partial configuration with fallbacks", () => {
      const config: HybridMemoryConfig = {
        llm: {
          default: ["shared-default"],
          heavy: ["specific-heavy"],
        },
      } as HybridMemoryConfig;

      const nano = resolveModelFromTier(config, "nano");
      const maintenance = resolveModelFromTier(config, "maintenance");
      const heavy = resolveModelFromTier(config, "heavy");

      // Nano and maintenance fall back to default
      expect(nano.model).toBe("shared-default");
      expect(maintenance.model).toBe("shared-default");

      // Heavy uses its specific config
      expect(heavy.model).toBe("specific-heavy");
    });

    it("should track sources correctly in complex config", () => {
      const config: HybridMemoryConfig = {
        llm: {
          nano: ["explicit-nano"],
          default: ["shared-default"],
        },
      } as HybridMemoryConfig;

      const nanoResult = resolveModelFromTier(config, "nano");
      const maintenanceResult = resolveModelFromTier(config, "maintenance");

      expect(nanoResult.source).toBe("llm.nano[0]");
      expect(maintenanceResult.source).toBe("llm.default[0]");
    });
  });

  describe("Edge cases", () => {
    it("should handle null llm config", () => {
      const config: HybridMemoryConfig = {
        llm: null as unknown as HybridMemoryConfig["llm"],
      } as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "nano");

      expect(result.model).toBeDefined();
      expect(result.source).toBe("built-in");
    });

    it("should handle undefined llm config", () => {
      const config: HybridMemoryConfig = {} as HybridMemoryConfig;

      const result = resolveModelFromTier(config, "nano");

      expect(result.model).toBeDefined();
      expect(result.source).toBe("built-in");
    });

    it("should handle all tiers with minimal config", () => {
      const config: HybridMemoryConfig = {} as HybridMemoryConfig;

      const tiers: Array<"nano" | "maintenance" | "default" | "heavy"> = ["nano", "maintenance", "default", "heavy"];

      for (const tier of tiers) {
        const result = resolveModelFromTier(config, tier);
        expect(result.model).toBeDefined();
        expect(result.model.length).toBeGreaterThan(0);
      }
    });
  });
});
