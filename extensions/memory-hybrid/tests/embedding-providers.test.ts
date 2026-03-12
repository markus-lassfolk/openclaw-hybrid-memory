/**
 * Tests for local embedding provider support (#153).
 *
 * All HTTP calls are mocked — no Ollama instance required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Embeddings,
  OllamaEmbeddingProvider,
  FallbackEmbeddingProvider,
  ChainEmbeddingProvider,
  OnnxEmbeddingProvider,
  AllEmbeddingProvidersFailed,
  createEmbeddingProvider,
  safeEmbed,
  __setOnnxRuntimeLoaderForTests,
  _resetOllamaCircuitBreakerForTesting,
  type EmbeddingConfig,
} from "../services/embeddings.js";
import { capturePluginError } from "../services/error-reporter.js";
import { LLMRetryError } from "../services/chat.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  __setOnnxRuntimeLoaderForTests(null);
});

beforeEach(() => {
  vi.mocked(capturePluginError).mockClear();
});

/** Build a mock OpenAI client that returns a fixed embedding vector.
 * Supports batch input: returns one copy of `vector` per input text. */
function makeMockOpenAI(vector: number[]): import("openai").default {
  const mockCreate = vi.fn().mockImplementation((params: { input: string | string[] }) => {
    const count = Array.isArray(params.input) ? params.input.length : 1;
    return Promise.resolve({ data: Array.from({ length: count }, () => ({ embedding: vector })) });
  });
  return {
    embeddings: { create: mockCreate },
  } as unknown as import("openai").default;
}

/** Build a mock fetch that returns an Ollama-style response. */
function mockOllamaFetch(embeddings: number[][]): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ embeddings }),
    text: async () => "",
  } as Response);
}

/** Build a mock fetch that rejects (connection refused). */
function mockOllamaFetchFail(message = "fetch failed"): typeof fetch {
  return vi.fn().mockRejectedValue(new Error(message));
}

/** Build a mock fetch that returns a non-OK HTTP response. */
function mockOllamaFetchError(status: number, text: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: text,
    text: async () => text,
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// EmbeddingProvider interface compliance
// ---------------------------------------------------------------------------

describe("Embeddings (OpenAI) implements EmbeddingProvider interface", () => {
  it("exposes dimensions and modelName", () => {
    const client = makeMockOpenAI([0.1, 0.2]);
    const provider = new Embeddings(client, "text-embedding-3-small", 1536);
    expect(provider.dimensions).toBe(1536);
    expect(provider.modelName).toBe("text-embedding-3-small");
  });

  it("defaults dimensions to 1536 when not provided", () => {
    const client = makeMockOpenAI([0.1, 0.2]);
    const provider = new Embeddings(client, "text-embedding-3-small");
    expect(provider.dimensions).toBe(1536);
  });

  it("embed() returns the vector from the API", async () => {
    const vec = [0.1, 0.2, 0.3];
    const client = makeMockOpenAI(vec);
    const provider = new Embeddings(client, "text-embedding-3-small", 3);
    const result = await provider.embed("hello");
    expect(result).toEqual(vec);
  });

  it("embedBatch() returns correct number of results", async () => {
    const vec = [0.5, 0.6];
    const client = makeMockOpenAI(vec);
    const provider = new Embeddings(client, "text-embedding-3-small", 2);
    const results = await provider.embedBatch(["a", "b", "c"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(vec);
    expect(results[1]).toEqual(vec);
    expect(results[2]).toEqual(vec);
  });

  it("embedBatch() makes a single batched API call (not N calls)", async () => {
    const vec = [0.5, 0.6];
    const client = makeMockOpenAI(vec);
    const mockCreate = (client.embeddings.create as ReturnType<typeof vi.fn>);
    const provider = new Embeddings(client, "text-embedding-3-small", 2);
    await provider.embedBatch(["a", "b", "c"]);
    expect(mockCreate).toHaveBeenCalledOnce();
    const [callArg] = mockCreate.mock.calls[0] as [{ input: string[] }];
    expect(callArg.input).toEqual(["a", "b", "c"]);
  });

  it("embedBatch() splits into multiple API calls when count exceeds batchSize", async () => {
    const vec = [0.5, 0.6];
    const client = makeMockOpenAI(vec);
    const mockCreate = (client.embeddings.create as ReturnType<typeof vi.fn>);
    const provider = new Embeddings(client, "text-embedding-3-small", 2, 2);
    const texts = ["a", "b", "c", "d", "e"];
    const results = await provider.embedBatch(texts);
    expect(results).toHaveLength(5);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[0][0].input).toEqual(["a", "b"]);
    expect(mockCreate.mock.calls[1][0].input).toEqual(["c", "d"]);
    expect(mockCreate.mock.calls[2][0].input).toEqual(["e"]);
  });

  it("throws when dimensions exceed model max", () => {
    const client = makeMockOpenAI([]);
    expect(() => new Embeddings(client, "text-embedding-3-small", 2000)).toThrow(/exceed/i);
    expect(() => new Embeddings(client, "text-embedding-3-large", 4000)).toThrow(/exceed/i);
  });

  it("does not throw when dimensions are within model max", () => {
    const client = makeMockOpenAI([]);
    expect(() => new Embeddings(client, "text-embedding-3-small", 1536)).not.toThrow();
    expect(() => new Embeddings(client, "text-embedding-3-large", 3072)).not.toThrow();
    expect(() => new Embeddings(client, "text-embedding-ada-002", 1536)).not.toThrow();
  });

  it("throws when non-text-embedding-3 model is used with custom dimensions", () => {
    const client = makeMockOpenAI([]);
    expect(() => new Embeddings(client, "text-embedding-ada-002", 768)).toThrow(/does not support custom dimensions/);
    expect(() => new Embeddings(client, ["text-embedding-3-small", "text-embedding-ada-002"], 768)).toThrow(/does not support custom dimensions/);
  });

  it("#329: Google API 404 fails fast (no retry) and does not report to GlitchTip", async () => {
    vi.useFakeTimers();
    try {
      // Simulate OpenAI SDK v6 NotFoundError from Google Generative Language API
      const googleError = Object.assign(
        new Error("404 models/text-embedding-004 is not found for API version v1beta, or is not supported for embeddings. Call ListModels to see the list of available models and their supported methods."),
        { status: 404 },
      );
      const mockCreate = vi.fn().mockRejectedValue(googleError);
      const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
      const provider = new Embeddings(client, "text-embedding-004", 768);
      await expect(provider.embed("test")).rejects.toThrow("404 models/text-embedding-004");
      // Must NOT retry — is404Like should exit withLLMRetry on first attempt
      expect(mockCreate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#329: Google API 404 (message-only, no status) still fails fast", async () => {
    vi.useFakeTimers();
    try {
      // Google API error without HTTP .status set (cross-realm or plain Error fallback)
      const googleError = new Error("models/text-embedding-004 is not found for API version v1beta");
      const mockCreate = vi.fn().mockRejectedValue(googleError);
      const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
      const provider = new Embeddings(client, "text-embedding-004", 768);
      await expect(provider.embed("test")).rejects.toThrow("is not found for API version");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#393: Google 403 country/region restriction fails fast and does not report to GlitchTip", async () => {
    vi.useFakeTimers();
    try {
      const googleError = Object.assign(
        new Error("403 Country, region, or territory not supported"),
        { status: 403 },
      );
      const mockCreate = vi.fn().mockRejectedValue(googleError);
      const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
      const provider = new Embeddings(client, "text-embedding-004", 768);
      await expect(provider.embed("test")).rejects.toThrow("403 Country");
      // Must NOT retry — is403Like should exit withLLMRetry on first attempt
      expect(mockCreate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates modelName when a fallback model succeeds", async () => {
    vi.useFakeTimers();
    try {
      // Mock: always fail for text-embedding-3-small (exhausts withLLMRetry retries),
      // succeed for text-embedding-ada-002
      const mockCreate = vi.fn().mockImplementation((params: { model: string; input: string | string[] }) => {
        if (params.model === "text-embedding-3-small") {
          return Promise.reject(new Error("model unavailable"));
        }
        const count = Array.isArray(params.input) ? params.input.length : 1;
        return Promise.resolve({ data: Array.from({ length: count }, () => ({ embedding: [0.1] })) });
      });
      const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
      const provider = new Embeddings(client, ["text-embedding-3-small", "text-embedding-ada-002"], 1536);
      expect(provider.modelName).toBe("text-embedding-3-small");
      const embedPromise = provider.embed("test");
      // Advance past all withLLMRetry delays (1s + 3s for 2 retries = 4s total)
      await vi.advanceTimersByTimeAsync(5000);
      await embedPromise;
      expect(provider.modelName).toBe("text-embedding-ada-002");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// OllamaEmbeddingProvider
// ---------------------------------------------------------------------------

describe("OllamaEmbeddingProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset module-level circuit breaker state so tests don't bleed into each other
    _resetOllamaCircuitBreakerForTesting();
  });

  it("exposes correct dimensions and modelName", () => {
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 768 });
    expect(p.dimensions).toBe(768);
    expect(p.modelName).toBe("nomic-embed-text");
  });

  it("uses default endpoint http://localhost:11434 when not specified", () => {
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 768 });
    // Access private endpoint via cast for testing
    expect((p as unknown as { endpoint: string }).endpoint).toBe("http://localhost:11434");
  });

  it("strips trailing slash from endpoint", () => {
    const p = new OllamaEmbeddingProvider({
      model: "nomic-embed-text",
      dimensions: 768,
      endpoint: "http://localhost:11434/",
    });
    expect((p as unknown as { endpoint: string }).endpoint).toBe("http://localhost:11434");
  });

  it("embed() calls POST /api/embed and returns first embedding", async () => {
    const vec = [0.1, 0.2, 0.3];
    vi.stubGlobal("fetch", mockOllamaFetch([vec]));
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 3 });
    const result = await p.embed("test text");
    expect(result).toEqual(vec);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/embed");
    expect(JSON.parse(opts.body as string)).toMatchObject({
      model: "nomic-embed-text",
      input: ["test text"],
    });
  });

  it("embedBatch() sends texts in one batch when count <= batchSize", async () => {
    const vecs = [[0.1, 0.2], [0.3, 0.4]];
    vi.stubGlobal("fetch", mockOllamaFetch(vecs));
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 2, batchSize: 50 });
    const results = await p.embedBatch(["a", "b"]);
    expect(results).toEqual(vecs);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("embedBatch() splits into multiple HTTP calls when count > batchSize", async () => {
    const batch1 = [[0.1], [0.2]];
    const batch2 = [[0.3]];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embeddings: batch1 }), text: async () => "" } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embeddings: batch2 }), text: async () => "" } as Response);
    vi.stubGlobal("fetch", mockFetch);
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 1, batchSize: 2 });
    const results = await p.embedBatch(["a", "b", "c"]);
    expect(results).toEqual([[0.1], [0.2], [0.3]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("embed() throws on connection failure", async () => {
    vi.stubGlobal("fetch", mockOllamaFetchFail("ECONNREFUSED"));
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 3 });
    await expect(p.embed("text")).rejects.toThrow(/Ollama connection failed/);
  });

  it("embed() throws on non-OK HTTP response", async () => {
    vi.stubGlobal("fetch", mockOllamaFetchError(404, "model not found"));
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 3 });
    await expect(p.embed("text")).rejects.toThrow(/Ollama embed failed.*404/);
  });

  it("embed() throws when response has no embeddings array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: "format" }),
      text: async () => "",
    } as unknown as Response));
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 3 });
    await expect(p.embed("text")).rejects.toThrow(/missing 'embeddings'/);
  });

  it("embedBatch() throws when Ollama returns wrong number of embeddings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1]] }), // 1 returned, 2 expected
      text: async () => "",
    } as Response));
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 1 });
    await expect(p.embedBatch(["a", "b"])).rejects.toThrow(/returned 1 embeddings for 2 inputs/);
  });

  it("embedBatch() throws on empty embeddings array in response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [] }),
      text: async () => "",
    } as Response));
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 3 });
    await expect(p.embedBatch(["a"])).rejects.toThrow(/empty 'embeddings' array/);
  });

  it("respects custom endpoint", async () => {
    const vec = [0.9, 0.8];
    vi.stubGlobal("fetch", mockOllamaFetch([vec]));
    const p = new OllamaEmbeddingProvider({
      model: "nomic-embed-text",
      dimensions: 2,
      endpoint: "http://my-server:12345",
    });
    await p.embed("test");
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://my-server:12345/api/embed");
  });

  it("#387: OOM response (HTTP 500 with OOM body) trips circuit breaker immediately", async () => {
    const oomBody = "model requires more system memory (18.2 GiB) than is available (8.0 GiB)";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => oomBody,
    } as unknown as Response));
    const p = new OllamaEmbeddingProvider({ model: "qwen3:8b", dimensions: 4096 });
    // First call: OOM — should throw and trip circuit breaker
    await expect(p.embed("test")).rejects.toThrow(/Ollama embed failed.*500/);
    // Second call: circuit breaker should be open — should throw without making HTTP request
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1]] }), text: async () => "" } as Response));
    await expect(p.embed("test")).rejects.toThrow(/circuit breaker open/i);
    // fetch was NOT called for the second attempt (blocked by circuit breaker)
    expect(fetch).not.toHaveBeenCalled();
  });

  it("#387: generic HTTP 500 (non-OOM) does not trip circuit breaker immediately", async () => {
    const genericBody = "Internal Server Error";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => genericBody,
    } as unknown as Response));
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 768 });
    // Generic 500: circuit breaker should NOT be immediately tripped (only on OLLAMA_MAX_FAILS connection failures)
    await expect(p.embed("test")).rejects.toThrow(/Ollama embed failed.*500/);
    // Second call should still reach fetch (circuit breaker not tripped for non-OOM 500)
    const goodVec = [0.5, 0.5];
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockOllamaFetch([[0.5, 0.5]]));
    const result = await p.embed("test");
    expect(result).toEqual(goodVec);
  });
});

// ---------------------------------------------------------------------------
// FallbackEmbeddingProvider
// ---------------------------------------------------------------------------

describe("FallbackEmbeddingProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset module-level Ollama circuit breaker state between tests
    _resetOllamaCircuitBreakerForTesting();
  });

  it("uses primary provider when it succeeds", async () => {
    const primaryVec = [0.1, 0.2];
    const fallbackVec = [0.9, 0.9];
    const primary = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 2 });
    vi.stubGlobal("fetch", mockOllamaFetch([primaryVec]));
    const fallback = { embed: vi.fn().mockResolvedValue(fallbackVec), embedBatch: vi.fn(), dimensions: 2, modelName: "fallback" };
    const wrapper = new FallbackEmbeddingProvider(primary, fallback as unknown as import("../services/embeddings.js").EmbeddingProvider);
    const result = await wrapper.embed("test");
    expect(result).toEqual(primaryVec);
    expect(fallback.embed).not.toHaveBeenCalled();
  });

  it("switches to fallback when primary fails", async () => {
    vi.stubGlobal("fetch", mockOllamaFetchFail("ECONNREFUSED"));
    const primary = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 2 });
    const fallbackVec = [0.5, 0.6];
    const fallback = { embed: vi.fn().mockResolvedValue(fallbackVec), embedBatch: vi.fn(), dimensions: 2, modelName: "fallback" };
    const onSwitch = vi.fn();
    const wrapper = new FallbackEmbeddingProvider(
      primary,
      fallback as unknown as import("../services/embeddings.js").EmbeddingProvider,
      onSwitch,
    );
    const result = await wrapper.embed("test");
    expect(result).toEqual(fallbackVec);
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it("stays on fallback after switching (no more attempts on primary)", async () => {
    vi.stubGlobal("fetch", mockOllamaFetchFail("ECONNREFUSED"));
    const primary = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 2 });
    const fallbackVec = [0.5, 0.6];
    const fallback = { embed: vi.fn().mockResolvedValue(fallbackVec), embedBatch: vi.fn(), dimensions: 2, modelName: "fallback" };
    const wrapper = new FallbackEmbeddingProvider(primary, fallback as unknown as import("../services/embeddings.js").EmbeddingProvider);
    await wrapper.embed("first");
    await wrapper.embed("second");
    expect(fallback.embed).toHaveBeenCalledTimes(2);
  });

  it("throws when primary fails and no fallback is configured", async () => {
    vi.stubGlobal("fetch", mockOllamaFetchFail("ECONNREFUSED"));
    const primary = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 2 });
    const wrapper = new FallbackEmbeddingProvider(primary, null);
    await expect(wrapper.embed("test")).rejects.toThrow();
  });

  it("exposes dimensions and modelName from the active provider", () => {
    const primary = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 768 });
    const fallback = { embed: vi.fn(), embedBatch: vi.fn(), dimensions: 768, modelName: "text-embedding-3-small" };
    const wrapper = new FallbackEmbeddingProvider(primary, fallback as unknown as import("../services/embeddings.js").EmbeddingProvider);
    expect(wrapper.dimensions).toBe(768);
    expect(wrapper.modelName).toBe("nomic-embed-text");
  });

  it("throws when primary and fallback dimensions differ", () => {
    const primary = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 768 });
    const fallback = { embed: vi.fn(), embedBatch: vi.fn(), dimensions: 1536, modelName: "text-embedding-3-small" };
    expect(
      () => new FallbackEmbeddingProvider(primary, fallback as unknown as import("../services/embeddings.js").EmbeddingProvider),
    ).toThrow(/must have matching dimensions/);
  });
});

// ---------------------------------------------------------------------------
// createEmbeddingProvider factory
// ---------------------------------------------------------------------------

describe("createEmbeddingProvider factory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset module-level circuit breaker state so tests don't bleed into each other
    _resetOllamaCircuitBreakerForTesting();
  });

  it("creates OllamaEmbeddingProvider for provider='ollama'", () => {
    const cfg: EmbeddingConfig = {
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      batchSize: 50,
    };
    const provider = createEmbeddingProvider(cfg);
    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(provider.dimensions).toBe(768);
    expect(provider.modelName).toBe("nomic-embed-text");
  });

  it("creates FallbackEmbeddingProvider when ollama + apiKey is set", () => {
    const cfg: EmbeddingConfig = {
      provider: "ollama",
      model: "nomic-embed-text",
      apiKey: "sk-test-1234567890",
      dimensions: 768,
      batchSize: 50,
    };
    const provider = createEmbeddingProvider(cfg);
    expect(provider).toBeInstanceOf(FallbackEmbeddingProvider);
  });

  it("creates Embeddings (OpenAI) for provider='openai'", () => {
    const cfg: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test-1234567890",
      dimensions: 1536,
      batchSize: 50,
    };
    const provider = createEmbeddingProvider(cfg);
    expect(provider).toBeInstanceOf(Embeddings);
    expect(provider.dimensions).toBe(1536);
    expect(provider.modelName).toBe("text-embedding-3-small");
  });

  it("uses models list for OpenAI when provided", () => {
    const cfg: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test-1234567890",
      models: ["text-embedding-3-small", "text-embedding-ada-002"],
      dimensions: 1536,
      batchSize: 50,
    };
    const provider = createEmbeddingProvider(cfg);
    expect(provider).toBeInstanceOf(Embeddings);
    expect(provider.modelName).toBe("text-embedding-3-small");
  });

  it("throws for provider='openai' without apiKey", () => {
    const cfg: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      batchSize: 50,
    };
    expect(() => createEmbeddingProvider(cfg)).toThrow(/apiKey/);
  });

  it("falls back to OpenAI when ONNX runtime is missing and apiKey is set", async () => {
    __setOnnxRuntimeLoaderForTests(async () => {
      throw new Error("onnxruntime-node not installed");
    });
    const openaiVec = [0.9, 0.8];
    const cfg: EmbeddingConfig = {
      provider: "onnx",
      model: "all-MiniLM-L6-v2",
      apiKey: "sk-test-1234567890",
      dimensions: 2,
      batchSize: 50,
    };
    const embedSpy = vi.spyOn(Embeddings.prototype, "embed").mockResolvedValue(openaiVec);
    const provider = createEmbeddingProvider(cfg);
    const result = await provider.embed("test");
    expect(result).toEqual(openaiVec);
    embedSpy.mockRestore();
  });

  it("throws for unknown provider", () => {
    const cfg = {
      provider: "unknown-provider",
      model: "some-model",
      dimensions: 512,
      batchSize: 50,
    } as unknown as EmbeddingConfig;
    expect(() => createEmbeddingProvider(cfg)).toThrow(/Unknown embedding provider/);
  });

  it("returns OllamaEmbeddingProvider without fallback when Ollama dimensions exceed OpenAI model limits", () => {
    const cfg: EmbeddingConfig = {
      provider: "ollama",
      model: "high-dim-model",
      apiKey: "sk-test-1234567890",
      dimensions: 4096, // exceeds text-embedding-3-large max of 3072
      batchSize: 50,
    };
    // Should not throw; should degrade gracefully to primary only
    const provider = createEmbeddingProvider(cfg);
    expect(provider).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(provider.dimensions).toBe(4096);
  });

  it("Ollama provider works end-to-end with mocked fetch", async () => {
    const vec = [0.1, 0.2, 0.3];
    vi.stubGlobal("fetch", mockOllamaFetch([vec]));
    const cfg: EmbeddingConfig = {
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 3,
      batchSize: 50,
    };
    const provider = createEmbeddingProvider(cfg);
    const result = await provider.embed("hello world");
    expect(result).toEqual(vec);
  });

  it("Ollama fallback to OpenAI when Ollama fails", async () => {
    vi.stubGlobal("fetch", mockOllamaFetchFail("ECONNREFUSED"));
    const openaiVec = [0.9, 0.8, 0.7];
    const cfg: EmbeddingConfig = {
      provider: "ollama",
      model: "nomic-embed-text",
      apiKey: "sk-test-1234567890",
      dimensions: 3,
      batchSize: 50,
    };
    // Spy on Embeddings.embed to return our vector
    const embedSpy = vi.spyOn(Embeddings.prototype, "embed").mockResolvedValue(openaiVec);
    const provider = createEmbeddingProvider(cfg);
    const result = await provider.embed("test");
    expect(result).toEqual(openaiVec);
    embedSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// OnnxEmbeddingProvider
// ---------------------------------------------------------------------------

describe("OnnxEmbeddingProvider", () => {
  it("creates embeddings with the expected dimensions (mocked runtime)", async () => {
    class FakeTensor {
      constructor(
        readonly type: string,
        readonly data: Float32Array | BigInt64Array,
        readonly dims: number[],
      ) {}
    }

    const fakeRuntime = {
      Tensor: FakeTensor,
      InferenceSession: {
        create: async () => ({
          inputNames: ["input_ids", "attention_mask", "token_type_ids"],
          run: async (feeds: Record<string, { dims: number[] }>) => {
            const batch = feeds.input_ids.dims[0];
            const dim = 3;
            const data = new Float32Array(batch * dim);
            for (let i = 0; i < batch; i++) {
              data[i * dim] = 1;
              data[i * dim + 1] = 2;
              data[i * dim + 2] = 3;
            }
            return { sentence_embedding: new FakeTensor("float32", data, [batch, dim]) };
          },
        }),
      },
    };

    __setOnnxRuntimeLoaderForTests(async () => fakeRuntime as unknown as typeof import("onnxruntime-node"));

    const tmp = await fs.mkdtemp(join(tmpdir(), "onnx-test-"));
    const modelPath = join(tmp, "model.onnx");
    const vocabPath = join(tmp, "vocab.txt");
    await fs.writeFile(modelPath, "");
    await fs.writeFile(vocabPath, ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "hello", "world"].join("\n"));

    const provider = new OnnxEmbeddingProvider({
      model: modelPath,
      modelPath,
      vocabPath,
      dimensions: 3,
      batchSize: 2,
    });
    const results = await provider.embedBatch(["hello world", "test"]);
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveLength(3);
    expect(results[1]).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Dimension handling
// ---------------------------------------------------------------------------

describe("Dimension mismatch detection via EmbeddingProvider.dimensions", () => {
  it("OllamaEmbeddingProvider reports configured dimensions", () => {
    const p = new OllamaEmbeddingProvider({ model: "nomic-embed-text", dimensions: 768 });
    expect(p.dimensions).toBe(768);
  });

  it("OllamaEmbeddingProvider reports custom dimensions", () => {
    const p = new OllamaEmbeddingProvider({ model: "custom-model", dimensions: 512 });
    expect(p.dimensions).toBe(512);
  });

  it("Embeddings (OpenAI) reports passed dimensions", () => {
    const client = makeMockOpenAI([]);
    const p = new Embeddings(client, "text-embedding-3-large", 3072);
    expect(p.dimensions).toBe(3072);
  });
});

// ---------------------------------------------------------------------------
// 403 country/region restriction suppression (#394)
// ---------------------------------------------------------------------------

describe("FallbackEmbeddingProvider — 403 suppression (#394)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOllamaCircuitBreakerForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetOllamaCircuitBreakerForTesting();
  });

  it("#394: does not report to GlitchTip when primary fails with 403 on embed", async () => {
    const err403 = Object.assign(
      new Error("403 Country, region, or territory not supported"),
      { status: 403 },
    );
    const primary = {
      embed: vi.fn().mockRejectedValue(err403),
      embedBatch: vi.fn(),
      dimensions: 768,
      modelName: "google/text-embedding-004",
    };
    const fallbackVec = [0.1, 0.2];
    const fallback = {
      embed: vi.fn().mockResolvedValue(fallbackVec),
      embedBatch: vi.fn(),
      dimensions: 768,
      modelName: "text-embedding-3-small",
    };
    const wrapper = new FallbackEmbeddingProvider(
      primary as unknown as import("../services/embeddings.js").EmbeddingProvider,
      fallback as unknown as import("../services/embeddings.js").EmbeddingProvider,
    );
    const result = await wrapper.embed("test");
    expect(result).toEqual(fallbackVec);
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });

  it("#394: does not report to GlitchTip when primary fails with 403 on embedBatch", async () => {
    const err403 = new Error("403 Country, region, or territory not supported");
    const primary = {
      embed: vi.fn().mockRejectedValue(err403),
      embedBatch: vi.fn().mockRejectedValue(err403),
      dimensions: 768,
      modelName: "google/text-embedding-004",
    };
    const fallbackVecs = [[0.1, 0.2]];
    const fallback = {
      embed: vi.fn(),
      embedBatch: vi.fn().mockResolvedValue(fallbackVecs),
      dimensions: 768,
      modelName: "text-embedding-3-small",
    };
    const wrapper = new FallbackEmbeddingProvider(
      primary as unknown as import("../services/embeddings.js").EmbeddingProvider,
      fallback as unknown as import("../services/embeddings.js").EmbeddingProvider,
    );
    const result = await wrapper.embedBatch(["test"]);
    expect(result).toEqual(fallbackVecs);
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });
});

describe("ChainEmbeddingProvider — 403 suppression (#394)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("#394: does not report to GlitchTip when a non-last provider fails with 403 on embed", async () => {
    const err403 = Object.assign(
      new Error("403 Country, region, or territory not supported"),
      { status: 403 },
    );
    const p1 = { embed: vi.fn().mockRejectedValue(err403), embedBatch: vi.fn(), dimensions: 768, modelName: "p1" };
    const p2 = { embed: vi.fn().mockResolvedValue([0.5, 0.6]), embedBatch: vi.fn(), dimensions: 768, modelName: "p2" };
    const chain = new ChainEmbeddingProvider(
      [p1, p2] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["provider1", "provider2"],
    );
    await chain.embed("test");
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });

  it("#394: does not report to GlitchTip when a non-last provider fails with 403 on embedBatch", async () => {
    const err403 = new Error("403 Country, region, or territory not supported");
    const p1 = { embed: vi.fn(), embedBatch: vi.fn().mockRejectedValue(err403), dimensions: 768, modelName: "p1" };
    const p2 = { embed: vi.fn(), embedBatch: vi.fn().mockResolvedValue([[0.5, 0.6]]), dimensions: 768, modelName: "p2" };
    const chain = new ChainEmbeddingProvider(
      [p1, p2] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["provider1", "provider2"],
    );
    await chain.embedBatch(["test"]);
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });
});

describe("safeEmbed — 403 suppression (#394)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("#394: does not report to GlitchTip when embed fails with 403", async () => {
    const err403 = Object.assign(
      new Error("403 Country, region, or territory not supported"),
      { status: 403 },
    );
    const provider = {
      embed: vi.fn().mockRejectedValue(err403),
      embedBatch: vi.fn(),
      dimensions: 768,
      modelName: "google/text-embedding-004",
    };
    const result = await safeEmbed(
      provider as unknown as import("../services/embeddings.js").EmbeddingProvider,
      "test",
    );
    expect(result).toBeNull();
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });
});

describe("Embeddings (OpenAI) — context-length truncation (#442)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("#442: truncates text > 32768 chars before calling the API", async () => {
    const vector = [0.1, 0.2, 0.3];
    const mockCreate = vi.fn().mockImplementation((params: { input: string }) => {
      return Promise.resolve({ data: [{ embedding: vector }] });
    });
    const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
    const provider = new Embeddings(client, "text-embedding-3-small", 3);

    const longText = "a".repeat(40000); // exceeds 32768 char limit
    await provider.embed(longText);

    const calledInput: string = mockCreate.mock.calls[0][0].input;
    expect(calledInput.length).toBeLessThanOrEqual(32768);
  });

  it("#442: does not truncate text within the limit", async () => {
    const vector = [0.1, 0.2, 0.3];
    const mockCreate = vi.fn().mockImplementation((params: { input: string }) => {
      return Promise.resolve({ data: [{ embedding: vector }] });
    });
    const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
    const provider = new Embeddings(client, "text-embedding-3-small", 3);

    const shortText = "hello world";
    await provider.embed(shortText);

    const calledInput: string = mockCreate.mock.calls[0][0].input;
    expect(calledInput).toBe(shortText);
  });

  it("#442: truncates batch items > 32768 chars in embedBatch", async () => {
    const vector = [0.1, 0.2, 0.3];
    const mockCreate = vi.fn().mockImplementation((params: { input: string[] }) => {
      return Promise.resolve({
        data: params.input.map((_, i) => ({ index: i, embedding: vector })),
      });
    });
    const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
    const provider = new Embeddings(client, "text-embedding-3-small", 3);

    const texts = ["a".repeat(40000), "short text"];
    await provider.embedBatch(texts);

    const calledBatch: string[] = mockCreate.mock.calls[0][0].input;
    expect(calledBatch[0].length).toBeLessThanOrEqual(32768);
    expect(calledBatch[1]).toBe("short text");
  });
});
// ---------------------------------------------------------------------------
// #385: Embedding fallback chain error handling
// ---------------------------------------------------------------------------

describe("#385: Embeddings 401 auth error does not report to GlitchTip", () => {
  it("embed() skips capturePluginError for 401 auth failure (direct .status field)", async () => {
    vi.useFakeTimers();
    try {
      const authError = Object.assign(
        new Error("401 Incorrect API key provided: AIzaSyDp..."),
        { status: 401 },
      );
      const mockCreate = vi.fn().mockRejectedValue(authError);
      const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
      const provider = new Embeddings(client, "text-embedding-005", 768);
      // Should throw but NOT call capturePluginError — 401 is a config issue
      await expect(provider.embed("test")).rejects.toThrow("401 Incorrect API key");
      // Must not retry on auth errors (withLLMRetry exits early on /\b401\b/i match)
      expect(mockCreate).toHaveBeenCalledTimes(1);
      // Must not report 401 to error monitoring
      expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("embed() skips capturePluginError for LLMRetryError with auth phrase in wrapper message", async () => {
    vi.useFakeTimers();
    try {
      // Construct a LLMRetryError whose wrapper message contains "401".
      // withLLMRetry exits early (message contains "401") so this tests message-based detection
      // on the wrapper error itself, not cause unwrapping (same path as the direct-status test above).
      const inner = new Error("Incorrect API key provided: AIzaSyDp...");
      const retryErr = new LLMRetryError(
        `Failed after 3 attempts: 401 Incorrect API key provided: AIzaSyDp...`,
        inner,
        3,
      );
      const mockCreate = vi.fn().mockRejectedValue(retryErr);
      const client = { embeddings: { create: mockCreate } } as unknown as import("openai").default;
      const provider = new Embeddings(client, "text-embedding-005", 768);
      await expect(provider.embed("test")).rejects.toBeInstanceOf(LLMRetryError);
      // withLLMRetry exits early (message contains "401") — exactly 1 attempt
      expect(mockCreate).toHaveBeenCalledTimes(1);
      // Must not report auth errors to error monitoring
      expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#385: safeEmbed suppresses capturePluginError for config-error-only chain failures", () => {
  it("returns null and does NOT report when all causes are config errors (404)", async () => {
    const configErr = Object.assign(
      new Error("404 models/text-embedding-004 is not found"),
      { status: 404 },
    );
    const p1 = { embed: vi.fn().mockRejectedValue(configErr), embedBatch: vi.fn(), dimensions: 768, modelName: "p1" };
    const chain = new ChainEmbeddingProvider(
      [p1] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["p1"],
    );
    const result = await safeEmbed(chain, "test");
    expect(result).toBeNull();
    // AllEmbeddingProvidersFailed with only config errors — must NOT call capturePluginError
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });

  it("returns null and does NOT report when all causes are config errors (401)", async () => {
    const authErr = Object.assign(new Error("401 Incorrect API key"), { status: 401 });
    const p1 = { embed: vi.fn().mockRejectedValue(authErr), embedBatch: vi.fn(), dimensions: 768, modelName: "p1" };
    const chain = new ChainEmbeddingProvider(
      [p1] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["p1"],
    );
    const logWarn = vi.fn();
    const result = await safeEmbed(chain, "test", logWarn);
    expect(result).toBeNull();
    expect(logWarn).toHaveBeenCalledOnce();
    // Config error — must NOT call capturePluginError
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });

  it("returns null and DOES report when causes include transient failures", async () => {
    // Transient error (not 404/401) — safeEmbed should still report so operators see it
    const p1 = { embed: vi.fn().mockRejectedValue(new Error("network timeout")), embedBatch: vi.fn(), dimensions: 768, modelName: "p1" };
    const chain = new ChainEmbeddingProvider(
      [p1] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["p1"],
    );
    const result = await safeEmbed(chain, "test");
    expect(result).toBeNull();
    // Transient failure — capturePluginError SHOULD be called
    expect(vi.mocked(capturePluginError)).toHaveBeenCalledOnce();
  });
});

describe("#385: ChainEmbeddingProvider does not report 404/401 config errors", () => {
  it("does not capturePluginError for 404 from non-last provider", async () => {
    const notFoundErr = Object.assign(
      new Error("404 models/text-embedding-004 is not found for API version v1beta"),
      { status: 404 },
    );
    const vec = [0.1, 0.2];
    const p1 = { embed: vi.fn().mockRejectedValue(notFoundErr), embedBatch: vi.fn(), dimensions: 2, modelName: "google" };
    const p2 = { embed: vi.fn().mockResolvedValue(vec), embedBatch: vi.fn(), dimensions: 2, modelName: "openai" };
    const chain = new ChainEmbeddingProvider(
      [p1, p2] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["google", "openai"],
    );
    const result = await chain.embed("test");
    expect(result).toEqual(vec);
    // 404 is a config error — must NOT trigger capturePluginError
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });

  it("does not capturePluginError for 401 from non-last provider", async () => {
    const authErr = Object.assign(
      new Error("401 Incorrect API key provided"),
      { status: 401 },
    );
    const vec = [0.5, 0.6];
    const p1 = { embed: vi.fn().mockRejectedValue(authErr), embedBatch: vi.fn(), dimensions: 2, modelName: "google" };
    const p2 = { embed: vi.fn().mockResolvedValue(vec), embedBatch: vi.fn(), dimensions: 2, modelName: "openai" };
    const chain = new ChainEmbeddingProvider(
      [p1, p2] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["google", "openai"],
    );
    const result = await chain.embed("test");
    expect(result).toEqual(vec);
    expect(p2.embed).toHaveBeenCalledOnce();
    // 401 is a config error — must NOT trigger capturePluginError
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });

  it("does not capturePluginError for 401 message-based (Ollama HTTP 401 Unauthorized)", async () => {
    const ollamaAuthErr = new Error("Ollama embed failed: HTTP 401 Unauthorized");
    const vec = [0.7, 0.8];
    const p1 = { embed: vi.fn().mockRejectedValue(ollamaAuthErr), embedBatch: vi.fn(), dimensions: 2, modelName: "ollama" };
    const p2 = { embed: vi.fn().mockResolvedValue(vec), embedBatch: vi.fn(), dimensions: 2, modelName: "openai" };
    const chain = new ChainEmbeddingProvider(
      [p1, p2] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["ollama", "openai"],
    );
    const result = await chain.embed("test");
    expect(result).toEqual(vec);
    expect(p2.embed).toHaveBeenCalledOnce();
    // Message-based 401 detection — must NOT trigger capturePluginError
    expect(vi.mocked(capturePluginError)).not.toHaveBeenCalled();
  });

  it("throws AllEmbeddingProvidersFailed when all providers exhaust", async () => {
    const p1 = { embed: vi.fn().mockRejectedValue(new Error("fail")), embedBatch: vi.fn(), dimensions: 2, modelName: "p1" };
    const p2 = { embed: vi.fn().mockRejectedValue(new Error("fail")), embedBatch: vi.fn(), dimensions: 2, modelName: "p2" };
    const chain = new ChainEmbeddingProvider(
      [p1, p2] as unknown as import("../services/embeddings.js").EmbeddingProvider[],
      ["p1", "p2"],
    );
    await expect(chain.embed("test")).rejects.toBeInstanceOf(AllEmbeddingProvidersFailed);
  });
});

describe("#385: createEmbeddingProvider uses text-embedding-005 as default Google model", () => {
  it("direct Google provider uses text-embedding-005 when no model specified", () => {
    const cfg: EmbeddingConfig = {
      provider: "google",
      model: "",
      googleApiKey: "AIzaSyTestKey1234567890",
      dimensions: 768,
      batchSize: 50,
    };
    const provider = createEmbeddingProvider(cfg);
    expect(provider).toBeInstanceOf(Embeddings);
    expect(provider.modelName).toBe("text-embedding-005");
  });

  it("direct Google provider respects explicitly set model", () => {
    const cfg: EmbeddingConfig = {
      provider: "google",
      model: "text-embedding-005",
      googleApiKey: "AIzaSyTestKey1234567890",
      dimensions: 768,
      batchSize: 50,
    };
    const provider = createEmbeddingProvider(cfg);
    expect(provider).toBeInstanceOf(Embeddings);
    expect(provider.modelName).toBe("text-embedding-005");
  });

  it("chain with Google uses text-embedding-005 by default", () => {
    const cfg: EmbeddingConfig = {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test-1234567890",
      googleApiKey: "AIzaSyTestKey1234567890",
      dimensions: 768,
      batchSize: 50,
      preferredProviders: ["openai", "google"],
    };
    const provider = createEmbeddingProvider(cfg);
    expect(provider).toBeInstanceOf(ChainEmbeddingProvider);
  });
});
