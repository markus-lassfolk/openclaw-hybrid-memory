import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const { EventLog } = _testing;

let tmpDir: string;
let log: InstanceType<typeof EventLog>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-log-test-"));
  log = new EventLog(join(tmpDir, "event-log.db"));
});

afterEach(() => {
  log.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

describe("EventLog.append", () => {
  it("creates an entry with a generated id", () => {
    const ts = new Date().toISOString();
    const id = log.append({
      sessionId: "sess-1",
      timestamp: ts,
      eventType: "fact_learned",
      content: { text: "User prefers dark mode" },
    });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const entries = log.getBySession("sess-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].sessionId).toBe("sess-1");
    expect(entries[0].timestamp).toBe(ts);
    expect(entries[0].eventType).toBe("fact_learned");
    expect(entries[0].content).toEqual({ text: "User prefers dark mode" });
    expect(entries[0].createdAt).toBeDefined();
  });

  it("stores optional entities array", () => {
    const id = log.append({
      sessionId: "sess-2",
      timestamp: new Date().toISOString(),
      eventType: "entity_mentioned",
      content: {},
      entities: ["Alice", "Bob"],
    });

    const entries = log.getBySession("sess-2");
    expect(entries[0].id).toBe(id);
    expect(entries[0].entities).toEqual(["Alice", "Bob"]);
  });

  it("stores optional metadata", () => {
    log.append({
      sessionId: "sess-3",
      timestamp: new Date().toISOString(),
      eventType: "decision_made",
      content: { decision: "use TypeScript" },
      metadata: { confidence: 0.9, source: "llm" },
    });

    const entries = log.getBySession("sess-3");
    expect(entries[0].metadata).toEqual({ confidence: 0.9, source: "llm" });
  });

  it("generates unique ids for each entry", () => {
    const ts = new Date().toISOString();
    const id1 = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    const id2 = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// appendBatch
// ---------------------------------------------------------------------------

describe("EventLog.appendBatch", () => {
  it("creates multiple entries atomically and returns ids in order", () => {
    const ts = new Date().toISOString();
    const ids = log.appendBatch([
      { sessionId: "s1", timestamp: ts, eventType: "fact_learned", content: { n: 1 } },
      { sessionId: "s1", timestamp: ts, eventType: "decision_made", content: { n: 2 } },
      { sessionId: "s1", timestamp: ts, eventType: "action_taken", content: { n: 3 } },
    ]);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3); // all unique

    const entries = log.getBySession("s1");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.id)).toEqual(ids);
  });

  it("returns empty array for empty input", () => {
    const ids = log.appendBatch([]);
    expect(ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getBySession
// ---------------------------------------------------------------------------

describe("EventLog.getBySession", () => {
  it("returns only entries for the given session", () => {
    const ts = new Date().toISOString();
    log.append({ sessionId: "A", timestamp: ts, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "B", timestamp: ts, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "A", timestamp: ts, eventType: "decision_made", content: {} });

    const aEntries = log.getBySession("A");
    expect(aEntries).toHaveLength(2);
    expect(aEntries.every((e) => e.sessionId === "A")).toBe(true);

    const bEntries = log.getBySession("B");
    expect(bEntries).toHaveLength(1);
  });

  it("returns empty array for unknown session", () => {
    expect(log.getBySession("no-such-session")).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const ts = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: { i } });
    }
    const limited = log.getBySession("s", 3);
    expect(limited).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getByTimeRange
// ---------------------------------------------------------------------------

describe("EventLog.getByTimeRange", () => {
  it("returns entries within the time window", () => {
    const early = "2024-01-01T00:00:00.000Z";
    const mid = "2024-06-15T12:00:00.000Z";
    const late = "2024-12-31T23:59:59.000Z";

    log.append({ sessionId: "s", timestamp: early, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: mid, eventType: "decision_made", content: {} });
    log.append({ sessionId: "s", timestamp: late, eventType: "action_taken", content: {} });

    const results = log.getByTimeRange("2024-03-01T00:00:00.000Z", "2024-09-01T00:00:00.000Z");
    expect(results).toHaveLength(1);
    expect(results[0].timestamp).toBe(mid);
  });

  it("filters by eventType when provided", () => {
    const ts = "2024-06-15T12:00:00.000Z";
    log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: ts, eventType: "decision_made", content: {} });

    const results = log.getByTimeRange(
      "2024-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      "fact_learned",
    );
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe("fact_learned");
  });

  it("returns empty array when nothing falls in range", () => {
    log.append({
      sessionId: "s",
      timestamp: "2024-01-01T00:00:00.000Z",
      eventType: "fact_learned",
      content: {},
    });
    const results = log.getByTimeRange("2025-01-01T00:00:00.000Z", "2025-12-31T00:00:00.000Z");
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getUnconsolidated
// ---------------------------------------------------------------------------

describe("EventLog.getUnconsolidated", () => {
  it("returns only entries without consolidated_into", () => {
    const ts = new Date().toISOString();
    const id1 = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    const id2 = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });

    log.markConsolidated([id1], "fact-xyz");

    const unconsolidated = log.getUnconsolidated();
    expect(unconsolidated).toHaveLength(1);
    expect(unconsolidated[0].id).toBe(id2);
  });

  it("respects olderThanDays parameter", () => {
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const recent = new Date().toISOString();

    log.append({ sessionId: "s", timestamp: old, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: recent, eventType: "fact_learned", content: {} });

    const results = log.getUnconsolidated(5);
    expect(results).toHaveLength(1);
    expect(results[0].timestamp).toBe(old);
  });

  it("returns all unconsolidated when olderThanDays not provided", () => {
    const ts = new Date().toISOString();
    log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: ts, eventType: "decision_made", content: {} });

    expect(log.getUnconsolidated()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getByEntity
// ---------------------------------------------------------------------------

describe("EventLog.getByEntity", () => {
  it("returns entries containing the entity name", () => {
    const ts = new Date().toISOString();
    log.append({
      sessionId: "s",
      timestamp: ts,
      eventType: "entity_mentioned",
      content: {},
      entities: ["Alice", "Bob"],
    });
    log.append({
      sessionId: "s",
      timestamp: ts,
      eventType: "entity_mentioned",
      content: {},
      entities: ["Carol"],
    });

    const results = log.getByEntity("Alice");
    expect(results).toHaveLength(1);
    expect(results[0].entities).toContain("Alice");
  });

  it("returns empty array when entity not found", () => {
    const ts = new Date().toISOString();
    log.append({
      sessionId: "s",
      timestamp: ts,
      eventType: "entity_mentioned",
      content: {},
      entities: ["Bob"],
    });
    expect(log.getByEntity("Alice")).toEqual([]);
  });

  it("returns empty array when entry has no entities", () => {
    log.append({
      sessionId: "s",
      timestamp: new Date().toISOString(),
      eventType: "fact_learned",
      content: {},
    });
    expect(log.getByEntity("anyone")).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const ts = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      log.append({
        sessionId: "s",
        timestamp: ts,
        eventType: "entity_mentioned",
        content: { i },
        entities: ["Alice"],
      });
    }
    expect(log.getByEntity("Alice", 2)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// markConsolidated
// ---------------------------------------------------------------------------

describe("EventLog.markConsolidated", () => {
  it("sets consolidated_into on the specified entries", () => {
    const ts = new Date().toISOString();
    const id1 = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    const id2 = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    const id3 = log.append({ sessionId: "s", timestamp: ts, eventType: "decision_made", content: {} });

    log.markConsolidated([id1, id2], "fact-abc");

    const all = log.getBySession("s");
    const e1 = all.find((e) => e.id === id1)!;
    const e2 = all.find((e) => e.id === id2)!;
    const e3 = all.find((e) => e.id === id3)!;

    expect(e1.consolidatedInto).toBe("fact-abc");
    expect(e2.consolidatedInto).toBe("fact-abc");
    expect(e3.consolidatedInto).toBeUndefined();
  });

  it("is a no-op for an empty id list", () => {
    const ts = new Date().toISOString();
    const id = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    log.markConsolidated([], "fact-xyz");
    const entries = log.getBySession("s");
    expect(entries[0].id).toBe(id);
    expect(entries[0].consolidatedInto).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// archiveOld
// ---------------------------------------------------------------------------

describe("EventLog.archiveOld", () => {
  it("removes consolidated entries older than N days and returns count", () => {
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const recent = new Date().toISOString();

    log.append({ sessionId: "s", timestamp: old, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: old, eventType: "decision_made", content: {} });
    log.append({ sessionId: "s", timestamp: recent, eventType: "action_taken", content: {} });

    // Mark the old entries as consolidated so archiveOld can clean them up
    const allEntries = log.getBySession("s");
    for (const entry of allEntries) {
      if (entry.timestamp === old) {
        log.markConsolidated([entry.id], "test-fact-id");
      }
    }

    const count = log.archiveOld(5);
    expect(count).toBe(2);

    const remaining = log.getBySession("s");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].timestamp).toBe(recent);
  });

  it("preserves unconsolidated old entries", () => {
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();

    log.append({ sessionId: "s", timestamp: old, eventType: "fact_learned", content: {} });

    // Don't mark as consolidated — archiveOld should NOT delete it
    const count = log.archiveOld(5);
    expect(count).toBe(0);

    const remaining = log.getBySession("s");
    expect(remaining).toHaveLength(1);
  });

  it("returns 0 when nothing is old enough", () => {
    const recent = new Date().toISOString();
    log.append({ sessionId: "s", timestamp: recent, eventType: "fact_learned", content: {} });
    expect(log.archiveOld(1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe("EventLog.getStats", () => {
  it("returns correct counts by type", () => {
    const ts = new Date().toISOString();
    log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: ts, eventType: "decision_made", content: {} });

    const stats = log.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byType["fact_learned"]).toBe(2);
    expect(stats.byType["decision_made"]).toBe(1);
  });

  it("tracks unconsolidated count correctly", () => {
    const ts = new Date().toISOString();
    const id1 = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });

    log.markConsolidated([id1], "fact-abc");

    const stats = log.getStats();
    expect(stats.total).toBe(2);
    expect(stats.unconsolidated).toBe(1);
  });

  it("reports oldestUnconsolidated correctly", () => {
    const old = "2024-01-01T00:00:00.000Z";
    const recent = "2024-12-01T00:00:00.000Z";

    log.append({ sessionId: "s", timestamp: old, eventType: "fact_learned", content: {} });
    log.append({ sessionId: "s", timestamp: recent, eventType: "fact_learned", content: {} });

    const stats = log.getStats();
    expect(stats.oldestUnconsolidated).toBe(old);
  });

  it("returns null oldestUnconsolidated when all are consolidated", () => {
    const ts = new Date().toISOString();
    const id = log.append({ sessionId: "s", timestamp: ts, eventType: "fact_learned", content: {} });
    log.markConsolidated([id], "fact-abc");

    const stats = log.getStats();
    expect(stats.oldestUnconsolidated).toBeNull();
  });

  it("returns zeroes on empty log", () => {
    const stats = log.getStats();
    expect(stats.total).toBe(0);
    expect(stats.unconsolidated).toBe(0);
    expect(stats.byType).toEqual({});
    expect(stats.oldestUnconsolidated).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CHECK constraint on event_type
// ---------------------------------------------------------------------------

describe("EventLog CHECK constraint", () => {
  it("rejects an invalid event_type", () => {
    expect(() => {
      log.append({
        sessionId: "s",
        timestamp: new Date().toISOString(),
        eventType: "invalid_type" as never,
        content: {},
      });
    }).toThrow();
  });

  it("accepts all valid event types", () => {
    const ts = new Date().toISOString();
    const validTypes = [
      "fact_learned",
      "decision_made",
      "action_taken",
      "entity_mentioned",
      "preference_expressed",
      "correction",
    ] as const;

    for (const eventType of validTypes) {
      expect(() => {
        log.append({ sessionId: "s", timestamp: ts, eventType, content: {} });
      }).not.toThrow();
    }

    expect(log.getBySession("s")).toHaveLength(validTypes.length);
  });
});

// ---------------------------------------------------------------------------
// Concurrent appends don't lose data
// ---------------------------------------------------------------------------

describe("EventLog concurrent safety", () => {
  it("multiple sequential appends preserve all entries", () => {
    const ts = new Date().toISOString();
    const count = 50;
    const ids: string[] = [];

    for (let i = 0; i < count; i++) {
      ids.push(
        log.append({
          sessionId: "s",
          timestamp: ts,
          eventType: "fact_learned",
          content: { i },
        }),
      );
    }

    expect(new Set(ids).size).toBe(count);
    expect(log.getBySession("s")).toHaveLength(count);
  });
});
