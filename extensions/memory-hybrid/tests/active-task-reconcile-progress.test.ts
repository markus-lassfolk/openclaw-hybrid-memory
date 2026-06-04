import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileActiveTaskInProgressSessions } from "../services/active-task.js";
import { ActiveTaskReconcileProgressReporter } from "../services/active-task-reconcile-progress.js";

function linesReporter(mode: "apply" | "dry-run", ledger: "markdown" | "facts", verbose = false) {
  const lines: string[] = [];
  const reporter = new ActiveTaskReconcileProgressReporter({
    mode,
    ledger,
    verbose,
    heartbeatIntervalMs: 5_000,
    itemProgressEvery: 1,
    emit: (line) => lines.push(line),
  });
  return { reporter, lines };
}

describe("ActiveTaskReconcileProgressReporter", () => {
  it("emits phase markers, per-item progress, and JSON complete summary", () => {
    const { reporter, lines } = linesReporter("apply", "markdown", true);

    reporter.start();
    reporter.phaseStart("session-index");
    reporter.setScanTotal(3);
    reporter.onScanItem({
      index: 1,
      total: 3,
      entity: "task-a",
      action: "mark_abandoned",
      reason: "session_missing",
      previousStatus: "In progress",
      elapsedMs: 12,
    });
    reporter.onScanItem({
      index: 2,
      total: 3,
      entity: "task-b",
      action: "skip",
      reason: "session_present",
      previousStatus: "In progress",
      elapsedMs: 24,
    });
    reporter.phaseComplete("session-index", { sessions: 3, candidates: 1 });
    reporter.setWriteTotal(1);
    reporter.phaseStart("file-write", { candidates: 1 });
    reporter.phaseComplete("file-write", { candidates: 1 });
    const summary = reporter.complete();

    expect(lines.some((line) => line.includes("active-tasks reconcile: start mode=apply"))).toBe(true);
    expect(lines.some((line) => line.includes("phase=session-index start"))).toBe(true);
    expect(lines.some((line) => line.includes("phase=session-index complete"))).toBe(true);
    expect(lines.some((line) => line.includes("entity=task-a action=mark_abandoned reason=session_missing"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("active-tasks reconcile: complete reconciled=1"))).toBe(true);
    expect(summary.event).toBe("active_tasks_reconcile_complete");
    expect(summary.reconciled).toBe(1);
    expect(summary.candidates).toBe(1);
    expect(lines.at(-1)).toBe(JSON.stringify(summary));
  });
});

describe("reconcileActiveTaskInProgressSessions progress (#1864)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "reconcile-progress-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reconciles multiple orphan tasks with apply progress markers", async () => {
    const path = join(tmpDir, "ACTIVE-TASKS.md");
    const keyA = "agent:a:subagent:11111111-1111-1111-1111-111111111111";
    const keyB = "agent:b:subagent:22222222-2222-2222-2222-222222222222";
    await writeFile(
      path,
      `## Active Tasks

### [orphan-a]: Ghost A
- **Status:** In progress
- **Subagent:** ${keyA}
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z

### [orphan-b]: Ghost B
- **Status:** In progress
- **Subagent:** ${keyB}
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z
`,
      "utf-8",
    );

    const openclawHome = join(tmpDir, "empty-openclaw");
    const { reporter, lines } = linesReporter("apply", "markdown", false);

    const r = await reconcileActiveTaskInProgressSessions(path, 1440, {
      openclawHome,
      dryRun: false,
      progress: reporter,
    });
    const summary = reporter.complete();

    expect(r.reconciledLabels).toEqual(["orphan-a", "orphan-b"]);
    expect(r.candidates).toBe(2);
    expect(r.wrote).toBe(true);
    expect(lines.some((line) => line.includes("phase=session-index complete"))).toBe(true);
    expect(lines.some((line) => line.includes("phase=file-write start"))).toBe(true);
    expect(lines.some((line) => line.includes("progress 1/2 phase=session-index"))).toBe(true);
    expect(lines.some((line) => line.includes("progress 2/2 phase=session-index"))).toBe(true);
    expect(summary.reconciled).toBe(2);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      event: "active_tasks_reconcile_complete",
      mode: "apply",
      reconciled: 2,
      candidates: 2,
    });

    const content = await readFile(path, "utf-8");
    expect(content).toContain("orphan-a");
    expect(content).toContain("orphan-b");
    expect(content).toContain("## Completed");
  });

  it("dry-run keeps candidate list without writing while verbose progress still scans", async () => {
    const path = join(tmpDir, "ACTIVE-TASKS.md");
    const key = "agent:x:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a";
    await writeFile(
      path,
      `## Active Tasks

### [orphan]: Ghost task
- **Status:** In progress
- **Subagent:** ${key}
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z
`,
      "utf-8",
    );

    const { reporter, lines } = linesReporter("dry-run", "markdown", true);
    const r = await reconcileActiveTaskInProgressSessions(path, 1440, {
      openclawHome: join(tmpDir, "empty-openclaw"),
      dryRun: true,
      progress: reporter,
    });
    reporter.complete();

    expect(r.reconciledLabels).toEqual(["orphan"]);
    expect(r.wrote).toBe(false);
    expect(lines.some((line) => line.includes("mode=dry-run"))).toBe(true);
    expect(lines.some((line) => line.includes("phase=file-write"))).toBe(false);

    const content = await readFile(path, "utf-8");
    expect(content).not.toContain("## Completed");
  });
});
