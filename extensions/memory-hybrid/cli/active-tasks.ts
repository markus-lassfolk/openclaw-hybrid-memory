/**
 * CLI commands for active task working memory (ACTIVE-TASK.md).
 *
 * Commands registered:
 *   hybrid-mem active-tasks              — list active tasks
 *   hybrid-mem active-tasks complete <label>  — mark done and flush to memory log
 *   hybrid-mem active-tasks stale        — show tasks not updated in >staleThreshold
 *   hybrid-mem active-tasks add <label> <description>  — add/update a task
 */

import { join } from "node:path";
import { dirname } from "node:path";
import { formatDuration } from "../utils/duration.js";
import {
  readActiveTaskFile,
  writeActiveTaskFile,
  completeTask,
  upsertTask,
  flushCompletedTaskToMemory,
  type ActiveTaskEntry,
  ACTIVE_TASK_STATUSES,
  type ActiveTaskStatus,
} from "../services/active-task.js";
import type {
  ActiveTaskListResult,
  ActiveTaskCompleteResult,
  ActiveTaskStaleResult,
  ActiveTaskAddResult,
} from "./types.js";
import type { Chainable } from "./shared.js";

/** Context injected into all active-task CLI commands */
export type ActiveTaskContext = {
  /** Absolute path to ACTIVE-TASK.md */
  activeTaskFilePath: string;
  /** Minutes before a task is considered stale (parsed from staleThreshold) */
  staleMinutes: number;
  /** Flush on complete: true = append to memory/YYYY-MM-DD.md */
  flushOnComplete: boolean;
  /** Memory directory (for flush). Usually workspace/memory */
  memoryDir: string;
};

// ---------------------------------------------------------------------------
// Runner functions (pure logic, no commander side-effects)
// ---------------------------------------------------------------------------

/** List all active tasks */
export async function runActiveTaskList(
  ctx: ActiveTaskContext,
): Promise<ActiveTaskListResult> {
  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  if (!taskFile) {
    return {
      tasks: [],
      total: 0,
      staleCount: 0,
      filePath: ctx.activeTaskFilePath,
      fileExists: false,
    };
  }
  const tasks = taskFile.active.map((t) => ({
    label: t.label,
    description: t.description,
    status: t.status,
    branch: t.branch,
    subagent: t.subagent,
    next: t.next,
    started: t.started,
    updated: t.updated,
    stale: t.stale === true,
  }));
  const staleCount = tasks.filter((t) => t.stale).length;
  return {
    tasks,
    total: tasks.length,
    staleCount,
    filePath: ctx.activeTaskFilePath,
    fileExists: true,
  };
}

/** Show tasks that are stale (not updated within the configured staleThreshold) */
export async function runActiveTaskStale(
  ctx: ActiveTaskContext,
): Promise<ActiveTaskStaleResult> {
  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  if (!taskFile) {
    return { tasks: [], total: 0, filePath: ctx.activeTaskFilePath };
  }
  const now = Date.now();
  const staleTasks = taskFile.active
    .filter((t) => t.stale)
    .map((t) => {
      const updatedMs = new Date(t.updated).getTime();
      const hoursStale = isNaN(updatedMs)
        ? 0
        : Math.floor((now - updatedMs) / (1000 * 60 * 60));
      return {
        label: t.label,
        description: t.description,
        status: t.status,
        updated: t.updated,
        hoursStale,
      };
    });
  return {
    tasks: staleTasks,
    total: staleTasks.length,
    filePath: ctx.activeTaskFilePath,
  };
}

/** Mark a task complete and flush to memory log */
export async function runActiveTaskComplete(
  ctx: ActiveTaskContext,
  label: string,
): Promise<ActiveTaskCompleteResult> {
  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  if (!taskFile) {
    return { ok: false, error: `ACTIVE-TASK.md not found at ${ctx.activeTaskFilePath}` };
  }

  const { updated, completed } = completeTask(taskFile.active, label);

  if (!completed) {
    return { ok: false, error: `No active task found with label "${label}"` };
  }

  // Write back to file (completed task moves to ## Completed section)
  const existingCompleted = taskFile.completed;
  await writeActiveTaskFile(ctx.activeTaskFilePath, updated, [
    ...existingCompleted,
    completed,
  ]);

  // Flush to memory log if configured
  let flushedTo: string | undefined;
  if (ctx.flushOnComplete) {
    try {
      flushedTo = await flushCompletedTaskToMemory(completed, ctx.memoryDir);
    } catch {
      // Non-fatal — task was still completed
    }
  }

  return { ok: true, label, flushedTo };
}

/** Add or update a task entry */
export async function runActiveTaskAdd(
  ctx: ActiveTaskContext,
  opts: {
    label: string;
    description: string;
    branch?: string;
    status?: string;
    subagent?: string;
    next?: string;
  },
): Promise<ActiveTaskAddResult> {
  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  const existingActive = taskFile?.active ?? [];
  const existingCompleted = taskFile?.completed ?? [];
  const wasExisting = existingActive.some((t) => t.label === opts.label);

  const now = new Date().toISOString();
  const existing = existingActive.find((t) => t.label === opts.label);

  const status: ActiveTaskStatus = (() => {
    if (opts.status && ACTIVE_TASK_STATUSES.includes(opts.status as ActiveTaskStatus)) {
      return opts.status as ActiveTaskStatus;
    }
    return existing?.status ?? "In progress";
  })();

  const entry: ActiveTaskEntry = {
    label: opts.label,
    description: opts.description,
    status,
    branch: opts.branch ?? existing?.branch,
    subagent: opts.subagent ?? existing?.subagent,
    next: opts.next ?? existing?.next,
    started: existing?.started ?? now,
    updated: now,
  };

  const updated = upsertTask(existingActive, entry);
  await writeActiveTaskFile(ctx.activeTaskFilePath, updated, existingCompleted);

  return { ok: true, label: opts.label, upserted: wasExisting };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerActiveTaskCommands(
  mem: Chainable,
  ctx: ActiveTaskContext,
): void {
  // `hybrid-mem active-tasks` — list
  mem
    .command("active-tasks")
    .description(
      "List active tasks from ACTIVE-TASK.md working memory. Subcommands: complete <label>, stale, add",
    )
    .action(async () => {
      const result = await runActiveTaskList(ctx);
      if (!result.fileExists) {
        console.log("No ACTIVE-TASK.md found — no active tasks.");
        return;
      }
      if (result.total === 0) {
        console.log("✅ No active tasks.");
        return;
      }
      console.log(`Active tasks (${result.total}):`);
      for (const t of result.tasks) {
        const staleFlag = t.stale ? " ⚠️ STALE" : "";
        console.log(`  [${t.label}] ${t.description}`);
        console.log(`    Status: ${t.status}${staleFlag}`);
        if (t.branch) console.log(`    Branch: ${t.branch}`);
        if (t.subagent) console.log(`    Subagent: ${t.subagent}`);
        if (t.next) console.log(`    Next: ${t.next}`);
        console.log(`    Updated: ${t.updated}`);
      }
      if (result.staleCount > 0) {
        console.log(`\n⚠️  ${result.staleCount} stale task(s) — run 'hybrid-mem active-tasks stale' for details`);
      }
    });

  // `hybrid-mem active-tasks complete <label>`
  mem
    .command("active-tasks complete <label>")
    .description("Mark an active task as Done and flush summary to memory log")
    .action(async (label: string) => {
      const result = await runActiveTaskComplete(ctx, label);
      if (!result.ok) {
        console.error(`Error: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`✅ Task [${result.label}] marked as Done.`);
      if (result.flushedTo) {
        console.log(`   Flushed summary to: ${result.flushedTo}`);
      }
    });

  // `hybrid-mem active-tasks stale`
  mem
    .command("active-tasks stale")
    .description(`Show tasks not updated in >${formatDuration(ctx.staleMinutes)}`)
    .action(async () => {
      const result = await runActiveTaskStale(ctx);
      if (result.total === 0) {
        console.log("✅ No stale tasks.");
        return;
      }
      console.log(`Stale tasks (${result.total}):`);
      for (const t of result.tasks) {
        console.log(`  [${t.label}] ${t.description}`);
        console.log(`    Status: ${t.status}`);
        console.log(`    Last updated: ${t.updated} (${t.hoursStale}h ago)`);
      }
    });

  // `hybrid-mem active-tasks add <label> <description>`
  mem
    .command("active-tasks add <label> <description>")
    .description("Add or update a task in ACTIVE-TASK.md")
    .option("--branch <branch>", "Git branch")
    .option("--status <status>", "Task status (In progress|Waiting|Stalled|Failed|Done)")
    .option("--subagent <subagent>", "Subagent session key")
    .option("--next <next>", "What to do next")
    .action(
      async (
        label: string,
        description: string,
        opts: {
          branch?: string;
          status?: string;
          subagent?: string;
          next?: string;
        },
      ) => {
        const result = await runActiveTaskAdd(ctx, { label, description, ...opts });
        if (!result.ok) {
          console.error(`Error: ${result.error}`);
          process.exitCode = 1;
          return;
        }
        const verb = result.upserted ? "Updated" : "Added";
        console.log(`✅ ${verb} task [${result.label}].`);
      },
    );
}
