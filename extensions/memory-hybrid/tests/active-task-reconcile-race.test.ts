/**
 * reconcileActiveTaskInProgressSessions() used a plain read-then-write on ACTIVE-TASKS.md: it
 * read the file once, scanned for orphaned "In progress" tasks whose subagent session transcript
 * is gone, and wrote back a freshly-computed active/completed array pair — with no check that the
 * file hadn't changed since the read. A concurrent writer (e.g. a live subagent_spawned/
 * subagent_ended checkpoint from lifecycle/stage-cleanup.ts, racing the heartbeat/cron reconciler)
 * that added or updated a *different* task between the read and the write would have its change
 * silently clobbered — the reconciler's write only knew about the tasks it saw at read time.
 *
 * This test simulates the race deterministically: it hooks the progress reporter's
 * setScanTotal() callback (invoked synchronously right after the reconciler's initial read,
 * before its scan loop starts) to perform a *synchronous* concurrent write that adds a brand-new
 * task the reconciler's in-memory snapshot never saw. With the fix (reconcile now uses
 * writeActiveTaskFileOptimistic with a merge callback that re-derives the reconciliation decision
 * against the freshly-read state), the concurrent task survives. Without it, the reconciler's
 * stale-computed array overwrites the file and the concurrent task disappears.
 */
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reconcileActiveTaskInProgressSessions,
  writeActiveTaskFile,
  readActiveTaskFile,
} from "../services/active-task.js";
import { ActiveTaskReconcileProgressReporter } from "../services/active-task-reconcile-progress.js";

describe("reconcileActiveTaskInProgressSessions concurrent-write race (loop iteration 66 regression)", () => {
  let tmpDir: string;
  let activeTaskPath: string;
  let openclawHome: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "reconcile-race-"));
    activeTaskPath = join(tmpDir, "ACTIVE-TASKS.md");
    openclawHome = join(tmpDir, ".openclaw");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does not clobber a task concurrently added between the read and the write", async () => {
    const orphanKey = "agent:orphan-agent:subagent:11111111-1111-1111-1111-111111111111";
    const liveKey = "agent:live-agent:subagent:22222222-2222-2222-2222-222222222222";

    // orphan-a's session transcript will never exist — it's the reconcile target.
    await writeActiveTaskFile(
      activeTaskPath,
      [
        {
          label: "orphan-a",
          description: "Ghost task",
          status: "In progress",
          subagent: orphanKey,
          started: "2026-02-24T10:00:00.000Z",
          updated: "2026-02-24T15:00:00.000Z",
        },
      ],
      [],
    );

    // live-task's session transcript DOES exist — a real, still-running subagent.
    await mkdir(join(openclawHome, "agents", "live-agent", "sessions"), { recursive: true });
    await writeFile(join(openclawHome, "agents", "live-agent", "sessions", `${liveKey}.jsonl`), "{}\n", "utf-8");

    const reporter = new ActiveTaskReconcileProgressReporter({
      mode: "apply",
      ledger: "markdown",
      emit: () => {},
    });

    // Fires synchronously right after reconcile's initial read, before its scan loop runs —
    // simulates a concurrent subagent_spawned checkpoint landing in the race window.
    let concurrentWriteApplied = false;
    reporter.setScanTotal = ((total: number) => {
      concurrentWriteApplied = true;
      writeFileSync(
        activeTaskPath,
        [
          "## Active Tasks",
          "",
          "### [orphan-a]: Ghost task",
          "- **Status:** In progress",
          `- **Subagent:** ${orphanKey}`,
          "- **Started:** 2026-02-24T10:00:00.000Z",
          "- **Updated:** 2026-02-24T15:00:00.000Z",
          "",
          "### [live-task]: Freshly spawned subagent",
          "- **Status:** In progress",
          `- **Subagent:** ${liveKey}`,
          "- **Started:** 2026-02-24T16:00:00.000Z",
          "- **Updated:** 2026-02-24T16:00:00.000Z",
          "",
        ].join("\n"),
        "utf-8",
      );
      ActiveTaskReconcileProgressReporter.prototype.setScanTotal.call(reporter, total);
    }) as typeof reporter.setScanTotal;

    const result = await reconcileActiveTaskInProgressSessions(activeTaskPath, 1440, {
      openclawHome,
      dryRun: false,
      progress: reporter,
    });

    expect(concurrentWriteApplied).toBe(true);
    expect(result.wrote).toBe(true);
    // The reconciler's own (stale) scan only ever saw orphan-a — it must have re-derived its
    // decision against the fresh file to know about live-task at all.
    expect(result.reconciledLabels).toEqual(["orphan-a"]);

    const finalFile = await readActiveTaskFile(activeTaskPath);
    const activeLabels = finalFile?.active.map((t) => t.label) ?? [];
    const completedLabels = finalFile?.completed.map((t) => t.label) ?? [];

    // live-task must survive — it was never touched by the reconciler's own decision.
    expect(activeLabels).toContain("live-task");
    // orphan-a must still be correctly reconciled to Failed.
    expect(completedLabels).toContain("orphan-a");
    expect(finalFile?.completed.find((t) => t.label === "orphan-a")?.status).toBe("Failed");
  });
});
