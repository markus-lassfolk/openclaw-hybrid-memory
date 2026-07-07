/**
 * syncMarkdownLedgerFromCheckpoint() used a plain read-then-write on ACTIVE-TASKS.md: it read the
 * file once, computed the active/completed arrays for its own checkpoint entity, and wrote them
 * back with no check that the file had changed since the read. Two subagents checkpointing
 * *different* tasks around the same time (a real, expected scenario — active_task_checkpoint is
 * called by every subagent as it makes progress) could race: the second call's write would only
 * know about the task it saw at read time, silently dropping whatever the first call had just
 * written for its own, different task.
 *
 * This test simulates the race deterministically: it spies on readActiveTaskFileWithMtime (a
 * cross-module call from active-task-checkpoint.ts into active-task.ts, the same pattern already
 * used elsewhere in this suite to intercept upsertProjectTaskKey) so that, right after the
 * checkpoint's own read resolves, a synchronous "concurrent checkpoint" write for a *different*
 * task lands on disk — but the checkpoint being tested still receives the pre-write (stale)
 * snapshot, exactly matching the real race window. With the fix (writeActiveTaskFileOptimistic
 * detects the mtime change and re-derives the decision against the fresh state), both tasks
 * survive. Without it, the concurrent task is clobbered.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema, type HybridMemoryConfig } from "../config.js";
import { syncMarkdownLedgerFromCheckpoint } from "../services/active-task-checkpoint.js";
import * as activeTaskModule from "../services/active-task.js";
import { readActiveTaskFile } from "../services/active-task.js";

function makeConfig(root: string, workspaceRoot: string): HybridMemoryConfig {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
    sqlitePath: join(root, "facts.db"),
    lanceDbPath: join(root, "lancedb"),
    activeTask: {
      enabled: true,
      ledger: "markdown",
      filePath: "ACTIVE-TASKS.md",
      staleThreshold: "24h",
      projection: {
        mode: "readable",
        excludeGenericTitle: true,
        titleMinChars: 0,
        dedupeBy: "none",
        sectioned: true,
      },
      staleWarning: { enabled: true },
      autoCheckpoint: true,
      flushOnComplete: true,
      injectionBudget: 500,
      taskHygiene: {
        heartbeatEscalation: true,
        suggestGoalAfterTaskAgeDays: 0,
        heartbeatNudgeMaxChars: 2500,
      },
    },
  });
}

describe("syncMarkdownLedgerFromCheckpoint concurrent-write race (loop iteration 67 regression)", () => {
  let root: string;
  let workspaceRoot: string;
  let activeTaskPath: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("does not clobber a different task checkpointed concurrently between the read and the write", async () => {
    root = mkdtempSync(join(tmpdir(), "hm-active-task-checkpoint-race-"));
    workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    activeTaskPath = join(workspaceRoot, "ACTIVE-TASKS.md");
    const cfg = makeConfig(root, workspaceRoot);
    const deps = { cfg, workspaceRoot };

    // Hook both the mtime-aware read (used by the fixed code) and the plain read (used by the
    // pre-fix code) with the same side effect, so this same test file proves the bug via git
    // stash regardless of which read function the code under test happens to call.
    let concurrentWriteApplied = false;
    const injectConcurrentWrite = async (
      path: string,
      snapshot: { active: activeTaskModule.ActiveTaskEntry[]; completed: activeTaskModule.ActiveTaskEntry[] } | null,
    ): Promise<void> => {
      if (concurrentWriteApplied) return;
      concurrentWriteApplied = true;
      // Simulate a second, concurrent active_task_checkpoint call for a DIFFERENT task landing
      // right after this checkpoint's own read but before its write.
      await activeTaskModule.writeActiveTaskFile(
        path,
        [
          ...(snapshot?.active ?? []),
          {
            label: "concurrent-task",
            description: "Checkpointed by a different subagent",
            status: "In progress" as const,
            subagent: "agent:other:subagent:33333333-3333-3333-3333-333333333333",
            started: "2026-02-24T16:00:00.000Z",
            updated: "2026-02-24T16:00:00.000Z",
          },
        ],
        snapshot?.completed ?? [],
      );
    };
    const realReadWithMtime = activeTaskModule.readActiveTaskFileWithMtime;
    const realRead = activeTaskModule.readActiveTaskFile;
    const spyWithMtime = vi
      .spyOn(activeTaskModule, "readActiveTaskFileWithMtime")
      .mockImplementation(async (path, staleMinutes) => {
        const snapshot = await realReadWithMtime(path, staleMinutes);
        await injectConcurrentWrite(path, snapshot);
        return snapshot; // stale — pre-concurrent-write state, exactly what the real race exposes
      });
    const spyPlain = vi.spyOn(activeTaskModule, "readActiveTaskFile").mockImplementation(async (path, staleMinutes) => {
      const snapshot = await realRead(path, staleMinutes);
      await injectConcurrentWrite(path, snapshot);
      return snapshot;
    });

    const result = await syncMarkdownLedgerFromCheckpoint(deps, {
      entity: "task-a",
      status: "in_progress",
      owner: "agent:mine",
      next: "Do the thing",
      relatedSession: "agent:mine:subagent:11111111-1111-1111-1111-111111111111",
      title: "Task A",
      taskUpdated: "2026-02-24T16:00:01.000Z",
    });

    spyWithMtime.mockRestore();
    spyPlain.mockRestore();

    expect(concurrentWriteApplied).toBe(true);
    expect(result.synced).toBe(true);

    const final = await readActiveTaskFile(activeTaskPath);
    const labels = final?.active.map((t) => t.label) ?? [];

    // concurrent-task must survive — this checkpoint's own decision never knew about it.
    expect(labels).toContain("concurrent-task");
    // task-a must still be correctly recorded by this checkpoint.
    expect(labels).toContain("task-a");
  });
});
