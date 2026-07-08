/**
 * Regression tests for services/workboard-facts-sync.ts's applyWorkboardGoalStatusUpdate.
 *
 * Dragging a Workboard card back to a non-terminal column previously reopened a goal the
 * system/user had already closed via goal_complete/goal_fail/goal_abandon — the function had no
 * isTerminalStatus() guard, unlike every other updateGoal() call site touching status
 * (goal-subagent.ts's linkSubagentToGoal/markGoalDispatchFailure, fixed under #37).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as goalRegistry from "../services/goal-registry.js";
import { createGoal, readGoal } from "../services/goal-registry.js";
import { applyWorkboardGoalStatusUpdate } from "../services/workboard-facts-sync.js";

const defaults = {
  maxDispatches: 20,
  maxAssessments: 50,
  cooldownMinutes: 10,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("applyWorkboardGoalStatusUpdate terminal-status guard (loop iteration 25 regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not resurrect a completed goal when its Workboard card is dragged to a non-terminal column", async () => {
    dir = await mkdtemp(join(tmpdir(), "workboard-goal-terminal-"));
    const goal = await createGoal(
      dir,
      { label: "wb_terminal_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    await goalRegistry.updateGoal(
      dir,
      goal.id,
      { status: "completed" },
      {
        timestamp: new Date().toISOString(),
        action: "completed",
        detail: "goal_complete",
        actor: "user",
      },
    );

    await applyWorkboardGoalStatusUpdate(dir, goal.id, "active");

    const after = await readGoal(dir, goal.id);
    expect(after?.status).toBe("completed");
    expect(after?.history?.some((h) => h.action === "workboard_pull")).toBe(false);
  });

  it("does not resurrect a goal terminated between the pre-check read and the lock (TOCTOU)", async () => {
    dir = await mkdtemp(join(tmpdir(), "workboard-goal-toctou-"));
    const goal = await createGoal(
      dir,
      { label: "wb_toctou_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );

    // Simulate a concurrent goal_complete landing between the pre-check readGoal() and the
    // updateGoal() lock: the spy returns the STALE (still-active) snapshot, exactly matching
    // the real race window, after a genuine concurrent write has already terminated the goal.
    const readGoalSpy = vi.spyOn(goalRegistry, "readGoal");
    readGoalSpy.mockImplementationOnce(async (goalsDir, id) => {
      const stale = await goalRegistry.readGoal(goalsDir, id);
      await goalRegistry.updateGoal(
        goalsDir,
        id,
        { status: "abandoned" },
        {
          timestamp: new Date().toISOString(),
          action: "abandoned",
          detail: "concurrent abandonment",
          actor: "user",
        },
      );
      return stale;
    });

    await applyWorkboardGoalStatusUpdate(dir, goal.id, "active");

    const after = await readGoal(dir, goal.id);
    expect(after?.status).toBe("abandoned");
    expect(after?.history?.some((h) => h.action === "workboard_pull")).toBe(false);
  });

  it("still applies a non-terminal status update when the goal is not terminal", async () => {
    dir = await mkdtemp(join(tmpdir(), "workboard-goal-active-"));
    const goal = await createGoal(
      dir,
      { label: "wb_active_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );

    await applyWorkboardGoalStatusUpdate(dir, goal.id, "blocked");

    const after = await readGoal(dir, goal.id);
    expect(after?.status).toBe("blocked");
    expect(after?.history?.some((h) => h.action === "workboard_pull")).toBe(true);
  });
});
