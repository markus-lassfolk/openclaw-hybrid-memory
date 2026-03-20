/**
 * Tests for the Task Queue — Pick Next Issue (Issue #635)
 */

import { describe, it, expect } from "vitest";
import {
  getQueuePriority,
  isEligible,
  sortByQueuePriority,
  toPickable,
  pickNextIssue,
  type GitHubIssueRaw,
  type PickableIssue,
} from "../services/pick-next-issue.js";

// ---------------------------------------------------------------------------
// getQueuePriority
// ---------------------------------------------------------------------------

describe("getQueuePriority", () => {
  it("returns 'high' when queue:high label is present", () => {
    expect(getQueuePriority(["autonomous", "enriched", "queue:high"])).toBe("high");
  });

  it("returns 'low' when queue:low label is present (and no queue:high)", () => {
    expect(getQueuePriority(["autonomous", "enriched", "queue:low"])).toBe("low");
  });

  it("returns 'normal' when neither queue:high nor queue:low is present", () => {
    expect(getQueuePriority(["autonomous", "enriched"])).toBe("normal");
  });

  it("returns 'normal' for an empty label list", () => {
    expect(getQueuePriority([])).toBe("normal");
  });

  it("prefers queue:high over queue:low when both are present", () => {
    // queue:high wins if somehow both are present
    expect(getQueuePriority(["queue:high", "queue:low"])).toBe("high");
  });

  it("returns 'normal' for unrelated labels", () => {
    expect(getQueuePriority(["bug", "enhancement", "priority: high"])).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// isEligible
// ---------------------------------------------------------------------------

describe("isEligible", () => {
  it("returns true when both autonomous and enriched labels are present", () => {
    expect(isEligible(["autonomous", "enriched"])).toBe(true);
  });

  it("returns true when extra labels are present alongside autonomous and enriched", () => {
    expect(isEligible(["autonomous", "enriched", "queue:high", "bug"])).toBe(true);
  });

  it("returns false when only autonomous is present", () => {
    expect(isEligible(["autonomous"])).toBe(false);
  });

  it("returns false when only enriched is present", () => {
    expect(isEligible(["enriched"])).toBe(false);
  });

  it("returns false for an empty label list", () => {
    expect(isEligible([])).toBe(false);
  });

  it("returns false for unrelated labels", () => {
    expect(isEligible(["bug", "enhancement"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sortByQueuePriority
// ---------------------------------------------------------------------------

describe("sortByQueuePriority", () => {
  const makeIssue = (number: number, priority: PickableIssue["priority"]): PickableIssue => ({
    number,
    title: `Issue ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    labels: [],
    priority,
  });

  it("sorts high before normal before low", () => {
    const issues = [makeIssue(3, "low"), makeIssue(1, "high"), makeIssue(2, "normal")];
    const sorted = sortByQueuePriority(issues);
    expect(sorted.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it("preserves relative order for issues of equal priority (stable sort)", () => {
    const issues = [makeIssue(10, "normal"), makeIssue(20, "normal"), makeIssue(30, "normal")];
    const sorted = sortByQueuePriority(issues);
    expect(sorted.map((i) => i.number)).toEqual([10, 20, 30]);
  });

  it("returns an empty array for empty input", () => {
    expect(sortByQueuePriority([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const issues = [makeIssue(3, "low"), makeIssue(1, "high")];
    const original = [...issues];
    sortByQueuePriority(issues);
    expect(issues.map((i) => i.number)).toEqual(original.map((i) => i.number));
  });

  it("handles all-high issues", () => {
    const issues = [makeIssue(5, "high"), makeIssue(6, "high")];
    const sorted = sortByQueuePriority(issues);
    expect(sorted.map((i) => i.number)).toEqual([5, 6]);
  });
});

// ---------------------------------------------------------------------------
// toPickable
// ---------------------------------------------------------------------------

describe("toPickable", () => {
  const makeRaw = (number: number, labels: string[]): GitHubIssueRaw => ({
    number,
    title: `Issue ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  });

  it("returns null for an issue without autonomous label", () => {
    expect(toPickable(makeRaw(1, ["enriched", "queue:high"]))).toBeNull();
  });

  it("returns null for an issue without enriched label", () => {
    expect(toPickable(makeRaw(1, ["autonomous", "queue:high"]))).toBeNull();
  });

  it("returns null for an issue with no labels", () => {
    expect(toPickable(makeRaw(1, []))).toBeNull();
  });

  it("converts an eligible issue with queue:high correctly", () => {
    const result = toPickable(makeRaw(42, ["autonomous", "enriched", "queue:high"]));
    expect(result).not.toBeNull();
    expect(result?.number).toBe(42);
    expect(result?.priority).toBe("high");
    expect(result?.labels).toContain("queue:high");
  });

  it("converts an eligible issue with queue:low correctly", () => {
    const result = toPickable(makeRaw(43, ["autonomous", "enriched", "queue:low"]));
    expect(result).not.toBeNull();
    expect(result?.priority).toBe("low");
  });

  it("converts an eligible issue with no queue label as normal priority", () => {
    const result = toPickable(makeRaw(44, ["autonomous", "enriched"]));
    expect(result).not.toBeNull();
    expect(result?.priority).toBe("normal");
  });

  it("preserves all label names in the result", () => {
    const result = toPickable(makeRaw(45, ["autonomous", "enriched", "priority: high", "bug"]));
    expect(result?.labels).toEqual(["autonomous", "enriched", "priority: high", "bug"]);
  });
});

// ---------------------------------------------------------------------------
// pickNextIssue
// ---------------------------------------------------------------------------

describe("pickNextIssue", () => {
  const makeRaw = (number: number, labels: string[]): GitHubIssueRaw => ({
    number,
    title: `Issue ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  });

  it("returns skip sentinel when no issues are present", () => {
    const result = pickNextIssue([], new Set());
    expect(result.picked).toBe(false);
    if (!result.picked) {
      expect(result.reason).toBe("SKIP: No more autonomous issues available");
    }
  });

  it("returns skip sentinel when no issues have both autonomous and enriched labels", () => {
    const issues = [makeRaw(1, ["bug"]), makeRaw(2, ["autonomous"]), makeRaw(3, ["enriched"])];
    const result = pickNextIssue(issues, new Set());
    expect(result.picked).toBe(false);
  });

  it("picks the only eligible issue when one is available", () => {
    const issues = [
      makeRaw(1, ["bug"]),
      makeRaw(2, ["autonomous", "enriched"]),
    ];
    const result = pickNextIssue(issues, new Set());
    expect(result.picked).toBe(true);
    if (result.picked) {
      expect(result.issue.number).toBe(2);
    }
  });

  it("picks queue:high before normal before queue:low", () => {
    const issues = [
      makeRaw(10, ["autonomous", "enriched", "queue:low"]),
      makeRaw(20, ["autonomous", "enriched"]),
      makeRaw(30, ["autonomous", "enriched", "queue:high"]),
    ];
    const result = pickNextIssue(issues, new Set());
    expect(result.picked).toBe(true);
    if (result.picked) {
      expect(result.issue.number).toBe(30);
    }
  });

  it("picks normal-priority issue when no queue:high exists", () => {
    const issues = [
      makeRaw(10, ["autonomous", "enriched", "queue:low"]),
      makeRaw(20, ["autonomous", "enriched"]),
    ];
    const result = pickNextIssue(issues, new Set());
    expect(result.picked).toBe(true);
    if (result.picked) {
      expect(result.issue.number).toBe(20);
    }
  });

  it("skips issues in the excludedNumbers set", () => {
    const issues = [
      makeRaw(1, ["autonomous", "enriched", "queue:high"]),
      makeRaw(2, ["autonomous", "enriched"]),
    ];
    // Issue 1 is already running
    const result = pickNextIssue(issues, new Set([1]));
    expect(result.picked).toBe(true);
    if (result.picked) {
      expect(result.issue.number).toBe(2);
    }
  });

  it("returns skip when all eligible issues are excluded", () => {
    const issues = [
      makeRaw(1, ["autonomous", "enriched", "queue:high"]),
      makeRaw(2, ["autonomous", "enriched"]),
    ];
    const result = pickNextIssue(issues, new Set([1, 2]));
    expect(result.picked).toBe(false);
  });

  it("picks the first high-priority issue when multiple high-priority issues exist", () => {
    const issues = [
      makeRaw(100, ["autonomous", "enriched", "queue:high"]),
      makeRaw(200, ["autonomous", "enriched", "queue:high"]),
    ];
    const result = pickNextIssue(issues, new Set());
    expect(result.picked).toBe(true);
    if (result.picked) {
      // First high-priority issue in original order is picked
      expect(result.issue.number).toBe(100);
    }
  });

  it("ignores non-eligible issues even with queue labels", () => {
    const issues = [
      makeRaw(1, ["queue:high"]), // missing autonomous + enriched
      makeRaw(2, ["autonomous", "queue:high"]), // missing enriched
    ];
    const result = pickNextIssue(issues, new Set());
    expect(result.picked).toBe(false);
  });

  it("3-tier example: high → normal → low ordering", () => {
    // Simulate a realistic queue with multiple issues across all three tiers
    const issues = [
      makeRaw(1, ["autonomous", "enriched", "queue:low"]),
      makeRaw(2, ["autonomous", "enriched", "queue:high"]),
      makeRaw(3, ["autonomous", "enriched"]), // normal
      makeRaw(4, ["autonomous", "enriched", "queue:high"]),
      makeRaw(5, ["autonomous", "enriched", "queue:low"]),
    ];

    // First pick: queue:high (issue 2, first high in list)
    const result1 = pickNextIssue(issues, new Set());
    expect(result1.picked).toBe(true);
    if (result1.picked) expect(result1.issue.number).toBe(2);

    // After picking issue 2: next is queue:high (issue 4)
    const result2 = pickNextIssue(issues, new Set([2]));
    expect(result2.picked).toBe(true);
    if (result2.picked) expect(result2.issue.number).toBe(4);

    // After picking issues 2 and 4: next is normal (issue 3)
    const result3 = pickNextIssue(issues, new Set([2, 4]));
    expect(result3.picked).toBe(true);
    if (result3.picked) expect(result3.issue.number).toBe(3);

    // After picking 2, 4, 3: next is queue:low (issue 1)
    const result4 = pickNextIssue(issues, new Set([2, 4, 3]));
    expect(result4.picked).toBe(true);
    if (result4.picked) expect(result4.issue.number).toBe(1);
  });
});
