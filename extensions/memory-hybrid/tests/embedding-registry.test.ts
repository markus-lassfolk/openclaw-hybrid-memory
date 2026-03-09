/**
 * Tests for EmbeddingRegistry (Issue #158).
 *
 * All provider calls are mocked — no Ollama/OpenAI required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EmbeddingRegistry,
  buildEmbeddingRegistry,
} from "../services/embedding-registry.js";
import { hybridConfigSchema } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { EmbeddingModelConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockProvider(modelName: string, dims: number, vec?: number[]): EmbeddingProvider {
  const vector = vec ?? Array.from({ length: dims }, (_, i) => i / dims);
  return {
    modelName,
    dimensions: dims,
    embed: vi.fn().mockResolvedValue(vector),
    embedBatch: vi.fn().mockResolvedValue([vector]),
  };
}

function makeOllamaConfig(name: string, dims: number): EmbeddingModelConfig {
  return {
    name,
    provider: "ollama",
    dimensions: dims,
    role: "domain",
    endpoint: "http://localhost:11434",
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Registry construction
// ---------------------------------------------------------------------------

describe("EmbeddingRegistry — construction", () => {
  it("starts with no additional models", () => {
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    expect(registry.getModels()).toHaveLength(0);
    expect(registry.isMultiModel()).toBe(false);
  });

  it("getPrimaryModel returns primary info", () => {
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    const pm = registry.getPrimaryModel();
    expect(pm.name).toBe("text-embedding-3-small");
    expect(pm.dimensions).toBe(1536);
  });

  it("allModelNames includes primary when no extras", () => {
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    expect(registry.allModelNames()).toEqual(["text-embedding-3-small"]);
  });
});

// ---------------------------------------------------------------------------
// Registry registration
// ---------------------------------------------------------------------------

describe("EmbeddingRegistry — register()", () => {
  let primary: EmbeddingProvider;
  let registry: EmbeddingRegistry;

  beforeEach(() => {
    primary = makeMockProvider("text-embedding-3-small", 1536);
    registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
  });

  it("registers an additional model", () => {
    registry.register(makeOllamaConfig("nomic-embed-text", 768));
    expect(registry.getModels()).toHaveLength(1);
    expect(registry.getModels()[0].name).toBe("nomic-embed-text");
    expect(registry.isMultiModel()).toBe(true);
  });

  it("skips disabled models", () => {
    registry.register({ ...makeOllamaConfig("nomic-embed-text", 768), enabled: false });
    expect(registry.getModels()).toHaveLength(0);
    expect(registry.isMultiModel()).toBe(false);
  });

  it("skips model with same name as primary", () => {
    registry.register({ ...makeOllamaConfig("text-embedding-3-small", 1536) });
    expect(registry.getModels()).toHaveLength(0);
  });

  it("skips duplicate registrations", () => {
    registry.register(makeOllamaConfig("nomic-embed-text", 768));
    registry.register(makeOllamaConfig("nomic-embed-text", 768));
    expect(registry.getModels()).toHaveLength(1);
  });

  it("registers multiple distinct models", () => {
    registry.register(makeOllamaConfig("nomic-embed-text", 768));
    registry.register(makeOllamaConfig("mxbai-embed-large", 1024));
    expect(registry.getModels()).toHaveLength(2);
    expect(registry.allModelNames()).toEqual([
      "text-embedding-3-small",
      "nomic-embed-text",
      "mxbai-embed-large",
    ]);
  });
});

// ---------------------------------------------------------------------------
// embed() — routing
// ---------------------------------------------------------------------------

describe("EmbeddingRegistry — embed()", () => {
  it("routes to primary when no model name given", async () => {
    const primary = makeMockProvider("text-embedding-3-small", 4, [1, 2, 3, 4]);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    const result = await registry.embed("hello");
    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    expect(primary.embed).toHaveBeenCalledWith("hello");
  });

  it("routes to primary when primary name is passed", async () => {
    const primary = makeMockProvider("text-embedding-3-small", 4, [1, 2, 3, 4]);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    const result = await registry.embed("hello", "text-embedding-3-small");
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
  });

  it("throws for unknown model name", async () => {
    const primary = makeMockProvider("text-embedding-3-small", 4);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    await expect(registry.embed("hello", "nonexistent-model")).rejects.toThrow(
      "No embedding model registered with name 'nonexistent-model'",
    );
  });

  it("returns Float32Array (not number[])", async () => {
    const primary = makeMockProvider("text-embedding-3-small", 4, [0.1, 0.2, 0.3, 0.4]);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    const result = await registry.embed("test");
    expect(result).toBeInstanceOf(Float32Array);
  });
});

// ---------------------------------------------------------------------------
// embedAll()
// ---------------------------------------------------------------------------

describe("EmbeddingRegistry — embedAll()", () => {
  it("returns only primary when no additional models", async () => {
    const primary = makeMockProvider("text-embedding-3-small", 4, [1, 2, 3, 4]);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    const result = await registry.embedAll("test");
    expect(result.size).toBe(1);
    expect(result.has("text-embedding-3-small")).toBe(true);
    expect(Array.from(result.get("text-embedding-3-small")!)).toEqual([1, 2, 3, 4]);
  });

  it("returns embeddings from all models", async () => {
    const primary = makeMockProvider("text-embedding-3-small", 4, [1, 0, 0, 0]);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");

    // Mock fetch for Ollama
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0, 1, 0]] }),
      text: async () => "",
    } as Response);
    vi.stubGlobal("fetch", mockFetch);

    registry.register({ name: "nomic-embed-text", provider: "ollama", dimensions: 3, role: "domain" });

    const result = await registry.embedAll("test");
    expect(result.size).toBe(2);
    expect(result.has("text-embedding-3-small")).toBe(true);
    expect(result.has("nomic-embed-text")).toBe(true);

    vi.unstubAllGlobals();
  });

  it("returns Map with Float32Array values", async () => {
    const primary = makeMockProvider("text-embedding-3-small", 4, [1, 2, 3, 4]);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");
    const result = await registry.embedAll("test");
    for (const vec of result.values()) {
      expect(vec).toBeInstanceOf(Float32Array);
    }
  });

  it("returns partial results when an additional model fails (reports error, does not throw)", async () => {
    const primary = makeMockProvider("text-embedding-3-small", 4, [1, 0, 0, 0]);
    const registry = new EmbeddingRegistry(primary, "text-embedding-3-small");

    const mockFetch = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    registry.register({ name: "nomic-embed-text", provider: "ollama", dimensions: 3, role: "domain" });

    const result = await registry.embedAll("test");
    expect(result.size).toBe(1);
    expect(result.has("text-embedding-3-small")).toBe(true);
    expect(result.get("text-embedding-3-small")).toBeInstanceOf(Float32Array);

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// buildEmbeddingRegistry()
// ---------------------------------------------------------------------------

describe("buildEmbeddingRegistry()", () => {
  it("creates single-model registry when multiModels is empty", () => {
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const registry = buildEmbeddingRegistry(primary, "text-embedding-3-small", []);
    expect(registry.isMultiModel()).toBe(false);
    expect(registry.getModels()).toHaveLength(0);
  });

  it("creates single-model registry when multiModels is undefined", () => {
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const registry = buildEmbeddingRegistry(primary, "text-embedding-3-small");
    expect(registry.isMultiModel()).toBe(false);
  });

  it("registers models from multiModels config", () => {
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const multiModels: EmbeddingModelConfig[] = [
      { name: "nomic-embed-text", provider: "ollama", dimensions: 768, role: "domain" },
      { name: "mxbai-embed-large", provider: "ollama", dimensions: 1024, role: "general" },
    ];
    const registry = buildEmbeddingRegistry(primary, "text-embedding-3-small", multiModels);
    expect(registry.isMultiModel()).toBe(true);
    expect(registry.getModels()).toHaveLength(2);
  });

  it("builds a registry from parsed config multiModels", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: {
        apiKey: "sk-test-key-long-enough",
        model: "text-embedding-3-small",
        multiModels: [
          { name: "nomic-embed-text", provider: "ollama", dimensions: 768, role: "domain" },
        ],
      },
    });
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const registry = buildEmbeddingRegistry(primary, cfg.embedding.model, cfg.embedding.multiModels);
    expect(registry.isMultiModel()).toBe(true);
    expect(registry.getModels()).toHaveLength(1);
  });

  it("falls back to single-model when config has no multiModels", () => {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
    });
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const registry = buildEmbeddingRegistry(primary, cfg.embedding.model, cfg.embedding.multiModels);
    expect(registry.isMultiModel()).toBe(false);
  });

  it("skips disabled models from config", () => {
    const primary = makeMockProvider("text-embedding-3-small", 1536);
    const multiModels: EmbeddingModelConfig[] = [
      { name: "nomic-embed-text", provider: "ollama", dimensions: 768, role: "domain", enabled: false },
      { name: "mxbai-embed-large", provider: "ollama", dimensions: 1024, role: "general", enabled: true },
    ];
    const registry = buildEmbeddingRegistry(primary, "text-embedding-3-small", multiModels);
    expect(registry.getModels()).toHaveLength(1);
    expect(registry.getModels()[0].name).toBe("mxbai-embed-large");
  });
});
