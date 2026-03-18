/**
 * workflow-tracker.test.ts — Dedicated unit tests for services/workflow-tracker.ts.
 *
 * Uses a mock WorkflowStore so WorkflowTracker is tested in isolation, independent
 * of the SQLite backend. This complements workflow-store.test.ts which uses an
 * integration approach with a real database.
 *
 * ## Coverage
 *
 * ### WorkflowTracker.push
 * - Buffers tool names per session.
 * - Sessions are isolated from each other.
 * - No-op when tracking is disabled.
 *
 * ### WorkflowTracker.flush
 * - Calls store.record with correct arguments (goal, outcome, toolSequence, sessionId).
 * - Returns the trace ID on success.
 * - Returns null when buffer is empty (no prior push).
 * - Returns null when disabled.
 * - Clears buffer after successful flush.
 * - Returns null when store.record throws (error path).
 *
 * ### WorkflowTracker.discard
 * - Clears buffer without calling store.record.
 * - Subsequent flush returns null after discard.
 *
 * ### WorkflowTracker.getBuffer
 * - Returns empty array for unknown session.
 * - Returns snapshot of current tool calls.
 *
 * ### WorkflowTracker.prune
 * - Delegates to store.prune(retentionDays).
 * - Returns 0 when disabled.
 * - Returns 0 (and does not rethrow) when store.prune throws.
 *
 * ### Rate limiting
 * - Allows exactly maxTracesPerDay flushes per UTC day.
 * - Day rollover (via injectable clock) resets the counter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowTracker } from "../services/workflow-tracker.js";
import type { WorkflowStore, WorkflowTrace, CreateWorkflowTraceInput } from "../backends/workflow-store.js";
import type { WorkflowTrackingConfig } from "../config/types/features.js";

// ---------------------------------------------------------------------------
// Mock WorkflowStore
// ---------------------------------------------------------------------------

function makeMockStore(overrides: Partial<WorkflowStore> = {}): WorkflowStore {
  return {
    record: vi.fn().mockReturnValue({ id: "trace-mock-id" } as WorkflowTrace),
    prune: vi.fn().mockReturnValue(0),
    getById: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    getByGoal: vi.fn().mockReturnValue([]),
    getSuccessRate: vi.fn().mockReturnValue(0),
    getPatterns: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as WorkflowStore;
}

const ENABLED_CFG: WorkflowTrackingConfig = {
  enabled: true,
  maxTracesPerDay: 100,
  retentionDays: 90,
};

const DISABLED_CFG: WorkflowTrackingConfig = {
  enabled: false,
  maxTracesPerDay: 100,
  retentionDays: 90,
};

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

describe("WorkflowTracker.push", () => {
  it("buffers tool names per session", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    tracker.push("sess-1", "exec");
    tracker.push("sess-1", "read");
    expect(tracker.getBuffer("sess-1")).toEqual(["exec", "read"]);
  });

  it("isolates buffers across sessions", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    tracker.push("sess-a", "exec");
    tracker.push("sess-b", "write");
    expect(tracker.getBuffer("sess-a")).toEqual(["exec"]);
    expect(tracker.getBuffer("sess-b")).toEqual(["write"]);
  });

  it("is a no-op when disabled", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, DISABLED_CFG);
    tracker.push("sess", "exec");
    expect(tracker.getBuffer("sess")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getBuffer
// ---------------------------------------------------------------------------

describe("WorkflowTracker.getBuffer", () => {
  it("returns empty array for unknown session", () => {
    const tracker = new WorkflowTracker(makeMockStore(), ENABLED_CFG);
    expect(tracker.getBuffer("nonexistent")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

describe("WorkflowTracker.flush", () => {
  it("calls store.record with correct arguments and returns trace id", () => {
    const store = makeMockStore();
    (store.record as ReturnType<typeof vi.fn>).mockReturnValue({ id: "trace-abc123" });
    const tracker = new WorkflowTracker(store, ENABLED_CFG);

    tracker.push("sess", "exec");
    tracker.push("sess", "read");
    const id = tracker.flush("sess", "deploy the app", "success");

    expect(id).toBe("trace-abc123");
    expect(store.record).toHaveBeenCalledOnce();
    const call = (store.record as ReturnType<typeof vi.fn>).mock.calls[0][0] as CreateWorkflowTraceInput;
    expect(call.goal).toBe("deploy the app");
    expect(call.outcome).toBe("success");
    expect(call.toolSequence).toEqual(["exec", "read"]);
    expect(call.sessionId).toBe("sess");
  });

  it("defaults outcome to 'unknown'", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    tracker.push("sess", "exec");
    tracker.flush("sess", "some goal");

    const call = (store.record as ReturnType<typeof vi.fn>).mock.calls[0][0] as CreateWorkflowTraceInput;
    expect(call.outcome).toBe("unknown");
  });

  it("clears buffer after flush", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    tracker.push("sess", "exec");
    tracker.flush("sess", "goal");
    expect(tracker.getBuffer("sess")).toEqual([]);
  });

  it("returns null when buffer is empty", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    const id = tracker.flush("empty-sess", "some goal");
    expect(id).toBeNull();
    expect(store.record).not.toHaveBeenCalled();
  });

  it("returns null when disabled", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, DISABLED_CFG);
    tracker.push("sess", "exec");
    const id = tracker.flush("sess", "goal");
    expect(id).toBeNull();
    expect(store.record).not.toHaveBeenCalled();
  });

  it("returns null (does not rethrow) when store.record throws", () => {
    const store = makeMockStore({
      record: vi.fn().mockImplementation(() => {
        throw new Error("DB write failed");
      }),
    });
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    tracker.push("sess", "exec");
    const id = tracker.flush("sess", "goal");
    expect(id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discard
// ---------------------------------------------------------------------------

describe("WorkflowTracker.discard", () => {
  it("clears buffer without calling store.record", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    tracker.push("sess", "exec");
    tracker.discard("sess");
    expect(tracker.getBuffer("sess")).toEqual([]);
    expect(store.record).not.toHaveBeenCalled();
  });

  it("subsequent flush returns null after discard", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    tracker.push("sess", "exec");
    tracker.discard("sess");
    const id = tracker.flush("sess", "some goal");
    expect(id).toBeNull();
    expect(store.record).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe("WorkflowTracker.prune", () => {
  it("delegates to store.prune with retentionDays", () => {
    const store = makeMockStore({ prune: vi.fn().mockReturnValue(3) });
    const cfg = { ...ENABLED_CFG, retentionDays: 30 };
    const tracker = new WorkflowTracker(store, cfg);
    const pruned = tracker.prune();
    expect(pruned).toBe(3);
    expect(store.prune).toHaveBeenCalledWith(30);
  });

  it("returns 0 when disabled", () => {
    const store = makeMockStore();
    const tracker = new WorkflowTracker(store, DISABLED_CFG);
    expect(tracker.prune()).toBe(0);
    expect(store.prune).not.toHaveBeenCalled();
  });

  it("returns 0 when retentionDays is 0", () => {
    const store = makeMockStore();
    const cfg = { ...ENABLED_CFG, retentionDays: 0 };
    const tracker = new WorkflowTracker(store, cfg);
    expect(tracker.prune()).toBe(0);
    expect(store.prune).not.toHaveBeenCalled();
  });

  it("returns 0 (does not rethrow) when store.prune throws", () => {
    const store = makeMockStore({
      prune: vi.fn().mockImplementation(() => {
        throw new Error("prune error");
      }),
    });
    const tracker = new WorkflowTracker(store, ENABLED_CFG);
    expect(() => tracker.prune()).not.toThrow();
    expect(tracker.prune()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("WorkflowTracker — rate limiting", () => {
  it("allows exactly maxTracesPerDay flushes", () => {
    const store = makeMockStore();
    const cfg: WorkflowTrackingConfig = { enabled: true, maxTracesPerDay: 2, retentionDays: 90 };
    const tracker = new WorkflowTracker(store, cfg);

    tracker.push("s1", "exec");
    const id1 = tracker.flush("s1", "g1", "success");
    expect(id1).not.toBeNull();

    tracker.push("s2", "read");
    const id2 = tracker.flush("s2", "g2", "success");
    expect(id2).not.toBeNull();

    tracker.push("s3", "write");
    const id3 = tracker.flush("s3", "g3", "success"); // over limit
    expect(id3).toBeNull();

    expect(store.record).toHaveBeenCalledTimes(2);
  });

  it("resets rate-limit counter when UTC day changes (injectable clock)", () => {
    const store = makeMockStore();
    const cfg: WorkflowTrackingConfig = { enabled: true, maxTracesPerDay: 1, retentionDays: 90 };

    let currentDay = new Date("2025-06-15T12:00:00Z");
    const tracker = new WorkflowTracker(store, cfg, () => currentDay);

    tracker.push("s1", "exec");
    expect(tracker.flush("s1", "g1")).not.toBeNull(); // day 1, allowed

    tracker.push("s2", "exec");
    expect(tracker.flush("s2", "g2")).toBeNull(); // day 1, rejected

    // Advance to day 2
    currentDay = new Date("2025-06-16T00:01:00Z");

    tracker.push("s3", "exec");
    expect(tracker.flush("s3", "g3")).not.toBeNull(); // day 2, counter reset, allowed
    expect(store.record).toHaveBeenCalledTimes(2);
  });
});
