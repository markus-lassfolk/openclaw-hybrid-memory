/**
 * Integration tests for HybridMemoryContextEngine (Issue #273)
 *
 * Covers:
 *   - compact(): flushes WAL entries to FactsDB before compaction
 *   - prepareSubagentSpawn(): returns relevant parent memories as context injection
 *   - onSubagentEnded(): counts and logs facts captured from child sessions
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { HybridMemoryContextEngine, buildContextBlock } from "../services/context-engine.js";
import type { ContextEngineOptions } from "../services/context-engine.js";
import { estimateTokenCount } from "../services/retrieval-orchestrator.js";

const { FactsDB, WriteAheadLog } = _testing;

const DEFAULT_WAL_MAX_AGE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function makeEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])),
    model: "test-embed",
    dimensions: 3,
  };
}

function makeVectorDb() {
  return {
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function makeMinimalConfig(): ContextEngineOptions["cfg"] {
  return {
    autoRecall: { enabled: true, limit: 10, minScore: 0.6, maxTokens: 2000, debounceMs: 200 },
    embedding: { model: "test-embed", dimensions: 3 },
  } as unknown as ContextEngineOptions["cfg"];
}

function makeSubagentSpawnConfig(): ContextEngineOptions["cfg"] {
  return {
    ...makeMinimalConfig(),
    autoRecall: { enabled: false, limit: 10, minScore: 0.6, maxTokens: 2000, debounceMs: 200 },
    retrieval: { ambientBudgetTokens: 400 },
  } as unknown as ContextEngineOptions["cfg"];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let wal: InstanceType<typeof WriteAheadLog>;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ctx-engine-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  wal = new WriteAheadLog(join(tmpDir, "test.wal"), DEFAULT_WAL_MAX_AGE_MS);
  await wal.init();
});

afterEach(() => {
  try {
    factsDb.close();
  } catch {
    /* ignore */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEngine(overrides?: Partial<ContextEngineOptions>): HybridMemoryContextEngine {
  return new HybridMemoryContextEngine({
    factsDb,
    vectorDb: makeVectorDb() as never,
    wal,
    embeddings: makeEmbeddings() as never,
    cfg: makeMinimalConfig(),
    logger: makeLogger(),
    pluginVersion: "1.0.0-test",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Gap 1a: compact() flushes WAL entries
// ---------------------------------------------------------------------------

describe("HybridMemoryContextEngine.compact()", () => {
  it("replays WAL entries into FactsDB and returns ok:true", async () => {
    // Arrange: write 2 entries to WAL
    const id1 = randomUUID();
    const id2 = randomUUID();
    await wal.write({
      id: id1,
      timestamp: Date.now(),
      operation: "store",
      data: { text: "Compact fact A", category: "fact", importance: 0.8, source: "test" },
    });
    await wal.write({
      id: id2,
      timestamp: Date.now(),
      operation: "store",
      data: { text: "Compact fact B", category: "preference", importance: 0.7, source: "test" },
    });

    const engine = makeEngine();
    const before = factsDb.getCount();

    // Act
    const result = await engine.compact({
      sessionId: "test-session",
      sessionFile: "/tmp/session.json",
    });

    // Assert
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false); // we flush but don't own compaction

    // Both WAL entries should now be in FactsDB
    const after = factsDb.getCount();
    expect(after).toBe(before + 2);
  });

  it("returns ok:true even when WAL is empty", async () => {
    const engine = makeEngine();
    const result = await engine.compact({ sessionId: "empty-session", sessionFile: "/tmp/s.json" });
    expect(result.ok).toBe(true);
  });

  it("skips duplicate WAL entries (idempotent)", async () => {
    // Pre-store the fact in FactsDB
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Already stored fact",
      category: "fact",
      importance: 0.9,
      source: "test",
    });

    // Write same text to WAL
    await wal.write({
      id: randomUUID(),
      timestamp: Date.now(),
      operation: "store",
      data: { text: "Already stored fact", category: "fact", importance: 0.9, source: "test" },
    });

    const engine = makeEngine();
    const before = factsDb.getCount();
    const result = await engine.compact({ sessionId: "dup-session", sessionFile: "/tmp/s.json" });

    expect(result.ok).toBe(true);
    // Count should not increase — duplicate was skipped
    expect(factsDb.getCount()).toBe(before);
  });

  it("returns ok:true with null WAL (graceful no-op)", async () => {
    const engine = makeEngine({ wal: null });
    const result = await engine.compact({ sessionId: "null-wal-session", sessionFile: "/tmp/s.json" });
    expect(result.ok).toBe(true);
  });

  it("skips delete WAL entries without attempting deletion (issue #334)", async () => {
    // A delete WAL entry stores memory text in data.text, NOT a UUID.
    // Replaying it used to pass the text as a fact ID, causing "Invalid UUID format" errors.
    // The fix: skip delete entries during replay (same as update entries).
    const deleteEntryId = randomUUID();
    await wal.write({
      id: deleteEntryId,
      timestamp: Date.now(),
      operation: "delete",
      data: { text: "MiniMax M2.5 limitations for council reviews (2026-02-22)", source: "test" },
    });

    const before = factsDb.getCount();
    const engine = makeEngine();

    // Should not throw — delete entries are now skipped
    const result = await engine.compact({ sessionId: "delete-skip-session", sessionFile: "/tmp/s.json" });

    expect(result.ok).toBe(true);
    // No facts added — the delete entry was skipped, not replayed as a store
    expect(factsDb.getCount()).toBe(before);
    // The WAL entry should have been removed (no longer pending)
    expect(await wal.readAll()).toHaveLength(0);
  });

  it("includes top-fact summary in result when facts are present", async () => {
    // Store a few facts first
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Important context fact",
      category: "fact",
      importance: 0.9,
      source: "test",
    });
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "User preference detail",
      category: "preference",
      importance: 0.8,
      source: "test",
    });

    const engine = makeEngine({ cfg: makeSubagentSpawnConfig() });
    const result = await engine.compact({ sessionId: "summary-session", sessionFile: "/tmp/s.json" });

    expect(result.ok).toBe(true);
    const summary = result.result as { topFacts?: unknown[]; factCount?: number; memorySummary?: string } | undefined;
    expect(summary?.memorySummary).toBeDefined();
    expect(summary?.memorySummary).toContain("Important context fact");
    // The reason string should mention the flush
    expect(result.reason).toMatch(/flushed/i);
  });

  it("skips memorySummary when autoRecall is enabled (after_compaction hook owns injection)", async () => {
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Should not be summarized by ContextEngine compact",
      category: "fact",
      importance: 0.9,
      source: "test",
    });

    const engine = makeEngine();
    const result = await engine.compact({ sessionId: "no-summary-session", sessionFile: "/tmp/s.json" });
    const summary = result.result as { memorySummary?: string } | undefined;
    expect(summary?.memorySummary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap 1b: prepareSubagentSpawn() returns relevant parent context
// ---------------------------------------------------------------------------

describe("HybridMemoryContextEngine.prepareSubagentSpawn()", () => {
  // Regression: #2112 — a superseded engine can still receive spawn callbacks after teardown.
  it("no-ops without DB access when the FactsDB was permanently closed by teardown", async () => {
    const engine = makeEngine({ cfg: makeSubagentSpawnConfig() });
    factsDb.permanentClose();

    const prep = await engine.prepareSubagentSpawn?.({
      parentSessionKey: "parent-session",
      childSessionKey: "child-session-torn-down",
    });

    // Returns a well-formed no-op preparation (rollback present, no injected context).
    expect(prep).toBeDefined();
    const extended = prep as { contextAddition?: string; rollback: () => void };
    expect(extended.contextAddition).toBeUndefined();
    await expect(Promise.resolve(extended.rollback())).resolves.not.toThrow();
  });

  it("skips injection when autoRecall is enabled", async () => {
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Should not inject via ContextEngine",
      category: "fact",
      importance: 0.85,
      source: "parent",
    });

    const engine = makeEngine();
    const prep = await engine.prepareSubagentSpawn?.({
      parentSessionKey: "parent-session",
      childSessionKey: "child-session",
    });

    const extended = prep as { contextAddition?: string };
    expect(extended.contextAddition).toBeUndefined();
  });

  it("returns a SubagentSpawnPreparation with rollback when facts exist", async () => {
    // Seed some parent facts
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Parent session context memory",
      category: "fact",
      importance: 0.85,
      source: "parent",
    });
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "User preference: dark mode",
      category: "preference",
      importance: 0.7,
      source: "parent",
    });

    const engine = makeEngine({ cfg: makeSubagentSpawnConfig() });
    const prep = await engine.prepareSubagentSpawn?.({
      parentSessionKey: "parent-session-abc",
      childSessionKey: "child-session-xyz",
    });

    expect(prep).toBeDefined();
    expect(typeof prep?.rollback).toBe("function");

    // Extended field: contextAddition should contain the injected parent facts
    const extended = prep as { rollback: () => void; contextAddition?: string };
    expect(extended.contextAddition).toBeDefined();
    expect(extended.contextAddition).toContain("Parent session context memory");
    expect(extended.contextAddition).toContain("child-session-xyz");
  });

  it("only injects parent-session and global facts for subagents", async () => {
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Parent session scoped memory",
      category: "fact",
      importance: 0.85,
      source: "parent",
      scope: "session",
      scopeTarget: "parent-session-abc",
    });
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Global memory visible to all sessions",
      category: "fact",
      importance: 0.8,
      source: "parent",
      scope: "global",
    });
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Victim session secret must not leak",
      category: "fact",
      importance: 0.95,
      source: "victim",
      scope: "session",
      scopeTarget: "victim-session",
    });

    const engine = makeEngine({ cfg: makeSubagentSpawnConfig() });
    const prep = await engine.prepareSubagentSpawn?.({
      parentSessionKey: "parent-session-abc",
      childSessionKey: "child-session-xyz",
    });

    const extended = prep as { contextAddition?: string };
    expect(extended.contextAddition).toContain("Parent session scoped memory");
    expect(extended.contextAddition).toContain("Global memory visible to all sessions");
    expect(extended.contextAddition).not.toContain("Victim session secret must not leak");
  });

  it("returns rollback-only preparation when no facts in store", async () => {
    const engine = makeEngine({ cfg: makeSubagentSpawnConfig() });
    const prep = await engine.prepareSubagentSpawn?.({
      parentSessionKey: "empty-parent",
      childSessionKey: "empty-child",
    });

    // Should still return a valid preparation (not throw / not return undefined)
    expect(prep).toBeDefined();
    expect(typeof prep?.rollback).toBe("function");
  });

  it("rollback is a no-op (does not throw)", async () => {
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Some fact",
      category: "fact",
      importance: 0.8,
      source: "test",
    });

    const engine = makeEngine({ cfg: makeSubagentSpawnConfig() });
    const prep = await engine.prepareSubagentSpawn?.({
      parentSessionKey: "parent",
      childSessionKey: "child",
    });

    // Rollback should resolve cleanly
    await expect(prep?.rollback()).resolves.not.toThrow();
  });

  it("respects autoRecall.limit when fetching parent facts", async () => {
    // Store 20 facts
    for (let i = 0; i < 20; i++) {
      factsDb.store({
        entity: null,
        key: null,
        value: null,
        text: `Fact number ${i}`,
        category: "fact",
        importance: 0.7,
        source: "test",
      });
    }

    const cfgWithLimit = { ...makeSubagentSpawnConfig() };
    (cfgWithLimit.autoRecall as { enabled: boolean; limit: number }).limit = 5;

    const engine = makeEngine({ cfg: cfgWithLimit });
    const prep = await engine.prepareSubagentSpawn?.({ parentSessionKey: "p", childSessionKey: "c" });
    const extended = prep as { contextAddition?: string };

    // contextAddition should not contain all 20 facts (limited to min(5, 15))
    expect(extended.contextAddition).toBeDefined();
    const bulletCount = (extended.contextAddition?.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBeLessThanOrEqual(15);
  });

  it("does not mark facts as injected that were trimmed off by the token budget (loop iteration 65 regression)", async () => {
    // Store facts whose combined serialized size exceeds a tight token budget, so
    // buildContextBlock must trim some of them off the returned contextAddition.
    const stored = [];
    for (let i = 0; i < 10; i++) {
      const entry = factsDb.store({
        entity: null,
        key: null,
        value: null,
        text: `Fact number ${i} with some reasonably long padding content to consume more tokens than a tiny budget allows`,
        category: "fact",
        importance: 0.9,
        source: "parent",
      });
      stored.push(entry);
    }

    const injectedFactIdsBySession = new Map<string, Set<string>>();
    const cfg = {
      ...makeSubagentSpawnConfig(),
      retrieval: { ambientBudgetTokens: 200 },
    } as never;

    const engine = makeEngine({ cfg, injectedFactIdsBySession });
    const prep = await engine.prepareSubagentSpawn?.({
      parentSessionKey: "parent",
      childSessionKey: "child-trim-test",
    });

    const extended = prep as { contextAddition?: string };
    expect(extended.contextAddition).toBeDefined();

    const injectedSet = injectedFactIdsBySession.get("child-trim-test") ?? new Set<string>();
    expect(injectedSet.size).toBeGreaterThan(0);
    // A 90-token budget cannot fit all 10 facts — some must have been trimmed off.
    expect(injectedSet.size).toBeLessThan(stored.length);

    // A fact must be marked injected if and only if its text actually made it into
    // the returned block. Before the fix, ALL 10 facts were marked injected regardless
    // of the budget, permanently hiding the trimmed-off facts from this child session.
    for (const entry of stored) {
      const includedInBlock = extended.contextAddition!.includes(entry.text);
      expect(injectedSet.has(entry.id)).toBe(includedInBlock);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 1c: onSubagentEnded() processes child session facts
// ---------------------------------------------------------------------------

describe("HybridMemoryContextEngine.onSubagentEnded()", () => {
  it("logs fact count when child session has captured facts", async () => {
    const childSessionKey = `child-session-${randomUUID()}`;

    // Simulate facts captured by the child session
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Child session discovery A",
      category: "fact",
      importance: 0.8,
      source: childSessionKey,
    });
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Child session discovery B",
      category: "technical",
      importance: 0.75,
      source: childSessionKey,
    });

    const logger = makeLogger();
    const engine = makeEngine({ logger });

    await engine.onSubagentEnded?.({ childSessionKey, reason: "completed" });

    // Should have logged with info level (facts were found)
    const infoCalls = logger.info.mock.calls.map((c: unknown[]) => String(c[0]));
    const relevant = infoCalls.find((msg: string) => msg.includes(childSessionKey));
    expect(relevant).toBeDefined();
    expect(relevant).toContain("childFacts=2");
  });

  it("logs debug (not info) when child session has no captured facts", async () => {
    const childSessionKey = `child-no-facts-${randomUUID()}`;
    const logger = makeLogger();
    const engine = makeEngine({ logger });

    await engine.onSubagentEnded?.({ childSessionKey, reason: "completed" });

    // Should use debug level when no facts found
    const debugCalls = logger.debug.mock.calls.map((c: unknown[]) => String(c[0]));
    const relevant = debugCalls.find((msg: string) => msg.includes(childSessionKey));
    expect(relevant).toBeDefined();
    expect(relevant).toContain("childFacts=0");

    // Should NOT have called info for this case
    const infoCalls = logger.info.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoCalls.some((msg: string) => msg.includes(childSessionKey))).toBe(false);
  });

  it("does not throw on DB errors (non-fatal)", async () => {
    const brokenFactsDb = {
      countBySource: vi.fn().mockImplementation(() => {
        throw new Error("DB error");
      }),
      getCount: vi.fn().mockReturnValue(0),
      list: vi.fn().mockReturnValue([]),
      hasDuplicate: vi.fn().mockReturnValue(false),
    };

    const engine = makeEngine({ factsDb: brokenFactsDb as never });

    // Should not throw
    await expect(
      engine.onSubagentEnded?.({ childSessionKey: "broken-child", reason: "completed" }),
    ).resolves.not.toThrow();
  });

  it("handles different completion reasons without error", async () => {
    const engine = makeEngine();
    const reasons = ["completed", "timeout", "error", "cancelled"];

    for (const reason of reasons) {
      await expect(
        engine.onSubagentEnded?.({ childSessionKey: `child-${randomUUID()}`, reason }),
      ).resolves.not.toThrow();
    }
  });

  // Regression: #2112 — a subagent that started under a prior plugin generation can end after
  // the hybrid-memory runtime was torn down (reload/teardown permanentClose'd the FactsDB).
  // The stale engine must no-op cleanly instead of hitting a closed connection and warning.
  it("no-ops cleanly (no DB access, no warn) when the FactsDB was permanently closed by teardown", async () => {
    const childSessionKey = `child-torn-down-${randomUUID()}`;
    const logger = makeLogger();
    const engine = makeEngine({ logger });

    // Simulate runtime teardown: closeOldDatabases() calls permanentClose() on the store.
    factsDb.permanentClose();
    expect(factsDb.isPermanentlyClosed()).toBe(true);

    await expect(
      engine.onSubagentEnded?.({ childSessionKey, reason: "completed" }),
    ).resolves.not.toThrow();

    // No warning noise for a normal subagent completion during teardown.
    const warnCalls = logger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnCalls.some((msg: string) => msg.includes("onSubagentEnded failed"))).toBe(false);

    // A debug breadcrumb explaining the skip is expected.
    const debugCalls = logger.debug.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(debugCalls.some((msg: string) => msg.includes(childSessionKey) && /torn down|DB closed/i.test(msg))).toBe(
      true,
    );
  });

  it("treats a late 'connection is not open' error as the benign torn-down case (debug, not warn)", async () => {
    // The DB reports open at the guard check but throws mid-read (teardown races the callback).
    const racyFactsDb = {
      isPermanentlyClosed: vi.fn().mockReturnValue(false),
      countBySource: vi.fn().mockImplementation(() => {
        throw new Error("The database connection is not open");
      }),
    };
    const logger = makeLogger();
    const engine = makeEngine({ factsDb: racyFactsDb as never, logger });

    await expect(
      engine.onSubagentEnded?.({ childSessionKey: "racy-child", reason: "completed" }),
    ).resolves.not.toThrow();

    const warnCalls = logger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnCalls.some((msg: string) => msg.includes("onSubagentEnded failed"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 1d: engine.info shape
// ---------------------------------------------------------------------------

describe("HybridMemoryContextEngine.info", () => {
  it("has correct id and name", () => {
    const engine = makeEngine();
    expect(engine.info.id).toBe("hybrid-memory");
    expect(engine.info.name).toBe("OpenClaw Hybrid Memory");
    expect(engine.info.ownsCompaction).toBe(false);
  });

  it("records pluginVersion when provided", () => {
    const engine = makeEngine({ pluginVersion: "9.8.7" });
    expect(engine.info.version).toBe("9.8.7");
  });
});

// ---------------------------------------------------------------------------
// SDK #274: assemble() — budget-aware context injection
// ---------------------------------------------------------------------------

describe("HybridMemoryContextEngine.assemble()", () => {
  it("skips injection when autoRecall is enabled (before_agent_start owns recall)", async () => {
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Should not appear in assemble when autoRecall is on",
      category: "fact",
      importance: 0.9,
      source: "test",
    });
    const engine = makeEngine();
    const result = await engine.assemble({ sessionId: "s1", messages: [], tokenBudget: 2000 });
    expect(result.estimatedTokens).toBe(0);
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("returns messages unchanged and estimatedTokens=0 when store is empty", async () => {
    const engine = makeEngine({
      cfg: { ...makeMinimalConfig(), autoRecall: { ...makeMinimalConfig().autoRecall, enabled: false } } as never,
    });
    const messages = [{ role: "user", content: "hello" }];
    const result = await engine.assemble({ sessionId: "s1", messages, tokenBudget: 2000 });

    expect(result.messages).toBe(messages);
    expect(result.estimatedTokens).toBe(0);
    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("populates systemPromptAddition when facts are present", async () => {
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "User prefers TypeScript over JavaScript",
      category: "preference",
      importance: 0.9,
      source: "test",
    });

    const engine = makeEngine({
      cfg: { ...makeMinimalConfig(), autoRecall: { ...makeMinimalConfig().autoRecall, enabled: false } } as never,
    });
    const result = await engine.assemble({ sessionId: "s1", messages: [], tokenBudget: 2000 });

    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain("memory-hybrid: session-context");
    expect(result.systemPromptAddition).toContain("User prefers TypeScript over JavaScript");
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("only injects same-session and global facts from search and fallback list paths", async () => {
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Shared project codename alpha",
      category: "fact",
      importance: 0.7,
      source: "global",
      scope: "global",
    });
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Attacker session codename beta",
      category: "fact",
      importance: 0.8,
      source: "attacker",
      scope: "session",
      scopeTarget: "attacker-session",
    });
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Victim session codename gamma secret",
      category: "fact",
      importance: 0.95,
      source: "victim",
      scope: "session",
      scopeTarget: "victim-session",
    });

    const engine = makeEngine({
      cfg: { ...makeMinimalConfig(), autoRecall: { ...makeMinimalConfig().autoRecall, enabled: false } } as never,
    });

    const searchResult = await engine.assemble({
      sessionId: "attacker-session",
      messages: [{ role: "user", content: "codename gamma secret" }],
      tokenBudget: 2000,
    });
    expect(searchResult.systemPromptAddition).not.toContain("Victim session codename gamma secret");

    const fallbackResult = await engine.assemble({
      sessionId: "attacker-session",
      messages: [],
      tokenBudget: 2000,
    });
    expect(fallbackResult.systemPromptAddition).toContain("Shared project codename alpha");
    expect(fallbackResult.systemPromptAddition).toContain("Attacker session codename beta");
    expect(fallbackResult.systemPromptAddition).not.toContain("Victim session codename gamma secret");
  });

  it("skips facts already injected this turn for the session", async () => {
    const entry = factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Already injected preference",
      category: "preference",
      importance: 0.9,
      source: "test",
    });
    const injectedFactIdsBySession = new Map<string, Set<string>>([["s-dedup", new Set([entry.id])]]);
    const engine = makeEngine({
      injectedFactIdsBySession,
      cfg: { ...makeMinimalConfig(), autoRecall: { ...makeMinimalConfig().autoRecall, enabled: false } } as never,
    });

    const result = await engine.assemble({ sessionId: "s-dedup", messages: [], tokenBudget: 2000 });

    expect(result.systemPromptAddition).toBeUndefined();
    expect(result.estimatedTokens).toBe(0);
  });

  it("respects tokenBudget — truncates facts when budget is very small", async () => {
    // Store many facts
    for (let i = 0; i < 10; i++) {
      factsDb.store({
        entity: null,
        key: null,
        value: null,
        text: `Fact number ${i} with some reasonable amount of content to consume tokens`,
        category: "fact",
        importance: 0.7,
        source: "test",
      });
    }

    const cfgDisabled = {
      ...makeMinimalConfig(),
      autoRecall: { ...makeMinimalConfig().autoRecall, enabled: false },
    } as never;
    const engineFull = makeEngine({ cfg: cfgDisabled });
    const engineTight = makeEngine({ cfg: cfgDisabled });

    const resultFull = await engineFull.assemble({ sessionId: "s1", messages: [], tokenBudget: 10000 });
    // Budget arithmetic (char/4 estimate):
    //   base overhead (open/close markers + RECALLED_CONTEXT_BOUNDARY + label) ≈ 59 tokens
    //   one serialised fact entry ≈ 32 tokens → 1 fact total ≈ 91 tokens
    //   two facts total ≈ 123 tokens
    // Pick 95 so exactly one fact fits, regardless of which fact is returned first.
    const resultTight = await engineTight.assemble({ sessionId: "s1", messages: [], tokenBudget: 95 });

    // Full budget should include more content
    const fullLength = resultFull.systemPromptAddition?.length ?? 0;
    const tightLength = resultTight.systemPromptAddition?.length ?? 0;

    expect(resultFull.systemPromptAddition).toBeDefined();
    expect(resultTight.systemPromptAddition).toBeDefined();

    expect(fullLength).toBeGreaterThan(tightLength);

    // Check exact enforcement on tight
    const tightTokens = estimateTokenCount(resultTight.systemPromptAddition!);
    expect(tightTokens).toBeLessThanOrEqual(95);

    // Verify truncation: the tight result must contain fewer facts than the full result.
    const fullFactCount = (resultFull.systemPromptAddition?.match(/Fact number \d/g) ?? []).length;
    const tightFactCount = (resultTight.systemPromptAddition?.match(/Fact number \d/g) ?? []).length;
    expect(fullFactCount).toBe(10);
    expect(tightFactCount).toBeGreaterThan(0);
    expect(tightFactCount).toBeLessThan(fullFactCount);
  });

  it("uses cfg.autoRecall.maxTokens as default budget when tokenBudget is omitted", async () => {
    factsDb.store({
      entity: null,
      key: null,
      value: null,
      text: "Default budget fact",
      category: "fact",
      importance: 0.8,
      source: "test",
    });

    const engine = makeEngine({
      cfg: { ...makeMinimalConfig(), autoRecall: { ...makeMinimalConfig().autoRecall, enabled: false } } as never,
    });
    // No tokenBudget → falls back to cfg.autoRecall.maxTokens (2000 in test config)
    const result = await engine.assemble({ sessionId: "s1", messages: [] });

    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain("Default budget fact");
  });

  it("does not throw on FactsDB error (non-fatal)", async () => {
    const brokenFactsDb = {
      list: vi.fn().mockImplementation(() => {
        throw new Error("DB read error");
      }),
      getCount: vi.fn().mockReturnValue(0),
    };

    const engine = makeEngine({
      factsDb: brokenFactsDb as never,
      cfg: { ...makeMinimalConfig(), autoRecall: { ...makeMinimalConfig().autoRecall, enabled: false } } as never,
    });
    const result = await engine.assemble({ sessionId: "s1", messages: [], tokenBudget: 2000 });

    expect(result.estimatedTokens).toBe(0);
    expect(result.systemPromptAddition).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildContextBlock helper
// ---------------------------------------------------------------------------

describe("buildContextBlock()", () => {
  it("returns null for empty facts list", () => {
    expect(buildContextBlock([], "test", "Label:")).toBeNull();
  });

  it("wraps facts with HTML comment markers", () => {
    const fakeEntry = {
      id: "1",
      text: "Some fact",
      category: "fact" as const,
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      createdAt: 0,
      decayClass: "normal" as const,
      expiresAt: null,
      lastConfirmedAt: 0,
      confidence: 0.9,
    };

    const block = buildContextBlock([fakeEntry], "my-header", "My label:");
    expect(block).not.toBeNull();
    expect(block).toContain("<!-- memory-hybrid: my-header -->");
    expect(block).toContain("<!-- /memory-hybrid: my-header -->");
    expect(block).toContain("My label:");
    expect(block).toContain("Some fact");
  });

  it("respects tokenBudget by omitting entries that would exceed it", () => {
    const makeEntry = (text: string) => ({
      id: randomUUID(),
      text,
      category: "fact" as const,
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      createdAt: 0,
      decayClass: "normal" as const,
      expiresAt: null,
      lastConfirmedAt: 0,
      confidence: 0.9,
    });

    const facts = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`Fact ${i}: This is a longer fact to consume more tokens in the budget.`),
    );

    const blockFull = buildContextBlock(facts, "h", "Label:", 100000);
    const blockSmall = buildContextBlock(facts, "h", "Label:", 100);

    expect(blockFull).not.toBeNull();
    expect(blockSmall).not.toBeNull();
    if (blockFull === null || blockSmall === null) {
      throw new Error("Expected context blocks to be generated");
    }

    const smallTokens = estimateTokenCount(blockSmall);
    expect(smallTokens).toBeLessThanOrEqual(100);

    // Ensure blockSmall has fewer entries
    expect(blockSmall?.length ?? 0).toBeLessThan(blockFull?.length ?? 0);
    expect(blockFull).toContain("Fact 19");
    expect(blockSmall).not.toContain("Fact 19");

    // Very tight budget should return null because overhead doesn't fit
    const blockTiny = buildContextBlock(facts, "h", "Label:", 5);
    expect(blockTiny).toBeNull();
  });

  it("uses serializeFactForContext format (includes category header)", () => {
    const entry = {
      id: "1",
      text: "Fact text here",
      category: "technical" as const,
      importance: 0.7,
      entity: "MyEntity",
      key: null,
      value: null,
      source: "test",
      createdAt: 0,
      decayClass: "normal" as const,
      expiresAt: null,
      lastConfirmedAt: 0,
      confidence: 0.85,
    };

    const block = buildContextBlock([entry], "header", "Label:");
    // serializeFactForContext includes entity and category in a header line
    expect(block).toContain("entity: MyEntity");
    expect(block).toContain("category: technical");
    expect(block).toContain("Fact text here");
  });
});
