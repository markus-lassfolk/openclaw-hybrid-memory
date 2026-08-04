import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileGoalContinuation } from "../services/goal-continuation.js";
import { createGoal, readGoal } from "../services/goal-registry.js";
import { linkSubagentToGoal, updateGoalOnSubagentEnd } from "../services/goal-subagent.js";

let dir = "";
const defaults = { maxDispatches: 20, maxAssessments: 50, cooldownMinutes: 1, escalateAfterFailures: 3, priority: "normal" as const };
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const policy = { version: 1 as const, classes: { repair: { allowedAgents: ["forge"], readOnly: false, canonical: { repository: "org/plugin", prNumber: 963, branch: "fix/pr-963", remoteHead: "abc" }, writeScope: ["services"], forbidNewPr: true, forbidNewBranch: true } } };

describe("goal continuation controller", () => {
  it("turns the #963/#964-shaped worker/CI failure into a same-PR repair decision", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-continuation-"));
    const goal = await createGoal(dir, { label: "pr963", description: "repair existing Armor PR", acceptanceCriteria: ["CI green"], dispatchPolicy: policy }, defaults);
    await linkSubagentToGoal(dir, goal.id, { label: "armor-pr-963", sessionKey: "worker", status: "in_progress" });
    await updateGoalOnSubagentEnd(dir, { label: "armor-pr-963", sessionKey: "worker", success: false, outcome: "CI failed on existing PR #963" });
    const decision = await reconcileGoalContinuation(dir, goal.id);
    expect(decision).toMatchObject({ kind: "repair" });
    const after = await readGoal(dir, goal.id);
    expect(after?.status).toBe("active");
    expect(after?.dispatchPolicy?.classes.repair.canonical).toMatchObject({ prNumber: 963, branch: "fix/pr-963" });
    expect(after?.history.some((h) => h.action === "continuation-decision" && h.detail.includes("repair:"))).toBe(true);
  });

  it("is idempotent across duplicate heartbeat pulses", async () => {
    dir = await mkdtemp(join(tmpdir(), "goal-continuation-duplicate-"));
    const goal = await createGoal(dir, { label: "pr964", description: "repair", acceptanceCriteria: ["green"], dispatchPolicy: policy }, defaults);
    await linkSubagentToGoal(dir, goal.id, { label: "armor-pr-964", sessionKey: "worker", status: "in_progress" });
    await updateGoalOnSubagentEnd(dir, { label: "armor-pr-964", sessionKey: "worker", success: false, outcome: "CI failed" });
    await Promise.all([reconcileGoalContinuation(dir, goal.id), reconcileGoalContinuation(dir, goal.id)]);
    const after = await readGoal(dir, goal.id);
    expect(after?.history.filter((h) => h.action === "continuation-decision")).toHaveLength(1);
  });
});
