// @ts-nocheck
/**
 * Tests that memory_store performs early input validation (Issue #1575).
 *
 * Validates that empty/whitespace text and out-of-range importance values
 * return structured errors BEFORE any side effects (WAL write, embedding
 * generation, or FactsDB insert).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { registerMemoryTools } from "../tools/memory-tools.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>, _options?: unknown) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session-early-val", agentId: "test-agent" },
  };
}

function makeMockVectorDb() {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  };
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: 384,
    modelName: "mock-model",
  };
}

function makeCfg() {
  return {
    captureMaxChars: 2000,
    categories: ["fact", "preference", "decision"],
    store: { classifyBeforeWrite: false },
    multiAgent: {
      orchestratorId: "main",
      defaultStoreScope: "global",
      strictAgentScoping: false,
    },
    graph: {
      enabled: false,
      autoLink: false,
      autoLinkLimit: 5,
      autoLinkMinScore: 0.5,
      useInRecall: false,
      maxTraversalDepth: 2,
      coOccurrenceWeight: 0.5,
      autoSupersede: false,
    },
    graphRetrieval: { enabled: false, defaultExpand: false, maxExpandDepth: 3, maxExpandedResults: 20 },
    credentials: { enabled: false },
    autoRecall: { scopeFilter: null, summaryThreshold: 0, summaryMaxChars: 500 },
    distill: { reinforcementBoost: 0.1 },
    retrieval: { strategies: [], explicitBudgetTokens: 2000 },
    aliases: { enabled: false },
    procedures: { enabled: false },
    clusters: null,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-store-early-val-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function setupTool(walWriteMock: ReturnType<typeof vi.fn>, embeddings: ReturnType<typeof makeMockEmbeddings>) {
  const api = makeMockApi();
  const vectorDb = makeMockVectorDb();
  const cfg = makeCfg();

  registerMemoryTools(
    {
      factsDb: factsDb as never,
      edictStore: null as any,
      vectorDb: vectorDb as never,
      cfg: cfg as never,
      embeddings: embeddings as never,
      openai: {} as never,
      wal: null,
      credentialsDb: null,
      eventLog: null,
      lastProgressiveIndexIds: [],
      currentAgentIdRef: { value: "test-agent" },
      pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
      aliasDb: null,
    },
    api as never,
    (_params, _currentAgent, _cfg) => undefined,
    walWriteMock,
    (_id, _logger) => undefined,
    async (_vdb, _fdb, _vec, _limit) => [],
  );

  return { api, vectorDb };
}

// ---------------------------------------------------------------------------
// Tests: invalid text
// ---------------------------------------------------------------------------

describe("memory_store early validation — invalid text", () => {
  it("returns invalid_text error for empty string without writing WAL", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-empty", { text: "", importance: 0.5 })) as {
      details: { error: string };
    };

    expect(result.details.error).toBe("invalid_text");
    expect(walWrite).not.toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("returns invalid_text error for whitespace-only string without writing WAL", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-ws", { text: "   \t\n  ", importance: 0.5 })) as {
      details: { error: string };
    };

    expect(result.details.error).toBe("invalid_text");
    expect(walWrite).not.toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("does not insert into FactsDB for empty text", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    await storeTool?.execute("call-empty-db", { text: "", importance: 0.5 });

    // FactsDB should have no records
    const all = factsDb.getAll();
    expect(all).toHaveLength(0);
  });

  it("returns invalid_text error for whitespace-only string exceeding captureMaxChars", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    // Create a whitespace-only string longer than captureMaxChars (2000)
    const longWhitespace = " ".repeat(2001);
    const result = (await storeTool?.execute("call-ws-long", { text: longWhitespace, importance: 0.5 })) as {
      details: { error: string };
    };

    expect(result.details.error).toBe("invalid_text");
    expect(walWrite).not.toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: invalid importance
// ---------------------------------------------------------------------------

describe("memory_store early validation — invalid importance", () => {
  it("returns invalid_importance for importance > 1 without writing WAL", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-imp-hi", {
      text: "Valid text",
      importance: 1.5,
    })) as { details: { error: string } };

    expect(result.details.error).toBe("invalid_importance");
    expect(walWrite).not.toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("returns invalid_importance for negative importance without writing WAL", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-imp-neg", {
      text: "Valid text",
      importance: -0.1,
    })) as { details: { error: string } };

    expect(result.details.error).toBe("invalid_importance");
    expect(walWrite).not.toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("returns invalid_importance for NaN importance without writing WAL", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-imp-nan", {
      text: "Valid text",
      importance: NaN,
    })) as { details: { error: string } };

    expect(result.details.error).toBe("invalid_importance");
    expect(walWrite).not.toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("returns invalid_importance for Infinity importance without writing WAL", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-imp-inf", {
      text: "Valid text",
      importance: Infinity,
    })) as { details: { error: string } };

    expect(result.details.error).toBe("invalid_importance");
    expect(walWrite).not.toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("does not insert into FactsDB for invalid importance", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    await storeTool?.execute("call-imp-db", { text: "Valid text", importance: 2 });

    const all = factsDb.getAll();
    expect(all).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: boundary / valid values still work
// ---------------------------------------------------------------------------

describe("memory_store early validation — valid inputs still stored", () => {
  it("stores fact with importance exactly 0", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-imp-0", {
      text: "Valid text boundary zero",
      importance: 0,
    })) as { details: { error?: string } };

    expect(result.details.error).toBeUndefined();
    expect(walWrite).toHaveBeenCalled();
  });

  it("stores fact with importance exactly 1", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-imp-1", {
      text: "Valid text boundary one",
      importance: 1,
    })) as { details: { error?: string } };

    expect(result.details.error).toBeUndefined();
    expect(walWrite).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: invalid decayFreezeUntil
// ---------------------------------------------------------------------------

describe("memory_store early validation — invalid decayFreezeUntil", () => {
  it("returns invalid_decay_freeze_until for NaN value without writing WAL", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-dfu-nan", {
      text: "Valid text",
      importance: 0.5,
      decayFreezeUntil: NaN,
    })) as { details: { error: string } };

    expect(result.details.error).toBe("invalid_decay_freeze_until");
    expect(walWrite).not.toHaveBeenCalled();
  });

  it("returns invalid_decay_freeze_until for negative value without writing WAL", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-dfu-neg", {
      text: "Valid text",
      importance: 0.5,
      decayFreezeUntil: -1,
    })) as { details: { error: string } };

    expect(result.details.error).toBe("invalid_decay_freeze_until");
    expect(walWrite).not.toHaveBeenCalled();
  });

  it("accepts valid positive decayFreezeUntil without error", async () => {
    const walWrite = vi.fn().mockResolvedValue("wal-id");
    const embeddings = makeMockEmbeddings();
    const { api } = setupTool(walWrite, embeddings);

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-dfu-valid", {
      text: "Valid text with freeze",
      importance: 0.5,
      decayFreezeUntil: Math.floor(Date.now() / 1000) + 86400,
    })) as { details: { error?: string } };

    expect(result.details.error).toBeUndefined();
    expect(walWrite).toHaveBeenCalled();
  });
});
