// @ts-nocheck
/**
 * Regression test (loop iteration 31): memory_record_episode derived `scope` directly from the
 * caller-supplied tool param, but computed `scopeTarget` from an unrelated, unconditional
 * session > user > agent priority chain over the resolved scopeFilter — completely ignoring the
 * caller's own explicit sessionId/userId/agentId params for that purpose, and falling through to
 * the public-API "unscoped" sentinel in the common single-agent default config. A caller declaring
 * `scope: "session", sessionId: "abc"` therefore got scope_target values unrelated to "abc",
 * making the episode permanently unfindable by any query actually scoped to that session (see
 * scopeFilterClausePositional, which only matches scope='session' rows against a real sessionId).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function makeMockEmbeddings(): EmbeddingProvider {
  return {
    modelName: "text-embedding-3-small",
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
  } as unknown as EmbeddingProvider;
}

function makeMockVectorDb() {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
  };
}

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "episode-scope-consistency-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function setupTools() {
  const api = makeMockApi();
  const cfg = hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
  });
  registerMemoryTools(
    {
      factsDb,
      vectorDb: makeMockVectorDb() as never,
      cfg,
      embeddings: makeMockEmbeddings(),
      openai: {} as never,
      wal: null,
      credentialsDb: null,
      eventLog: null,
      lastProgressiveIndexIds: [],
      currentAgentIdRef: { value: null },
      pendingLLMWarnings: createPendingLLMWarnings(),
    } as never,
    api as never,
    buildToolScopeFilter,
    async () => "wal-id",
    async () => {},
    async () => [],
  );
  return api;
}

describe("memory_record_episode scope/scopeTarget consistency (loop iteration 31 regression)", () => {
  it("stores scopeTarget matching the declared session scope, using the caller's own sessionId param", async () => {
    const api = setupTools();
    const recordEpisode = api.getTool("memory_record_episode");

    await recordEpisode?.execute("tc", {
      event: "deployed the service",
      outcome: "success",
      scope: "session",
      sessionId: "session-alpha",
    });

    const episodes = factsDb.searchEpisodes({});
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.scope).toBe("session");
    expect(episodes[0]?.scopeTarget).toBe("session-alpha");
  });

  it("stores scopeTarget matching the declared user scope, using the caller's own userId param", async () => {
    const api = setupTools();
    const recordEpisode = api.getTool("memory_record_episode");

    await recordEpisode?.execute("tc", {
      event: "reviewed the incident report",
      outcome: "success",
      scope: "user",
      userId: "user-bob",
    });

    const episodes = factsDb.searchEpisodes({});
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.scope).toBe("user");
    expect(episodes[0]?.scopeTarget).toBe("user-bob");
  });

  it("does not leak the public-API unscoped sentinel as a scopeTarget for agent scope with no agentId", async () => {
    const api = setupTools();
    const recordEpisode = api.getTool("memory_record_episode");

    await recordEpisode?.execute("tc", {
      event: "ran a scheduled maintenance job",
      outcome: "success",
      scope: "agent",
    });

    const episodes = factsDb.searchEpisodes({});
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.scopeTarget).not.toBe("__public_api_unscoped__");
  });
});
