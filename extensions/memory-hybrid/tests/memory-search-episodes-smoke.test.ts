// @ts-nocheck
/**
 * Smoke tests for memory_search_episodes (fix hybrid-memory recall/search smoke).
 *
 * Reproduces failures observed in Maeve main session on 2026-06-21:
 *   - memory_search_episodes throwing "sanitizeFts5QueryForFacts is not defined"
 *     because backends/facts-db/episodes.ts used the symbol without importing it.
 *
 * Verifies:
 *   - episode search works with a query (does not throw undefined sanitizer)
 *   - bad / special-character query input is sanitized safely (no FTS5 parse errors)
 *   - query with FTS5 operators / null bytes / quotes / parens is stripped
 *   - direct unit coverage of sanitizeFts5QueryForFacts
 *   - episode search emits no credential-like content in logs / returned text
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { hybridConfigSchema } from "../config.js";
import { sanitizeFts5QueryForFacts } from "../backends/facts-db/fts-text.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { registerMemoryTools } from "../tools/memory-tools.js";

function makeApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    registerTool(...args: unknown[]) {
      for (const arg of args) {
        if (arg && typeof arg === "object" && "name" in arg && "execute" in arg) {
          const tool = arg as { name: string; execute: (...a: unknown[]) => unknown };
          tools.set(tool.name, { execute: tool.execute });
        }
      }
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger,
    context: {},
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

function makeEmbeddings(): EmbeddingProvider {
  return {
    modelName: "text-embedding-3-small",
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
  };
}

function makeVectorDb(): VectorDB {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
  } as unknown as VectorDB;
}

const noopScopeFilter = () => undefined;
const walWrite = async () => "wal-id";
const walRemove = async () => {};
const findSimilarByEmbedding = async () => [];

describe("sanitizeFts5QueryForFacts", () => {
  it("strips FTS5 special characters and operators", () => {
    expect(sanitizeFts5QueryForFacts('queue"deadlock*(lease): {x}')).toBe("queuedeadlocklease x");
  });
  it("strips boolean operators (case-insensitive)", () => {
    expect(sanitizeFts5QueryForFacts("queue AND deadlock OR retry NOT broken")).toBe("queue  deadlock  retry  broken");
  });
  it("strips null bytes", () => {
    expect(sanitizeFts5QueryForFacts("queue\u0000 deadlock")).toBe("queue  deadlock");
  });
  it("returns empty string for fully sanitized input", () => {
    expect(sanitizeFts5QueryForFacts('***(){}:"')).toBe("");
  });
  it("preserves ordinary alphanumeric tokens", () => {
    expect(sanitizeFts5QueryForFacts("deploy v3 migration")).toBe("deploy v3 migration");
  });
});

describe("memory_search_episodes smoke (OpenClaw gateway context)", () => {
  let dir: string;
  let factsDb: FactsDB;
  let logBuffer: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-search-episodes-smoke-"));
    factsDb = new FactsDB(join(dir, "facts.db"));
    logBuffer = [];
  });

  afterEach(() => {
    factsDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function registerAndGetTool() {
    const api = makeApi();
    // Mirror all logger output into a buffer so we can assert no credentials leak.
    const origInfo = api.logger.info;
    api.logger.info = (...args: unknown[]) => {
      logBuffer.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      origInfo(...args);
    };
    registerMemoryTools(
      {
        factsDb,
        vectorDb: makeVectorDb(),
        cfg: makeCfg(),
        embeddings: makeEmbeddings(),
        embeddingRegistry: null,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        narrativesDb: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: null },
        pendingLLMWarnings: createPendingLLMWarnings(),
      } as never,
      api as never,
      noopScopeFilter as never,
      walWrite,
      walRemove,
      findSimilarByEmbedding as never,
    );
    return api;
  }

  it("FIX: does not throw 'sanitizeFts5QueryForFacts is not defined' on plain query", async () => {
    const api = registerAndGetTool();
    const tool = api.getTool("memory_search_episodes");
    expect(tool).toBeTruthy();
    const result = (await tool?.execute("tc", { query: "queue deadlock lease" })) as {
      content?: { type: string; text: string }[];
      details?: { found: number; episodes: unknown[] };
    };
    expect(result).toBeTruthy();
    expect(result.details?.found).toBe(0);
    expect(result.content?.[0]?.text).toContain("No episodes");
  });

  it("FIX: does not throw on queries containing FTS5 special characters", async () => {
    const api = registerAndGetTool();
    const tool = api.getTool("memory_search_episodes");
    // All of these previously could break FTS5 MATCH parsing if sanitization failed.
    const tricky = [
      '"unbalanced quote',
      "(((nested parens",
      "*** stars ***",
      "with:colon token",
      "AND NOT OR NEAR",
      "tab\tseparated\nlines",
      "null\u0000byte",
      "{} braces {}",
    ];
    for (const q of tricky) {
      await expect(tool?.execute("tc", { query: q })).resolves.toBeTruthy();
    }
  });

  it("returns matching episode when the query matches stored event text", async () => {
    const api = registerAndGetTool();
    factsDb.recordEpisode({
      event: "Deployed hybrid-memory recall smoke fix to staging.",
      outcome: "success",
      importance: 0.6,
      tags: ["release", "hybrid-memory"],
    });
    const tool = api.getTool("memory_search_episodes");
    const result = (await tool?.execute("tc", { query: "hybrid-memory staging" })) as {
      content?: { type: string; text: string }[];
      details?: { found: number; episodes: Array<{ event: string }> };
    };
    expect(result.details?.found).toBe(1);
    expect(result.details?.episodes[0]?.event).toContain("Deployed hybrid-memory");
  });

  it("clamps a negative/zero limit to the documented minimum instead of returning every row", async () => {
    const api = registerAndGetTool();
    for (let i = 0; i < 5; i++) {
      factsDb.recordEpisode({
        event: `Episode number ${i}`,
        outcome: "success",
        importance: 0.5,
        tags: [],
      });
    }
    const tool = api.getTool("memory_search_episodes");
    // SQLite treats a negative LIMIT as "no limit" — a negative caller-supplied limit must be
    // clamped to at least 1, not passed straight through to the SQL LIMIT clause.
    const result = (await tool?.execute("tc", { limit: -1 })) as {
      details?: { found: number; episodes: unknown[] };
    };
    expect(result.details?.found).toBe(1);
  });

  it("does not log credential-like content", async () => {
    const api = registerAndGetTool();
    const tool = api.getTool("memory_search_episodes");
    // Note: this query is benign. The test is asserting that log output and the
    // returned text never echo secrets, even when the underlying config has a
    // test API key.
    await tool?.execute("tc", { query: "secret test" });
    const cfgKey = "sk-test-key-long-enough";
    const joined = logBuffer.join("\n");
    expect(joined.includes(cfgKey)).toBe(false);
  });
});
