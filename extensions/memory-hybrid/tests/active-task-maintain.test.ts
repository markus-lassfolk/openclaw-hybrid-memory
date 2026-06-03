import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMaintainCompleteEvent,
  runActiveTaskMaintain,
  type ActiveTaskContext,
} from "../cli/active-tasks.js";
import type { HybridMemoryConfig } from "../config.js";

const mockCfg = {
  activeTask: {
    liveStateReconcile: { enabled: false },
  },
} as HybridMemoryConfig;

const projection = {
  mode: "readable" as const,
  excludeGenericTitle: true,
  titleMinChars: 0,
  dedupeBy: "none" as const,
  sectioned: true,
};

describe("runActiveTaskMaintain (#1865)", () => {
  let tmpDir: string;
  let ctx: ActiveTaskContext;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "maintain-at-"));
    const path = join(tmpDir, "ACTIVE-TASKS.md");
    await writeFile(path, "## Active Tasks\n\n", "utf-8");
    ctx = {
      activeTaskFilePath: path,
      staleMinutes: 1440,
      flushOnComplete: false,
      memoryDir: join(tmpDir, "memory"),
      ledger: "markdown",
      projection,
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("dry-run maintain reports orphan reconcile without mutating ACTIVE-TASKS.md", async () => {
    const key = "agent:x:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a";
    await writeFile(
      ctx.activeTaskFilePath,
      `## Active Tasks

### [orphan]: Ghost task
- **Status:** In progress
- **Subagent:** ${key}
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z
`,
      "utf-8",
    );

    const result = await runActiveTaskMaintain(ctx, mockCfg, {
      dryRun: true,
      openclawHome: join(tmpDir, "empty-openclaw"),
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("dry-run");
    expect(result.reconcileDryRun?.reconciledLabels).toEqual(["orphan"]);
    expect(result.reconcile).toBeUndefined();
    const content = await readFile(ctx.activeTaskFilePath, "utf-8");
    expect(content).not.toContain("## Completed");
  });

  it("apply maintain reconciles orphan session-backed tasks in one pass", async () => {
    const keyA = "agent:a:subagent:11111111-1111-1111-1111-111111111111";
    const keyB = "agent:b:subagent:22222222-2222-2222-2222-222222222222";
    await writeFile(
      ctx.activeTaskFilePath,
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

    const result = await runActiveTaskMaintain(ctx, mockCfg, {
      apply: true,
      openclawHome: join(tmpDir, "empty-openclaw"),
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("apply");
    expect(result.reconcile?.reconciledLabels).toEqual(["orphan-a", "orphan-b"]);
    expect(result.reconcile?.candidates).toBe(2);
    const content = await readFile(ctx.activeTaskFilePath, "utf-8");
    expect(content).toContain("## Completed");
    expect(content).toContain("orphan-a");
    expect(content).toContain("orphan-b");
  });

  it("buildMaintainCompleteEvent emits cron-parseable JSON summary", async () => {
    const key = "agent:x:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a";
    await writeFile(
      ctx.activeTaskFilePath,
      `## Active Tasks

### [orphan]: Ghost task
- **Status:** In progress
- **Subagent:** ${key}
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z
`,
      "utf-8",
    );

    const result = await runActiveTaskMaintain(ctx, mockCfg, {
      apply: true,
      staleSummary: true,
      openclawHome: join(tmpDir, "empty-openclaw"),
    });
    const event = buildMaintainCompleteEvent(result);

    expect(event.event).toBe("active_tasks_maintain_complete");
    expect(event.status).toBe("ok");
    expect(event.mode).toBe("apply");
    expect(event.reconcile?.reconciled).toBe(1);
    expect(event.reconcile?.candidates).toBe(1);
    expect(event.staleAfter).toBeDefined();
    expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(() => JSON.parse(JSON.stringify(event))).not.toThrow();
  });

  it("qa mode performs dry-run then apply and includes both reconcile results", async () => {
    const key = "agent:x:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a";
    await writeFile(
      ctx.activeTaskFilePath,
      `## Active Tasks

### [orphan]: Ghost task
- **Status:** In progress
- **Subagent:** ${key}
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z
`,
      "utf-8",
    );

    const result = await runActiveTaskMaintain(ctx, mockCfg, {
      qa: true,
      openclawHome: join(tmpDir, "empty-openclaw"),
    });

    expect(result.mode).toBe("qa");
    expect(result.reconcileDryRun?.reconciledLabels).toEqual(["orphan"]);
    expect(result.reconcile?.reconciledLabels).toEqual(["orphan"]);
    expect(result.staleAfter).toBeDefined();
  });

  it("jsonMode routes maintain progress to stderr and leaves stdout clean", async () => {
    const key = "agent:x:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a";
    await writeFile(
      ctx.activeTaskFilePath,
      `## Active Tasks

### [orphan]: Ghost task
- **Status:** In progress
- **Subagent:** ${key}
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z
`,
      "utf-8",
    );

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await runActiveTaskMaintain(ctx, mockCfg, {
        apply: true,
        jsonMode: true,
        openclawHome: join(tmpDir, "empty-openclaw"),
      });
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }

    expect(stdoutChunks.join("")).toBe("");
    expect(stderrChunks.join("")).toContain("active-tasks maintain:");
  });

  it("jsonMode does not stick stderr routing for subsequent non-json maintain runs", async () => {
    const key = "agent:x:subagent:f3d14066-09ea-492f-a3f3-7ae2fe6c9b0a";
    await writeFile(
      ctx.activeTaskFilePath,
      `## Active Tasks

### [orphan]: Ghost task
- **Status:** In progress
- **Subagent:** ${key}
- **Started:** 2026-02-24T10:00:00.000Z
- **Updated:** 2026-02-24T15:00:00.000Z
`,
      "utf-8",
    );

    const capture = () => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutChunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      return {
        restore: () => {
          process.stdout.write = origStdoutWrite;
          process.stderr.write = origStderrWrite;
        },
        stdout: stdoutChunks,
        stderr: stderrChunks,
      };
    };

    const jsonCapture = capture();
    try {
      await runActiveTaskMaintain(ctx, mockCfg, {
        dryRun: true,
        jsonMode: true,
        openclawHome: join(tmpDir, "empty-openclaw"),
      });
    } finally {
      jsonCapture.restore();
    }
    expect(jsonCapture.stdout.join("")).toBe("");

    const normalCapture = capture();
    try {
      await runActiveTaskMaintain(ctx, mockCfg, {
        dryRun: true,
        openclawHome: join(tmpDir, "empty-openclaw"),
      });
    } finally {
      normalCapture.restore();
    }
    expect(normalCapture.stdout.join("")).toContain("active-tasks maintain:");
    expect(normalCapture.stderr.join("")).toBe("");
  });
});
