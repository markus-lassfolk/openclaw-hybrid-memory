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
  it("drops generic titles and stale tasks in readable mode", () => {
    const tasks = [
      entry({ label: "stale-a", stale: true, updated: "2020-01-01T00:00:00.000Z", description: "Real work A" }),
      entry({ label: "fresh-b", stale: false, description: "Real work B" }),
      entry({ label: "generic", description: "Project task" }),
    ];
    const { prepared, ledgerActiveCount, filteredActiveCount } = prepareActiveTasksForInjection(tasks, {
      projection: defaultProjection,
    });
    expect(ledgerActiveCount).toBe(3);
    expect(filteredActiveCount).toBe(1);
    expect(prepared.map((t) => t.label)).toEqual(["fresh-b"]);
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
  it("excludes stale tasks from the main block but still reports stale warnings", () => {
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
    expect(main).not.toContain("[old-stale]");
    expect(combined).toContain("STALE ACTIVE TASKS");
    expect(bundle.injectedTaskCount).toBe(1);
    expect(bundle.ledgerActiveCount).toBe(2);
    expect(bundle.filteredActiveCount).toBe(1);
  });

  it("does not count stale-only ledgers as injected tasks", () => {
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
    const combined = bundle.parts.join("\n");
    const main = bundle.parts.find((p) => p.includes("<active-tasks>")) ?? "";
    expect(main).toBe("");
    expect(combined).toContain("[old-stale]");
    expect(bundle.injectedTaskCount).toBe(0);
    expect(bundle.filteredActiveCount).toBe(0);
  });

  it("suppresses stale orphan subagent placeholder rows from default injection", () => {
    const tasks = [
      entry({
        label: "agent:main:subagent:worker-1",
        description: "Subagent task placeholder",
        subagent: "agent:main:subagent:worker-1",
        next: "Task [agent:main:subagent:worker-1] next:",
        stale: true,
        updated: "2020-01-01T00:00:00.000Z",
      }),
      entry({
        label: "live-task",
        description: "Investigate projection cleanup",
        next: "Check the latest task projection rows",
        stale: false,
      }),
    ];
    const bundle = buildActiveTaskContextBundle({
      ledgerTasks: tasks,
      injectionBudgetTokens: 500,
      staleMinutes: 60,
      staleWarningEnabled: true,
      projection: { ...defaultProjection, excludeGenericTitle: false },
    });
    const combined = bundle.parts.join("\n");
    expect(combined).toContain("[live-task]");
    expect(combined).not.toContain("agent:main:subagent:worker-1");
    expect(combined).not.toContain("STALE ACTIVE TASKS");
    expect(bundle.injectedTaskCount).toBe(1);
  });

  it("reports injectedTaskCount after the shared budget caps rendered tasks", () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      entry({
        label: `fresh-${i}`,
        stale: false,
        description: "Fresh work with enough text to make the active-task block hit its character budget quickly",
        next: "Continue with a specific bounded implementation step before moving to the next task",
      }),
    );
    const bundle = buildActiveTaskContextBundle({
      ledgerTasks: tasks,
      injectionBudgetTokens: 100,
      staleMinutes: 60,
      staleWarningEnabled: false,
      projection: { ...defaultProjection, excludeGenericTitle: false },
    });
    const main = bundle.parts.find((p) => p.includes("<active-tasks>")) ?? "";
    const rendered = main.match(/\[fresh-/g)?.length ?? 0;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(tasks.length);
    expect(bundle.injectedTaskCount).toBe(rendered);
    expect(bundle.filteredActiveCount).toBe(tasks.length);
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

  it("suppresses non-stale orphan subagent placeholders in full projection mode", () => {
    const tasks = [
      entry({
        label: "agent:main:subagent:worker-2",
        description: "Subagent task (session: agent:main:subagent:worker-2)",
        subagent: "agent:main:subagent:worker-2",
        stale: false,
      }),
      entry({
        label: "real-work",
        description: "Investigate projection cleanup",
        stale: false,
      }),
    ];
    const bundle = buildActiveTaskContextBundle({
      ledgerTasks: tasks,
      injectionBudgetTokens: 500,
      staleMinutes: 60,
      staleWarningEnabled: false,
      projection: { ...defaultProjection, mode: "full", excludeGenericTitle: false },
    });
    const main = bundle.parts.find((p) => p.includes("<active-tasks>")) ?? "";
    expect(main).toContain("[real-work]");
    expect(main).not.toContain("agent:main:subagent:worker-2");
    expect(bundle.injectedTaskCount).toBe(1);
  });

  it("excludes Failed rows from heartbeat main injection block", () => {
    const tasks = [
      entry({ label: "failed-task", status: "Failed", description: "Dispatch failed", stale: false }),
      entry({ label: "live-task", status: "In progress", description: "Continue rollout", stale: false }),
    ];
    const bundle = buildActiveTaskContextBundle({
      ledgerTasks: tasks,
      injectionBudgetTokens: 500,
      staleMinutes: 60,
      staleWarningEnabled: false,
      projection: { ...defaultProjection, excludeGenericTitle: false },
      heartbeatHygiene: { maxChars: 800, suggestGoalAfterTaskAgeDays: 0 },
    });
    const main = bundle.parts.find((p) => p.includes("<active-tasks>")) ?? "";
    expect(main).toContain("[live-task]");
    expect(main).not.toContain("[failed-task]");
    expect(bundle.injectedTaskCount).toBe(1);
  });

  it("excludes Failed rows from stale warning when heartbeat hygiene is active", () => {
    const tasks = [
      entry({
        label: "failed-stale",
        status: "Failed",
        description: "Terminal failure",
        stale: true,
        updated: "2020-01-01T00:00:00.000Z",
      }),
      entry({
        label: "live-stale",
        status: "In progress",
        description: "Needs attention",
        stale: true,
        updated: "2020-01-01T00:00:00.000Z",
      }),
    ];
    const bundle = buildActiveTaskContextBundle({
      ledgerTasks: tasks,
      injectionBudgetTokens: 500,
      staleMinutes: 60,
      staleWarningEnabled: true,
      projection: { ...defaultProjection, excludeGenericTitle: false },
      heartbeatHygiene: { maxChars: 800, suggestGoalAfterTaskAgeDays: 0 },
    });
    const staleBlock = bundle.parts.find((p) => p.includes("STALE ACTIVE TASKS")) ?? "";
    expect(staleBlock).toContain("[live-stale]");
    expect(staleBlock).not.toContain("[failed-stale]");
  });
});
