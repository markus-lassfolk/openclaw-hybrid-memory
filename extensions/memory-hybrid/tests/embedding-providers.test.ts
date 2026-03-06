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
  createEmbeddingProvider,
  type EmbeddingConfig,
} from "../services/embeddings.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// FallbackEmbeddingProvider
// ---------------------------------------------------------------------------

describe("FallbackEmbeddingProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    const fallback = { embed: vi.fn(), embedBatch: vi.fn(), dimensions: 1536, modelName: "text-embedding-3-small" };
    const wrapper = new FallbackEmbeddingProvider(primary, fallback as unknown as import("../services/embeddings.js").EmbeddingProvider);
    expect(wrapper.dimensions).toBe(768);
    expect(wrapper.modelName).toBe("nomic-embed-text");
  });
});

// ---------------------------------------------------------------------------
// createEmbeddingProvider factory
// ---------------------------------------------------------------------------

describe("createEmbeddingProvider factory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("throws for provider='onnx' regardless of apiKey (data-privacy protection)", () => {
    const cfg: EmbeddingConfig = {
      provider: "onnx",
      model: "text-embedding-3-small",
      apiKey: "sk-test-1234567890",
      dimensions: 1536,
      batchSize: 50,
    };
    expect(() => createEmbeddingProvider(cfg)).toThrow(/ONNX/);
  });

  it("throws for provider='onnx' without apiKey", () => {
    const cfg: EmbeddingConfig = {
      provider: "onnx",
      model: "some-model",
      dimensions: 512,
      batchSize: 50,
    };
    expect(() => createEmbeddingProvider(cfg)).toThrow(/ONNX/);
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
