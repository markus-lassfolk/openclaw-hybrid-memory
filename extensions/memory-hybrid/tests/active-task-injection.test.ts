import { describe, expect, it } from "vitest";
import type { ActiveTaskEntry } from "../services/active-task.js";
import {
  buildActiveTaskContextBundle,
  formatCappedTaskLabelList,
  prepareActiveTasksForInjection,
} from "../services/active-task-injection.js";

function entry(partial: Partial<ActiveTaskEntry> & { label: string }): ActiveTaskEntry {
  return {
    description: "Project task",
    status: "In progress",
    started: new Date().toISOString(),
    updated: new Date().toISOString(),
    ...partial,
  };
}

const defaultProjection = {
  mode: "readable" as const,
  excludeGenericTitle: true,
  titleMinChars: 0,
  dedupeBy: "none" as const,
  sectioned: true,
};

describe("prepareActiveTasksForInjection", () => {
  it("drops generic titles in readable mode and sorts non-stale first", () => {
    const tasks = [
      entry({ label: "stale-a", stale: true, updated: "2020-01-01T00:00:00.000Z", description: "Real work A" }),
      entry({ label: "fresh-b", stale: false, description: "Real work B" }),
      entry({ label: "generic", description: "Project task" }),
    ];
    const { prepared, ledgerActiveCount, filteredActiveCount } = prepareActiveTasksForInjection(tasks, {
      projection: defaultProjection,
    });
    expect(ledgerActiveCount).toBe(3);
    expect(filteredActiveCount).toBe(2);
    expect(prepared.map((t) => t.label)).toEqual(["fresh-b", "stale-a"]);
  });

  it("boosts tasks matching user text", () => {
    const tasks = [
      entry({ label: "other", description: "Unrelated" }),
      entry({ label: "deploy-prod", description: "Deploy production stack" }),
    ];
    const { prepared } = prepareActiveTasksForInjection(tasks, {
      projection: { ...defaultProjection, excludeGenericTitle: false },
      userText: "Please continue deploy-prod rollout",
    });
    expect(prepared[0]?.label).toBe("deploy-prod");
  });

  it("applies injectionMaxTasks cap", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => entry({ label: `t-${i}`, description: `Work ${i}` }));
    const { prepared } = prepareActiveTasksForInjection(tasks, {
      projection: defaultProjection,
      injectionMaxTasks: 3,
    });
    expect(prepared).toHaveLength(3);
  });
});

describe("formatCappedTaskLabelList", () => {
  it("truncates long label lists", () => {
    const labels = Array.from({ length: 20 }, (_, i) => `task-${i}`);
    const out = formatCappedTaskLabelList(labels, 5);
    expect(out).toContain("[task-0]");
    expect(out).toContain("and 15 more");
  });
});

describe("buildActiveTaskContextBundle", () => {
  it("excludes stale tasks from main block but includes stale warnings within budget", () => {
    const tasks = [
      entry({ label: "fresh", stale: false, description: "Current work" }),
      entry({
        label: "old-stale",
        stale: true,
        updated: "2020-01-01T00:00:00.000Z",
        description: "Stale work",
      }),
    ];
    const bundle = buildActiveTaskContextBundle({
      ledgerTasks: tasks,
      injectionBudgetTokens: 500,
      staleMinutes: 60,
      staleWarningEnabled: true,
      projection: defaultProjection,
    });
    const main = bundle.parts.find((p) => p.includes("<active-tasks>")) ?? "";
    const combined = bundle.parts.join("\n");
    expect(main).toContain("[fresh]");
    expect(main).toContain("[old-stale]");
    expect(combined).toContain("STALE ACTIVE TASKS");
    expect(combined).toContain("[old-stale]");
    expect(bundle.injectedTaskCount).toBe(2);
    expect(bundle.ledgerActiveCount).toBe(2);
  });

  it("counts stale-warning-only tasks as injected", () => {
    const tasks = [
      entry({
        label: "old-stale",
        stale: true,
        updated: "2020-01-01T00:00:00.000Z",
        description: "Stale work",
      }),
    ];
    const bundle = buildActiveTaskContextBundle({
      ledgerTasks: tasks,
      injectionBudgetTokens: 500,
      staleMinutes: 60,
      staleWarningEnabled: true,
      projection: defaultProjection,
    });
    expect(bundle.parts.join("\n")).toContain("[old-stale]");
    expect(bundle.injectedTaskCount).toBe(1);
  });

  it("keeps total injected tokens within shared budget on heartbeat hygiene", () => {
    const tasks = [
      entry({ label: "fresh", stale: false, description: "Current work" }),
      ...Array.from({ length: 30 }, (_, i) =>
        entry({
          label: `stale-${i}`,
          stale: true,
          updated: "2020-01-01T00:00:00.000Z",
          description: `Stale task number ${i}`,
        }),
      ),
    ];
    const bundle = buildActiveTaskContextBundle({
      ledgerTasks: tasks,
      injectionBudgetTokens: 400,
      staleMinutes: 60,
      staleWarningEnabled: true,
      projection: { ...defaultProjection, excludeGenericTitle: false },
      heartbeatHygiene: { maxChars: 2500, suggestGoalAfterTaskAgeDays: 0 },
    });
    expect(bundle.injectedTokens).toBeLessThanOrEqual(450);
    const hygiene = bundle.parts.find((p) => p.includes("<task-hygiene>")) ?? "";
    expect(hygiene).toContain("<task-hygiene>");
    expect(hygiene).toContain("and 15 more");
  });
});
