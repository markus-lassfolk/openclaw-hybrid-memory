/**
 * Concurrency regression tests for services/goal-subagent.ts.
 *
 * updateGoalOnSubagentEnd / linkSubagentToGoal / markGoalDispatchFailure previously computed
 * linkedTasks/consecutiveFailures patches from a goal snapshot read *before* acquiring
 * updateGoal's per-goal lock. Two concurrent calls targeting different linked tasks on the same
 * goal could each read the same stale linkedTasks array, and whichever committed second would
 * silently overwrite the first's update — permanently stalling one task. These tests exercise
 * that race directly (via Promise.all) to confirm both concurrent updates survive.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as goalRegistry from "../services/goal-registry.js";
import { createGoal, readGoal, updateGoal } from "../services/goal-registry.js";
import { linkSubagentToGoal, markGoalDispatchFailure, updateGoalOnSubagentEnd } from "../services/goal-subagent.js";

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

describe("updateGoalOnSubagentEnd concurrency", () => {
  it("does not let a concurrent subagent-end update for one task revert another task's status", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-subagent-race-"));
    const goal = await createGoal(dir, { label: "race_goal", description: "d", acceptanceCriteria: ["a"] }, defaults);

    await linkSubagentToGoal(dir, goal.id, { label: "task-a", sessionKey: "session-a", status: "in_progress" });
    await linkSubagentToGoal(dir, goal.id, { label: "task-b", sessionKey: "session-b", status: "in_progress" });

    // Two subagents finish "at the same time" — both handlers read the pre-race goal state and
    // race to commit. Without the fix, whichever commits second reverts the other's task status
    // because its patch was computed from a linkedTasks array that doesn't yet include the
    // first commit's change.
    await Promise.all([
      updateGoalOnSubagentEnd(dir, { label: "task-a", sessionKey: "session-a", success: true, outcome: "done a" }),
      updateGoalOnSubagentEnd(dir, { label: "task-b", sessionKey: "session-b", success: true, outcome: "done b" }),
    ]);

    const after = await readGoal(dir, goal.id);
    const taskA = after?.linkedTasks.find((t) => t.label === "task-a");
    const taskB = after?.linkedTasks.find((t) => t.label === "task-b");
    expect(taskA?.status).toBe("completed");
    expect(taskB?.status).toBe("completed");
    // Both tasks terminal (success) → goal should have moved to verifying, not be stuck active.
    expect(after?.status).toBe("verifying");
  });

  it("does not lose a concurrent consecutiveFailures increment from a parallel failure", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-subagent-race-fail-"));
    const goal = await createGoal(
      dir,
      { label: "race_fail_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    await linkSubagentToGoal(dir, goal.id, { label: "task-a", sessionKey: "session-a", status: "in_progress" });
    await linkSubagentToGoal(dir, goal.id, { label: "task-b", sessionKey: "session-b", status: "in_progress" });

    // Bump consecutiveFailures once via a direct update, concurrently with a subagent-end
    // failure for a different task, to exercise the same "compute from fresh state" fix.
    await Promise.all([
      updateGoal(dir, goal.id, (fresh) => ({ consecutiveFailures: fresh.consecutiveFailures + 1 }), {
        timestamp: new Date().toISOString(),
        action: "assessed",
        detail: "manual bump",
        actor: "steward",
      }),
      updateGoalOnSubagentEnd(dir, { label: "task-b", sessionKey: "session-b", success: false, outcome: "failed b" }),
    ]);

    const after = await readGoal(dir, goal.id);
    // Both increments must land: 0 -> 1 (manual bump) -> 2 (subagent failure), regardless of
    // commit order, because each is computed from the freshly-locked read, not a stale snapshot.
    expect(after?.consecutiveFailures).toBe(2);
  });
});

describe("goal-subagent TOCTOU terminal-status re-check (#37)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("linkSubagentToGoal does not resurrect a goal terminated between the pre-check read and the lock", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-subagent-toctou-link-"));
    const goal = await createGoal(
      dir,
      { label: "toctou_link_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );

    // Simulate a concurrent goal_complete landing between linkSubagentToGoal's pre-lock
    // readGoal() and its updateGoal() call: the spy returns the STALE (still-active) snapshot,
    // exactly matching the real race window, after a genuine concurrent write has already
    // terminated the goal.
    const readGoalSpy = vi.spyOn(goalRegistry, "readGoal");
    readGoalSpy.mockImplementationOnce(async (goalsDir, id) => {
      const stale = await goalRegistry.readGoal(goalsDir, id);
      await goalRegistry.updateGoal(
        goalsDir,
        id,
        { status: "completed" },
        {
          timestamp: new Date().toISOString(),
          action: "completed",
          detail: "concurrent completion",
          actor: "user",
        },
      );
      return stale;
    });

    await linkSubagentToGoal(dir, goal.id, { label: "late-task", sessionKey: "session-late", status: "in_progress" });

    const after = await readGoal(dir, goal.id);
    // Status must remain "completed" — the fix must not overwrite it back to a non-terminal
    // status, and the late task must not be linked onto an already-finished goal.
    expect(after?.status).toBe("completed");
    expect(after?.linkedTasks.some((t) => t.label === "late-task")).toBe(false);
    expect(after?.history?.some((h) => h.action === "subagent-linked")).toBe(false);
  });

  it("markGoalDispatchFailure does not resurrect a goal terminated between the pre-check read and the lock", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-subagent-toctou-dispatch-"));
    const goal = await createGoal(
      dir,
      { label: "toctou_dispatch_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );

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

    await markGoalDispatchFailure(dir, goal.id, {
      label: "late-task",
      sessionKey: "session-late",
      runId: null,
      reason: "dispatch exploded",
    });

    const after = await readGoal(dir, goal.id);
    // Without the fix this would flip back to "blocked" and append a stray dispatch-failed entry.
    expect(after?.status).toBe("abandoned");
    expect(after?.history?.some((h) => h.action === "dispatch-failed")).toBe(false);
  });

  it("updateGoalOnSubagentEnd does not resurrect a goal terminated between the pre-check read and the lock", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-subagent-toctou-end-"));
    const goal = await createGoal(
      dir,
      { label: "toctou_end_goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    await linkSubagentToGoal(dir, goal.id, { label: "task-a", sessionKey: "session-a", status: "in_progress" });

    const listActiveGoalsSpy = vi.spyOn(goalRegistry, "listActiveGoals");
    listActiveGoalsSpy.mockImplementationOnce(async (goalsDir) => {
      const stale = await goalRegistry.listActiveGoals(goalsDir);
      await goalRegistry.updateGoal(
        goalsDir,
        goal.id,
        { status: "failed" },
        {
          timestamp: new Date().toISOString(),
          action: "failed",
          detail: "concurrent failure",
          actor: "user",
        },
      );
      return stale;
    });

    await updateGoalOnSubagentEnd(dir, { label: "task-a", sessionKey: "session-a", success: true, outcome: "done a" });

    const after = await readGoal(dir, goal.id);
    // Without the fix, a successful subagent-end for the only linked task would flip an
    // already-failed goal to "verifying".
    expect(after?.status).toBe("failed");
    const taskA = after?.linkedTasks.find((t) => t.label === "task-a");
    expect(taskA?.status).toBe("in_progress");
    expect(after?.history?.some((h) => h.action === "subagent-succeeded" || h.action === "all-tasks-complete")).toBe(
      false,
    );
  });
});
