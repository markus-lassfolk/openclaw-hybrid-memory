/**
 * Tests for Ollama local LLM provider support in hybrid-memory.
 * Covers: provider resolution, health check / graceful fallback, cost tracking ($0), nano-tier classification.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Model-pricing: Ollama always $0
// ─────────────────────────────────────────────────────────────────────────────
import { getModelPricing, estimateCost } from "../services/model-pricing.js";

describe("Ollama cost tracking — $0 for local models", () => {
  it("getModelPricing returns $0 for ollama/qwen3:8b", () => {
    const p = getModelPricing("ollama/qwen3:8b");
    expect(p).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it("getModelPricing returns $0 for any ollama/* model", () => {
    expect(getModelPricing("ollama/llama3:8b")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(getModelPricing("ollama/mistral:7b")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(getModelPricing("ollama/phi4:14b")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it("getModelPricing is case-insensitive for ollama prefix", () => {
    expect(getModelPricing("OLLAMA/Qwen3:8b")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(getModelPricing("Ollama/llama3")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });

  it("estimateCost returns exactly 0 for ollama models at any scale", () => {
    expect(estimateCost("ollama/qwen3:8b", 0, 0)).toBe(0);
    expect(estimateCost("ollama/qwen3:8b", 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCost("ollama/llama3:8b", 500_000, 200_000)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. chatCompleteWithRetry: ECONNREFUSED on Ollama falls through to next model
// ─────────────────────────────────────────────────────────────────────────────
import { chatCompleteWithRetry } from "../services/chat.js";
import OpenAI from "openai";

describe("Ollama graceful fallback — ECONNREFUSED", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to cloud model when primary ollama model returns ECONNREFUSED", async () => {
    const ollamaErr = Object.assign(
      new Error("Ollama not available at http://127.0.0.1:11434 (ECONNREFUSED) — try next model"),
      { code: "ECONNREFUSED" },
    );
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn()
            .mockRejectedValueOnce(ollamaErr)    // first call: ollama fails
            .mockResolvedValueOnce({              // second call: cloud model succeeds
              choices: [{ message: { content: "response from cloud" } }],
            }),
        },
      },
    } as unknown as OpenAI;

    const result = await chatCompleteWithRetry({
      model: "ollama/qwen3:8b",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["openai/gpt-4.1-nano"],
    });

    expect(result).toBe("response from cloud");
    // Should have tried ollama first, then the fallback
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("throws when both ollama and fallback models fail", async () => {
    const connErr = Object.assign(
      new Error("ECONNREFUSED"),
      { code: "ECONNREFUSED" },
    );
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(connErr),
        },
      },
    } as unknown as OpenAI;

    await expect(
      chatCompleteWithRetry({
        model: "ollama/qwen3:8b",
        content: "test",
        openai: mockOpenai,
        fallbackModels: [],
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Config: localAutoStart is parsed correctly
// ─────────────────────────────────────────────────────────────────────────────
import { parseLLMConfig } from "../config/parsers/core.js";

describe("parseLLMConfig — localAutoStart", () => {
  it("parses localAutoStart: true", () => {
    const cfg = {
      llm: {
        default: ["openai/gpt-4.1-mini"],
        heavy: ["openai/gpt-5.4"],
        nano: ["ollama/qwen3:8b"],
        localAutoStart: true,
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.localAutoStart).toBe(true);
  });

  it("defaults localAutoStart to false when not set", () => {
    const cfg = {
      llm: {
        default: ["openai/gpt-4.1-mini"],
        heavy: ["openai/gpt-5.4"],
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.localAutoStart).toBe(false);
  });

  it("ignores localAutoStart: 'true' (string) — must be boolean true", () => {
    const cfg = {
      llm: {
        default: ["openai/gpt-4.1-mini"],
        heavy: ["openai/gpt-5.4"],
        localAutoStart: "true",
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.localAutoStart).toBe(false);
  });

  it("materializes LLM config when only localAutoStart: true is set (no explicit tiers)", () => {
    const cfg = { llm: { localAutoStart: true } };
    const result = parseLLMConfig(cfg);
    expect(result).not.toBeUndefined();
    expect(result?.localAutoStart).toBe(true);
    // Tiers should be empty (auto-derive happens in initializeDatabases, not parseLLMConfig)
    expect(result?.default).toEqual([]);
    expect(result?.heavy).toEqual([]);
  });

  it("parses nano tier containing ollama models", () => {
    const cfg = {
      llm: {
        default: ["openai/gpt-4.1-mini"],
        heavy: ["openai/gpt-5.4"],
        nano: ["ollama/qwen3:8b", "openai/gpt-4.1-nano"],
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.nano).toEqual(["ollama/qwen3:8b", "openai/gpt-4.1-nano"]);
  });

  it("preserves localAutoStart when no tier lists are present", () => {
    const cfg = {
      llm: {
        localAutoStart: true,
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result).toBeDefined();
    expect(result?.localAutoStart).toBe(true);
  });
});
