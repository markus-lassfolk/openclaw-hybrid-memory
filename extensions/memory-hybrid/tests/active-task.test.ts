/**
 * Tests for ACTIVE-TASK.md working memory service and CLI commands.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseActiveTaskFile,
  serializeTaskEntry,
  serializeActiveTaskFile,
  detectStaleTasks,
  buildActiveTaskInjection,
  buildStaleWarningInjection,
  upsertTask,
  completeTask,
  flushCompletedTaskToMemory,
  readActiveTaskFile,
  writeActiveTaskFile,
  ACTIVE_TASK_STATUSES,
  isSubagentSession,
  writeTaskSignal,
  readPendingSignals,
  deleteSignal,
  readActiveTaskFileWithMtime,
  writeActiveTaskFileGuarded,
  writeActiveTaskFileOptimistic,
  type ActiveTaskEntry,
  type TaskSignal,
} from "../services/active-task.js";
import {
  runActiveTaskList,
  runActiveTaskComplete,
  runActiveTaskStale,
  runActiveTaskAdd,
  type ActiveTaskContext,
} from "../cli/active-tasks.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ACTIVE_TASK_MD = `# ACTIVE-TASK.md — Working Memory

## Active Tasks

### [forge-99]: Implement ACTIVE-TASK.md working memory
- **Branch:** feature/active-task-working-memory-99
- **Status:** In progress
- **Subagent:** forge-subagent-abc123
- **Next:** Write tests and verify TypeScript
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z

### [deploy-prod]: Deploy hotfix to production
- **Branch:** fix/hotfix-v2
- **Status:** Waiting
- **Next:** Wait for CI to pass
- **Started:** 2026-02-23T08:00:00.000Z
- **Updated:** 2026-02-23T09:00:00.000Z

## Completed

### [old-task]: Some old task
- **Status:** Done
- **Started:** 2026-02-20T10:00:00.000Z
- **Updated:** 2026-02-20T18:00:00.000Z
`;

const EMPTY_ACTIVE_TASK_MD = `# ACTIVE-TASK.md — Working Memory

## Active Tasks

_No active tasks._
`;

function makeEntry(overrides: Partial<ActiveTaskEntry> = {}): ActiveTaskEntry {
  return {
    label: "test-task",
    description: "A test task",
    status: "In progress",
    started: "2026-02-24T10:00:00.000Z",
    updated: "2026-02-24T15:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe("parseActiveTaskFile", () => {
  it("parses active tasks from markdown", () => {
    const result = parseActiveTaskFile(SAMPLE_ACTIVE_TASK_MD);
    expect(result.active).toHaveLength(2);
    expect(result.completed).toHaveLength(1);
  });

  it("parses all fields correctly", () => {
    const result = parseActiveTaskFile(SAMPLE_ACTIVE_TASK_MD);
    const task = result.active[0];
    expect(task.label).toBe("forge-99");
    expect(task.description).toBe("Implement ACTIVE-TASK.md working memory");
    expect(task.branch).toBe("feature/active-task-working-memory-99");
    expect(task.status).toBe("In progress");
    expect(task.subagent).toBe("forge-subagent-abc123");
    expect(task.next).toBe("Write tests and verify TypeScript");
    expect(task.started).toBe("2026-02-24T10:00:00.000Z");
    expect(task.updated).toBe("2026-02-24T15:00:00.000Z");
  });

  it("parses second task with partial fields", () => {
    const result = parseActiveTaskFile(SAMPLE_ACTIVE_TASK_MD);
    const task = result.active[1];
    expect(task.label).toBe("deploy-prod");
    expect(task.status).toBe("Waiting");
    expect(task.branch).toBe("fix/hotfix-v2");
    expect(task.subagent).toBeUndefined();
    expect(task.next).toBe("Wait for CI to pass");
  });

  it("moves Done tasks to completed section", () => {
    const result = parseActiveTaskFile(SAMPLE_ACTIVE_TASK_MD);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].label).toBe("old-task");
  });

  it("handles empty active tasks section", () => {
    const result = parseActiveTaskFile(EMPTY_ACTIVE_TASK_MD);
    expect(result.active).toHaveLength(0);
    expect(result.completed).toHaveLength(0);
  });

  it("handles completely empty string", () => {
    const result = parseActiveTaskFile("");
    expect(result.active).toHaveLength(0);
    expect(result.completed).toHaveLength(0);
  });

  it("handles all valid statuses", () => {
    for (const status of ACTIVE_TASK_STATUSES) {
      const md = `## Active Tasks\n\n### [test]: Test task\n- **Status:** ${status}\n- **Started:** 2026-01-01T00:00:00.000Z\n- **Updated:** 2026-01-01T00:00:00.000Z\n`;
      const result = parseActiveTaskFile(md);
      if (status === "Done") {
        expect(result.completed).toHaveLength(1);
        expect(result.active).toHaveLength(0);
      } else {
        expect(result.active).toHaveLength(1);
        expect(result.active[0].status).toBe(status);
      }
    }
  });

  it("preserves raw content", () => {
    const result = parseActiveTaskFile(SAMPLE_ACTIVE_TASK_MD);
    expect(result.raw).toBe(SAMPLE_ACTIVE_TASK_MD);
  });
});

// ---------------------------------------------------------------------------
// Serialization tests
// ---------------------------------------------------------------------------

describe("serializeTaskEntry", () => {
  it("serializes a full entry with all fields", () => {
    const entry: ActiveTaskEntry = {
      label: "forge-99",
      description: "Implement working memory",
      branch: "feature/active-task-99",
      status: "In progress",
      stashCommit: "forge-99-wip",
      subagent: "session-abc",
      next: "Write tests",
      started: "2026-02-24T10:00:00.000Z",
      updated: "2026-02-24T15:00:00.000Z",
    };
    const result = serializeTaskEntry(entry);
    expect(result).toContain("### [forge-99]: Implement working memory");
    expect(result).toContain("**Branch:** feature/active-task-99");
    expect(result).toContain("**Status:** In progress");
    expect(result).toContain("**Stash/Commit:** forge-99-wip");
    expect(result).toContain("**Subagent:** session-abc");
    expect(result).toContain("**Next:** Write tests");
    expect(result).toContain("**Started:** 2026-02-24T10:00:00.000Z");
    expect(result).toContain("**Updated:** 2026-02-24T15:00:00.000Z");
  });

  it("omits optional fields when not set", () => {
    const entry = makeEntry();
    const result = serializeTaskEntry(entry);
    expect(result).not.toContain("**Branch:**");
    expect(result).not.toContain("**Stash/Commit:**");
    expect(result).not.toContain("**Subagent:**");
    expect(result).not.toContain("**Next:**");
  });

  it("produces parseable output (round-trip)", () => {
    const entry: ActiveTaskEntry = {
      label: "rt-test",
      description: "Round-trip test task",
      branch: "fix/something",
      status: "Waiting",
      subagent: "forge-session-xyz",
      next: "Verify something",
      started: "2026-02-24T10:00:00.000Z",
      updated: "2026-02-24T15:00:00.000Z",
    };
    const serialized = serializeTaskEntry(entry);
    const md = `## Active Tasks\n\n${serialized}\n`;
    const parsed = parseActiveTaskFile(md);
    expect(parsed.active).toHaveLength(1);
    expect(parsed.active[0].label).toBe("rt-test");
    expect(parsed.active[0].description).toBe("Round-trip test task");
    expect(parsed.active[0].branch).toBe("fix/something");
    expect(parsed.active[0].status).toBe("Waiting");
    expect(parsed.active[0].subagent).toBe("forge-session-xyz");
    expect(parsed.active[0].next).toBe("Verify something");
  });
});

describe("serializeActiveTaskFile", () => {
  it("generates valid markdown with active and completed sections", () => {
    const active = [makeEntry({ label: "task-a", status: "In progress" })];
    const completed = [makeEntry({ label: "task-b", status: "Done" })];
    const result = serializeActiveTaskFile(active, completed);
    expect(result).toContain("## Active Tasks");
    expect(result).toContain("## Completed");
    expect(result).toContain("[task-a]");
    expect(result).toContain("[task-b]");
  });

  it("shows placeholder when no active tasks", () => {
    const result = serializeActiveTaskFile([], []);
    expect(result).toContain("_No active tasks._");
    expect(result).not.toContain("## Completed");
  });

  it("omits completed section when empty", () => {
    const active = [makeEntry()];
    const result = serializeActiveTaskFile(active, []);
    expect(result).not.toContain("## Completed");
  });
});

// ---------------------------------------------------------------------------
// Stale detection tests
// ---------------------------------------------------------------------------

describe("detectStaleTasks", () => {
  it("flags tasks not updated within the stale threshold", () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const freshTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const tasks = [
      makeEntry({ label: "stale", updated: staleTime }),
      makeEntry({ label: "fresh", updated: freshTime }),
    ];
    const result = detectStaleTasks(tasks, 1440);
    expect(result[0].stale).toBe(true);
    expect(result[1].stale).toBe(false);
  });

  it("does not flag tasks updated recently", () => {
    const freshTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const tasks = [makeEntry({ updated: freshTime })];
    const result = detectStaleTasks(tasks, 1440);
    expect(result[0].stale).toBe(false);
  });

  it("handles invalid updated timestamp gracefully", () => {
    const tasks = [makeEntry({ updated: "not-a-date" })];
    const result = detectStaleTasks(tasks, 1440);
    expect(result[0].stale).toBe(false);
  });

  it("returns empty array for empty input", () => {
    expect(detectStaleTasks([], 1440)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Injection builder tests
// ---------------------------------------------------------------------------

describe("buildActiveTaskInjection", () => {
  it("returns empty string when no active tasks", () => {
    const result = buildActiveTaskInjection([], 500);
    expect(result).toBe("");
  });

  it("returns empty string when all tasks are Done", () => {
    const tasks = [makeEntry({ status: "Done" })];
    const result = buildActiveTaskInjection(tasks, 500);
    expect(result).toBe("");
  });

  it("includes task label, description, and status", () => {
    const tasks = [makeEntry({ label: "my-task", description: "Fix the bug", status: "In progress" })];
    const result = buildActiveTaskInjection(tasks, 500);
    expect(result).toContain("my-task");
    expect(result).toContain("Fix the bug");
    expect(result).toContain("In progress");
    expect(result).toContain("<active-tasks>");
    expect(result).toContain("</active-tasks>");
  });

  it("includes next step when present", () => {
    const tasks = [makeEntry({ next: "Deploy the fix" })];
    const result = buildActiveTaskInjection(tasks, 500);
    expect(result).toContain("Deploy the fix");
  });

  it("includes stale flag for stale tasks", () => {
    const tasks = [makeEntry({ stale: true })];
    const result = buildActiveTaskInjection(tasks, 500);
    expect(result).toContain("STALE");
  });

  it("caps injection to budget (approximate)", () => {
    // Create many tasks that would exceed budget
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeEntry({
        label: `task-${i}`,
        description: "A very long description that takes up lots of space and tokens in the injection block",
        next: "Do something very specific and detailed about this particular task",
        status: "In progress",
      }),
    );
    const result = buildActiveTaskInjection(tasks, 100); // Very tight budget
    // Should not include all 20 tasks
    const taskMatches = result.match(/\[task-/g)?.length ?? 0;
    expect(taskMatches).toBeLessThan(20);
    expect(result.length).toBeLessThan(100 * 4 + 200); // Approximately within budget
  });

  it("handles all non-Done statuses", () => {
    const activeStatuses = ["In progress", "Waiting", "Stalled", "Failed"] as const;
    for (const status of activeStatuses) {
      const tasks = [makeEntry({ status })];
      const result = buildActiveTaskInjection(tasks, 500);
      expect(result).toContain(status);
    }
  });
});

// ---------------------------------------------------------------------------
// Stale warning injection builder tests
// ---------------------------------------------------------------------------

describe("buildStaleWarningInjection", () => {
  const THRESHOLD_MINUTES = 1440; // 24h

  it("returns empty string when no stale tasks and no in-progress subagents", () => {
    const tasks = [
      makeEntry({ label: "fresh", stale: false }),
      makeEntry({ label: "done", status: "Done", stale: false }),
    ];
    expect(buildStaleWarningInjection(tasks, THRESHOLD_MINUTES)).toBe("");
  });

  it("returns empty string for empty task list", () => {
    expect(buildStaleWarningInjection([], THRESHOLD_MINUTES)).toBe("");
  });

  it("generates warning for stale tasks", () => {
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const tasks = [
      makeEntry({
        label: "forge-99",
        description: "Implement heartbeat hook",
        status: "In progress",
        updated: staleTime,
        stale: true,
      }),
    ];
    const result = buildStaleWarningInjection(tasks, THRESHOLD_MINUTES);
    expect(result).toContain("⚠️ STALE ACTIVE TASKS");
    // 1440 min = 1 day → formatDuration renders "1d"
    expect(result).toContain(">1d");
    expect(result).toContain("[forge-99]");
    expect(result).toContain("Implement heartbeat hook");
    expect(result).toContain("Status: In progress");
    expect(result).toContain("Consider:");
  });

  it("includes hours-ago elapsed time in warning", () => {
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const tasks = [makeEntry({ stale: true, updated: staleTime })];
    const result = buildStaleWarningInjection(tasks, THRESHOLD_MINUTES);
    // Should show approximately 48h ago (allow ±1h for test timing)
    expect(result).toMatch(/4[78]h ago/);
  });

  it("includes 'Next' step when present", () => {
    const tasks = [
      makeEntry({
        stale: true,
        next: "Deploy the hotfix",
        updated: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const result = buildStaleWarningInjection(tasks, THRESHOLD_MINUTES);
    expect(result).toContain("Deploy the hotfix");
    expect(result).toContain("Next:");
  });

  it("omits 'Next' part when not set", () => {
    const tasks = [
      makeEntry({
        stale: true,
        next: undefined,
        updated: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    const result = buildStaleWarningInjection(tasks, THRESHOLD_MINUTES);
    expect(result).not.toContain("Next:");
  });

  it("generates subagent hint for in-progress tasks with subagent", () => {
    const tasks = [
      makeEntry({
        label: "agent-task",
        description: "Run analysis",
        status: "In progress",
        subagent: "forge-session-abc123",
        stale: false,
      }),
    ];
    const result = buildStaleWarningInjection(tasks, THRESHOLD_MINUTES);
    expect(result).toContain("💡");
    expect(result).toContain("forge-session-abc123");
    expect(result).toContain("subagents list");
  });

  it("does not generate subagent hint for non-in-progress tasks", () => {
    const tasks = [
      makeEntry({ status: "Waiting", subagent: "forge-session-xyz", stale: false }),
    ];
    const result = buildStaleWarningInjection(tasks, THRESHOLD_MINUTES);
    // No stale, no in-progress-with-subagent → empty
    expect(result).toBe("");
  });

  it("generates both stale warning and subagent hint when applicable", () => {
    const staleTime = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const tasks = [
      makeEntry({
        label: "stale-task",
        description: "Stale without subagent",
        status: "Stalled",
        updated: staleTime,
        stale: true,
      }),
      makeEntry({
        label: "agent-task",
        description: "Active subagent",
        status: "In progress",
        subagent: "forge-session-xyz",
        stale: false,
      }),
    ];
    const result = buildStaleWarningInjection(tasks, THRESHOLD_MINUTES);
    expect(result).toContain("⚠️ STALE ACTIVE TASKS");
    expect(result).toContain("[stale-task]");
    expect(result).toContain("💡");
    expect(result).toContain("forge-session-xyz");
  });

  it("displays threshold using human-friendly format", () => {
    const tasks = [
      makeEntry({
        stale: true,
        updated: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    // 90 minutes → "1h30m"
    const result90m = buildStaleWarningInjection(tasks, 90);
    expect(result90m).toContain(">1h30m");

    // 1440 minutes → "1d" (formatDuration: 1440/1440 = 1 day, 0 hours, 0 min)
    const result24h = buildStaleWarningInjection(tasks, 1440);
    expect(result24h).toContain(">1d");

    // 2880 minutes → "2d"
    const result2d = buildStaleWarningInjection(tasks, 2880);
    expect(result2d).toContain(">2d");
  });

  it("generates warning for multiple stale tasks", () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const tasks = [
      makeEntry({ label: "stale-a", stale: true, updated: staleTime }),
      makeEntry({ label: "stale-b", stale: true, updated: staleTime }),
      makeEntry({ label: "fresh", stale: false }),
    ];
    const result = buildStaleWarningInjection(tasks, THRESHOLD_MINUTES);
    expect(result).toContain("[stale-a]");
    expect(result).toContain("[stale-b]");
    expect(result).not.toContain("[fresh]");
  });
});

// ---------------------------------------------------------------------------
// Task mutation tests
// ---------------------------------------------------------------------------

describe("upsertTask", () => {
  it("appends new task when label not found", () => {
    const existing = [makeEntry({ label: "existing" })];
    const result = upsertTask(existing, makeEntry({ label: "new-task" }));
    expect(result).toHaveLength(2);
    expect(result[1].label).toBe("new-task");
  });

  it("updates existing task when label matches", () => {
    const existing = [makeEntry({ label: "task", status: "In progress", next: "original" })];
    const result = upsertTask(existing, makeEntry({ label: "task", status: "Waiting", next: "updated" }));
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("Waiting");
    expect(result[0].next).toBe("updated");
  });

  it("updates the 'updated' timestamp on upsert", () => {
    const before = new Date().toISOString();
    const existing = [makeEntry({ label: "task", updated: "2020-01-01T00:00:00.000Z" })];
    const result = upsertTask(existing, makeEntry({ label: "task" }));
    expect(result[0].updated >= before).toBe(true);
  });

  it("preserves order for non-matching tasks", () => {
    const existing = [
      makeEntry({ label: "a" }),
      makeEntry({ label: "b" }),
      makeEntry({ label: "c" }),
    ];
    const result = upsertTask(existing, makeEntry({ label: "b", status: "Waiting" }));
    expect(result.map((t) => t.label)).toEqual(["a", "b", "c"]);
  });
});

describe("completeTask", () => {
  it("removes task from active and returns completed entry", () => {
    const active = [makeEntry({ label: "task-a" }), makeEntry({ label: "task-b" })];
    const { updated, completed } = completeTask(active, "task-a");
    expect(updated).toHaveLength(1);
    expect(updated[0].label).toBe("task-b");
    expect(completed).not.toBeNull();
    expect(completed!.label).toBe("task-a");
    expect(completed!.status).toBe("Done");
  });

  it("returns null completed when label not found", () => {
    const active = [makeEntry({ label: "task-a" })];
    const { updated, completed } = completeTask(active, "nonexistent");
    expect(updated).toHaveLength(1);
    expect(completed).toBeNull();
  });

  it("updates the 'updated' timestamp", () => {
    const before = new Date().toISOString();
    const active = [makeEntry({ label: "task", updated: "2020-01-01T00:00:00.000Z" })];
    const { completed } = completeTask(active, "task");
    expect(completed!.updated >= before).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// File I/O tests
// ---------------------------------------------------------------------------

describe("readActiveTaskFile / writeActiveTaskFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-task-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", async () => {
    const result = await readActiveTaskFile(join(tmpDir, "ACTIVE-TASK.md"), 1440);
    expect(result).toBeNull();
  });

  it("reads and parses existing file", async () => {
    const filePath = join(tmpDir, "ACTIVE-TASK.md");
    await writeActiveTaskFile(
      filePath,
      [makeEntry({ label: "test-task" })],
      [],
    );
    const result = await readActiveTaskFile(filePath, 1440);
    expect(result).not.toBeNull();
    expect(result!.active).toHaveLength(1);
    expect(result!.active[0].label).toBe("test-task");
  });

  it("writes and reads back correctly (round-trip)", async () => {
    const filePath = join(tmpDir, "ACTIVE-TASK.md");
    const active = [
      makeEntry({ label: "forge-99", status: "In progress", branch: "feature/test", next: "Run tests" }),
    ];
    const completed = [makeEntry({ label: "old-task", status: "Done" })];
    await writeActiveTaskFile(filePath, active, completed);
    const result = await readActiveTaskFile(filePath, 1440);
    expect(result!.active).toHaveLength(1);
    expect(result!.active[0].branch).toBe("feature/test");
    expect(result!.active[0].next).toBe("Run tests");
    expect(result!.completed).toHaveLength(1);
    expect(result!.completed[0].label).toBe("old-task");
  });

  it("creates parent directories as needed", async () => {
    const filePath = join(tmpDir, "deep", "nested", "ACTIVE-TASK.md");
    await writeActiveTaskFile(filePath, [makeEntry()], []);
    const result = await readActiveTaskFile(filePath, 1440);
    expect(result).not.toBeNull();
  });

  it("applies stale detection on read", async () => {
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const filePath = join(tmpDir, "ACTIVE-TASK.md");
    await writeActiveTaskFile(
      filePath,
      [makeEntry({ updated: staleTime })],
      [],
    );
    const result = await readActiveTaskFile(filePath, 1440);
    expect(result!.active[0].stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flush to memory log tests
// ---------------------------------------------------------------------------

describe("flushCompletedTaskToMemory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-task-memory-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates memory log file if it does not exist", async () => {
    const task = makeEntry({ label: "test-flush", status: "Done" });
    const filePath = await flushCompletedTaskToMemory(task, tmpDir);
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("## Completed Task: [test-flush]");
    expect(content).toContain("**Status:** Done");
  });

  it("appends to existing memory log file", async () => {
    const task = makeEntry({ label: "task-b", status: "Done" });
    // First flush
    await flushCompletedTaskToMemory(makeEntry({ label: "task-a", status: "Done" }), tmpDir);
    // Second flush
    const filePath = await flushCompletedTaskToMemory(task, tmpDir);
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("[task-a]");
    expect(content).toContain("[task-b]");
  });

  it("includes branch and subagent in flush when present", async () => {
    const task = makeEntry({
      label: "task-x",
      status: "Done",
      branch: "fix/something",
      subagent: "forge-session-abc",
    });
    const filePath = await flushCompletedTaskToMemory(task, tmpDir);
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("fix/something");
    expect(content).toContain("forge-session-abc");
  });

  it("returns the file path with correct date-based name", async () => {
    const task = makeEntry({ label: "dated-task", status: "Done" });
    const filePath = await flushCompletedTaskToMemory(task, tmpDir);
    const date = new Date().toISOString().slice(0, 10);
    expect(filePath).toContain(date);
    expect(filePath.endsWith(".md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI command tests
// ---------------------------------------------------------------------------

describe("runActiveTaskList", () => {
  let tmpDir: string;
  let ctx: ActiveTaskContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-task-cli-"));
    ctx = {
      activeTaskFilePath: join(tmpDir, "ACTIVE-TASK.md"),
      staleMinutes: 1440,
      flushOnComplete: false,
      memoryDir: join(tmpDir, "memory"),
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns fileExists=false when file missing", async () => {
    const result = await runActiveTaskList(ctx);
    expect(result.fileExists).toBe(false);
    expect(result.total).toBe(0);
  });

  it("lists active tasks from file", async () => {
    await writeActiveTaskFile(
      ctx.activeTaskFilePath,
      [
        makeEntry({ label: "task-1", status: "In progress" }),
        makeEntry({ label: "task-2", status: "Waiting" }),
      ],
      [],
    );
    const result = await runActiveTaskList(ctx);
    expect(result.fileExists).toBe(true);
    expect(result.total).toBe(2);
    expect(result.tasks[0].label).toBe("task-1");
    expect(result.tasks[1].label).toBe("task-2");
  });

  it("counts stale tasks correctly", async () => {
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await writeActiveTaskFile(
      ctx.activeTaskFilePath,
      [
        makeEntry({ label: "stale", updated: staleTime }),
        makeEntry({ label: "fresh" }),
      ],
      [],
    );
    const result = await runActiveTaskList(ctx);
    expect(result.staleCount).toBe(1);
  });
});

describe("runActiveTaskStale", () => {
  let tmpDir: string;
  let ctx: ActiveTaskContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-task-stale-"));
    ctx = {
      activeTaskFilePath: join(tmpDir, "ACTIVE-TASK.md"),
      staleMinutes: 1440,
      flushOnComplete: false,
      memoryDir: join(tmpDir, "memory"),
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty tasks when file missing", async () => {
    const result = await runActiveTaskStale(ctx);
    expect(result.tasks).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("returns stale tasks with hours stale", async () => {
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await writeActiveTaskFile(
      ctx.activeTaskFilePath,
      [
        makeEntry({ label: "stale-task", updated: staleTime }),
        makeEntry({ label: "fresh-task" }), // fresh
      ],
      [],
    );
    const result = await runActiveTaskStale(ctx);
    expect(result.total).toBe(1);
    expect(result.tasks[0].label).toBe("stale-task");
    expect(result.tasks[0].hoursStale).toBeGreaterThanOrEqual(47);
  });
});

describe("runActiveTaskComplete", () => {
  let tmpDir: string;
  let ctx: ActiveTaskContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-task-complete-"));
    ctx = {
      activeTaskFilePath: join(tmpDir, "ACTIVE-TASK.md"),
      staleMinutes: 1440,
      flushOnComplete: true,
      memoryDir: join(tmpDir, "memory"),
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error when file missing", async () => {
    const result = await runActiveTaskComplete(ctx, "missing");
    expect(result.ok).toBe(false);
  });

  it("returns error when label not found", async () => {
    await writeActiveTaskFile(ctx.activeTaskFilePath, [makeEntry({ label: "other" })], []);
    const result = await runActiveTaskComplete(ctx, "nonexistent");
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("nonexistent");
  });

  it("marks task as Done and removes from active list", async () => {
    await writeActiveTaskFile(
      ctx.activeTaskFilePath,
      [
        makeEntry({ label: "target-task" }),
        makeEntry({ label: "other-task" }),
      ],
      [],
    );
    const result = await runActiveTaskComplete(ctx, "target-task");
    expect(result.ok).toBe(true);

    const updated = await readActiveTaskFile(ctx.activeTaskFilePath, 1440);
    expect(updated!.active).toHaveLength(1);
    expect(updated!.active[0].label).toBe("other-task");
    expect(updated!.completed).toHaveLength(1);
    expect(updated!.completed[0].label).toBe("target-task");
    expect(updated!.completed[0].status).toBe("Done");
  });

  it("flushes to memory log when flushOnComplete=true", async () => {
    await writeActiveTaskFile(ctx.activeTaskFilePath, [makeEntry({ label: "flush-task" })], []);
    const result = await runActiveTaskComplete(ctx, "flush-task");
    expect(result.ok).toBe(true);
    const ok = result as { ok: true; label: string; flushedTo?: string };
    expect(ok.flushedTo).toBeDefined();
    const content = await readFile(ok.flushedTo!, "utf-8");
    expect(content).toContain("[flush-task]");
  });

  it("does not flush when flushOnComplete=false", async () => {
    ctx.flushOnComplete = false;
    await writeActiveTaskFile(ctx.activeTaskFilePath, [makeEntry({ label: "no-flush" })], []);
    const result = await runActiveTaskComplete(ctx, "no-flush");
    expect(result.ok).toBe(true);
    const ok = result as { ok: true; label: string; flushedTo?: string };
    expect(ok.flushedTo).toBeUndefined();
  });
});

describe("runActiveTaskAdd", () => {
  let tmpDir: string;
  let ctx: ActiveTaskContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "active-task-add-"));
    ctx = {
      activeTaskFilePath: join(tmpDir, "ACTIVE-TASK.md"),
      staleMinutes: 1440,
      flushOnComplete: false,
      memoryDir: join(tmpDir, "memory"),
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates new task when file does not exist", async () => {
    const result = await runActiveTaskAdd(ctx, {
      label: "new-task",
      description: "A brand new task",
    });
    expect(result.ok).toBe(true);
    const ok = result as { ok: true; label: string; upserted: boolean };
    expect(ok.upserted).toBe(false);

    const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, 1440);
    expect(taskFile!.active).toHaveLength(1);
    expect(taskFile!.active[0].label).toBe("new-task");
  });

  it("adds optional fields when provided", async () => {
    await runActiveTaskAdd(ctx, {
      label: "rich-task",
      description: "Task with extras",
      branch: "fix/something",
      subagent: "forge-session",
      next: "Deploy",
      status: "Waiting",
    });
    const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, 1440);
    const task = taskFile!.active[0];
    expect(task.branch).toBe("fix/something");
    expect(task.subagent).toBe("forge-session");
    expect(task.next).toBe("Deploy");
    expect(task.status).toBe("Waiting");
  });

  it("updates existing task when label matches", async () => {
    await writeActiveTaskFile(
      ctx.activeTaskFilePath,
      [makeEntry({ label: "existing", next: "old next" })],
      [],
    );
    const result = await runActiveTaskAdd(ctx, {
      label: "existing",
      description: "Updated description",
      next: "new next",
    });
    expect(result.ok).toBe(true);
    const ok = result as { ok: true; label: string; upserted: boolean };
    expect(ok.upserted).toBe(true);

    const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, 1440);
    expect(taskFile!.active).toHaveLength(1);
    expect(taskFile!.active[0].description).toBe("Updated description");
    expect(taskFile!.active[0].next).toBe("new next");
  });

  it("rejects invalid status gracefully (falls back to In progress)", async () => {
    await runActiveTaskAdd(ctx, {
      label: "bad-status",
      description: "Task with bad status",
      status: "InvalidStatus",
    });
    const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, 1440);
    expect(taskFile!.active[0].status).toBe("In progress");
  });
});

// ---------------------------------------------------------------------------
// Config injection tests
// ---------------------------------------------------------------------------

describe("buildActiveTaskInjection (integration)", () => {
  it("filters out Done tasks from injection", () => {
    const tasks = [
      makeEntry({ label: "done", status: "Done" }),
      makeEntry({ label: "active", status: "In progress" }),
    ];
    const result = buildActiveTaskInjection(tasks, 500);
    expect(result).toContain("[active]");
    expect(result).not.toContain("[done]");
  });

  it("includes subagent session in injection", () => {
    const tasks = [makeEntry({ subagent: "forge-session-xyz" })];
    const result = buildActiveTaskInjection(tasks, 500);
    expect(result).toContain("forge-session-xyz");
  });

  it("handles multiple active tasks within budget", () => {
    const tasks = [
      makeEntry({ label: "task-1", status: "In progress" }),
      makeEntry({ label: "task-2", status: "Waiting" }),
      makeEntry({ label: "task-3", status: "Stalled" }),
    ];
    const result = buildActiveTaskInjection(tasks, 1000);
    expect(result).toContain("task-1");
    expect(result).toContain("task-2");
    expect(result).toContain("task-3");
  });
});

// ---------------------------------------------------------------------------
// isSubagentSession tests
// ---------------------------------------------------------------------------

describe("isSubagentSession", () => {
  it("returns true for session keys containing 'subagent:'", () => {
    expect(isSubagentSession("agent:forge:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a")).toBe(true);
    expect(isSubagentSession("agent:main:subagent:abc123")).toBe(true);
    expect(isSubagentSession("subagent:xyz")).toBe(true);
  });

  it("returns false for orchestrator session keys", () => {
    expect(isSubagentSession("agent:main:main")).toBe(false);
    expect(isSubagentSession("agent:forge:forge")).toBe(false);
    expect(isSubagentSession("main")).toBe(false);
  });

  it("returns false for undefined or empty session key", () => {
    expect(isSubagentSession(undefined)).toBe(false);
    expect(isSubagentSession("")).toBe(false);
  });

  it("is case-sensitive — 'Subagent:' without lowercase does not match", () => {
    // Sub-agent keys in practice always use lowercase "subagent:"
    expect(isSubagentSession("agent:forge:Subagent:abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task signal tests (writeTaskSignal / readPendingSignals / deleteSignal)
// ---------------------------------------------------------------------------

describe("writeTaskSignal / readPendingSignals / deleteSignal", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "task-signal-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeSignal(overrides: Partial<TaskSignal> = {}): TaskSignal {
    return {
      agent: "test-agent",
      taskRef: "test-task",
      timestamp: "2026-02-25T07:48:00.000Z",
      signal: "completed",
      summary: "Task is complete",
      ...overrides,
    };
  }

  it("writes a signal file to memory/task-signals/<label>.json", async () => {
    const signal = makeSignal();
    const filePath = await writeTaskSignal("my-label", signal, tmpDir);
    expect(filePath).toContain("task-signals");
    expect(filePath).toMatch(/my-label-\d+\.json$/);
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.agent).toBe("test-agent");
    expect(parsed.signal).toBe("completed");
  });

  it("sanitises label to be filesystem-safe", async () => {
    const signal = makeSignal();
    const filePath = await writeTaskSignal("label with spaces/and:colons", signal, tmpDir);
    expect(filePath).not.toContain(" ");
    expect(filePath).not.toContain(":");
    expect(filePath).not.toContain("/task-signals/label with");
  });

  it("returns empty array when signals dir does not exist", async () => {
    const signals = await readPendingSignals(tmpDir);
    expect(signals).toHaveLength(0);
  });

  it("reads all pending signals from signals dir", async () => {
    const s1 = makeSignal({ agent: "agent-1", signal: "completed" });
    const s2 = makeSignal({ agent: "agent-2", signal: "blocked" });
    await writeTaskSignal("label-1", s1, tmpDir);
    await writeTaskSignal("label-2", s2, tmpDir);

    const signals = await readPendingSignals(tmpDir);
    expect(signals).toHaveLength(2);
    const agents = signals.map((s) => s.agent).sort();
    expect(agents).toEqual(["agent-1", "agent-2"]);
  });

  it("includes _filePath on each pending signal", async () => {
    const signal = makeSignal();
    await writeTaskSignal("with-path", signal, tmpDir);
    const signals = await readPendingSignals(tmpDir);
    expect(signals[0]._filePath).toBeDefined();
    expect(signals[0]._filePath).toMatch(/with-path-\d+\.json$/);
  });

  it("skips malformed JSON files without crashing", async () => {
    const { writeFile: fsWrite, mkdir: fsMkdir } = await import("node:fs/promises");
    const signalsDir = join(tmpDir, "task-signals");
    await fsMkdir(signalsDir, { recursive: true });
    await fsWrite(join(signalsDir, "bad.json"), "not valid json", "utf-8");
    await writeTaskSignal("good-label", makeSignal(), tmpDir);

    const signals = await readPendingSignals(tmpDir);
    expect(signals).toHaveLength(1);
    expect(signals[0].agent).toBe("test-agent");
  });

  it("ignores non-JSON files in signals dir", async () => {
    const { writeFile: fsWrite, mkdir: fsMkdir } = await import("node:fs/promises");
    const signalsDir = join(tmpDir, "task-signals");
    await fsMkdir(signalsDir, { recursive: true });
    await fsWrite(join(signalsDir, "notes.txt"), "ignore me", "utf-8");
    await writeTaskSignal("real-signal", makeSignal(), tmpDir);

    const signals = await readPendingSignals(tmpDir);
    expect(signals).toHaveLength(1);
  });

  it("deleteSignal removes the file", async () => {
    const filePath = await writeTaskSignal("to-delete", makeSignal(), tmpDir);
    await deleteSignal(filePath);
    const signals = await readPendingSignals(tmpDir);
    expect(signals).toHaveLength(0);
  });

  it("deleteSignal is idempotent (ENOENT is ignored)", async () => {
    const filePath = await writeTaskSignal("to-delete-twice", makeSignal(), tmpDir);
    await deleteSignal(filePath);
    // Second delete should not throw
    await expect(deleteSignal(filePath)).resolves.toBeUndefined();
  });

  it("preserves optional fields in signal round-trip", async () => {
    const signal = makeSignal({
      signal: "blocked",
      statusChange: { from: "in-progress", to: "blocked" },
      findings: ["finding 1", "finding 2"],
    });
    await writeTaskSignal("rich-signal", signal, tmpDir);
    const signals = await readPendingSignals(tmpDir);
    expect(signals[0].statusChange).toEqual({ from: "in-progress", to: "blocked" });
    expect(signals[0].findings).toEqual(["finding 1", "finding 2"]);
  });
});

// ---------------------------------------------------------------------------
// readActiveTaskFileWithMtime tests
// ---------------------------------------------------------------------------

describe("readActiveTaskFileWithMtime", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mtime-test-"));
    filePath = join(tmpDir, "ACTIVE-TASK.md");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file does not exist", async () => {
    const result = await readActiveTaskFileWithMtime(filePath);
    expect(result).toBeNull();
  });

  it("returns parsed tasks and mtime when file exists", async () => {
    await writeActiveTaskFile(filePath, [makeEntry()], []);
    const result = await readActiveTaskFileWithMtime(filePath);
    expect(result).not.toBeNull();
    expect(result!.active).toHaveLength(1);
    expect(typeof result!.mtime).toBe("number");
    expect(result!.mtime).toBeGreaterThan(0);
  });

  it("returns a different mtime after the file is updated", async () => {
    await writeActiveTaskFile(filePath, [makeEntry({ label: "first" })], []);
    const first = await readActiveTaskFileWithMtime(filePath);

    // Brief pause to ensure mtime changes
    await new Promise((r) => setTimeout(r, 10));

    await writeActiveTaskFile(filePath, [makeEntry({ label: "second" })], []);
    const second = await readActiveTaskFileWithMtime(filePath);

    expect(second!.mtime).toBeGreaterThanOrEqual(first!.mtime);
    expect(second!.active[0].label).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// writeActiveTaskFileGuarded tests
// ---------------------------------------------------------------------------

describe("writeActiveTaskFileGuarded", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "guarded-test-"));
    filePath = join(tmpDir, "ACTIVE-TASK.md");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes normally when no session key is provided (orchestrator default)", async () => {
    const result = await writeActiveTaskFileGuarded(filePath, [makeEntry()], []);
    expect(result.skipped).toBe(false);
    const taskFile = await readActiveTaskFile(filePath);
    expect(taskFile!.active).toHaveLength(1);
  });

  it("writes normally when orchestrator session key is provided", async () => {
    const result = await writeActiveTaskFileGuarded(
      filePath, [makeEntry()], [], "agent:main:main"
    );
    expect(result.skipped).toBe(false);
    const taskFile = await readActiveTaskFile(filePath);
    expect(taskFile!.active).toHaveLength(1);
  });

  it("skips write when session is a sub-agent", async () => {
    const result = await writeActiveTaskFileGuarded(
      filePath,
      [makeEntry()],
      [],
      "agent:forge:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a",
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("read-only");
    // File should NOT have been written
    const taskFile = await readActiveTaskFile(filePath);
    expect(taskFile).toBeNull();
  });

  it("provides a reason when skipped", async () => {
    const result = await writeActiveTaskFileGuarded(
      filePath, [makeEntry()], [], "agent:x:subagent:y"
    );
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// writeActiveTaskFileOptimistic tests
// ---------------------------------------------------------------------------

describe("writeActiveTaskFileOptimistic", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "optimistic-test-"));
    filePath = join(tmpDir, "ACTIVE-TASK.md");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes directly when mtime has not changed", async () => {
    await writeActiveTaskFile(filePath, [makeEntry({ label: "original" })], []);
    const read = await readActiveTaskFileWithMtime(filePath);
    expect(read).not.toBeNull();

    const newActive = [makeEntry({ label: "updated" })];
    let mergeCalled = false;
    await writeActiveTaskFileOptimistic(
      filePath,
      newActive,
      [],
      read!.mtime,
      async () => { mergeCalled = true; return null; },
    );

    // No conflict — merge should NOT have been called
    expect(mergeCalled).toBe(false);
    const result = await readActiveTaskFile(filePath);
    expect(result!.active[0].label).toBe("updated");
  });

  it("calls merge when file was modified concurrently", async () => {
    await writeActiveTaskFile(filePath, [makeEntry({ label: "original" })], []);
    const read = await readActiveTaskFileWithMtime(filePath);

    // Simulate a concurrent write by updating the file with a small delay
    await new Promise((r) => setTimeout(r, 20));
    await writeActiveTaskFile(filePath, [makeEntry({ label: "concurrent" })], []);

    let mergeCalled = false;
    await writeActiveTaskFileOptimistic(
      filePath,
      [makeEntry({ label: "mine" })],
      [],
      read!.mtime, // stale mtime — triggers merge
      async (fresh) => {
        mergeCalled = true;
        // Accept the fresh state plus our label
        return [[...fresh.active, makeEntry({ label: "mine" })], fresh.completed];
      },
    );

    expect(mergeCalled).toBe(true);
    const result = await readActiveTaskFile(filePath);
    const labels = result!.active.map((t) => t.label);
    expect(labels).toContain("concurrent");
    expect(labels).toContain("mine");
  });

  it("aborts write when merge returns null", async () => {
    await writeActiveTaskFile(filePath, [makeEntry({ label: "original" })], []);
    const read = await readActiveTaskFileWithMtime(filePath);

    // Simulate a concurrent write
    await new Promise((r) => setTimeout(r, 20));
    await writeActiveTaskFile(filePath, [makeEntry({ label: "concurrent" })], []);

    await writeActiveTaskFileOptimistic(
      filePath,
      [makeEntry({ label: "mine" })],
      [],
      read!.mtime,
      async () => null, // Abort
    );

    const result = await readActiveTaskFile(filePath);
    // File should remain as "concurrent" — our write was aborted
    expect(result!.active[0].label).toBe("concurrent");
  });

  it("writes successfully to non-existent file (no conflict possible)", async () => {
    const newPath = join(tmpDir, "new-file.md");
    await writeActiveTaskFileOptimistic(
      newPath,
      [makeEntry({ label: "new" })],
      [],
      0, // mtime 0 = not yet read
      async () => null,
    );
    const result = await readActiveTaskFile(newPath);
    expect(result!.active[0].label).toBe("new");
  });
});
