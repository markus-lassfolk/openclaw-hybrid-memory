// @ts-nocheck
/**
 * memory tool execute boundaries (query/id validation, not-found paths).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { buildEmbeddingRegistry } from "../services/embedding-registry.js";
import { registerMemoryTools } from "../tools/memory-tools.js";

vi.mock("../services/retrieval-orchestrator.js", () => ({
  buildExplicitSemanticQueryVector: vi.fn().mockResolvedValue({ queryVector: [0.1], warning: null }),
  runRetrievalPipeline: vi.fn().mockResolvedValue({ fused: [], packed: [], packedFactIds: [], entries: [] }),
  runExplicitDeepRetrieval: vi.fn().mockResolvedValue({ fused: [], packed: [], packedFactIds: [], entries: [] }),
}));

function makeMockApi() {
  const tools = new Map();
  return {
    registerTool(opts, _options) {
      tools.set(opts.name, { execute: opts.execute });
    },
    getTool(name) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session" },
  };
}

describe("memory tools execute boundaries", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-tools-boundaries-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory_recall returns guidance when query and id are both missing", async () => {
    const api = makeMockApi();
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      store: { classifyBeforeWrite: false },
    });
    const embeddings = {
      modelName: "text-embedding-3-small",
      dimensions: 4,
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
      embedBatch: vi.fn(),
    };
    registerMemoryTools(
      {
        factsDb,
        vectorDb: { search: vi.fn().mockResolvedValue([]), store: vi.fn(), hasDuplicate: vi.fn() },
        cfg,
        embeddings,
        embeddingRegistry: buildEmbeddingRegistry(embeddings, embeddings.modelName, []),
        openai: {},
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: null },
        pendingLLMWarnings: createPendingLLMWarnings(),
      },
      api,
      () => undefined,
      async () => "wal",
      async () => {},
      async () => [],
    );

    const result = await api.getTool("memory_recall").execute("tc", {});
    expect(result.content[0].text).toContain("Provide a search query or an id");
    expect(result.details.count).toBe(0);
  });

  it("memory_forget returns not_found when UUID does not exist", async () => {
    const api = makeMockApi();
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
      store: { classifyBeforeWrite: false },
    });
    const embeddings = {
      modelName: "text-embedding-3-small",
      dimensions: 4,
      embed: vi.fn(),
      embedBatch: vi.fn(),
    };
    registerMemoryTools(
      {
        factsDb,
        vectorDb: {
          delete: vi.fn().mockResolvedValue(false),
          search: vi.fn(),
          store: vi.fn(),
          hasDuplicate: vi.fn(),
        },
        cfg,
        embeddings,
        embeddingRegistry: buildEmbeddingRegistry(embeddings, embeddings.modelName, []),
        openai: {},
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: null },
        pendingLLMWarnings: createPendingLLMWarnings(),
      },
      api,
      () => undefined,
      async () => "wal",
      async () => {},
      async () => [],
    );

    const missingId = "00000000-0000-4000-8000-000000000001";
    const result = await api.getTool("memory_forget").execute("tc", { memoryId: missingId });
    expect(result.details.action).toBe("not_found");
    expect(result.content[0].text).toContain("not found");
  });
});
