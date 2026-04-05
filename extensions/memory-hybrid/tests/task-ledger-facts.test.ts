import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../types/memory.js";
import {
  factStatusToDisplay,
  displayStatusToFact,
  groupProjectFactsByEntity,
  buildTaskEntriesFromGroupedFacts,
} from "../services/task-ledger-facts.js";

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
});
