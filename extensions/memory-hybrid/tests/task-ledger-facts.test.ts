import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ActiveTaskProjectionConfig } from "../config.js";
import { type ActiveTaskEntry, UNKNOWN_ACTIVE_TASK_TIME } from "../services/active-task.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import {
  applyActiveTaskHygieneFacts,
  applyActiveTaskProjectionFilters,
  buildFactsSectionedMarkdownBody,
  buildTaskEntriesFromGroupedFacts,
  displayStatusToFact,
  factStatusToDisplay,
  groupProjectFactsByEntity,
  loadTaskLedgerFromFacts,
  planActiveTaskHygiene,
  taskEntityKey,
  upsertProjectTaskKey,
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

  it("planActiveTaskHygiene detects duplicate variants, dead sessions, and stale failed tasks", async () => {
    const now = Date.now();
    const staleIso = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const freshIso = new Date(now - 20 * 60 * 1000).toISOString();
    const tasks: ActiveTaskEntry[] = [
      {
        label: "proj-1273",
        description: "Issue 1273 active task hygiene",
        status: "In progress",
        subagent: "agent:forge:subagent:dead-aaa",
        started: staleIso,
        updated: staleIso,
      },
      {
        label: "proj 1273",
        description: "Issue 1273 Active Task Hygiene",
        status: "Waiting",
        started: freshIso,
        updated: freshIso,
      },
      {
        label: "proj_1273_copy",
        description: "Issue 1273 active task hygiene",
        status: "Waiting",
        started: freshIso,
        updated: freshIso,
      },
      {
        label: "stale-failure",
        description: "Previous run failed",
        status: "Failed",
        started: staleIso,
        updated: staleIso,
      },
    ];

    const plan = await planActiveTaskHygiene(tasks, {
      olderThanMinutes: 60,
      checkSessionPresent: async () => false,
    });

    expect(plan.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(plan.actions.some((a) => a.label === "proj-1273" && a.kind === "dead-session")).toBe(true);
    expect(plan.actions.some((a) => a.label === "stale-failure" && a.kind === "stale-failed")).toBe(true);
    expect(plan.actions.some((a) => a.label === "proj_1273_copy" && a.kind === "superseded-duplicate")).toBe(true);
  });

  it("planActiveTaskHygiene does not group generic fallback titles as duplicates", async () => {
    const now = Date.now();
    const freshIso = new Date(now - 5 * 60 * 1000).toISOString();
    const tasks: ActiveTaskEntry[] = [
      {
        label: "task-alpha",
        description: "Project task",
        status: "In progress",
        started: freshIso,
        updated: freshIso,
      },
      {
        label: "task-beta",
        description: "Project task",
        status: "In progress",
        started: freshIso,
        updated: freshIso,
      },
    ];
    const plan = await planActiveTaskHygiene(tasks, { olderThanMinutes: 60 });
    expect(plan.duplicates).toHaveLength(0);
    expect(plan.actions.some((a) => a.kind === "superseded-duplicate")).toBe(false);
  });

  it("planActiveTaskHygiene explains unknown updated timestamps in stale reasons", async () => {
    const tasks: ActiveTaskEntry[] = [
      {
        label: "failed-unknown-updated",
        description: "Unknown update timestamp",
        status: "Failed",
        started: "2026-01-01T00:00:00.000Z",
        updated: UNKNOWN_ACTIVE_TASK_TIME,
      },
    ];
    const plan = await planActiveTaskHygiene(tasks, { olderThanMinutes: 60 });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].reason).toContain("missing/unknown updated timestamp");
  });

  it("applyActiveTaskHygieneFacts marks rows as terminal and keeps an audit trail fact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-hygiene-facts-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const vectorDb = {
      hasDuplicate: async () => true,
      store: async () => {},
    } as unknown as VectorDB;
    const embeddings = {
      modelName: "test-model",
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    } as unknown as EmbeddingProvider;
    const staleIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const freshIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const storeTask = (
      entity: string,
      title: string,
      status: string,
      updated: string,
      relatedSession?: string,
      started?: string,
    ): void => {
      const base = {
        category: "project",
        importance: 0.7,
        // Use "active-task" source so loadTaskLedgerFromFacts picks these up.
        source: "active-task",
        decayClass: "permanent" as const,
        entity,
      };
      db.store({ ...base, key: "title", value: title, text: `Task [${entity}] title: ${title}` });
      db.store({ ...base, key: "status", value: status, text: `Task [${entity}] status: ${status}` });
      const startedIso = started ?? updated;
      db.store({ ...base, key: "started", value: startedIso, text: `Task [${entity}] started: ${startedIso}` });
      db.store({ ...base, key: "task_updated", value: updated, text: `Task [${entity}] updated: ${updated}` });
      if (relatedSession) {
        db.store({
          ...base,
          key: "related_session",
          value: relatedSession,
          text: `Task [${entity}] session: ${relatedSession}`,
        });
      }
    };

    try {
      storeTask(
        "proj-1273-a",
        "Issue 1273 active task hygiene",
        "in_progress",
        staleIso,
        "agent:forge:subagent:dead-zzz",
      );
      storeTask("proj-1273-b", "Issue 1273 Active Task Hygiene", "waiting", freshIso);
      storeTask("proj-1273-copy", "Issue 1273 active task hygiene", "waiting", freshIso);
      storeTask("stale-failure", "Failed run", "failed", staleIso);

      const plan = await planActiveTaskHygiene(loadTaskLedgerFromFacts(db).active, {
        olderThanMinutes: 60,
        checkSessionPresent: async () => false,
      });
      const applied = await applyActiveTaskHygieneFacts(db, vectorDb, embeddings, plan);
      expect(applied.appliedCount).toBeGreaterThanOrEqual(3);

      const { active, completed } = loadTaskLedgerFromFacts(db);
      expect(active.some((t) => t.label === "proj-1273-b")).toBe(true);
      expect(active.some((t) => t.label === "proj-1273-copy")).toBe(false);
      expect(completed.some((t) => t.label === "proj-1273-copy")).toBe(true);
      expect(completed.some((t) => t.label === "stale-failure")).toBe(true);

      const projectRows = groupProjectFactsByEntity(db.listFactsByCategory("project", 1000));
      expect(projectRows.get("proj-1273-copy")?.get("status")?.value).toBe("superseded");
      expect(projectRows.get("stale-failure")?.get("status")?.value).toBe("abandoned");
      expect(projectRows.get("proj-1273-copy")?.get("superseded_by")?.value).toBe("proj-1273-b");

      const audits = db.listFactsByCategory("episode", 1000).filter((row) => row.source === "active-task-hygiene");
      expect(audits.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadTaskLedgerFromFacts ignores category:project facts without source='active-task'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-source-filter-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      // Arbitrary project entity stored without the active-task marker.
      db.store({
        category: "project",
        importance: 0.7,
        source: "memory_store",
        decayClass: "permanent",
        entity: "some-random-note",
        key: "pr_1338_plan",
        value: "some plan text",
        text: "Task [some-random-note] pr_1338_plan: some plan text",
      });
      // Another arbitrary entity — no status key at all.
      db.store({
        category: "project",
        importance: 0.7,
        source: "memory_store",
        decayClass: "permanent",
        entity: "release-history",
        key: "v1.0",
        value: "initial release",
        text: "Task [release-history] v1.0: initial release",
      });
      // A real active task — has the marker.
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "real-active-task",
        key: "status",
        value: "in_progress",
        text: "Task [real-active-task] status: in_progress",
      });

      const { active, completed } = loadTaskLedgerFromFacts(db);
      const allLabels = [...active, ...completed].map((t) => t.label);
      expect(allLabels).not.toContain("some-random-note");
      expect(allLabels).not.toContain("release-history");
      expect(allLabels).toContain("real-active-task");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadTaskLedgerFromFacts excludes active-task entities that have no status key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-no-status-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      // Active-task marker present but no status key written yet.
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "incomplete-task",
        key: "title",
        value: "Not yet started",
        text: "Task [incomplete-task] title: Not yet started",
      });
      // Properly formed active task.
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "proper-task",
        key: "status",
        value: "in_progress",
        text: "Task [proper-task] status: in_progress",
      });

      const { active, completed } = loadTaskLedgerFromFacts(db);
      const allLabels = [...active, ...completed].map((t) => t.label);
      // incomplete-task has no status key — must be excluded, not defaulted to in-progress.
      expect(allLabels).not.toContain("incomplete-task");
      expect(allLabels).toContain("proper-task");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("upsertProjectTaskKey does not supersede cached memory_store rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-upsert-source-filter-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const vectorDb = {
      hasDuplicate: async () => true,
      store: async () => {},
    } as unknown as VectorDB;
    const embeddings = {
      modelName: "test-model",
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    } as unknown as EmbeddingProvider;
    try {
      const memoryStoreFact = db.store({
        category: "project",
        importance: 0.7,
        source: "memory_store",
        decayClass: "permanent",
        entity: "proj-1273",
        key: "status",
        value: "legacy-note",
        text: "Task [proj-1273] status: legacy-note",
      });
      const latestByEntityKey = new Map<string, MemoryEntry>();
      latestByEntityKey.set(taskEntityKey("proj-1273", "status"), memoryStoreFact);

      await upsertProjectTaskKey(db, vectorDb, embeddings, "PROJ-1273", "status", "in_progress", undefined, {
        latestByEntityKey,
      });

      const untouched = db.getById(memoryStoreFact.id);
      expect(untouched?.supersededBy).toBeNull();

      const activeRows = db
        .listFactsByCategory("project", 100)
        .filter((row) => row.entity === "proj-1273" && row.key === "status" && row.source === "active-task");
      expect(activeRows.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("groupProjectFactsByEntity merges case-variant entities under a normalised lowercase key", () => {
    const rows: MemoryEntry[] = [
      fact({ id: "h1", entity: "Humanizer", key: "status", value: "in_progress", createdAt: 1, source: "active-task" }),
      fact({
        id: "h2",
        entity: "humanizer",
        key: "title",
        value: "Humanizer task",
        createdAt: 2,
        source: "active-task",
      }),
      fact({ id: "h3", entity: "HUMANIZER", key: "next", value: "do stuff", createdAt: 3, source: "active-task" }),
    ];
    const g = groupProjectFactsByEntity(rows);
    // All three variants should collapse into one group keyed by the lowercase label.
    expect(g.size).toBe(1);
    expect(g.has("humanizer")).toBe(true);
    expect(g.get("humanizer")?.get("status")?.value).toBe("in_progress");
    expect(g.get("humanizer")?.get("title")?.value).toBe("Humanizer task");
    expect(g.get("humanizer")?.get("next")?.value).toBe("do stuff");
  });
});
