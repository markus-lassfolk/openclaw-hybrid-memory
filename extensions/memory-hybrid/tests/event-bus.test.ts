import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { EventBus, computeFingerprint } from "../backends/event-bus.js";

let tmpDir: string;
let bus: EventBus;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-bus-test-"));
  bus = new EventBus(join(tmpDir, "event-bus.db"));
});

afterEach(() => {
  bus.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendEvent
// ---------------------------------------------------------------------------

describe("EventBus.appendEvent", () => {
  it("inserts an event and returns a positive integer id", () => {
    const id = bus.appendEvent("sensor.garmin", "garmin-sensor", { steps: 8000 });
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("auto-increments ids for successive inserts", () => {
    const id1 = bus.appendEvent("sensor.garmin", "garmin-sensor", { steps: 1 });
    const id2 = bus.appendEvent("sensor.github", "github-sensor", { commits: 3 });
    expect(id2).toBeGreaterThan(id1);
  });

  it("defaults importance to 0.5 and status to 'raw'", () => {
    const id = bus.appendEvent("sensor.test", "test", { x: 1 });
    const events = bus.queryEvents({ type: "sensor.test" });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(id);
    expect(events[0].importance).toBe(0.5);
    expect(events[0].status).toBe("raw");
  });

  it("stores custom importance", () => {
    bus.appendEvent("insight.candidate", "rumination", { summary: "foo" }, 0.9);
    const events = bus.queryEvents({ type: "insight.candidate" });
    expect(events[0].importance).toBe(0.9);
  });

  it("throws RangeError for importance below 0", () => {
    expect(() => bus.appendEvent("sensor.test", "test", {}, -0.1)).toThrow(RangeError);
  });

  it("throws RangeError for importance above 1", () => {
    expect(() => bus.appendEvent("sensor.test", "test", {}, 1.1)).toThrow(RangeError);
  });

  it("throws RangeError for NaN importance", () => {
    expect(() => bus.appendEvent("sensor.test", "test", {}, NaN)).toThrow(RangeError);
  });

  it("stores fingerprint when provided", () => {
    const fp = computeFingerprint("sensor.garmin:entity123:summary:bucket");
    bus.appendEvent("sensor.garmin", "garmin-sensor", {}, 0.5, fp);
    const events = bus.queryEvents();
    expect(events[0].fingerprint).toBe(fp);
  });

  it("stores null fingerprint when omitted", () => {
    bus.appendEvent("sensor.garmin", "garmin-sensor", {});
    const events = bus.queryEvents();
    expect(events[0].fingerprint).toBeNull();
  });

  it("serializes payload as JSON and round-trips correctly", () => {
    const payload = { nested: { a: 1 }, arr: [1, 2, 3], flag: true };
    bus.appendEvent("sensor.test", "test", payload);
    const events = bus.queryEvents({ type: "sensor.test" });
    expect(events[0].payload).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// queryEvents
// ---------------------------------------------------------------------------

describe("EventBus.queryEvents", () => {
  beforeEach(() => {
    bus.appendEvent("sensor.garmin", "garmin", { a: 1 });
    bus.appendEvent("sensor.github", "github", { b: 2 });
    bus.appendEvent("sensor.garmin", "garmin", { c: 3 });
  });

  it("returns all events when no filter provided", () => {
    const events = bus.queryEvents();
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it("filters by type", () => {
    const events = bus.queryEvents({ type: "sensor.garmin" });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.event_type === "sensor.garmin")).toBe(true);
  });

  it("filters by status", () => {
    const events = bus.queryEvents();
    const id = events[0].id;
    bus.updateStatus(id, "processed");

    const rawEvents = bus.queryEvents({ status: "raw" });
    const processedEvents = bus.queryEvents({ status: "processed" });

    expect(rawEvents.every((e) => e.status === "raw")).toBe(true);
    expect(processedEvents.every((e) => e.status === "processed")).toBe(true);
    expect(processedEvents.some((e) => e.id === id)).toBe(true);
  });

  it("filters by since (ISO datetime)", () => {
    // Use a since value well in the past — all events should be returned.
    const pastCutoff = "2000-01-01T00:00:00.000Z";
    const events = bus.queryEvents({ since: pastCutoff });
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Use a since value in the future — no events should be returned.
    const futureCutoff = "2999-01-01T00:00:00.000Z";
    const noEvents = bus.queryEvents({ since: futureCutoff });
    expect(noEvents).toHaveLength(0);
  });

  it("respects the limit", () => {
    const events = bus.queryEvents({ limit: 2 });
    expect(events).toHaveLength(2);
  });

  it("returns events in ascending id order", () => {
    const events = bus.queryEvents();
    for (let i = 1; i < events.length; i++) {
      expect(events[i].id).toBeGreaterThan(events[i - 1].id);
    }
  });

  it("returns empty array when no events match filter", () => {
    const events = bus.queryEvents({ type: "sensor.nonexistent" });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

describe("EventBus.updateStatus", () => {
  it("transitions status from raw to processed", () => {
    const id = bus.appendEvent("sensor.test", "test", {});
    bus.updateStatus(id, "processed");
    const events = bus.queryEvents({ status: "processed" });
    expect(events.some((e) => e.id === id)).toBe(true);
  });

  it("sets processed_at on first transition away from raw", () => {
    const id = bus.appendEvent("sensor.test", "test", {});
    bus.updateStatus(id, "surfaced");
    const events = bus.queryEvents({ status: "surfaced" });
    const event = events.find((e) => e.id === id);
    expect(event).toBeDefined();
    expect(event!.processed_at).not.toBeNull();
  });

  it("does not overwrite existing processed_at on subsequent transitions", () => {
    const id = bus.appendEvent("sensor.test", "test", {});
    bus.updateStatus(id, "processed");
    const afterFirst = bus.queryEvents().find((e) => e.id === id)!.processed_at;

    bus.updateStatus(id, "surfaced");
    const afterSecond = bus.queryEvents().find((e) => e.id === id)!.processed_at;

    expect(afterFirst).toBe(afterSecond);
  });

  it("supports all valid status values", () => {
    const statuses = ["raw", "processed", "surfaced", "pushed", "archived"] as const;
    for (const status of statuses) {
      const id = bus.appendEvent("sensor.test", "test", {});
      bus.updateStatus(id, status);
      const events = bus.queryEvents({ status });
      expect(events.some((e) => e.id === id)).toBe(true);
    }
  });

  it("throws when called with a non-existent id", () => {
    expect(() => bus.updateStatus(999999, "processed")).toThrow(
      "EventBus: no event found with id 999999",
    );
  });
});

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

describe("EventBus.dedup", () => {
  it("returns false when no event with that fingerprint exists", () => {
    const fp = computeFingerprint("sensor.garmin:entity:summary:bucket");
    expect(bus.dedup(fp)).toBe(false);
  });

  it("returns true when a recent event with matching fingerprint exists", () => {
    const fp = computeFingerprint("sensor.garmin:entity:summary:bucket");
    bus.appendEvent("sensor.garmin", "garmin", {}, 0.5, fp);
    expect(bus.dedup(fp)).toBe(true);
  });

  it("returns false when matching fingerprint is older than cooldown", () => {
    const fp = computeFingerprint("sensor.garmin:entity:summary:bucket");
    bus.appendEvent("sensor.garmin", "garmin", {}, 0.5, fp);

    // Back-date the row to 2 hours ago via a second DB connection so it is
    // deterministically outside a 1-hour cooldown window.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const db2 = new Database(join(tmpDir, "event-bus.db"));
    db2.prepare("UPDATE memory_events SET created_at = ? WHERE fingerprint = ?")
      .run(twoHoursAgo, fp);
    db2.close();

    // Event is 2 h old but cooldown is 1 h → should NOT be treated as a duplicate
    expect(bus.dedup(fp, 1)).toBe(false);
  });

  it("returns false for a different fingerprint", () => {
    const fp1 = computeFingerprint("sensor.garmin:entity1:summary:bucket");
    const fp2 = computeFingerprint("sensor.garmin:entity2:summary:bucket");
    bus.appendEvent("sensor.garmin", "garmin", {}, 0.5, fp1);
    expect(bus.dedup(fp2)).toBe(false);
  });

  it("uses 6-hour default cooldown", () => {
    const fp = computeFingerprint("sensor.test:default-cooldown");
    bus.appendEvent("sensor.test", "test", {}, 0.5, fp);
    // Just inserted — should be detected as duplicate
    expect(bus.dedup(fp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pruneArchived
// ---------------------------------------------------------------------------

describe("EventBus.pruneArchived", () => {
  it("deletes archived events older than N days and returns correct count", () => {
    const id1 = bus.appendEvent("sensor.test", "test", {});
    const id2 = bus.appendEvent("sensor.test", "test", {});
    bus.updateStatus(id1, "archived");
    bus.updateStatus(id2, "archived");

    // Back-date both rows to be well in the past via a second DB connection
    const db2 = new Database(join(tmpDir, "event-bus.db"));
    db2.prepare("UPDATE memory_events SET created_at = '2000-01-01T00:00:00.000Z'").run();
    db2.close();

    // Prune with 1-day cutoff — both archived rows are far older than that
    const count = bus.pruneArchived(1);
    expect(count).toBe(2);
    expect(bus.queryEvents({ status: "archived" })).toHaveLength(0);
  });

  it("does not prune archived events that are still within the retention window", () => {
    const id1 = bus.appendEvent("sensor.test", "test", {});
    const id2 = bus.appendEvent("sensor.test", "test", {});
    bus.updateStatus(id1, "archived");
    bus.updateStatus(id2, "archived");

    // Events were just created — they are within the 30-day window
    const count = bus.pruneArchived(30);
    expect(count).toBe(0);
    expect(bus.queryEvents({ status: "archived" })).toHaveLength(2);
  });

  it("does not delete non-archived events", () => {
    const id = bus.appendEvent("sensor.test", "test", {});
    bus.updateStatus(id, "processed");

    // Back-date to make it look ancient — still not archived so must survive
    const db2 = new Database(join(tmpDir, "event-bus.db"));
    db2.prepare("UPDATE memory_events SET created_at = '2000-01-01T00:00:00.000Z'").run();
    db2.close();

    const count = bus.pruneArchived(1);
    expect(count).toBe(0);
    expect(bus.queryEvents({ status: "processed" }).some((e) => e.id === id)).toBe(true);
  });

  it("uses 30-day default", () => {
    bus.appendEvent("sensor.test", "test", {});
    const count = bus.pruneArchived();
    expect(count).toBe(0); // event is fresh
  });
});

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

describe("computeFingerprint", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    const fp = computeFingerprint("sensor.garmin:entity123:summary:bucket");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const input = "sensor.garmin:entity123:summary:bucket";
    expect(computeFingerprint(input)).toBe(computeFingerprint(input));
  });

  it("produces different hashes for different inputs", () => {
    const fp1 = computeFingerprint("sensor.garmin:entity1:summary:bucket");
    const fp2 = computeFingerprint("sensor.garmin:entity2:summary:bucket");
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Integration: write → query → update status → verify
// ---------------------------------------------------------------------------

describe("EventBus integration", () => {
  it("full lifecycle: append → query → updateStatus → verify", () => {
    // 1. Write an event
    const fp = computeFingerprint("sensor.github:repo123:3 new commits:2026-03-11");
    const id = bus.appendEvent("sensor.github", "github-sensor", { commits: 3, repo: "my-repo" }, 0.7, fp);
    expect(id).toBeGreaterThan(0);

    // 2. Query it — should be raw
    const rawEvents = bus.queryEvents({ status: "raw", type: "sensor.github" });
    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0].id).toBe(id);
    expect(rawEvents[0].source).toBe("github-sensor");
    expect(rawEvents[0].payload).toEqual({ commits: 3, repo: "my-repo" });
    expect(rawEvents[0].importance).toBe(0.7);
    expect(rawEvents[0].fingerprint).toBe(fp);

    // 3. Dedup check — fingerprint exists within cooldown
    expect(bus.dedup(fp)).toBe(true);

    // 4. Update status → processed
    bus.updateStatus(id, "processed");
    const processedEvents = bus.queryEvents({ status: "processed" });
    expect(processedEvents.some((e) => e.id === id)).toBe(true);
    expect(processedEvents.find((e) => e.id === id)!.processed_at).not.toBeNull();

    // 5. No longer in raw
    const stillRaw = bus.queryEvents({ status: "raw", type: "sensor.github" });
    expect(stillRaw).toHaveLength(0);

    // 6. Advance through the full lifecycle
    bus.updateStatus(id, "surfaced");
    bus.updateStatus(id, "pushed");
    bus.updateStatus(id, "archived");

    const archivedEvents = bus.queryEvents({ status: "archived" });
    expect(archivedEvents.some((e) => e.id === id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isOpen / close
// ---------------------------------------------------------------------------

describe("EventBus lifecycle", () => {
  it("isOpen returns true before close", () => {
    expect(bus.isOpen()).toBe(true);
  });

  it("isOpen returns false after close", () => {
    bus.close();
    expect(bus.isOpen()).toBe(false);
  });

  it("close is idempotent", () => {
    bus.close();
    expect(() => bus.close()).not.toThrow();
  });

  it("throws when used after close", () => {
    bus.close();
    expect(() => bus.appendEvent("sensor.test", "test", {})).toThrow("EventBus is closed");
  });
});
