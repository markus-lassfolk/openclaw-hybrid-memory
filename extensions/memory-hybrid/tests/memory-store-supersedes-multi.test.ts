// @ts-nocheck — registerMemoryTools uses `ClawdbotPluginApi` from `openclaw`, not available in the
// test environment; consistent with the pattern in memory-tools-cross-scope-mutation.test.ts.
/**
 * Regression tests for #2139 (and its QA follow-up): memory_store's `supersedes` must accept a
 * single id OR an array of ids, applying each in-scope target, reporting blocked/unknown targets,
 * and never mislabeling a blocked target as a dedupe-merge or writing a phantom `supersedes_id`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";

const { FactsDB } = _testing;

function makeMockApi() {
  const tools = new Map();
  return {
    registerTool(opts) {
      tools.set(opts.name, { execute: opts.execute });
    },
    getTool(name) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session" },
  };
}

const makeMockVectorDb = () => ({
  hasDuplicate: vi.fn().mockResolvedValue(false),
  store: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(true),
  search: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  close: vi.fn(),
});

const makeMockEmbeddings = () => ({
  embed: vi.fn().mockResolvedValue(new Array(4).fill(0.1)),
  embedBatch: vi.fn().mockResolvedValue([]),
  dimensions: 4,
  modelName: "mock-model",
});

function makeCfg() {
  return {
    captureMaxChars: 2000,
    categories: ["fact", "preference", "decision"],
    store: { classifyBeforeWrite: false, fuzzyDedupe: false },
    multiAgent: { orchestratorId: "main", defaultStoreScope: "global", strictAgentScoping: false },
    graph: { enabled: false, autoLink: false, autoSupersede: false },
    graphRetrieval: { enabled: false },
    credentials: { enabled: false },
    autoRecall: { scopeFilter: null, summaryThreshold: 0, summaryMaxChars: 500 },
    distill: { reinforcementBoost: 0.1 },
    retrieval: { strategies: [], explicitBudgetTokens: 2000, contradictionLatencyWarnMs: 1000 },
    aliases: { enabled: false },
    procedures: { enabled: false },
    verbosity: "normal",
    clusters: null,
  };
}

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-store-supersedes-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function setupStoreTool() {
  const api = makeMockApi();
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
      currentAgentIdRef: { value: "main" }, // orchestrator → global scope
      pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
      aliasDb: null,
    },
    api as never,
    buildToolScopeFilter,
    async () => "wal-id",
    async () => {},
    async () => [],
  );
  return api.getTool("memory_store");
}

const globalFact = (text: string) =>
  factsDb.store({
    text,
    category: "fact",
    importance: 0.8,
    entity: null,
    key: null,
    value: null,
    source: "test",
    scope: "global",
    scopeTarget: null,
  });

describe("memory_store supersedes (#2139)", () => {
  it("rejects a malformed supersedes shape with a structured error, not a thrown exception", async () => {
    const store = setupStoreTool();
    const result = (await store.execute("c1", {
      text: "some new correction fact number one",
      supersedes: { not: "a string or array" },
    })) as { details?: { error?: string } };
    expect(result.details?.error).toBe("invalid_supersedes");
  });

  it("supersedes a single in-scope target and reports it", async () => {
    const store = setupStoreTool();
    const stale = globalFact("Doris gateway is 192.168.1.198 (stale)");
    const result = (await store.execute("c1", {
      text: "Doris gateway corrected to 10.0.0.5 current",
      supersedes: stale.id,
    })) as { details?: { action?: string; superseded?: string; supersededIds?: string[] } };
    expect(result.details?.action).toBe("updated");
    expect(result.details?.superseded).toBe(stale.id);
    expect(result.details?.supersededIds).toEqual([stale.id]);
    expect(factsDb.getById(stale.id)?.supersededAt ?? null).not.toBeNull();
  });

  it("accepts an ARRAY of supersedes ids and supersedes each in-scope target", async () => {
    const store = setupStoreTool();
    const a = globalFact("Doris stale fact A 192.168.1.198");
    const b = globalFact("Doris stale fact B 192.168.1.224");
    const result = (await store.execute("c1", {
      text: "Doris current runtime correction supersedes A and B",
      supersedes: [a.id, b.id],
    })) as { details?: { action?: string; supersededIds?: string[] } };
    expect(result.details?.action).toBe("updated");
    expect(new Set(result.details?.supersededIds)).toEqual(new Set([a.id, b.id]));
    expect(factsDb.getById(a.id)?.supersededAt ?? null).not.toBeNull();
    expect(factsDb.getById(b.id)?.supersededAt ?? null).not.toBeNull();
  });

  it("reports blocked targets on a partial multi-id supersede instead of silently dropping them", async () => {
    const store = setupStoreTool();
    const valid = globalFact("Doris stale valid target");
    const foreign = factsDb.store({
      text: "another agent's private fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "agent-2",
    });
    const result = (await store.execute("c1", {
      text: "Doris correction touching one valid and one out-of-scope target",
      supersedes: [valid.id, foreign.id],
    })) as { details?: { supersededIds?: string[]; supersedeBlocked?: string[] } };
    expect(result.details?.supersededIds).toEqual([valid.id]);
    expect(result.details?.supersedeBlocked).toEqual([foreign.id]);
    // The out-of-scope fact must be untouched.
    expect(factsDb.getById(foreign.id)?.supersededAt ?? null).toBeNull();
  });

  it("when ALL targets are blocked, reports a blocked reason (not a bogus dedupe-merge) and writes no phantom lineage", async () => {
    const store = setupStoreTool();
    const foreign = factsDb.store({
      text: "foreign fact only",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "agent-2",
    });
    const result = (await store.execute("c1", {
      text: "Doris correction whose only supersede target is out of scope",
      supersedes: foreign.id,
    })) as {
      details?: {
        action?: string;
        reason?: string;
        supersedeApplied?: boolean;
        supersedeBlocked?: string[];
        id?: string;
      };
    };
    // A new fact was created; the supersede was blocked — reason must reflect that, not dedupe-merge.
    expect(result.details?.action).toBe("created");
    expect(result.details?.supersedeApplied).toBe(false);
    expect(result.details?.reason).toBe("targets_blocked_or_not_found");
    expect(result.details?.supersedeBlocked).toEqual([foreign.id]);
    // The new fact must NOT persist a phantom supersedes_id pointing at the blocked foreign fact.
    const newFact = factsDb.getById(result.details!.id!);
    expect(newFact?.supersedesId ?? null).toBeNull();
    expect(factsDb.getById(foreign.id)?.supersededAt ?? null).toBeNull();
  });
});
