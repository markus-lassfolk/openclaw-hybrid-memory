/**
 * gap-detector.test.ts — Dedicated unit tests for services/gap-detector.ts.
 *
 * Uses a mock WorkflowStore so GapDetector is tested in isolation.
 *
 * ## Coverage
 *
 * ### deriveToolNameFromSequence
 * - All-same tools: returns "{tool}_bulk".
 * - Mixed tools with memory_ prefix: returns "memory_{base}_{sec}".
 * - Mixed tools without memory_ prefix: returns "{base}_{sec}".
 * - Empty sequence: returns "memory_custom_tool".
 *
 * ### computeGapId
 * - Returns a 16-char hex string.
 * - Is deterministic for the same sequence.
 * - Returns different IDs for different sequences.
 * - Handles empty sequence.
 *
 * ### GapDetector.detect
 * - Returns empty array when no patterns exist.
 * - Filters out patterns with fewer than 3 tool calls.
 * - Filters out patterns below minFrequency.
 * - Filters out patterns below minSuccessRate (default 0.5).
 * - Computes toolSavings as sequence.length - 1.
 * - Computes score as frequency × toolSavings × successRate.
 * - Sorts gaps by score descending.
 * - Respects the limit option.
 * - Accepts custom minFrequency and minToolSavings overrides.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorkflowPattern, WorkflowStore } from "../backends/workflow-store.js";
import { GapDetector, computeGapId, deriveToolNameFromSequence } from "../services/gap-detector.js";

// ---------------------------------------------------------------------------
// Mock WorkflowStore
// ---------------------------------------------------------------------------

function makeMockStore(patterns: WorkflowPattern[] = []): WorkflowStore {
  return {
    getPatterns: vi.fn().mockReturnValue(patterns),
    record: vi.fn(),
    prune: vi.fn().mockReturnValue(0),
    getById: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    getByGoal: vi.fn().mockReturnValue([]),
    getSuccessRate: vi.fn().mockReturnValue(0),
    count: vi.fn().mockReturnValue(0),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
  } as unknown as WorkflowStore;
}

function makePattern(
  toolSequence: string[],
  totalCount: number,
  successRate: number,
  exampleGoals: string[] = [],
): WorkflowPattern {
  return {
    toolSequence,
    totalCount,
    successCount: Math.round(totalCount * successRate),
    failureCount: totalCount - Math.round(totalCount * successRate),
    successRate,
    avgDurationMs: 1000,
    exampleGoals,
  };
}

// ---------------------------------------------------------------------------
// deriveToolNameFromSequence
// ---------------------------------------------------------------------------

describe("deriveToolNameFromSequence", () => {
  it("returns '{tool}_bulk' when all tools are identical", () => {
    expect(deriveToolNameFromSequence(["memory_recall", "memory_recall", "memory_recall"])).toBe("memory_recall_bulk");
  });

  it("returns 'exec_bulk' for exec-only sequences", () => {
    expect(deriveToolNameFromSequence(["exec", "exec", "exec"])).toBe("exec_bulk");
  });

  it("returns memory-prefixed name for mixed sequence with memory_ dominant", () => {
    const name = deriveToolNameFromSequence(["memory_recall", "exec", "memory_recall"]);
    expect(name).toMatch(/^memory_/);
  });

  it("returns combined name for mixed without memory_ prefix", () => {
    const name = deriveToolNameFromSequence(["exec", "read", "exec"]);
    // dominant=exec, second=read → exec_read or read_exec
    expect(name).not.toMatch(/^memory_/);
    expect(name.length).toBeGreaterThan(0);
  });

  it("returns 'memory_custom_tool' for empty sequence", () => {
    expect(deriveToolNameFromSequence([])).toBe("memory_custom_tool");
  });

  it("returns a single-tool bulk name for single-element sequence", () => {
    expect(deriveToolNameFromSequence(["read"])).toBe("read_bulk");
  });
});

// ---------------------------------------------------------------------------
// computeGapId
// ---------------------------------------------------------------------------

describe("computeGapId", () => {
  it("returns a 16-char hex string", () => {
    const id = computeGapId(["exec", "read", "write"]);
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    const seq = ["memory_recall", "exec", "memory_store"];
    expect(computeGapId(seq)).toBe(computeGapId(seq));
  });

  it("returns different IDs for different sequences", () => {
    expect(computeGapId(["a", "b"])).not.toBe(computeGapId(["b", "a"]));
  });

  it("handles empty sequence without throwing", () => {
    const id = computeGapId([]);
    expect(id).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// GapDetector.detect — basic cases
// ---------------------------------------------------------------------------

describe("GapDetector.detect — no patterns", () => {
  it("returns empty array when store returns no patterns", () => {
    const detector = new GapDetector(makeMockStore([]));
    expect(detector.detect()).toEqual([]);
  });
});

describe("GapDetector.detect — filtering by sequence length", () => {
  it("skips patterns with fewer than 3 tool calls", () => {
    const store = makeMockStore([
      makePattern(["exec", "read"], 10, 0.9), // length 2 — filtered out
    ]);
    const detector = new GapDetector(store);
    expect(detector.detect()).toEqual([]);
  });

  it("includes patterns with exactly 3 tool calls", () => {
    const store = makeMockStore([makePattern(["exec", "read", "write"], 5, 0.8, ["some goal"])]);
    const detector = new GapDetector(store);
    const gaps = detector.detect({ minFrequency: 3, minToolSavings: 2 });
    expect(gaps.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GapDetector.detect — filtering by frequency", () => {
  it("skips patterns below default minFrequency (3)", () => {
    const store = makeMockStore([
      makePattern(["exec", "read", "write"], 2, 0.9), // totalCount=2 < 3
    ]);
    const detector = new GapDetector(store);
    expect(detector.detect()).toEqual([]);
  });

  it("includes patterns at exactly minFrequency", () => {
    const store = makeMockStore([makePattern(["exec", "read", "write"], 3, 0.9, ["deploy app"])]);
    const detector = new GapDetector(store);
    const gaps = detector.detect({ minFrequency: 3 });
    expect(gaps.length).toBe(1);
  });

  it("respects custom minFrequency override", () => {
    const store = makeMockStore([makePattern(["exec", "read", "write"], 5, 0.8, ["goal"])]);
    const detector = new GapDetector(store);
    expect(detector.detect({ minFrequency: 10 })).toEqual([]);
    expect(detector.detect({ minFrequency: 5 })).toHaveLength(1);
  });
});

describe("GapDetector.detect — filtering by success rate", () => {
  it("skips patterns with success rate below 0.5 (default)", () => {
    const store = makeMockStore([
      makePattern(["exec", "read", "write"], 5, 0.4), // successRate < 0.5
    ]);
    const detector = new GapDetector(store);
    expect(detector.detect()).toEqual([]);
  });

  it("includes patterns at exactly 0.5 success rate", () => {
    const store = makeMockStore([makePattern(["exec", "read", "write"], 5, 0.5, ["goal"])]);
    const detector = new GapDetector(store);
    expect(detector.detect()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GapDetector.detect — score and sorting
// ---------------------------------------------------------------------------

describe("GapDetector.detect — score computation and sorting", () => {
  it("computes toolSavings as sequence.length - 1", () => {
    const store = makeMockStore([makePattern(["exec", "read", "write", "memory_store"], 5, 0.8, ["four tools"])]);
    const detector = new GapDetector(store);
    const gaps = detector.detect({ minFrequency: 3 });
    expect(gaps[0].toolSavings).toBe(3); // 4 - 1
  });

  it("computes score as frequency × toolSavings × successRate", () => {
    const totalCount = 6;
    const successRate = 0.8;
    const toolSavings = 3; // sequence length 4 - 1
    const store = makeMockStore([makePattern(["a", "b", "c", "d"], totalCount, successRate, ["goal"])]);
    const detector = new GapDetector(store);
    const gaps = detector.detect({ minFrequency: 3 });
    const expectedScore = totalCount * toolSavings * successRate;
    expect(gaps[0].score).toBeCloseTo(expectedScore, 5);
  });

  it("sorts gaps by score descending", () => {
    const store = makeMockStore([
      makePattern(["exec", "read", "write"], 3, 0.8, ["low score"]), // score = 3 * 2 * 0.8 = 4.8
      makePattern(["exec", "exec", "exec", "read"], 10, 0.9, ["high score"]), // score = 10 * 3 * 0.9 = 27
    ]);
    const detector = new GapDetector(store);
    const gaps = detector.detect({ minFrequency: 3 });
    expect(gaps[0].score).toBeGreaterThan(gaps[1].score);
    expect(gaps[0].exampleGoals[0]).toBe("high score");
  });

  it("respects limit option", () => {
    const store = makeMockStore([
      makePattern(["a", "b", "c"], 5, 0.8, ["g1"]),
      makePattern(["d", "e", "f"], 5, 0.8, ["g2"]),
      makePattern(["x", "y", "z"], 5, 0.8, ["g3"]),
    ]);
    const detector = new GapDetector(store);
    expect(detector.detect({ minFrequency: 3, limit: 2 }).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GapDetector.detect — gap fields
// ---------------------------------------------------------------------------

describe("GapDetector.detect — gap fields", () => {
  it("includes toolSequence, frequency, successRate, exampleGoals", () => {
    const seq = ["memory_recall", "memory_recall", "memory_store"];
    const store = makeMockStore([makePattern(seq, 5, 0.8, ["search and store"])]);
    const detector = new GapDetector(store);
    const gaps = detector.detect({ minFrequency: 3 });
    expect(gaps[0].toolSequence).toEqual(seq);
    expect(gaps[0].frequency).toBe(5);
    expect(gaps[0].successRate).toBe(0.8);
    expect(gaps[0].exampleGoals).toContain("search and store");
  });

  it("includes a suggestedToolName derived from the sequence", () => {
    const store = makeMockStore([makePattern(["memory_recall", "memory_recall", "memory_recall"], 5, 0.8, ["goal"])]);
    const detector = new GapDetector(store);
    const gaps = detector.detect({ minFrequency: 3 });
    expect(typeof gaps[0].suggestedToolName).toBe("string");
    expect(gaps[0].suggestedToolName.length).toBeGreaterThan(0);
  });

  it("includes a deterministic id derived from the tool sequence", () => {
    const seq = ["exec", "exec", "write"];
    const store = makeMockStore([makePattern(seq, 5, 0.8, ["goal"])]);
    const detector = new GapDetector(store);
    const gaps = detector.detect({ minFrequency: 3 });
    expect(gaps[0].id).toBe(computeGapId(seq));
  });
});
