import { describe, expect, it } from "vitest";
import {
  taskToCard,
  goalToCard,
  taskExternalId,
  goalExternalId,
  isHybridMemoryCard,
  parseExternalId,
  columnToTaskStatus,
  columnToGoalStatus,
} from "../services/workboard-card-mapper.js";
import { DEFAULT_WORKBOARD_COLUMNS } from "../config/types/workboard.js";
import type { ActiveTaskEntry } from "../services/active-task.js";
import type { Goal } from "../services/goal-stewardship-types.js";

const TAG = "hybrid-memory";

function makeTask(overrides: Partial<ActiveTaskEntry> = {}): ActiveTaskEntry {
  return {
    label: "test-task",
    description: "Do the thing",
    status: "In progress",
    started: "2026-06-01T00:00:00Z",
    updated: "2026-06-05T00:00:00Z",
    ...overrides,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    label: "Ship feature X",
    description: "Make feature X production-ready",
    acceptanceCriteria: ["Tests pass", "Docs updated"],
    phase: "implementation",
    iteration: 0,
    maxIterations: 20,
    prereqStatus: "ready",
    prereqReasons: [],
    nextAction: null,
    evidence: null,
    blockerFingerprint: null,
    status: "active",
    priority: "high",
    createdAt: "2026-06-01T00:00:00Z",
    lastAssessedAt: null,
    lastDispatchedAt: null,
    assessmentCount: 0,
    dispatchCount: 0,
    currentBlockers: [],
    lastOutcome: null,
    maxDispatches: 5,
    maxAssessments: 10,
    cooldownMinutes: 60,
    escalateAfterFailures: 3,
    consecutiveFailures: 0,
    lastBlockerFingerprint: null,
    sameBlockerStreak: 0,
    circuitBreakerLastProgressAssessmentCount: 0,
    humanEscalationSummary: null,
    escalationKind: null,
    linkedTasks: [],
    history: [],
    ...overrides,
  };
}

describe("workboard-card-mapper", () => {
  describe("taskToCard", () => {
    it("maps an in-progress task", () => {
      const card = taskToCard(makeTask(), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card).not.toBeNull();
      expect(card!.title).toBe("[Task] test-task");
      expect(card!.column).toBe("running");
      expect(card!.externalId).toBe("hm-task:test-task");
      expect(card!.tags).toContain(TAG);
    });

    it("maps a done task", () => {
      const card = taskToCard(makeTask({ status: "Done" }), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card!.column).toBe("done");
    });

    it("maps a failed task", () => {
      const card = taskToCard(makeTask({ status: "Failed" }), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card!.column).toBe("blocked");
    });

    it("maps a stale task to Backlog", () => {
      const card = taskToCard(makeTask({ stale: true }), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card!.column).toBe("backlog");
    });

    it("includes branch and next in description", () => {
      const card = taskToCard(makeTask({ branch: "feat/x", next: "fix tests" }), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card!.description).toContain("Branch: feat/x");
      expect(card!.description).toContain("Next: fix tests");
    });
  });

  describe("goalToCard", () => {
    it("maps an active goal", () => {
      const card = goalToCard(makeGoal(), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card).not.toBeNull();
      expect(card!.title).toBe("[Goal] Ship feature X");
      expect(card!.column).toBe("running");
      expect(card!.externalId).toBe("hm-goal:goal-1");
      expect(card!.tags).toContain("priority:high");
    });

    it("maps a blocked goal", () => {
      const card = goalToCard(makeGoal({ status: "blocked" }), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card!.column).toBe("blocked");
    });

    it("maps a completed goal", () => {
      const card = goalToCard(makeGoal({ status: "completed" }), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card!.column).toBe("done");
    });

    it("includes acceptance criteria and blockers in description", () => {
      const card = goalToCard(makeGoal({ currentBlockers: ["Dependency on team B"] }), DEFAULT_WORKBOARD_COLUMNS, TAG);
      expect(card!.description).toContain("Acceptance criteria:");
      expect(card!.description).toContain("Tests pass");
      expect(card!.description).toContain("Blockers:");
      expect(card!.description).toContain("Dependency on team B");
    });
  });

  describe("external ID helpers", () => {
    it("generates task external IDs", () => {
      expect(taskExternalId("my-task")).toBe("hm-task:my-task");
    });

    it("generates goal external IDs", () => {
      expect(goalExternalId("uuid-123")).toBe("hm-goal:uuid-123");
    });

    it("detects hybrid-memory cards", () => {
      expect(isHybridMemoryCard({ id: "1", title: "t", column: "c", externalId: "hm-task:x" })).toBe(true);
      expect(isHybridMemoryCard({ id: "2", title: "t", column: "c", externalId: "hm-goal:y" })).toBe(true);
      expect(isHybridMemoryCard({ id: "3", title: "t", column: "c", externalId: "other:z" })).toBe(false);
      expect(isHybridMemoryCard({ id: "4", title: "t", column: "c" })).toBe(false);
    });

    it("parses external IDs", () => {
      expect(parseExternalId("hm-task:my-task")).toEqual({ type: "task", label: "my-task" });
      expect(parseExternalId("hm-goal:uuid-123")).toEqual({ type: "goal", goalId: "uuid-123" });
      expect(parseExternalId("other:stuff")).toBeNull();
    });
  });

  describe("column-to-status mapping", () => {
    it("maps columns back to task statuses", () => {
      expect(columnToTaskStatus("running", DEFAULT_WORKBOARD_COLUMNS)).toBe("In progress");
      expect(columnToTaskStatus("scheduled", DEFAULT_WORKBOARD_COLUMNS)).toBe("Waiting");
      expect(columnToTaskStatus("done", DEFAULT_WORKBOARD_COLUMNS)).toBe("Done");
      expect(columnToTaskStatus("blocked", DEFAULT_WORKBOARD_COLUMNS)).toBe("Failed");
      expect(columnToTaskStatus("backlog", DEFAULT_WORKBOARD_COLUMNS)).toBe("Stalled");
      expect(columnToTaskStatus("Unknown Column", DEFAULT_WORKBOARD_COLUMNS)).toBeNull();
    });

    it("maps columns back to goal statuses", () => {
      expect(columnToGoalStatus("running", DEFAULT_WORKBOARD_COLUMNS)).toBe("active");
      expect(columnToGoalStatus("done", DEFAULT_WORKBOARD_COLUMNS)).toBe("completed");
      expect(columnToGoalStatus("blocked", DEFAULT_WORKBOARD_COLUMNS)).toBe("blocked");
      expect(columnToGoalStatus("backlog", DEFAULT_WORKBOARD_COLUMNS)).toBe("stalled");
      expect(columnToGoalStatus("Unknown Column", DEFAULT_WORKBOARD_COLUMNS)).toBeNull();
    });
  });
});
