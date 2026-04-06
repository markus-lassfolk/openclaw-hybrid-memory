import { describe, expect, it } from "vitest";
import {
  buildGoalEscalationHeartbeatBlock,
  buildHeartbeatTaskHygieneBlock,
  buildProposeGoalDraftFromTask,
} from "../services/task-hygiene.js";
import type { ActiveTaskEntry } from "../services/active-task.js";

function baseTask(over: Partial<ActiveTaskEntry> = {}): ActiveTaskEntry {
  return {
    label: "t1",
    description: "desc",
    status: "In progress",
    started: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

describe("task-hygiene", () => {
  it("buildHeartbeatTaskHygieneBlock includes stale labels", () => {
    const tasks = [baseTask({ label: "a", stale: true }), baseTask({ label: "b", stale: false })];
    const block = buildHeartbeatTaskHygieneBlock(tasks, {
      maxChars: 2500,
      suggestGoalAfterTaskAgeDays: 0,
    });
    expect(block).toContain("<task-hygiene>");
    expect(block).toContain("[a]");
    expect(block).not.toContain("[b]");
    expect(block).toContain("</task-hygiene>");
  });

  it("buildHeartbeatTaskHygieneBlock suggests goal when task is old enough", () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const tasks = [baseTask({ label: "long", updated: old })];
    const block = buildHeartbeatTaskHygieneBlock(tasks, {
      maxChars: 2500,
      suggestGoalAfterTaskAgeDays: 7,
    });
    expect(block).toContain("Long-running");
    expect(block).toContain("active_task_propose_goal");
  });

  it("buildHeartbeatTaskHygieneBlock truncates when over maxChars", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => baseTask({ label: `x${i}`, stale: true }));
    const block = buildHeartbeatTaskHygieneBlock(tasks, {
      maxChars: 400,
      suggestGoalAfterTaskAgeDays: 0,
    });
    expect(block.length).toBeLessThanOrEqual(420);
    expect(block).toContain("truncated");
  });

  it("buildGoalEscalationHeartbeatBlock lists blocked and stalled goals", () => {
    const block = buildGoalEscalationHeartbeatBlock(
      [
        { label: "g1", status: "blocked" },
        { label: "g2", status: "active" },
        { label: "g3", status: "stalled" },
      ],
      { maxChars: 2500 },
    );
    expect(block).toContain("<goal-escalation>");
    expect(block).toContain("[g1]");
    expect(block).toContain("[g3]");
    expect(block).not.toContain("[g2]");
    expect(block).toContain("HEARTBEAT_OK");
    expect(block).toContain("</goal-escalation>");
  });

  it("buildGoalEscalationHeartbeatBlock returns empty when no blocked/stalled", () => {
    expect(buildGoalEscalationHeartbeatBlock([{ label: "a", status: "active" }], { maxChars: 500 })).toBe("");
  });

  it("buildProposeGoalDraftFromTask maps row to draft", () => {
    const draft = buildProposeGoalDraftFromTask(
      baseTask({ label: "my-task", next: "Run tests", description: "Ship feature" }),
    );
    expect(draft.suggestedLabel).toBe("my-task");
    expect(draft.suggestedDescription).toBe("Ship feature");
    expect(draft.suggestedCriteria.some((c) => c.includes("Run tests"))).toBe(true);
  });
});
