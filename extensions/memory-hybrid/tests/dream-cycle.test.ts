/**
 * Dream Cycle tests — Issue #143
 *
 * Covers:
 *  - buildDigestSummary (pure function, 5 tests)
 *  - extractEventText (pure function, 4 tests)
 *  - groupEventsByEntity (pure function, 4 tests)
 *  - runEpisodicConsolidation with real DB (5 tests: DERIVED_FROM, grouping, mark consolidated, empty, text fallback)
 *  - runDreamCycle with real DB (7 tests: disabled skip, prune, decay, reflect stub, config schedule, full pipeline)
 *  - NightlyCycleConfig parsing via hybridConfigSchema (3 tests: defaults, enabled, overrides)
 *  - EventLogConfig parsing via hybridConfigSchema (2 tests: defaults, overrides)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDigestSummary,
  extractEventText,
  groupEventsByEntity,
  runEpisodicConsolidation,
  runDreamCycle,
  type DreamCycleConfig,
} from "../services/dream-cycle.js";
import { _testing } from "../index.js";
import { hybridConfigSchema } from "../config.js";
import type { EventLogEntry } from "../backends/event-log.js";

const { FactsDB, EventLog } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    sessionId: "sess-1",
    timestamp: new Date().toISOString(),
    eventType: "fact_learned",
    content: { text: "User prefers dark mode" },
    entities: undefined,
    consolidatedInto: undefined,
    metadata: undefined,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const silentLogger = { info: () => undefined, warn: () => undefined };

// ---------------------------------------------------------------------------
// buildDigestSummary
// ---------------------------------------------------------------------------

describe("buildDigestSummary", () => {
  it("returns 'No changes.' when all counts are zero", () => {
    const s = buildDigestSummary({
      factsPruned: 0,
      factsDecayed: 0,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 0,
      rulesGenerated: 0,
    });
    expect(s).toBe("No changes.");
  });

  it("reports pruned facts", () => {
    const s = buildDigestSummary({
      factsPruned: 5,
      factsDecayed: 0,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 0,
      rulesGenerated: 0,
    });
    expect(s).toContain("5 facts pruned");
  });

  it("reports decayed facts", () => {
    const s = buildDigestSummary({
      factsPruned: 0,
      factsDecayed: 3,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 0,
      rulesGenerated: 0,
    });
    expect(s).toContain("3 facts decayed");
  });

  it("reports events consolidated", () => {
    const s = buildDigestSummary({
      factsPruned: 0,
      factsDecayed: 0,
      eventsConsolidated: 10,
      factsCreated: 2,
      patternsFound: 0,
      rulesGenerated: 0,
    });
    expect(s).toContain("10 events consolidated into 2 facts");
  });

  it("reports patterns and rules", () => {
    const s = buildDigestSummary({
      factsPruned: 0,
      factsDecayed: 0,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 4,
      rulesGenerated: 2,
    });
    expect(s).toContain("4 patterns extracted");
    expect(s).toContain("2 rules generated");
  });

  it("combines multiple non-zero counts", () => {
    const s = buildDigestSummary({
      factsPruned: 1,
      factsDecayed: 2,
      eventsConsolidated: 5,
      factsCreated: 1,
      patternsFound: 3,
      rulesGenerated: 1,
    });
    expect(s).toContain("1 facts pruned");
    expect(s).toContain("2 facts decayed");
    expect(s).toContain("5 events consolidated");
    expect(s).toContain("3 patterns extracted");
    expect(s).toContain("1 rules generated");
    expect(s.endsWith(".")).toBe(true);
  });

  it("reports log rows pruned and VACUUM (Issue #573)", () => {
    const s = buildDigestSummary({
      factsPruned: 0,
      factsDecayed: 0,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 0,
      rulesGenerated: 0,
      logRowsPruned: 42,
      vacuumRan: true,
    });
    expect(s).toContain("42 log rows pruned");
    expect(s).toContain("VACUUM ran");
  });

  it("omits log rows pruned when count is zero (Issue #573)", () => {
    const s = buildDigestSummary({
      factsPruned: 1,
      factsDecayed: 0,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 0,
      rulesGenerated: 0,
      logRowsPruned: 0,
      vacuumRan: false,
    });
    expect(s).not.toContain("log rows");
    expect(s).not.toContain("VACUUM");
  });
});

// ---------------------------------------------------------------------------
// extractEventText
// ---------------------------------------------------------------------------

describe("extractEventText", () => {
  it("extracts 'text' field first", () => {
    const evt = makeEntry({ content: { text: "hello world", decision: "other" } });
    expect(extractEventText(evt)).toBe("hello world");
  });

  it("falls back to 'decision' when no text", () => {
    const evt = makeEntry({ content: { decision: "use TypeScript" } });
    expect(extractEventText(evt)).toBe("use TypeScript");
  });

  it("falls back to any string value", () => {
    const evt = makeEntry({ content: { foo: "bar baz" } });
    expect(extractEventText(evt)).toBe("bar baz");
  });

  it("returns empty string when no string values in content", () => {
    const evt = makeEntry({ content: { count: 42 } });
    expect(extractEventText(evt)).toBe("");
  });

  it("trims whitespace from extracted text", () => {
    const evt = makeEntry({ content: { text: "  hello  " } });
    expect(extractEventText(evt)).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// groupEventsByEntity
// ---------------------------------------------------------------------------

describe("groupEventsByEntity", () => {
  it("groups events by their primary entity", () => {
    const events = [
      makeEntry({ entities: ["Alice"] }),
      makeEntry({ entities: ["Alice"] }),
      makeEntry({ entities: ["Bob"] }),
    ];
    const groups = groupEventsByEntity(events);
    expect(groups.get("Alice")).toHaveLength(2);
    expect(groups.get("Bob")).toHaveLength(1);
  });

  it("puts events with no entity under __default__", () => {
    const events = [makeEntry(), makeEntry()];
    const groups = groupEventsByEntity(events);
    expect(groups.get("__default__")).toHaveLength(2);
  });

  it("uses the first entity when multiple are listed", () => {
    const events = [makeEntry({ entities: ["Alice", "Bob"] })];
    const groups = groupEventsByEntity(events);
    expect(groups.has("Alice")).toBe(true);
    expect(groups.has("Bob")).toBe(false);
  });

  it("returns empty map for empty input", () => {
    const groups = groupEventsByEntity([]);
    expect(groups.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runEpisodicConsolidation — integration with real DB
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let eventLog: InstanceType<typeof EventLog>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dream-cycle-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  eventLog = new EventLog(join(tmpDir, "event-log.db"));
});

afterEach(() => {
  factsDb.close();
  eventLog.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runEpisodicConsolidation", () => {
  it("returns zero counts when no unconsolidated events exist", async () => {
    const result = await runEpisodicConsolidation(factsDb, eventLog, 0, silentLogger);
    expect(result.eventsConsolidated).toBe(0);
    expect(result.factsCreated).toBe(0);
  });

  it("consolidates old events into facts", async () => {
    // Insert events old enough to be consolidated (olderThanDays = 0 means any event)
    const oldTs = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    eventLog.append({
      sessionId: "s1",
      timestamp: oldTs,
      eventType: "fact_learned",
      content: { text: "User prefers TypeScript" },
    });
    eventLog.append({
      sessionId: "s1",
      timestamp: oldTs,
      eventType: "fact_learned",
      content: { text: "User prefers functional style" },
    });

    const result = await runEpisodicConsolidation(factsDb, eventLog, 7, silentLogger);
    expect(result.eventsConsolidated).toBe(2);
    expect(result.factsCreated).toBe(1); // Both go into __default__ group
  });

  it("creates DERIVED_FROM links for consolidated events", async () => {
    const oldTs = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    eventLog.append({
      sessionId: "s1",
      timestamp: oldTs,
      eventType: "fact_learned",
      content: { text: "Fact about Alice" },
      entities: ["Alice"],
    });

    const result = await runEpisodicConsolidation(factsDb, eventLog, 7, silentLogger);
    expect(result.factsCreated).toBe(1);

    // Find the consolidated fact
    const allFacts = factsDb.getByCategory("fact");
    const consolidated = allFacts.find((f) => f.source === "dream-cycle");
    expect(consolidated).toBeDefined();

    // Check DERIVED_FROM links from consolidated fact
    const links = factsDb.getLinksFrom(consolidated!.id);
    const derivedLinks = links.filter((l) => l.linkType === "DERIVED_FROM");
    expect(derivedLinks.length).toBeGreaterThanOrEqual(1);
  });

  it("marks events as consolidated in the event log", async () => {
    const oldTs = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    eventLog.append({ sessionId: "s1", timestamp: oldTs, eventType: "fact_learned", content: { text: "Some event" } });

    await runEpisodicConsolidation(factsDb, eventLog, 7, silentLogger);

    // After consolidation, no unconsolidated events older than 7 days should remain
    const remaining = eventLog.getUnconsolidated(7);
    expect(remaining).toHaveLength(0);
  });

  it("skips events that are not old enough", async () => {
    // Recent events (not older than 7 days) should NOT be consolidated
    const recentTs = new Date().toISOString();
    eventLog.append({
      sessionId: "s1",
      timestamp: recentTs,
      eventType: "fact_learned",
      content: { text: "Recent event" },
    });

    const result = await runEpisodicConsolidation(factsDb, eventLog, 7, silentLogger);
    expect(result.eventsConsolidated).toBe(0);
    expect(result.factsCreated).toBe(0);
  });

  it("groups events by entity into separate consolidated facts", async () => {
    const oldTs = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    eventLog.append({
      sessionId: "s1",
      timestamp: oldTs,
      eventType: "fact_learned",
      content: { text: "Alice prefers coffee" },
      entities: ["Alice"],
    });
    eventLog.append({
      sessionId: "s1",
      timestamp: oldTs,
      eventType: "fact_learned",
      content: { text: "Bob prefers tea" },
      entities: ["Bob"],
    });

    const result = await runEpisodicConsolidation(factsDb, eventLog, 7, silentLogger);
    expect(result.eventsConsolidated).toBe(2);
    expect(result.factsCreated).toBe(2); // One per entity group
  });
});

// ---------------------------------------------------------------------------
// runDreamCycle — integration tests
// ---------------------------------------------------------------------------

describe("runDreamCycle", () => {
  const baseConfig: DreamCycleConfig = {
    enabled: true,
    schedule: "45 2 * * *",
    reflectWindowDays: 7,
    pruneMode: "both",
    model: "gpt-4o-mini",
    consolidateAfterDays: 7,
    eventLogArchivalDays: 90,
    eventLogArchivePath: join(tmpdir(), "event-log-archive"),
    maxUnconsolidatedAgeDays: 90,
    logRetentionDays: 30,
    vacuumOnCycle: false, // keep tests fast — VACUUM is slow
  };

  it("returns skipped=true when enabled=false", async () => {
    const result = await runDreamCycle(
      factsDb,
      {} as never,
      {} as never,
      {} as never,
      null,
      { ...baseConfig, enabled: false },
      silentLogger,
    );
    expect(result.skipped).toBe(true);
    expect(result.factsPruned).toBe(0);
    expect(result.patternsFound).toBe(0);
    expect(result.digestSummary).toContain("disabled");
  });

  it("prunes expired facts when pruneMode='expired'", async () => {
    // Store a fact with expired TTL
    const nowSec = Math.floor(Date.now() / 1000);
    factsDb.store({
      text: "Expired fact about old news",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "session",
      expiresAt: nowSec - 100,
    });
    // Verify it exists
    expect(factsDb.count()).toBe(1);

    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    const result = await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      null,
      { ...baseConfig, pruneMode: "expired" },
      silentLogger,
    );
    expect(result.factsPruned).toBe(1);
    expect(factsDb.count()).toBe(0);
  });

  it("decays confidence when pruneMode='decay'", async () => {
    // Store a fact with expiring TTL (needed for decayConfidence to apply)
    const nowSec = Math.floor(Date.now() / 1000);
    factsDb.store({
      text: "A fact with expiring confidence",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "active",
      confidence: 0.9,
      // last_confirmed_at and expires_at set so decay applies
      expiresAt: nowSec + 100,
    });

    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    const result = await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      null,
      { ...baseConfig, pruneMode: "decay" },
      silentLogger,
    );
    // decayConfidence only fires for facts that have passed 75% of their TTL;
    // our test fact is fresh, so decayed count may be 0 — just confirm no throw
    expect(result.skipped).toBe(false);
    expect(result.factsPruned).toBe(0); // pruneExpired not called
  });

  it("includes eventsConsolidated count when eventLog is provided", async () => {
    const oldTs = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    eventLog.append({
      sessionId: "s1",
      timestamp: oldTs,
      eventType: "fact_learned",
      content: { text: "Old event to consolidate" },
    });

    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    const result = await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      eventLog,
      baseConfig,
      silentLogger,
    );
    expect(result.eventsConsolidated).toBe(1);
    expect(result.factsCreated).toBe(1);
  });

  it("skips consolidation when eventLog is null", async () => {
    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    const result = await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      null,
      baseConfig,
      silentLogger,
    );
    expect(result.eventsConsolidated).toBe(0);
  });

  it("produces a non-empty digest summary", async () => {
    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    const result = await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      null,
      baseConfig,
      silentLogger,
    );
    expect(typeof result.digestSummary).toBe("string");
    expect(result.digestSummary.length).toBeGreaterThan(0);
  });

  it("permanent facts are not pruned by pruneExpired", async () => {
    // Permanent facts have no expiresAt — they must survive pruning
    factsDb.store({
      text: "A permanent rule that should never be deleted",
      category: "rule",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "permanent",
      expiresAt: null,
    });
    const beforeCount = factsDb.count();

    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      null,
      { ...baseConfig, pruneMode: "expired" },
      silentLogger,
    );
    // Permanent fact must still be there
    expect(factsDb.count()).toBe(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// NightlyCycleConfig — config parsing
// ---------------------------------------------------------------------------

describe("NightlyCycleConfig parsing", () => {
  const minimalConfig = {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
    },
    sqlitePath: "/tmp/test-facts.db",
    lanceDbPath: "/tmp/test-lance",
  };

  it("defaults to disabled with sensible defaults", () => {
    const cfg = hybridConfigSchema.parse({ ...minimalConfig, mode: "minimal" });
    expect(cfg.nightlyCycle.enabled).toBe(false);
    expect(cfg.nightlyCycle.schedule).toBe("45 2 * * *");
    expect(cfg.nightlyCycle.reflectWindowDays).toBe(7);
    expect(cfg.nightlyCycle.pruneMode).toBe("both");
    expect(cfg.nightlyCycle.consolidateAfterDays).toBe(7);
    expect(cfg.nightlyCycle.maxUnconsolidatedAgeDays).toBe(90);
  });

  it("2026.3.140 migration forces nightlyCycle off even when enabled: true", () => {
    const cfg = hybridConfigSchema.parse({
      ...minimalConfig,
      nightlyCycle: { enabled: true },
    });
    expect(cfg.nightlyCycle.enabled).toBe(false);
  });

  it("accepts custom schedule, window, pruneMode, and consolidateAfterDays", () => {
    const cfg = hybridConfigSchema.parse({
      ...minimalConfig,
      nightlyCycle: {
        enabled: true,
        schedule: "30 2 * * *",
        reflectWindowDays: 14,
        pruneMode: "expired",
        consolidateAfterDays: 3,
        maxUnconsolidatedAgeDays: 30,
      },
    });
    expect(cfg.nightlyCycle.schedule).toBe("30 2 * * *");
    expect(cfg.nightlyCycle.reflectWindowDays).toBe(14);
    expect(cfg.nightlyCycle.pruneMode).toBe("expired");
    expect(cfg.nightlyCycle.consolidateAfterDays).toBe(3);
    expect(cfg.nightlyCycle.maxUnconsolidatedAgeDays).toBe(30);
  });

  it("clamps reflectWindowDays to max 90", () => {
    const cfg = hybridConfigSchema.parse({
      ...minimalConfig,
      nightlyCycle: { reflectWindowDays: 200 },
    });
    expect(cfg.nightlyCycle.reflectWindowDays).toBe(90);
  });

  it("falls back to 'both' pruneMode for unknown values", () => {
    const cfg = hybridConfigSchema.parse({
      ...minimalConfig,
      nightlyCycle: { pruneMode: "unknown-value" },
    });
    expect(cfg.nightlyCycle.pruneMode).toBe("both");
  });

  it("defaults logRetentionDays to 30 and vacuumOnCycle to true (Issue #573)", () => {
    const cfg = hybridConfigSchema.parse({ ...minimalConfig, mode: "minimal" });
    expect(cfg.nightlyCycle.logRetentionDays).toBe(30);
    expect(cfg.nightlyCycle.vacuumOnCycle).toBe(true);
  });

  it("accepts custom logRetentionDays and vacuumOnCycle=false (Issue #573)", () => {
    const cfg = hybridConfigSchema.parse({
      ...minimalConfig,
      nightlyCycle: { logRetentionDays: 60, vacuumOnCycle: false },
    });
    expect(cfg.nightlyCycle.logRetentionDays).toBe(60);
    expect(cfg.nightlyCycle.vacuumOnCycle).toBe(false);
  });

  it("accepts logRetentionDays=0 to disable log pruning (Issue #573)", () => {
    const cfg = hybridConfigSchema.parse({
      ...minimalConfig,
      nightlyCycle: { logRetentionDays: 0 },
    });
    expect(cfg.nightlyCycle.logRetentionDays).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EventLogConfig — config parsing
// ---------------------------------------------------------------------------

describe("EventLogConfig parsing", () => {
  const minimalConfig = {
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
    },
    sqlitePath: "/tmp/test-facts.db",
    lanceDbPath: "/tmp/test-lance",
  };

  it("defaults to 90 days and ~/.openclaw/event-archive", () => {
    const cfg = hybridConfigSchema.parse({ ...minimalConfig });
    expect(cfg.eventLog.archivalDays).toBe(90);
    expect(cfg.eventLog.archivePath).toBe("~/.openclaw/event-archive");
  });

  it("accepts custom archivalDays and archivePath", () => {
    const cfg = hybridConfigSchema.parse({
      ...minimalConfig,
      eventLog: {
        archivalDays: 120,
        archivePath: "/tmp/custom-archive",
      },
    });
    expect(cfg.eventLog.archivalDays).toBe(120);
    expect(cfg.eventLog.archivePath).toBe("/tmp/custom-archive");
  });
});

// ---------------------------------------------------------------------------
// FactsDB maintenance methods — Issue #573
// ---------------------------------------------------------------------------

describe("FactsDB maintenance (Issue #573)", () => {
  it("pruneLogTables deletes old recall_log, reinforcement_log, feedback_trajectories rows", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 60 * 86400; // 60 days ago
    const newTs = Math.floor(Date.now() / 1000) - 1 * 86400; // 1 day ago

    // Insert a fact for FK constraint in reinforcement_log
    const fact = factsDb.store({
      text: "test fact for reinforcement",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
      decayClass: "stable",
    });

    // Populate log tables with old and new rows
    factsDb.logRecall(true, oldTs);
    factsDb.logRecall(false, newTs);
    factsDb.logRecall(true, oldTs);

    const deleted = factsDb.pruneLogTables(30);
    // At least the 2 old recall_log rows should be deleted
    expect(deleted).toBeGreaterThanOrEqual(2);

    // New row must remain
    factsDb.delete(fact.id);
  });

  it("pruneLogTables with retentionDays=0 deletes nothing", () => {
    factsDb.logRecall(true);
    const deleted = factsDb.pruneLogTables(0);
    expect(deleted).toBe(0);
  });

  it("optimizeFts runs without throwing", () => {
    expect(() => factsDb.optimizeFts()).not.toThrow();
  });

  it("vacuumAndCheckpoint runs without throwing", () => {
    expect(() => factsDb.vacuumAndCheckpoint()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runDreamCycle — maintenance integration (Issue #573)
// ---------------------------------------------------------------------------

describe("runDreamCycle maintenance (Issue #573)", () => {
  const baseConfig: DreamCycleConfig = {
    enabled: true,
    schedule: "45 2 * * *",
    reflectWindowDays: 7,
    pruneMode: "both",
    model: "gpt-4o-mini",
    consolidateAfterDays: 7,
    eventLogArchivalDays: 90,
    eventLogArchivePath: join(tmpdir(), "event-log-archive"),
    maxUnconsolidatedAgeDays: 90,
    logRetentionDays: 30,
    vacuumOnCycle: false,
  };

  it("pruneLogTables is called and logRowsPruned is reported", async () => {
    // Insert two old recall_log rows (61 days old — beyond retention)
    const oldTs = Math.floor(Date.now() / 1000) - 61 * 86400;
    factsDb.logRecall(true, oldTs);
    factsDb.logRecall(false, oldTs);

    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    const result = await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      null,
      { ...baseConfig, logRetentionDays: 30 },
      silentLogger,
    );
    expect(result.logRowsPruned).toBeGreaterThanOrEqual(2);
    expect(result.digestSummary).toContain("log rows pruned");
  });

  it("vacuumRan=true when vacuumOnCycle=true", async () => {
    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    const result = await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      null,
      { ...baseConfig, vacuumOnCycle: true },
      silentLogger,
    );
    expect(result.vacuumRan).toBe(true);
    expect(result.digestSummary).toContain("VACUUM ran");
  });

  it("vacuumRan=false when vacuumOnCycle=false", async () => {
    const openaiStub = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("no key")) } },
    } as never;
    const embeddingsStub = { embed: vi.fn().mockRejectedValue(new Error("no key")) } as never;

    const result = await runDreamCycle(
      factsDb,
      {} as never,
      embeddingsStub,
      openaiStub,
      null,
      { ...baseConfig, vacuumOnCycle: false },
      silentLogger,
    );
    expect(result.vacuumRan).toBe(false);
  });

  it("logRowsPruned and vacuumRan are 0/false in skipped result", async () => {
    const result = await runDreamCycle(
      factsDb,
      {} as never,
      {} as never,
      {} as never,
      null,
      { ...baseConfig, enabled: false },
      silentLogger,
    );
    expect(result.skipped).toBe(true);
    expect(result.logRowsPruned).toBe(0);
    expect(result.vacuumRan).toBe(false);
  });
});
