/**
 * Tests for Ollama local LLM provider support in hybrid-memory.
 * Covers: provider resolution, health check / graceful fallback, cost tracking ($0), nano-tier classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Model-pricing: Ollama always $0
// ─────────────────────────────────────────────────────────────────────────────
import { estimateCost, getModelPricing } from "../services/model-pricing.js";

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

import type OpenAI from "openai";
// ─────────────────────────────────────────────────────────────────────────────
// 2. chatCompleteWithRetry: ECONNREFUSED on Ollama falls through to next model
// ─────────────────────────────────────────────────────────────────────────────
import { chatCompleteWithRetry } from "../services/chat.js";

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
          create: vi
            .fn()
            .mockRejectedValueOnce(ollamaErr) // first call: ollama fails
            .mockResolvedValueOnce({
              // second call: cloud model succeeds
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
    const connErr = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
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

describe("parseLLMConfig — maintenanceFallbackPolicy", () => {
  it("materializes llm when only maintenanceFallbackPolicy is set", () => {
    const cfg = { llm: { maintenanceFallbackPolicy: "explicit-only" } };
    const result = parseLLMConfig(cfg);
    expect(result).toBeDefined();
    expect(result?.maintenanceFallbackPolicy).toBe("explicit-only");
    expect(result?.default).toEqual([]);
    expect(result?.heavy).toEqual([]);
  });
});

describe("parseLLMConfig — provider baseURL / baseUrl", () => {
  it("accepts camelCase `baseUrl` in provider config (OpenClaw convention)", () => {
    const cfg = {
      llm: {
        providers: {
          "azure-foundry": {
            apiKey: "test-key",
            baseUrl: "https://my-foundry.openai.azure.com",
          },
        },
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.providers?.["azure-foundry"]?.baseURL).toBe("https://my-foundry.openai.azure.com");
  });

  it("accepts kebab-case `baseURL` in provider config", () => {
    const cfg = {
      llm: {
        providers: {
          "azure-foundry": {
            apiKey: "test-key",
            baseURL: "https://my-foundry.openai.azure.com",
          },
        },
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.providers?.["azure-foundry"]?.baseURL).toBe("https://my-foundry.openai.azure.com");
  });

  it("prefers kebab-case `baseURL` over camelCase `baseUrl` when both are set", () => {
    const cfg = {
      llm: {
        providers: {
          "azure-foundry": {
            apiKey: "test-key",
            baseURL: "https://kebab.example.com",
            baseUrl: "https://camel.example.com",
          },
        },
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.providers?.["azure-foundry"]?.baseURL).toBe("https://kebab.example.com");
  });

  it("strips whitespace from baseUrl and baseURL", () => {
    const cfg = {
      llm: {
        providers: {
          "azure-foundry": {
            apiKey: "test-key",
            baseUrl: "  https://spaces.example.com  ",
          },
        },
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.providers?.["azure-foundry"]?.baseURL).toBe("https://spaces.example.com");
  });

  it("returns undefined baseURL when neither baseUrl nor baseURL is set", () => {
    const cfg = {
      llm: {
        providers: {
          "azure-foundry": {
            apiKey: "test-key",
          },
        },
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.providers?.["azure-foundry"]?.baseURL).toBeUndefined();
  });

  it("returns undefined baseURL when baseUrl is an empty string", () => {
    const cfg = {
      llm: {
        providers: {
          "azure-foundry": {
            apiKey: "test-key",
            baseUrl: "   ",
          },
        },
      },
    };
    const result = parseLLMConfig(cfg);
    expect(result?.providers?.["azure-foundry"]?.baseURL).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. startOllamaIfNeeded — deduplication guard (race / concurrent-init safety)
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("../setup/provider-router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../setup/provider-router.js")>();
  return {
    ...actual,
    probeOllamaEndpoint: vi.fn(),
    clearOllamaHealthCacheEntry: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    unref: vi.fn(),
  })),
}));

import { probeOllamaEndpoint } from "../setup/provider-router.js";
import { spawn } from "node:child_process";
import {
  startOllamaIfNeeded,
  _resetOllamaAutoStartForTesting,
} from "../setup/bootstrap-databases.js";

describe("startOllamaIfNeeded — deduplication guard", () => {
  const makeApi = () => ({
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  });

  const baseCfg = {
    llm: {
      localAutoStart: true,
      default: ["ollama/qwen3:8b"],
      heavy: [],
      nano: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetOllamaAutoStartForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not spawn ollama at all when the server is already running", async () => {
    vi.mocked(probeOllamaEndpoint).mockResolvedValue(true);

    startOllamaIfNeeded(baseCfg as never, makeApi() as never);

    // Drain microtasks so the async IIFE can run
    await vi.runAllTimersAsync();
    await vi.advanceTimersByTimeAsync(0);

    expect(probeOllamaEndpoint).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns ollama exactly once even when called concurrently twice", async () => {
    // First probe: Ollama is down; use a manually-resolved promise so the second call
    // arrives while the first auto-start is still in-flight (before the probe resolves).
    let resolveProbe!: (v: boolean) => void;
    const slowProbe = new Promise<boolean>((res) => {
      resolveProbe = res;
    });
    vi.mocked(probeOllamaEndpoint)
      .mockReturnValueOnce(slowProbe) // first probe (is it running?) — held
      .mockResolvedValue(true); // re-probe after spawn

    const api1 = makeApi();
    const api2 = makeApi();

    startOllamaIfNeeded(baseCfg as never, api1 as never);
    // Second call arrives while the first is still awaiting the slow probe
    startOllamaIfNeeded(baseCfg as never, api2 as never);

    // Unblock the first probe — Ollama is down, so it should spawn
    resolveProbe(false);
    await vi.runAllTimersAsync();

    // Advance past the 2-second post-spawn wait
    await vi.advanceTimersByTimeAsync(2100);
    await vi.runAllTimersAsync();

    // spawn must have been called only once despite two concurrent startOllamaIfNeeded calls
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith("ollama", ["serve"], { detached: true, stdio: "ignore" });
    // Two probes: initial + re-probe after spawn
    expect(probeOllamaEndpoint).toHaveBeenCalledTimes(2);
  });

  it("allows a new auto-start after the previous one completes", async () => {
    vi.mocked(probeOllamaEndpoint)
      .mockResolvedValueOnce(false) // first run: down
      .mockResolvedValueOnce(true) // re-probe after first spawn
      .mockResolvedValueOnce(false) // second run: down again
      .mockResolvedValue(true); // re-probe after second spawn

    startOllamaIfNeeded(baseCfg as never, makeApi() as never);
    await vi.runAllTimersAsync();
    // Advance past the 2-second wait; finally clears _ollamaAutoStartPromise
    await vi.advanceTimersByTimeAsync(2100);
    await vi.runAllTimersAsync();

    expect(spawn).toHaveBeenCalledOnce();

    // _ollamaAutoStartPromise should now be null (cleared by finally); second call can run
    startOllamaIfNeeded(baseCfg as never, makeApi() as never);
    await vi.runAllTimersAsync();
    await vi.advanceTimersByTimeAsync(2100);
    await vi.runAllTimersAsync();

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("skips when localAutoStart is false", async () => {
    const cfg = { llm: { localAutoStart: false, default: ["ollama/qwen3:8b"], heavy: [], nano: [] } };
    startOllamaIfNeeded(cfg as never, makeApi() as never);
    await vi.runAllTimersAsync();
    expect(probeOllamaEndpoint).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("skips when no ollama/* models are configured", async () => {
    const cfg = {
      llm: { localAutoStart: true, default: ["openai/gpt-4.1-mini"], heavy: [], nano: [] },
    };
    startOllamaIfNeeded(cfg as never, makeApi() as never);
    await vi.runAllTimersAsync();
    expect(probeOllamaEndpoint).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("captures and logs errors without crashing when probeOllamaEndpoint throws", async () => {
    const { capturePluginError } = await import("../services/error-reporter.js");
    vi.mocked(probeOllamaEndpoint).mockRejectedValue(new Error("network failure"));
    const api = makeApi();

    startOllamaIfNeeded(baseCfg as never, api as never);
    await vi.runAllTimersAsync();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("network failure"));
    expect(capturePluginError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "network failure" }),
      expect.objectContaining({ operation: "ollama-auto-start" }),
    );
  });
});
