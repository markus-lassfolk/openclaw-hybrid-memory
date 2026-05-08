import { describe, expect, it } from "vitest";
import type { ActiveTaskProjectionConfig } from "../config.js";
import { type ActiveTaskEntry, UNKNOWN_ACTIVE_TASK_TIME } from "../services/active-task.js";
import {
  applyActiveTaskProjectionFilters,
  buildFactsSectionedMarkdownBody,
  buildTaskEntriesFromGroupedFacts,
  displayStatusToFact,
  factStatusToDisplay,
  groupProjectFactsByEntity,
} from "../services/task-ledger-facts.js";
import type { MemoryEntry } from "../types/memory.js";

function fact(partial: Partial<MemoryEntry> & { id: string; entity: string; key: string | null }): MemoryEntry {
  return {
    category: "project",
    importance: 0.7,
    source: "test",
    createdAt: partial.createdAt ?? 1000,
    decayClass: "permanent",
    expiresAt: null,
    lastConfirmedAt: 1000,
    confidence: 1,
    ...partial,
  } as MemoryEntry;
}

describe("task-ledger-facts", () => {
  it("factStatusToDisplay maps common stored values", () => {
    expect(factStatusToDisplay("in_progress")).toBe("In progress");
    expect(factStatusToDisplay("done")).toBe("Done");
    expect(factStatusToDisplay("failed")).toBe("Failed");
    expect(factStatusToDisplay("blocked")).toBe("Stalled");
  });

  it("displayStatusToFact round-trips core statuses", () => {
    expect(displayStatusToFact("In progress")).toBe("in_progress");
    expect(displayStatusToFact("Done")).toBe("done");
  });

  it("groupProjectFactsByEntity keeps latest per key", () => {
    const rows: MemoryEntry[] = [
      fact({ id: "a1", entity: "t1", key: "status", value: "open", createdAt: 1 }),
      fact({ id: "a2", entity: "t1", key: "status", value: "in_progress", createdAt: 2 }),
      fact({ id: "b1", entity: "t1", key: "title", value: "Hello", createdAt: 3 }),
    ];
    const g = groupProjectFactsByEntity(rows);
    const t1 = g.get("t1");
    expect(t1?.get("status")?.value).toBe("in_progress");
    expect(t1?.get("title")?.value).toBe("Hello");
  });

  it("buildTaskEntriesFromGroupedFacts splits active vs terminal", () => {
    const m = new Map<string, Map<string, MemoryEntry>>();
    const r1 = new Map<string, MemoryEntry>();
    r1.set("status", fact({ id: "s1", entity: "open-task", key: "status", value: "in_progress", createdAt: 1 }));
    r1.set("title", fact({ id: "t1", entity: "open-task", key: "title", value: "A", createdAt: 1 }));
    m.set("open-task", r1);
    const r2 = new Map<string, MemoryEntry>();
    r2.set("status", fact({ id: "s2", entity: "done-task", key: "status", value: "done", createdAt: 1 }));
    r2.set("title", fact({ id: "t2", entity: "done-task", key: "title", value: "B", createdAt: 1 }));
    m.set("done-task", r2);
    const { active, completed } = buildTaskEntriesFromGroupedFacts(m);
    expect(active).toHaveLength(1);
    expect(active[0].label).toBe("open-task");
    expect(completed).toHaveLength(1);
    expect(completed[0].label).toBe("done-task");
    expect(completed[0].status).toBe("Done");
  });

  it("derives Started/Updated from fact row createdAt when string fields absent", () => {
    const m = new Map<string, Map<string, MemoryEntry>>();
    const r1 = new Map<string, MemoryEntry>();
    r1.set(
      "status",
      fact({ id: "s1", entity: "task-a", key: "status", value: "in_progress", createdAt: 1_700_000_000 }),
    );
    r1.set("title", fact({ id: "t1", entity: "task-a", key: "title", value: "Real title", createdAt: 1_700_000_100 }));
    m.set("task-a", r1);
    const r2 = new Map<string, MemoryEntry>();
    r2.set(
      "status",
      fact({ id: "s2", entity: "task-b", key: "status", value: "in_progress", createdAt: 1_800_000_000 }),
    );
    r2.set("title", fact({ id: "t2", entity: "task-b", key: "title", value: "Other", createdAt: 1_800_000_200 }));
    m.set("task-b", r2);
    const { active } = buildTaskEntriesFromGroupedFacts(m);
    expect(active).toHaveLength(2);
    expect(active[0].started).not.toBe(active[1].started);
    expect(active[0].updated).not.toBe(active[1].updated);
    expect(active[0].started).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(active[0].updated).toBe(new Date(1_700_000_100 * 1000).toISOString());
  });

  it("readable projection drops generic Project task titles", () => {
    const proj: ActiveTaskProjectionConfig = {
      mode: "readable",
      excludeGenericTitle: true,
      titleMinChars: 0,
      dedupeBy: "none",
      sectioned: true,
    };
    const entries: ActiveTaskEntry[] = [
      {
        label: "a",
        description: "Project task",
        status: "In progress",
        started: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
      },
      {
        label: "b",
        description: "Real work",
        status: "In progress",
        started: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ];
    const filtered = applyActiveTaskProjectionFilters(entries, proj);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].label).toBe("b");
  });

  it("sectioned markdown includes Active and Stale headings", () => {
    const hot: ActiveTaskEntry[] = [
      {
        label: "fresh",
        description: "x",
        status: "In progress",
        started: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-02T00:00:00.000Z",
        stale: false,
      },
    ];
    const stale: ActiveTaskEntry[] = [
      {
        label: "old",
        description: "y",
        status: "In progress",
        started: "2026-01-01T00:00:00.000Z",
        updated: UNKNOWN_ACTIVE_TASK_TIME,
        stale: true,
      },
    ];
    const md = buildFactsSectionedMarkdownBody(hot, stale, [], { active: 0, stale: 0, completed: 0 });
    expect(md).toContain("## Active");
    expect(md).toContain("## Stale — revisit");
    expect(md).toContain("[fresh]");
    expect(md).toContain("[old]");
  });
});
