import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/process-runner.js", () => ({ execFile: execFileMock }));

import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ActiveTaskProjectionConfig } from "../config.js";
import {
  type ActiveTaskEntry,
  UNKNOWN_ACTIVE_TASK_TIME,
  clearActiveTaskHandoff,
  readPendingSignals,
  writeTaskSignal,
} from "../services/active-task.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { initPluginLogger, resetPluginLogger } from "../utils/logger.js";
import { taskLabelsMatch } from "../utils/subagent-ended-utils.js";
import {
  applyActiveTaskHygieneFacts,
  applyActiveTaskProjectionFilters,
  backfillActiveTaskCanonicalLabels,
  buildFactsSectionedMarkdownBody,
  buildTaskEntriesFromGroupedFacts,
  canonicalLabel,
  displayStatusToFact,
  factStatusToDisplay,
  groupProjectFactsByEntity,
  loadTaskLedgerFromFacts,
  loadTaskLedgerFromFactsWithMetrics,
  planActiveTaskHygiene,
  reconcileActiveTaskInProgressSessionsFacts,
  reconcileActiveTaskLiveState,
  consumePendingTaskSignalsFacts,
  renderActiveTaskMarkdownFile,
  syncActiveTaskEntryToFacts,
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

function activeTaskStubs(): { vectorDb: VectorDB; embeddings: EmbeddingProvider } {
  return {
    vectorDb: {
      hasDuplicate: async () => true,
      store: async () => {},
    } as unknown as VectorDB,
    embeddings: {
      modelName: "test-model",
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    } as unknown as EmbeddingProvider,
  };
}

function storeActiveTaskFactRow(db: FactsDB, entity: string, title: string, status = "in_progress"): void {
  const nowIso = new Date().toISOString();
  db.store({
    category: "project",
    importance: 0.7,
    source: "active-task",
    decayClass: "permanent",
    entity,
    key: "title",
    value: title,
    text: `Task [${entity}] title: ${title}`,
  });
  db.store({
    category: "project",
    importance: 0.7,
    source: "active-task",
    decayClass: "permanent",
    entity,
    key: "status",
    value: status,
    text: `Task [${entity}] status: ${status}`,
  });
  db.store({
    category: "project",
    importance: 0.7,
    source: "active-task",
    decayClass: "permanent",
    entity,
    key: "task_updated",
    value: nowIso,
    text: `Task [${entity}] task_updated: ${nowIso}`,
  });
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

  it("groupProjectFactsByEntity ignores superseded and expired rows when selecting current state", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows: MemoryEntry[] = [
      fact({ id: "s-old", entity: "task-1633", key: "status", value: "in_progress", createdAt: 100 }),
      fact({
        id: "s-superseded",
        entity: "task-1633",
        key: "status",
        value: "done",
        createdAt: 500,
        supersededAt: nowSec - 5,
      }),
      fact({
        id: "s-expired",
        entity: "task-1633",
        key: "status",
        value: "waiting",
        createdAt: 600,
        expiresAt: nowSec - 1,
      }),
      fact({ id: "s-current", entity: "task-1633", key: "status", value: "done", createdAt: 300 }),
      fact({ id: "t1", entity: "task-1633", key: "title", value: "Close stale projection bug", createdAt: 300 }),
    ];
    const grouped = groupProjectFactsByEntity(rows);
    expect(grouped.get("task-1633")?.get("status")?.id).toBe("s-current");
    const { active, completed } = buildTaskEntriesFromGroupedFacts(grouped);
    expect(active).toHaveLength(0);
    expect(completed).toHaveLength(1);
    expect(completed[0].label).toBe("task-1633");
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

  it("buildTaskEntriesFromGroupedFacts parses valid handoff JSON and warns on malformed handoff facts", () => {
    const warn = vi.fn();
    initPluginLogger({ info: vi.fn(), warn, error: vi.fn() });
    try {
      const validHandoff = JSON.stringify({
        schema: "octave/task-handoff@v1",
        artifactId: "artifact-1",
        signal: "completed",
        agent: "worker",
        timestamp: "2026-01-01T00:00:00.000Z",
        checksum: "abc123",
      });

      const valid = new Map<string, MemoryEntry>();
      valid.set("status", fact({ id: "s1", entity: "task-valid", key: "status", value: "in_progress", createdAt: 1 }));
      valid.set("title", fact({ id: "t1", entity: "task-valid", key: "title", value: "Valid handoff", createdAt: 1 }));
      valid.set("handoff", fact({ id: "h1", entity: "task-valid", key: "handoff", value: validHandoff, createdAt: 1 }));

      const invalid = new Map<string, MemoryEntry>();
      invalid.set(
        "status",
        fact({ id: "s2", entity: "task-invalid", key: "status", value: "in_progress", createdAt: 1 }),
      );
      invalid.set(
        "title",
        fact({ id: "t2", entity: "task-invalid", key: "title", value: "Bad handoff", createdAt: 1 }),
      );
      invalid.set(
        "handoff",
        fact({ id: "h2", entity: "task-invalid", key: "handoff", value: "{not-json", createdAt: 1 }),
      );

      const grouped = new Map<string, Map<string, MemoryEntry>>([
        ["task-valid", valid],
        ["task-invalid", invalid],
      ]);
      const { active } = buildTaskEntriesFromGroupedFacts(grouped);

      expect(active.find((task) => task.label === "task-valid")?.handoff).toMatchObject({
        artifactId: "artifact-1",
        signal: "completed",
      });
      expect(active.find((task) => task.label === "task-invalid")?.handoff).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to parse active-task handoff JSON for task-invalid"),
      );
    } finally {
      resetPluginLogger();
    }
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

  it("buildTaskEntriesFromGroupedFacts strips placeholder next text for subagent rows", () => {
    const m = new Map<string, Map<string, MemoryEntry>>();
    const row = new Map<string, MemoryEntry>();
    row.set(
      "status",
      fact({ id: "s1", entity: "agent:main:subagent:dead-1", key: "status", value: "in_progress", createdAt: 1 }),
    );
    row.set(
      "title",
      fact({ id: "t1", entity: "agent:main:subagent:dead-1", key: "title", value: "Subagent task", createdAt: 1 }),
    );
    row.set(
      "related_session",
      fact({
        id: "r1",
        entity: "agent:main:subagent:dead-1",
        key: "related_session",
        value: "agent:main:subagent:dead-1",
        createdAt: 1,
      }),
    );
    row.set(
      "next",
      fact({
        id: "n1",
        entity: "agent:main:subagent:dead-1",
        key: "next",
        value: "Task [agent:main:subagent:dead-1] next:",
        createdAt: 1,
      }),
    );
    m.set("agent:main:subagent:dead-1", row);

    const { active } = buildTaskEntriesFromGroupedFacts(m);
    expect(active).toHaveLength(1);
    expect(active[0].next).toBeUndefined();
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
      storeTask("stale-failure", "Failed run", "failed", staleIso, "agent:forge:subagent:stale-fail");
      const staleHandoff = JSON.stringify({
        schema: "octave/task-handoff@v1",
        artifactId: "stale-fail-artifact",
        signal: "update",
        agent: "worker",
        timestamp: staleIso,
        checksum: "abc123",
      });
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "stale-failure",
        key: "handoff",
        value: staleHandoff,
        text: `Task [stale-failure] handoff: ${staleHandoff}`,
      });

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
      expect(completed.find((t) => t.label === "stale-failure")?.subagent).toBeUndefined();
      expect(completed.find((t) => t.label === "stale-failure")?.handoff).toBeUndefined();

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

  it("applyActiveTaskHygieneFacts keeps pr-live-blocker tasks active and clears dead subagent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-hygiene-pr-blocker-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const { vectorDb, embeddings } = activeTaskStubs();
    const updated = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    try {
      await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
        label: "pr-blocker-task",
        description: "Drive owner/repo pull request #99",
        status: "Stalled",
        subagent: "agent:forge:subagent:dead-pr-blocker",
        handoff: {
          schema: "octave/task-handoff@v1",
          artifactId: "pr-blocker-artifact",
          signal: "update",
          agent: "worker",
          timestamp: updated,
          checksum: "abc123",
        },
        started: updated,
        updated,
      });
      const { active } = loadTaskLedgerFromFacts(db);
      const stored = active.find((t) => t.description.includes("#99"));
      expect(stored).toBeDefined();
      const plan = {
        olderThanMinutes: 60,
        duplicates: [] as const,
        stale: [] as const,
        actions: [
          {
            label: stored!.label,
            kind: "pr-live-blocker" as const,
            toStatus: "stage-4-feedback" as const,
            reason:
              "[PR hygiene #99] Live GitHub state: unresolved_review_threads — task updated to reflect actual PR state.",
            prBlockerStatus: "unresolved_review_threads|owner:repo:99",
          },
        ],
      };
      const applied = await applyActiveTaskHygieneFacts(db, vectorDb, embeddings, plan, {
        openclawHome: join(dir, "missing-openclaw-home"),
      });
      expect(applied.appliedCount).toBe(1);
      const reloaded = loadTaskLedgerFromFacts(db);
      const task = reloaded.active.find((t) => taskLabelsMatch(t.label, stored!.label));
      expect(task?.status).toBe("Waiting");
      expect(task?.subagent).toBeUndefined();
      expect(task?.handoff).toBeUndefined();
      expect(reloaded.completed.some((t) => taskLabelsMatch(t.label, stored!.label))).toBe(false);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applyActiveTaskHygieneFacts continues after a single action persist failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-hygiene-partial-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const { vectorDb, embeddings } = activeTaskStubs();
    const staleIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const originalStoreWithResult = FactsDB.prototype.storeWithResult;

    const storeTask = (entity: string, title: string, status: string, updated: string): void => {
      const base = {
        category: "project" as const,
        importance: 0.7,
        source: "active-task" as const,
        decayClass: "permanent" as const,
        entity,
      };
      db.store({ ...base, key: "title", value: title, text: `Task [${entity}] title: ${title}` });
      db.store({ ...base, key: "status", value: status, text: `Task [${entity}] status: ${status}` });
      db.store({ ...base, key: "started", value: updated, text: `Task [${entity}] started: ${updated}` });
      db.store({ ...base, key: "task_updated", value: updated, text: `Task [${entity}] updated: ${updated}` });
    };

    try {
      storeTask("hygiene-ok", "Will apply", "failed", staleIso);
      storeTask("hygiene-fail", "Will fail persist", "failed", staleIso);

      vi.spyOn(FactsDB.prototype, "storeWithResult").mockImplementation(function (this: FactsDB, input) {
        if (input.source === "active-task" && input.entity === "hygiene-fail" && input.key === "status") {
          return {
            skipped: true,
            rejected: true,
            evictedFactId: null,
            embeddingStale: false,
            newlyStored: false,
            preMergeText: null,
            entry: {
              id: "blocked-hygiene-fail",
              text: input.text ?? "",
              category: "project",
              importance: 0.7,
              source: "active-task",
              createdAt: 1,
              decayClass: "permanent",
            },
          };
        }
        return originalStoreWithResult.call(this, input);
      });

      const plan = await planActiveTaskHygiene(loadTaskLedgerFromFacts(db).active, {
        olderThanMinutes: 60,
      });
      const applied = await applyActiveTaskHygieneFacts(db, vectorDb, embeddings, plan);

      expect(applied.appliedCount).toBeGreaterThanOrEqual(1);
      const { active, completed } = loadTaskLedgerFromFacts(db);
      expect(completed.some((t) => t.label === "hygiene-ok")).toBe(true);
      expect(active.some((t) => t.label === "hygiene-fail")).toBe(true);
    } finally {
      vi.restoreAllMocks();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reconcileActiveTaskInProgressSessionsFacts records an audit fact for changed orphan subagent rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-session-reconcile-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const { vectorDb, embeddings } = activeTaskStubs();
    const staleIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    try {
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "agent:main:subagent:dead-1",
        key: "title",
        value: "Subagent task",
        text: "Task [agent:main:subagent:dead-1] title: Subagent task",
      });
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "agent:main:subagent:dead-1",
        key: "status",
        value: "in_progress",
        text: "Task [agent:main:subagent:dead-1] status: in_progress",
      });
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "agent:main:subagent:dead-1",
        key: "task_updated",
        value: staleIso,
        text: `Task [agent:main:subagent:dead-1] task_updated: ${staleIso}`,
      });
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "agent:main:subagent:dead-1",
        key: "related_session",
        value: "agent:main:subagent:dead-1",
        text: "Task [agent:main:subagent:dead-1] related_session: agent:main:subagent:dead-1",
      });
      const handoff = JSON.stringify({
        schema: "octave/task-handoff@v1",
        artifactId: "dead-artifact",
        signal: "update",
        agent: "worker",
        timestamp: staleIso,
        checksum: "abc123",
      });
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "agent:main:subagent:dead-1",
        key: "handoff",
        value: handoff,
        text: `Task [agent:main:subagent:dead-1] handoff: ${handoff}`,
      });

      const result = await reconcileActiveTaskInProgressSessionsFacts(db, vectorDb, embeddings, 60, {
        openclawHome: dir,
      });

      expect(result.reconciledLabels).toEqual(["agent:main:subagent:dead-1"]);
      expect(result.wrote).toBe(true);

      const { active, completed } = loadTaskLedgerFromFacts(db);
      expect(active.some((task) => task.label === "agent:main:subagent:dead-1")).toBe(false);
      expect(completed.some((task) => task.label === "agent:main:subagent:dead-1")).toBe(true);
      expect(completed.find((task) => task.label === "agent:main:subagent:dead-1")?.handoff).toBeUndefined();

      const audits = db
        .listFactsByCategory("episode", 1000)
        .filter((row) => row.source === "active-task-session-reconcile");
      expect(audits).toHaveLength(1);
      expect(audits[0].value).toContain("agent:main:subagent:dead-1");
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

  it("loadTaskLedgerFromFactsWithMetrics reports fetched rows and collapsed duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-metrics-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "ship-release",
        key: "status",
        value: "open",
        text: "Task [ship-release] status: open",
        sourceDate: 1,
      });
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "ship-release",
        key: "status",
        value: "in_progress",
        text: "Task [ship-release] status: in_progress",
        sourceDate: 2,
      });
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "ship-release",
        key: "title",
        value: "Ship the release",
        text: "Task [ship-release] title: Ship the release",
        sourceDate: 3,
      });
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "draft-docs",
        key: "title",
        value: "Draft docs",
        text: "Task [draft-docs] title: Draft docs",
        sourceDate: 4,
      });

      const result = loadTaskLedgerFromFactsWithMetrics(db);
      expect(result.active).toHaveLength(1);
      expect(result.completed).toHaveLength(0);
      expect(result.metrics).toMatchObject({
        projectRowsFetched: 4,
        groupedEntityCount: 2,
        duplicateRowsCollapsed: 1,
        activeCandidates: 1,
        completedCandidates: 0,
        entitiesSkippedWithoutStatus: 1,
      });
      expect(result.metrics.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renderActiveTaskMarkdownFile emits projection diagnostics when a logger is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-render-metrics-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const logger = { debug: vi.fn() };
    try {
      const staleUpdated = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const freshUpdated = new Date().toISOString();
      for (const [entity, title, updated] of [
        ["fresh-task", "Fresh task", freshUpdated],
        ["stale-task", "Stale task", staleUpdated],
      ] as const) {
        db.store({
          category: "project",
          importance: 0.7,
          source: "active-task",
          decayClass: "permanent",
          entity,
          key: "title",
          value: title,
          text: `Task [${entity}] title: ${title}`,
        });
        db.store({
          category: "project",
          importance: 0.7,
          source: "active-task",
          decayClass: "permanent",
          entity,
          key: "status",
          value: "in_progress",
          text: `Task [${entity}] status: in_progress`,
        });
        db.store({
          category: "project",
          importance: 0.7,
          source: "active-task",
          decayClass: "permanent",
          entity,
          key: "task_updated",
          value: updated,
          text: `Task [${entity}] task_updated: ${updated}`,
        });
      }

      await renderActiveTaskMarkdownFile(
        db,
        60,
        join(dir, "ACTIVE-TASKS.md"),
        {
          mode: "readable",
          excludeGenericTitle: true,
          titleMinChars: 0,
          dedupeBy: "none",
          sectioned: true,
        },
        logger,
      );

      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("memory-hybrid: active-task projection rowsFetched=6"),
      );
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("groupedEntities=2"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("activeCandidates=2"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("staleBucketed=1"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("renderedActive=1"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("renderedStale=1"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("elapsedMs="));
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renderActiveTaskMarkdownFile preserves goals mirror across re-renders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-render-goals-preserve-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      storeActiveTaskFactRow(db, "render-goal-task", "Active work", "in_progress");
      const outPath = join(dir, "ACTIVE-TASKS.md");
      await writeFile(
        outPath,
        `# ACTIVE-TASKS.md

## Active Goals
_Mirror from goal registry — do not edit by hand; refreshed on heartbeat._

### [deploy]: Ship it

## Active

### [old-task]: stale
`,
        "utf-8",
      );

      await renderActiveTaskMarkdownFile(
        db,
        60,
        outPath,
        {
          mode: "readable",
          excludeGenericTitle: true,
          titleMinChars: 0,
          dedupeBy: "none",
          sectioned: true,
        },
        undefined,
      );

      const rendered = await readFile(outPath, "utf-8");
      expect(rendered).toContain("[render-goal-task]");
      expect(rendered).toContain("## Active Goals");
      expect(rendered).toContain("### [deploy]: Ship it");
      expect(rendered).not.toContain("[old-task]");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renderActiveTaskMarkdownFile excludes completed rows by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-render-default-active-only-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      storeActiveTaskFactRow(db, "active-task-1633", "Active task", "in_progress");
      storeActiveTaskFactRow(db, "done-task-1633", "Done task", "done");

      const outPath = join(dir, "ACTIVE-TASKS.md");
      await renderActiveTaskMarkdownFile(
        db,
        60,
        outPath,
        {
          mode: "readable",
          excludeGenericTitle: true,
          titleMinChars: 0,
          dedupeBy: "none",
          sectioned: true,
        },
        undefined,
      );

      const rendered = await readFile(outPath, "utf-8");
      expect(rendered).toContain("## Active");
      expect(rendered).toContain("[active-task-1633]");
      expect(rendered).not.toContain("## Completed");
      expect(rendered).not.toContain("[done-task-1633]");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renderActiveTaskMarkdownFile includes completed rows in explicit history mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-render-history-"));
    const db = new FactsDB(join(dir, "facts.db"));
    try {
      storeActiveTaskFactRow(db, "active-task-history", "Active task", "in_progress");
      storeActiveTaskFactRow(db, "done-task-history", "Done task", "done");

      const outPath = join(dir, "ACTIVE-TASKS.md");
      await renderActiveTaskMarkdownFile(
        db,
        60,
        outPath,
        {
          mode: "readable",
          excludeGenericTitle: true,
          titleMinChars: 0,
          dedupeBy: "none",
          sectioned: true,
        },
        undefined,
        { includeCompleted: true },
      );

      const rendered = await readFile(outPath, "utf-8");
      expect(rendered).toContain("## Active");
      expect(rendered).toContain("[active-task-history]");
      expect(rendered).toContain("## Completed");
      expect(rendered).toContain("[done-task-history]");
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

  it("upsertProjectTaskKey status writes supersede canonical-variant active-task rows even when cache misses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-ledger-upsert-status-canonical-"));
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
      const prior = db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "proj-1633 pr queue",
        key: "status",
        value: "in_progress",
        text: "Task [proj-1633 pr queue] status: in_progress",
      });

      await upsertProjectTaskKey(db, vectorDb, embeddings, "proj-1633", "status", "done", undefined, {
        latestByEntityKey: new Map<string, MemoryEntry>(),
      });

      const priorAfter = db.getById(prior.id);
      expect(priorAfter?.supersededBy).toBeTruthy();
      expect(priorAfter?.supersededAt).toBeTypeOf("number");

      const { active, completed } = loadTaskLedgerFromFacts(db);
      expect(active.some((task) => canonicalLabel(task.label) === "proj-1633")).toBe(false);
      expect(completed.some((task) => canonicalLabel(task.label) === "proj-1633")).toBe(true);
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

it("canonicalLabel collapses case, separators, and active-task suffix variants", () => {
  expect(canonicalLabel(" Hybrid_Memory PR Queue ")).toBe("hybrid-memory");
  expect(canonicalLabel("hybrid-memory pr-stewardship")).toBe("hybrid-memory");
  expect(canonicalLabel("Humanizer")).toBe("humanizer");
});

it("factStatusToDisplay maps common stored values case-insensitively", () => {
  expect(factStatusToDisplay("in_progress")).toBe("In progress");
  expect(factStatusToDisplay("Done")).toBe("Done");
  expect(factStatusToDisplay("COMPLETED")).toBe("Done");
  expect(factStatusToDisplay("failed")).toBe("Failed");
  expect(factStatusToDisplay("blocked")).toBe("Stalled");
});

it("groupProjectFactsByEntity collapses case-variant labels by canonical label", () => {
  const rows: MemoryEntry[] = [
    fact({ id: "a1", entity: "humanizer", key: "status", value: "in_progress", createdAt: 1 }),
    fact({ id: "a2", entity: "Humanizer", key: "status", value: "Done", createdAt: 3 }),
    fact({ id: "b1", entity: "humanizer", key: "title", value: "Old title", createdAt: 2 }),
    fact({ id: "b2", entity: "Humanizer", key: "title", value: "New title", createdAt: 4 }),
  ];
  const g = groupProjectFactsByEntity(rows);
  expect(g.size).toBe(1);
  const row = g.get("humanizer");
  expect(row?.get("status")?.value).toBe("Done");
  expect(row?.get("title")?.value).toBe("New title");
});

it("groupProjectFactsByEntity uses sourceDate tie-break when createdAt is equal", () => {
  // Issue #1624: when createdAt is equal, sourceDate is the tie-breaker.
  // The fact with the higher sourceDate (more recent external event) wins.
  const rows: MemoryEntry[] = [
    // Stale in_progress fact written earlier (createdAt equal to done, but older sourceDate)
    fact({ id: "a1", entity: "proj-1624", key: "status", value: "in_progress", createdAt: 1000, sourceDate: 900 }),
    // Terminal done fact: same createdAt, but newer sourceDate (more recent live event)
    fact({ id: "a2", entity: "proj-1624", key: "status", value: "done", createdAt: 1000, sourceDate: 1000 }),
    // Also write a stale "next" field from the old checkpoint so we can verify
    // that status comes from the newer fact (a2) and not mixed with stale fields.
    fact({ id: "a3", entity: "proj-1624", key: "next", value: "Closed by live audit", createdAt: 950 }),
  ];
  const g = groupProjectFactsByEntity(rows);
  const row = g.get("proj-1624");
  // Status must be "done" (newer sourceDate wins the tie-break at same createdAt)
  expect(row?.get("status")?.value).toBe("done");
  // Next should still be the latest fact for the "next" key
  expect(row?.get("next")?.value).toBe("Closed by live audit");
});

it("groupProjectFactsByEntity prefers missing sourceDate over stale sourceDate when createdAt is equal", () => {
  const rows: MemoryEntry[] = [
    fact({ id: "a1", entity: "proj-source-null", key: "status", value: "done", createdAt: 1000 }),
    fact({
      id: "a2",
      entity: "proj-source-null",
      key: "status",
      value: "in_progress",
      createdAt: 1000,
      sourceDate: 1001,
    }),
  ];
  const g = groupProjectFactsByEntity(rows);
  const row = g.get("proj-source-null");
  expect(row?.get("status")?.value).toBe("done");
});

it("groupProjectFactsByEntity preserves terminal status even when it has sourceDate and non-terminal lacks it", () => {
  // Bug #1624/#1625: terminal status with sourceDate should beat non-terminal without sourceDate
  const rows: MemoryEntry[] = [
    fact({
      id: "a1",
      entity: "proj-terminal-sourcedate",
      key: "status",
      value: "done",
      createdAt: 1000,
      sourceDate: 999,
    }),
    fact({
      id: "a2",
      entity: "proj-terminal-sourcedate",
      key: "status",
      value: "in_progress",
      createdAt: 1000,
    }),
  ];
  const g = groupProjectFactsByEntity(rows);
  const row = g.get("proj-terminal-sourcedate");
  expect(row?.get("status")?.value).toBe("done");
});

it("groupProjectFactsByEntity uses insertion order tie-break when createdAt and sourceDate are equal", () => {
  // Last-write wins by insertion order when timestamps tie and rowid is unavailable.
  const rows: MemoryEntry[] = [
    fact({ id: "z9", entity: "proj-tie", key: "status", value: "in_progress", createdAt: 500, sourceDate: undefined }),
    fact({ id: "a1", entity: "proj-tie", key: "status", value: "done", createdAt: 500, sourceDate: undefined }),
  ];
  const g = groupProjectFactsByEntity(rows);
  const row = g.get("proj-tie");
  expect(row?.get("status")?.value).toBe("done");
});

it("groupProjectFactsByEntity keeps terminal status over non-terminal when all timestamps equal", () => {
  // This is the exact bug from #1624: in_progress and done share createdAt.
  // With insertion-order tie-break, the later write wins for each key.
  const rows: MemoryEntry[] = [
    fact({ id: "aa", entity: "proj-1624-bug", key: "status", value: "in_progress", createdAt: 2000 }),
    fact({ id: "bb", entity: "proj-1624-bug", key: "status", value: "done", createdAt: 2000 }),
    fact({ id: "aa", entity: "proj-1624-bug", key: "next", value: "Closed...", createdAt: 1999 }),
    fact({ id: "bb", entity: "proj-1624-bug", key: "next", value: "Still active...", createdAt: 2000 }),
  ];
  const g = groupProjectFactsByEntity(rows);
  const row = g.get("proj-1624-bug");
  // Status: later "done" write wins.
  expect(row?.get("status")?.value).toBe("done");
  // Next: later write for "next" also wins.
  expect(row?.get("next")?.value).toBe("Still active...");
});

it("upserting Humanizer as done suppresses humanizer case-variant rows from active projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-ledger-canonical-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const vectorDb = {
    hasDuplicate: async () => true,
    store: async () => {},
  } as unknown as VectorDB;
  const embeddings = {
    modelName: "test-model",
    embed: async () => new Float32Array([0.1, 0.2, 0.3]),
  } as unknown as EmbeddingProvider;
  const now = new Date().toISOString();

  try {
    db.store({
      text: "Task [humanizer] title: old",
      category: "project",
      importance: 0.7,
      source: "test",
      decayClass: "permanent",
      entity: "humanizer",
      key: "title",
      value: "Old humanizer task",
    });
    db.store({
      text: "Task [humanizer] status: in_progress",
      category: "project",
      importance: 0.7,
      source: "test",
      decayClass: "permanent",
      entity: "humanizer",
      key: "status",
      value: "in_progress",
    });
    db.store({
      text: `Task [humanizer] task_updated: ${now}`,
      category: "project",
      importance: 0.7,
      source: "test",
      decayClass: "permanent",
      entity: "humanizer",
      key: "task_updated",
      value: now,
    });

    await syncActiveTaskEntryToFacts(
      db,
      vectorDb,
      embeddings,
      {
        label: "Humanizer",
        description: "Closed humanizer task",
        status: "Done",
        started: now,
        updated: now,
      },
      undefined,
      { statusOverride: "DONE" },
    );

    const { active, completed } = loadTaskLedgerFromFacts(db);
    expect(active.some((t) => canonicalLabel(t.label) === "humanizer")).toBe(false);
    expect(completed).toHaveLength(1);
    expect(canonicalLabel(completed[0].label)).toBe("humanizer");
    expect(completed[0].status).toBe("Done");
    expect(completed[0].description).toBe("Closed humanizer task");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("backfillActiveTaskCanonicalLabels collapses legacy case-variant duplicate facts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-ledger-backfill-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const now = new Date().toISOString();
  try {
    for (const [entity, status, offset] of [
      ["hybrid-memory", "in_progress", 1],
      ["Hybrid-Memory", "DONE", 2],
      ["Hybrid-memory PR Queue", "in_progress", 3],
    ] as const) {
      db.store({
        text: `Task [${entity}] status: ${status}`,
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity,
        key: "status",
        value: status,
        sourceDate: Date.now() / 1000 + offset,
      });
      db.store({
        text: `Task [${entity}] task_updated: ${now}`,
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity,
        key: "task_updated",
        value: now,
        sourceDate: Date.now() / 1000 + offset,
      });
    }

    const result = backfillActiveTaskCanonicalLabels(db);
    expect(result.scannedFacts).toBe(6);
    expect(result.canonicalLabelsUpdated).toBe(6);
    expect(result.supersededFacts).toBeGreaterThan(0);
    const { active, completed } = loadTaskLedgerFromFacts(db);
    expect(active.some((t) => canonicalLabel(t.label) === "hybrid-memory")).toBe(false);
    expect(completed.some((t) => canonicalLabel(t.label) === "hybrid-memory")).toBe(true);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("backfillActiveTaskCanonicalLabels preserves provenance and avoids superseded keepers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-ledger-backfill-provenance-"));
  const db = new FactsDB(join(dir, "facts.db"));
  try {
    const supersededDone = db.store({
      text: "Task [Hybrid-Memory] status: done",
      category: "project",
      importance: 0.7,
      source: "test",
      decayClass: "permanent",
      entity: "Hybrid-Memory",
      key: "status",
      value: "done",
      provenanceJson: JSON.stringify({ sourceEventIds: ["evt-1"], method: "fixture" }),
      sourceDate: 3,
    });
    const activeProgress = db.store({
      text: "Task [hybrid-memory] status: in_progress",
      category: "project",
      importance: 0.7,
      source: "test",
      decayClass: "permanent",
      entity: "hybrid-memory",
      key: "status",
      value: "in_progress",
      provenanceJson: JSON.stringify({ sourceEventIds: ["evt-2"], method: "active-fixture" }),
      sourceDate: 2,
    });
    db.supersede(supersededDone.id, null);

    const olderTitle = db.store({
      text: "Task [hybrid-memory] title: Old",
      category: "project",
      importance: 0.7,
      source: "test",
      decayClass: "permanent",
      entity: "hybrid-memory",
      key: "title",
      value: "Old",
      sourceDate: 1,
    });
    const newerSupersededTitle = db.store({
      text: "Task [Hybrid-Memory] title: Newer but superseded",
      category: "project",
      importance: 0.7,
      source: "test",
      decayClass: "permanent",
      entity: "Hybrid-Memory",
      key: "title",
      value: "Newer but superseded",
      sourceDate: 4,
    });
    db.supersede(newerSupersededTitle.id, null);

    const result = backfillActiveTaskCanonicalLabels(db);
    expect(result.canonicalLabelsUpdated).toBe(2);

    const updatedProgress = db
      .getRawDb()
      .prepare("SELECT provenance_json FROM facts WHERE id = ?")
      .get(activeProgress.id) as {
      provenance_json: string;
    };
    expect(JSON.parse(updatedProgress.provenance_json)).toMatchObject({
      sourceEventIds: ["evt-2"],
      method: "active-fixture",
      activeTask: { canonicalLabel: "hybrid-memory" },
      canonical_label: "hybrid-memory",
    });

    const rows = db.listFactsByCategory("project", 20);
    expect(rows.find((row) => row.id === activeProgress.id)?.supersededAt).toBeNull();
    expect(rows.find((row) => row.id === olderTitle.id)?.supersededAt).toBeNull();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("terminal status supersession does not supersede title fact created in same sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-title-preservation-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const vectorDb = {
    hasDuplicate: async () => true,
    store: async () => {},
  } as unknown as VectorDB;
  const embeddings = {
    modelName: "test-model",
    embed: async () => new Float32Array([0.1, 0.2, 0.3]),
  } as unknown as EmbeddingProvider;
  const now = new Date().toISOString();

  try {
    await syncActiveTaskEntryToFacts(
      db,
      vectorDb,
      embeddings,
      {
        label: "my-task",
        description: "Specific title for this task",
        status: "Done",
        started: now,
        updated: now,
      },
      undefined,
      { statusOverride: "done" },
    );

    const { completed } = loadTaskLedgerFromFacts(db);
    expect(completed).toHaveLength(1);
    expect(completed[0].label).toBe("my-task");
    expect(completed[0].description).toBe("Specific title for this task");
    expect(completed[0].status).toBe("Done");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("syncActiveTaskEntryToFacts preserves optional fields when omitted from entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-partial-sync-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();

  try {
    await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
      label: "forge-task",
      description: "Implement feature",
      status: "In progress",
      next: "Write tests",
      branch: "feature/forge",
      relatedGoal: "goal-abc",
      started: now,
      updated: now,
    });

    await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
      label: "forge-task",
      description: "Implement feature (spawn refresh)",
      status: "In progress",
      subagent: "agent:main:subagent:abc",
      started: now,
      updated: new Date(Date.now() + 1000).toISOString(),
    });

    const { active } = loadTaskLedgerFromFacts(db);
    expect(active).toHaveLength(1);
    expect(active[0].next).toBe("Write tests");
    expect(active[0].branch).toBe("feature/forge");
    expect(active[0].relatedGoal).toBe("goal-abc");
    expect(active[0].subagent).toBe("agent:main:subagent:abc");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("syncActiveTaskEntryToFacts clears handoff when handoff is explicitly set undefined", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-handoff-clear-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();
  const handoff = {
    schema: "octave/task-handoff@v1",
    artifactId: "artifact-1",
    signal: "update",
    agent: "worker",
    timestamp: now,
    checksum: "abc123",
  };

  try {
    await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
      label: "handoff-task",
      description: "Task with handoff",
      status: "Failed",
      handoff,
      next: "Fix: stale",
      started: now,
      updated: now,
    });

    await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
      label: "handoff-task",
      description: "Task reopened",
      status: "In progress",
      handoff: undefined,
      next: "",
      subagent: "agent:main:subagent:new",
      started: now,
      updated: new Date(Date.now() + 1000).toISOString(),
    });

    const { active } = loadTaskLedgerFromFacts(db);
    expect(active).toHaveLength(1);
    expect(active[0].handoff).toBeUndefined();
    expect(active[0].next).toBeUndefined();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("syncActiveTaskEntryToFacts writes related_goal when provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-related-goal-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();

  try {
    await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
      label: "goal-backed-task",
      description: "Work tied to a goal",
      status: "In progress",
      relatedGoal: "goal-1271",
      started: now,
      updated: now,
    });

    const { active } = loadTaskLedgerFromFacts(db);
    expect(active[0]?.relatedGoal).toBe("goal-1271");
    const row = db
      .listFactsByCategory("project", 20)
      .find((f) => f.entity === "goal-backed-task" && f.key === "related_goal");
    expect(row?.value).toBe("goal-1271");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("syncActiveTaskEntryToFacts fails fast when a required key is blocked by pre-store guard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-upsert-guard-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();
  const originalStoreWithResult = FactsDB.prototype.storeWithResult;

  try {
    vi.spyOn(FactsDB.prototype, "storeWithResult").mockImplementation(function (this: FactsDB, input) {
      if (input.source === "active-task" && input.key === "status") {
        return {
          skipped: true,
          rejected: true,
          evictedFactId: null,
          embeddingStale: false,
          newlyStored: false,
          preMergeText: null,
          entry: {
            id: "blocked-status-id",
            text: input.text ?? "",
            category: "project",
            importance: 0.7,
            source: "active-task",
            createdAt: 1,
            decayClass: "permanent",
          },
        };
      }
      return originalStoreWithResult.call(this, input);
    });

    await expect(
      syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
        label: "guard-task",
        description: "Should not partially persist",
        status: "In progress",
        started: now,
        updated: now,
      }),
    ).rejects.toThrow(/pre-store guard/);

    const rows = db.listFactsByCategory("project", 20).filter((f) => f.entity === "guard-task");
    expect(rows.some((f) => f.key === "status")).toBe(false);
    expect(rows.some((f) => f.key === "title")).toBe(false);
  } finally {
    vi.restoreAllMocks();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("syncActiveTaskEntryToFacts rolls back handoff retire when a later key fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-handoff-rollback-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();
  const originalStoreWithResult = FactsDB.prototype.storeWithResult;
  const handoff = {
    schema: "octave/task-handoff@v1",
    artifactId: "artifact-rollback",
    signal: "update" as const,
    agent: "worker",
    timestamp: now,
    checksum: "abc123",
  };

  try {
    await syncActiveTaskEntryToFacts(db, vectorDb, embeddings, {
      label: "handoff-task",
      description: "Task with handoff",
      status: "In progress",
      started: now,
      updated: now,
      handoff,
    });

    vi.spyOn(FactsDB.prototype, "storeWithResult").mockImplementation(function (this: FactsDB, input) {
      if (input.source === "active-task" && input.entity === "handoff-task" && input.key === "related_goal") {
        return {
          skipped: true,
          rejected: true,
          evictedFactId: null,
          embeddingStale: false,
          newlyStored: false,
          preMergeText: null,
          entry: {
            id: "blocked-related-goal",
            text: input.text ?? "",
            category: "project",
            importance: 0.7,
            source: "active-task",
            createdAt: 1,
            decayClass: "permanent",
          },
        };
      }
      return originalStoreWithResult.call(this, input);
    });

    const failingEntry: ActiveTaskEntry = {
      label: "handoff-task",
      description: "Task with handoff",
      status: "In progress",
      started: now,
      updated: now,
      relatedGoal: "goal-rollback-test",
    };
    clearActiveTaskHandoff(failingEntry);

    await expect(syncActiveTaskEntryToFacts(db, vectorDb, embeddings, failingEntry)).rejects.toThrow(/pre-store guard/);

    const { active } = loadTaskLedgerFromFacts(db);
    const task = active.find((t) => t.label === "handoff-task");
    expect(task?.handoff?.artifactId).toBe("artifact-rollback");
  } finally {
    vi.restoreAllMocks();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("reconcileActiveTaskInProgressSessionsFacts skips audit fact id when reconcile audit is guard-blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-reconcile-audit-guard-"));
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const staleIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const originalStoreWithResult = FactsDB.prototype.storeWithResult;

  try {
    db.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "agent:main:subagent:dead-audit",
      key: "title",
      value: "Subagent task",
      text: "Task [agent:main:subagent:dead-audit] title: Subagent task",
    });
    db.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "agent:main:subagent:dead-audit",
      key: "status",
      value: "in_progress",
      text: "Task [agent:main:subagent:dead-audit] status: in_progress",
    });
    db.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "agent:main:subagent:dead-audit",
      key: "task_updated",
      value: staleIso,
      text: `Task [agent:main:subagent:dead-audit] task_updated: ${staleIso}`,
    });
    db.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "agent:main:subagent:dead-audit",
      key: "related_session",
      value: "agent:main:subagent:dead-audit",
      text: "Task [agent:main:subagent:dead-audit] related_session: agent:main:subagent:dead-audit",
    });

    vi.spyOn(FactsDB.prototype, "storeWithResult").mockImplementation(function (this: FactsDB, input) {
      if (input.source === "active-task-session-reconcile") {
        return {
          skipped: true,
          rejected: true,
          evictedFactId: null,
          embeddingStale: false,
          newlyStored: false,
          preMergeText: null,
          entry: {
            id: "bogus-audit-id",
            text: input.text ?? "",
            category: "episode",
            importance: 0.7,
            source: "active-task-session-reconcile",
            createdAt: 1,
            decayClass: "permanent",
          },
        };
      }
      return originalStoreWithResult.call(this, input);
    });

    const result = await reconcileActiveTaskInProgressSessionsFacts(db, vectorDb, embeddings, 60, {
      openclawHome: dir,
    });

    expect(result.reconciledLabels).toEqual(["agent:main:subagent:dead-audit"]);
    const audits = db
      .listFactsByCategory("episode", 1000)
      .filter((row) => row.source === "active-task-session-reconcile");
    expect(audits).toHaveLength(0);
    expect(db.getById("bogus-audit-id")).toBeNull();
  } finally {
    vi.restoreAllMocks();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("consumePendingTaskSignalsFacts deletes only signals whose facts persist succeeded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-signal-partial-"));
  const workspaceRoot = join(dir, "workspace");
  const memoryDir = join(workspaceRoot, "memory");
  await mkdir(memoryDir, { recursive: true });
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();
  const originalStoreWithResult = FactsDB.prototype.storeWithResult;

  const seedTask = (entity: string, title: string) => {
    for (const [key, value] of [
      ["title", title],
      ["status", "in_progress"],
      ["task_updated", now],
      ["started", now],
    ] as const) {
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity,
        key,
        value,
        text: `Task [${entity}] ${key}: ${value}`,
      });
    }
  };

  try {
    seedTask("ok-task", "First task");
    seedTask("fail-task", "Second task");

    await writeTaskSignal(
      "ok-task",
      { agent: "sub-1", taskRef: "ok-task", signal: "update", summary: "first ok", timestamp: now },
      memoryDir,
    );
    await writeTaskSignal(
      "fail-task",
      { agent: "sub-2", taskRef: "fail-task", signal: "update", summary: "second fails", timestamp: now },
      memoryDir,
    );

    vi.spyOn(FactsDB.prototype, "storeWithResult").mockImplementation(function (this: FactsDB, input) {
      if (input.source === "active-task" && input.entity === "fail-task" && input.key === "status") {
        return {
          skipped: true,
          rejected: true,
          evictedFactId: null,
          embeddingStale: false,
          newlyStored: false,
          preMergeText: null,
          entry: {
            id: "blocked-fail-task-status",
            text: input.text ?? "",
            category: "project",
            importance: 0.7,
            source: "active-task",
            createdAt: 1,
            decayClass: "permanent",
          },
        };
      }
      return originalStoreWithResult.call(this, input);
    });

    await consumePendingTaskSignalsFacts(workspaceRoot, 60, false, db, vectorDb, embeddings);

    const { active } = loadTaskLedgerFromFacts(db);
    expect(active.find((t) => t.label === "ok-task")?.next).toContain("first ok");
    expect(active.find((t) => t.label === "fail-task")?.next ?? "").not.toContain("second fails");

    const pending = await readPendingSignals(memoryDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.taskRef).toBe("fail-task");
  } finally {
    vi.restoreAllMocks();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("consumePendingTaskSignalsFacts drops signals for terminal Failed tasks without reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-signal-terminal-"));
  const workspaceRoot = join(dir, "workspace");
  const memoryDir = join(workspaceRoot, "memory");
  await mkdir(memoryDir, { recursive: true });
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();

  const seedTask = (entity: string, title: string, status: string) => {
    for (const [key, value] of [
      ["title", title],
      ["status", status],
      ["task_updated", now],
      ["started", now],
    ] as const) {
      db.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity,
        key,
        value,
        text: `Task [${entity}] ${key}: ${value}`,
      });
    }
  };

  try {
    seedTask("failed-task", "Already failed", "failed");
    await writeTaskSignal(
      "failed-task",
      { agent: "sub-1", taskRef: "failed-task", signal: "blocked", summary: "should not reopen", timestamp: now },
      memoryDir,
    );

    await consumePendingTaskSignalsFacts(workspaceRoot, 60, false, db, vectorDb, embeddings);

    const { active } = loadTaskLedgerFromFacts(db);
    const task = active.find((t) => t.label === "failed-task");
    expect(task?.status).toBe("Failed");
    expect(task?.next ?? "").not.toContain("should not reopen");
    expect(await readPendingSignals(memoryDir)).toHaveLength(0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("consumePendingTaskSignalsFacts replaces stale handoff with completed signal handoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-signal-complete-handoff-"));
  const workspaceRoot = join(dir, "workspace");
  const memoryDir = join(workspaceRoot, "memory");
  await mkdir(memoryDir, { recursive: true });
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();
  const handoff = JSON.stringify({
    schema: "octave/task-handoff@v1",
    artifactId: "complete-artifact",
    signal: "update",
    agent: "worker",
    timestamp: now,
    checksum: "abc123",
  });

  for (const [key, value] of [
    ["title", "Completing task"],
    ["status", "in_progress"],
    ["task_updated", now],
    ["started", now],
    ["handoff", handoff],
  ] as const) {
    db.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "complete-handoff-task",
      key,
      value,
      text: `Task [complete-handoff-task] ${key}: ${value}`,
    });
  }

  try {
    await writeTaskSignal(
      "complete-handoff-task",
      {
        agent: "sub-1",
        taskRef: "complete-handoff-task",
        signal: "completed",
        summary: "all done",
        timestamp: now,
      },
      memoryDir,
    );

    await consumePendingTaskSignalsFacts(workspaceRoot, 60, false, db, vectorDb, embeddings);

    const { active, completed } = loadTaskLedgerFromFacts(db);
    expect(active.some((t) => t.label === "complete-handoff-task")).toBe(false);
    const task = completed.find((t) => t.label === "complete-handoff-task");
    expect(task?.status).toBe("Done");
    expect(task?.handoff?.signal).toBe("completed");
    expect(task?.handoff?.artifactId).not.toBe("complete-artifact");
    expect(await readPendingSignals(memoryDir)).toHaveLength(0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("consumePendingTaskSignalsFacts drops completed signals for Done tasks in completed list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-signal-done-"));
  const workspaceRoot = join(dir, "workspace");
  const memoryDir = join(workspaceRoot, "memory");
  await mkdir(memoryDir, { recursive: true });
  const db = new FactsDB(join(dir, "facts.db"));
  const { vectorDb, embeddings } = activeTaskStubs();
  const now = new Date().toISOString();

  for (const [key, value] of [
    ["title", "Finished task"],
    ["status", "done"],
    ["task_updated", now],
    ["started", now],
  ] as const) {
    db.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "done-task",
      key,
      value,
      text: `Task [done-task] ${key}: ${value}`,
    });
  }

  try {
    await writeTaskSignal(
      "done-task",
      { agent: "sub-1", taskRef: "done-task", signal: "completed", summary: "late duplicate", timestamp: now },
      memoryDir,
    );

    await consumePendingTaskSignalsFacts(workspaceRoot, 60, false, db, vectorDb, embeddings);

    expect(await readPendingSignals(memoryDir)).toHaveLength(0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("reconcileActiveTaskLiveState", () => {
  it("parses PR/issue refs correctly and defaults bare owner/repo#N to issue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-live-state-parse-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const { vectorDb, embeddings } = activeTaskStubs();
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (_file: string, args: string[], _opts: unknown, cb: (err: null, result: { stdout: string }) => void) => {
        if (args[0] === "pr") {
          cb(null, { stdout: JSON.stringify({ state: "OPEN", mergedAt: null, closedAt: null }) });
        } else {
          cb(null, { stdout: JSON.stringify({ state: "OPEN" }) });
        }
      },
    );

    try {
      storeActiveTaskFactRow(db, "task-pr", "Track markus-lassfolk/openclaw-hybrid-memory pull request #101");
      storeActiveTaskFactRow(db, "task-issue-1", "Track markus-lassfolk/openclaw-hybrid-memory issue #102");
      storeActiveTaskFactRow(db, "task-issue-2", "Track markus-lassfolk/openclaw-hybrid-memory#103");

      const result = await reconcileActiveTaskLiveState(db, vectorDb, embeddings, { maxRequests: 10 });
      expect(result.checkedCount).toBe(3);
      expect(result.updatedCount).toBe(0);

      const calls = execFileMock.mock.calls.map((call) => call[1] as string[]);
      expect(calls.some((args) => args[0] === "pr" && args[2] === "101")).toBe(true);
      expect(calls.some((args) => args[0] === "issue" && args[2] === "102")).toBe(true);
      expect(calls.some((args) => args[0] === "issue" && args[2] === "103")).toBe(true);
    } finally {
      process.env.GITHUB_TOKEN = previousToken;
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rotates live-state checks across runs when budget is smaller than refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-live-state-budget-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const { vectorDb, embeddings } = activeTaskStubs();
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    execFileMock.mockReset();
    const queriedNumbers: number[] = [];
    execFileMock.mockImplementation(
      (_file: string, args: string[], _opts: unknown, cb: (err: null, result: { stdout: string }) => void) => {
        queriedNumbers.push(Number(args[2] ?? 0));
        cb(null, { stdout: JSON.stringify({ state: "OPEN" }) });
      },
    );

    try {
      storeActiveTaskFactRow(db, "task-1", "Track markus-lassfolk/openclaw-hybrid-memory#201");
      storeActiveTaskFactRow(db, "task-2", "Track markus-lassfolk/openclaw-hybrid-memory#202");
      storeActiveTaskFactRow(db, "task-3", "Track markus-lassfolk/openclaw-hybrid-memory#203");

      const run1 = await reconcileActiveTaskLiveState(db, vectorDb, embeddings, { maxRequests: 1 });
      const run2 = await reconcileActiveTaskLiveState(db, vectorDb, embeddings, { maxRequests: 1 });
      const run3 = await reconcileActiveTaskLiveState(db, vectorDb, embeddings, { maxRequests: 1 });

      expect(run1.checkedCount).toBe(1);
      expect(run2.checkedCount).toBe(1);
      expect(run3.checkedCount).toBe(1);
      expect(queriedNumbers).toEqual([201, 202, 203]);
    } finally {
      process.env.GITHUB_TOKEN = previousToken;
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks all tasks done for a shared terminal PR ref", async () => {
    const dir = await mkdtemp(join(tmpdir(), "task-live-state-terminal-"));
    const db = new FactsDB(join(dir, "facts.db"));
    const { vectorDb, embeddings } = activeTaskStubs();
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string }) => void) => {
        cb(null, {
          stdout: JSON.stringify({
            state: "CLOSED",
            mergedAt: "2026-01-01T00:00:00Z",
            closedAt: "2026-01-01T00:00:00Z",
          }),
        });
      },
    );

    try {
      storeActiveTaskFactRow(db, "task-a", "Follow markus-lassfolk/openclaw-hybrid-memory pull request #301");
      storeActiveTaskFactRow(db, "task-b", "Also track markus-lassfolk/openclaw-hybrid-memory pull request #301");

      const result = await reconcileActiveTaskLiveState(db, vectorDb, embeddings, { maxRequests: 10 });
      expect(result.checkedCount).toBe(1);
      expect(result.updatedCount).toBe(2);

      const { active, completed } = loadTaskLedgerFromFacts(db);
      expect(active.some((t) => t.label === "task-a" || t.label === "task-b")).toBe(false);
      expect(completed.some((t) => t.label === "task-a" && t.status === "Done")).toBe(true);
      expect(completed.some((t) => t.label === "task-b" && t.status === "Done")).toBe(true);
    } finally {
      process.env.GITHUB_TOKEN = previousToken;
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
