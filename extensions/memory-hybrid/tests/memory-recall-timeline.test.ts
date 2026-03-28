import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hybridConfigSchema } from "../config.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { FactsDB } from "../backends/facts-db.js";
import { EventLog } from "../backends/event-log.js";
import { NarrativesDB } from "../backends/narratives-db.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";

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
    context: { sessionId: "test-session" },
  };
}

function makeCfg(overrides: Record<string, unknown> = {}) {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
    store: { classifyBeforeWrite: false },
    graph: { enabled: false },
    queryExpansion: { enabled: false },
    ...overrides,
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

function makeMockVectorDb(): VectorDB {
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

describe("memory_recall_timeline tool", () => {
  let dir: string;
  let factsDb: FactsDB;
  let eventLog: EventLog;
  let narrativesDb: NarrativesDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-recall-timeline-"));
    factsDb = new FactsDB(join(dir, "facts.db"));
    eventLog = new EventLog(join(dir, "event-log.db"));
    narrativesDb = new NarrativesDB(join(dir, "narratives.db"));
  });

  afterEach(() => {
    factsDb.close();
    eventLog.close();
    narrativesDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns narrative summaries with chronological metadata", async () => {
    const api = makeMockApi();
    narrativesDb.store({
      sessionId: "s-timeline",
      periodStart: Math.floor(Date.parse("2026-03-22T10:00:00.000Z") / 1000),
      periodEnd: Math.floor(Date.parse("2026-03-22T10:30:00.000Z") / 1000),
      tag: "session",
      narrativeText: "Yesterday you tried queue compaction, hit a deadlock, and decided to retry with a lease fix.",
    });

    registerMemoryTools(
      {
        factsDb,
        vectorDb: makeMockVectorDb(),
        cfg: makeCfg(),
        embeddings: makeMockEmbeddings(),
        embeddingRegistry: null,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog,
        narrativesDb,
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

    const tool = api.getTool("memory_recall_timeline");
    expect(tool).toBeTruthy();

    const result = (await tool?.execute("tool-call", {
      query: "queue deadlock lease",
      limit: 1,
      days: 30,
    })) as {
      content?: { type: string; text: string }[];
      details?: {
        count: number;
        narratives: Array<{ sessionId: string; periodStart: string; periodEnd: string; text: string }>;
      };
    };

    expect(result.details?.count).toBe(1);
    expect(result.details?.narratives[0]?.sessionId).toBe("s-timeline");
    expect(result.details?.narratives[0]?.periodStart).toBe("2026-03-22T10:00:00.000Z");
    expect(result.content?.[0]?.text).toContain("queue compaction");
  });
});
