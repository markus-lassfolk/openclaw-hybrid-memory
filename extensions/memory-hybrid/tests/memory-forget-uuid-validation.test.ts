/**
 * Tests for memory_forget UUID validation (issue #334).
 *
 * MiniMax M2.5 (and other LLMs) sometimes pass the memory text content as
 * the memoryId instead of the UUID, causing "Invalid UUID format" errors in
 * LanceDB. The fix validates the resolved ID is a proper UUID before deletion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { buildEmbeddingRegistry } from "../services/embedding-registry.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { hybridConfigSchema } from "../config.js";
import type { EmbeddingProvider } from "../services/embeddings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi() {
  const tools: Map<string, { opts: Record<string, unknown>; execute: (...args: unknown[]) => unknown }> = new Map();
  return {
    registerTool(opts: Record<string, unknown>, _options?: Record<string, unknown>) {
      tools.set(opts.name as string, { opts, execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session" },
  };
}

function makeCfg() {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
    store: { classifyBeforeWrite: false },
    graph: { enabled: false },
    queryExpansion: { enabled: false },
  });
}

function makeMockEmbeddings(): EmbeddingProvider {
  return {
    modelName: "text-embedding-3-small",
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
  };
}

function makeMockVectorDb(): VectorDB & { delete: ReturnType<typeof vi.fn> } {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn(),
  } as unknown as VectorDB & { delete: ReturnType<typeof vi.fn> };
}

const noopScopeFilter = () => undefined;
const walWrite = async () => "wal-id";
const walRemove = async () => {};
const findSimilarByEmbedding = async () => [];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-forget-uuid-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory_forget UUID validation (issue #334)", () => {
  function setupTool() {
    const api = makeMockApi();
    const embeddings = makeMockEmbeddings();
    const embeddingRegistry = buildEmbeddingRegistry(embeddings, embeddings.modelName, []);
    const cfg = makeCfg();
    const vectorDb = makeMockVectorDb();

    registerMemoryTools(
      {
        factsDb,
        vectorDb,
        cfg,
        embeddings,
        embeddingRegistry,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: null },
        pendingLLMWarnings: createPendingLLMWarnings(),
      },
      api as never,
      noopScopeFilter as never,
      walWrite,
      walRemove,
      findSimilarByEmbedding as never,
    );

    return { api, vectorDb };
  }

  it("returns invalid_id error when memoryId is memory text content (not a UUID)", async () => {
    const { api, vectorDb } = setupTool();
    const tool = api.getTool("memory_forget");
    expect(tool).toBeTruthy();

    // Simulate an LLM passing the memory text instead of its UUID
    const result = (await tool?.execute("tool-call", {
      memoryId: "MiniMax M2.5 limitations for council reviews (2026-02-22)",
    })) as { details?: { action?: string } };

    expect(result.details?.action).toBe("invalid_id");
    // vectorDb.delete must NOT be called with a non-UUID — this was the root cause
    expect(vectorDb.delete).not.toHaveBeenCalled();
  });

  it("returns invalid_id error when memoryId is a plain text phrase", async () => {
    const { api, vectorDb } = setupTool();
    const tool = api.getTool("memory_forget");

    const result = (await tool?.execute("tool-call", {
      memoryId: "user prefers dark mode",
    })) as { details?: { action?: string } };

    expect(result.details?.action).toBe("invalid_id");
    expect(vectorDb.delete).not.toHaveBeenCalled();
  });

  it("proceeds with deletion when memoryId is a valid UUID", async () => {
    const { api, vectorDb } = setupTool();
    const tool = api.getTool("memory_forget");

    // Store a real fact so SQLite delete can succeed
    const stored = factsDb.store({
      text: "Test memory entry",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const result = (await tool?.execute("tool-call", {
      memoryId: stored.id,
    })) as { details?: { action?: string } };

    // Should attempt deletion, not reject
    expect(result.details?.action).toBe("deleted");
    expect(vectorDb.delete).toHaveBeenCalledWith(stored.id);
  });

  it("returns invalid_id for a UUID-like string that fails validation (wrong version byte)", async () => {
    const { api, vectorDb } = setupTool();
    const tool = api.getTool("memory_forget");

    // Construct something that looks UUID-shaped but has invalid version (0 is not 1-5)
    const invalidUuid = "a1b2c3d4-e5f6-0000-abcd-ef1234567890";
    const result = (await tool?.execute("tool-call", {
      memoryId: invalidUuid,
    })) as { details?: { action?: string } };

    expect(result.details?.action).toBe("invalid_id");
    expect(vectorDb.delete).not.toHaveBeenCalled();
  });

  it("proceeds with short prefix that resolves to a valid UUID", async () => {
    const { api, vectorDb } = setupTool();
    const tool = api.getTool("memory_forget");

    // Store a fact and use a short prefix to reference it
    const stored = factsDb.store({
      text: "Short prefix test memory",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    // Use the first 8 chars of the UUID as a prefix (no dashes in first segment)
    const prefix = stored.id.slice(0, 8);
    const result = (await tool?.execute("tool-call", {
      memoryId: prefix,
    })) as { details?: { action?: string } };

    // Should resolve and delete, not reject as invalid_id
    expect(result.details?.action).toBe("deleted");
    expect(vectorDb.delete).toHaveBeenCalledWith(stored.id);
  });
});
