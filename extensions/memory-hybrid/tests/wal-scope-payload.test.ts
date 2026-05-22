// @ts-nocheck — registerMemoryTools uses `ClawdbotPluginApi` from `openclaw` which is not
// available in the test environment; consistent with the pattern in memory-store-event-log.test.ts
/**
 * Regression tests for issue #1574: memory_store WAL replay can globalize scoped facts.
 *
 * Verifies that the WAL payload written by memory_store includes scope and scopeTarget
 * so that crash recovery can replay the entry with the correct scope.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { registerMemoryTools } from "../tools/memory-tools.js";

const { FactsDB, EventLog } = _testing;

// ---------------------------------------------------------------------------
// Helpers (reused from memory-store-event-log.test.ts pattern)
// ---------------------------------------------------------------------------

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session", agentId: "test-agent" },
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
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let eventLog: InstanceType<typeof EventLog>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wal-scope-payload-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  eventLog = new EventLog(join(tmpDir, "event-log.db"));
});

afterEach(() => {
  factsDb.close();
  eventLog.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_store WAL payload — scope fields (issue #1574)", () => {
  it("includes scope and scopeTarget in the WAL payload for explicit agent scope", async () => {
    const api = makeMockApi();
    const walWriteSpy = vi.fn().mockResolvedValue("wal-id");

    registerMemoryTools(
      {
        factsDb: factsDb as never,
        edictStore: null as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: "agent-1" },
        pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
        aliasDb: null,
      },
      api as never,
      (_params, _currentAgent, _cfg) => undefined,
      walWriteSpy,
      (_id, _logger) => undefined,
      async () => [],
    );

    const storeTool = api.getTool("memory_store");
    await storeTool?.execute("call-1", {
      text: "Agent-owned preference fact",
      importance: 0.7,
      scope: "agent",
      scopeTarget: "agent-1",
    });

    expect(walWriteSpy).toHaveBeenCalledOnce();
    const [operation, payload] = walWriteSpy.mock.calls[0];
    expect(operation).toBe("store");
    expect(payload.scope).toBe("agent");
    expect(payload.scopeTarget).toBe("agent-1");
  });

  it("includes scope and scopeTarget in the WAL payload for explicit user scope", async () => {
    const api = makeMockApi();
    const walWriteSpy = vi.fn().mockResolvedValue("wal-id");

    registerMemoryTools(
      {
        factsDb: factsDb as never,
        edictStore: null as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: "agent-1" },
        pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
        aliasDb: null,
      },
      api as never,
      (_params, _currentAgent, _cfg) => undefined,
      walWriteSpy,
      (_id, _logger) => undefined,
      async () => [],
    );

    const storeTool = api.getTool("memory_store");
    await storeTool?.execute("call-2", {
      text: "User-scoped preference fact",
      importance: 0.6,
      scope: "user",
      scopeTarget: "user-99",
    });

    expect(walWriteSpy).toHaveBeenCalledOnce();
    const [operation, payload] = walWriteSpy.mock.calls[0];
    expect(operation).toBe("store");
    expect(payload.scope).toBe("user");
    expect(payload.scopeTarget).toBe("user-99");
  });

  it("includes global scope in the WAL payload when no explicit scope is provided", async () => {
    const api = makeMockApi();
    const walWriteSpy = vi.fn().mockResolvedValue("wal-id");

    registerMemoryTools(
      {
        factsDb: factsDb as never,
        edictStore: null as never,
        vectorDb: makeMockVectorDb() as never,
        cfg: makeCfg() as never,
        embeddings: makeMockEmbeddings() as never,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: "main" },
        pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
        aliasDb: null,
      },
      api as never,
      (_params, _currentAgent, _cfg) => undefined,
      walWriteSpy,
      (_id, _logger) => undefined,
      async () => [],
    );

    const storeTool = api.getTool("memory_store");
    await storeTool?.execute("call-3", {
      text: "Global fact without explicit scope",
      importance: 0.5,
    });

    expect(walWriteSpy).toHaveBeenCalledOnce();
    const [operation, payload] = walWriteSpy.mock.calls[0];
    expect(operation).toBe("store");
    expect(payload.scope).toBe("global");
    expect(payload.scopeTarget).toBeNull();
  });
});
