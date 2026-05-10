/**
 * CLI commands for active task working memory.
 *
 * With activeTask.ledger `markdown` (default): reads/writes ACTIVE-TASKS.md.
 * With activeTask.ledger `facts`: reads/writes hybrid-memory category:project facts
 * (aligned with memory_store). Optional `active-tasks render` writes markdown projection.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ActiveTaskProjectionConfig, HybridMemoryConfig } from "../config.js";
import {
  ACTIVE_TASK_STATUSES,
  type ActiveTaskEntry,
  type ActiveTaskStatus,
  completeTask,
  flushCompletedTaskToMemory,
  readActiveTaskFile,
  reconcileActiveTaskInProgressSessions,
  upsertTask,
  writeActiveTaskFile,
} from "../services/active-task.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import {
  applyActiveTaskHygieneFacts,
  loadTaskLedgerFromFacts,
  planActiveTaskHygiene,
  readActiveTaskRowsFromFacts,
  reconcileActiveTaskInProgressSessionsFacts,
  renderActiveTaskMarkdownFile,
  syncActiveTaskEntryToFacts,
} from "../services/task-ledger-facts.js";
import { formatDuration, parseDuration } from "../utils/duration.js";
import { formatActiveTaskConfigLines } from "./config-feature-summaries.js";
import type { Chainable } from "./shared.js";
import type {
  ActiveTaskAddResult,
  ActiveTaskCompleteResult,
  ActiveTaskHygieneResult,
  ActiveTaskListResult,
  ActiveTaskStaleResult,
} from "./types.js";

/** Context injected into all active-task CLI commands */
export type ActiveTaskContext = {
  /** Absolute path to ACTIVE-TASKS.md (markdown ledger or render target) */
  activeTaskFilePath: string;
  /** Minutes before a task is considered stale (parsed from staleThreshold) */
  staleMinutes: number;
  /** Flush on complete: true = append to memory/YYYY-MM-DD.md */
  flushOnComplete: boolean;
  /** Memory directory (for flush). Usually workspace/memory */
  memoryDir: string;
  /** Task ledger backend */
  ledger: "markdown" | "facts";
  /** Facts projection settings (`active-tasks render` when ledger is facts). */
  projection: ActiveTaskProjectionConfig;
  factsDb?: FactsDB;
  vectorDb?: VectorDB;
  embeddings?: EmbeddingProvider;
};

function requireFacts(ctx: ActiveTaskContext): { factsDb: FactsDB; vectorDb: VectorDB; embeddings: EmbeddingProvider } {
  if (!ctx.factsDb || !ctx.vectorDb || !ctx.embeddings) {
    throw new Error("activeTask.ledger=facts requires factsDb, vectorDb, and embeddings in CLI context");
  }
  return { factsDb: ctx.factsDb, vectorDb: ctx.vectorDb, embeddings: ctx.embeddings };
}

// ---------------------------------------------------------------------------
// Runner functions (pure logic, no commander side-effects)
// ---------------------------------------------------------------------------

/** List all active tasks */
export async function runActiveTaskList(ctx: ActiveTaskContext): Promise<ActiveTaskListResult> {
  if (ctx.ledger === "facts") {
    const { factsDb } = requireFacts(ctx);
    const { active } = readActiveTaskRowsFromFacts(factsDb, ctx.staleMinutes);
    const tasks = active.map((t) => ({
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
      filePath: "(hybrid-memory category:project)",
      fileExists: true,
      ledger: "facts",
    };
  }

  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  if (!taskFile) {
    return {
      tasks: [],
      total: 0,
      staleCount: 0,
      filePath: ctx.activeTaskFilePath,
      fileExists: false,
      ledger: "markdown",
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
    ledger: "markdown",
  };
}

/** Show tasks that are stale (not updated within the configured staleThreshold) */
export async function runActiveTaskStale(ctx: ActiveTaskContext): Promise<ActiveTaskStaleResult> {
  if (ctx.ledger === "facts") {
    const { factsDb } = requireFacts(ctx);
    const { active } = readActiveTaskRowsFromFacts(factsDb, ctx.staleMinutes);
    const now = Date.now();
    const staleTasks = active
      .filter((t) => t.stale)
      .map((t) => {
        const updatedMs = new Date(t.updated).getTime();
        const hoursStale: number | "?" = Number.isNaN(updatedMs)
          ? "?"
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
      filePath: "(hybrid-memory category:project)",
    };
  }

  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  if (!taskFile) {
    return { tasks: [], total: 0, filePath: ctx.activeTaskFilePath };
  }
  const now = Date.now();
  const staleTasks = taskFile.active
    .filter((t) => t.stale)
    .map((t) => {
      const updatedMs = new Date(t.updated).getTime();
      const hoursStale: number | "?" = Number.isNaN(updatedMs) ? "?" : Math.floor((now - updatedMs) / (1000 * 60 * 60));
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
export async function runActiveTaskComplete(ctx: ActiveTaskContext, label: string): Promise<ActiveTaskCompleteResult> {
  if (ctx.ledger === "facts") {
    const { factsDb, vectorDb, embeddings } = requireFacts(ctx);
    const { active } = loadTaskLedgerFromFacts(factsDb);
    const { completed } = completeTask(active, label);
    if (!completed) {
      return { ok: false, error: `No active task found with label "${label}"` };
    }
    const doneEntry: ActiveTaskEntry = { ...completed, status: "Done" };
    await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, doneEntry);
    let flushedTo: string | undefined;
    if (ctx.flushOnComplete) {
      try {
        flushedTo = await flushCompletedTaskToMemory(doneEntry, ctx.memoryDir);
      } catch {
        // non-fatal
      }
    }
    return { ok: true, label, flushedTo };
  }

  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  if (!taskFile) {
    return { ok: false, error: `ACTIVE-TASKS.md not found at ${ctx.activeTaskFilePath}` };
  }

  const { updated, completed } = completeTask(taskFile.active, label);

  if (!completed) {
    return { ok: false, error: `No active task found with label "${label}"` };
  }

  const existingCompleted = taskFile.completed;
  await writeActiveTaskFile(ctx.activeTaskFilePath, updated, [...existingCompleted, completed]);

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
  const now = new Date().toISOString();

  if (ctx.ledger === "facts") {
    const { factsDb, vectorDb, embeddings } = requireFacts(ctx);
    const { active, completed } = loadTaskLedgerFromFacts(factsDb);
    const wasExisting = active.some((t) => t.label === opts.label) || completed.some((t) => t.label === opts.label);
    const existing = active.find((t) => t.label === opts.label) ?? completed.find((t) => t.label === opts.label);
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
      stashCommit: existing?.stashCommit,
      started: existing?.started ?? now,
      updated: now,
    };
    await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, entry);
    if (status === "Done" && ctx.flushOnComplete) {
      try {
        await flushCompletedTaskToMemory(entry, ctx.memoryDir);
      } catch {
        // non-fatal
      }
    }
    return { ok: true, label: opts.label, upserted: wasExisting };
  }

  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  const existingActive = taskFile?.active ?? [];
  const existingCompleted = taskFile?.completed ?? [];
  const wasExisting = existingActive.some((t) => t.label === opts.label);
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
    stashCommit: existing?.stashCommit,
    started: existing?.started ?? now,
    updated: now,
  };

  if (status === "Done") {
    const updatedActive = existingActive.filter((t) => t.label !== opts.label);
    const updatedCompleted = [...existingCompleted, entry];
    await writeActiveTaskFile(ctx.activeTaskFilePath, updatedActive, updatedCompleted);
    if (ctx.flushOnComplete) {
      try {
        await flushCompletedTaskToMemory(entry, ctx.memoryDir);
      } catch {
        // Non-fatal
      }
    }
  } else {
    const updatedActive = upsertTask(existingActive, entry);
    await writeActiveTaskFile(ctx.activeTaskFilePath, updatedActive, existingCompleted);
  }

  return { ok: true, label: opts.label, upserted: wasExisting };
}

/** Detect/apply active-task hygiene: duplicates, stale failed tasks, dead-session in-progress tasks. */
export async function runActiveTaskHygiene(
  ctx: ActiveTaskContext,
  opts: {
    apply?: boolean;
    olderThanMinutes?: number;
    openclawHome?: string;
  } = {},
): Promise<ActiveTaskHygieneResult> {
  const olderThanMinutes = Math.max(1, Math.floor(opts.olderThanMinutes ?? ctx.staleMinutes));
  const apply = opts.apply === true;
  if (ctx.ledger === "facts") {
    const { factsDb, vectorDb, embeddings } = requireFacts(ctx);
    const { active } = loadTaskLedgerFromFacts(factsDb);
    const plan = await planActiveTaskHygiene(active, {
      olderThanMinutes,
      openclawHome: opts.openclawHome,
    });
    if (!apply || plan.actions.length === 0) {
      return {
        ledger: "facts",
        dryRun: !apply,
        olderThanMinutes,
        duplicates: plan.duplicates,
        stale: plan.stale,
        actions: plan.actions,
        appliedCount: 0,
      };
    }
    const applied = await applyActiveTaskHygieneFacts(factsDb, vectorDb, embeddings, plan, {
      flushOnComplete: ctx.flushOnComplete,
      memoryDir: ctx.memoryDir,
    });
    await renderActiveTaskMarkdownFile(factsDb, ctx.staleMinutes, ctx.activeTaskFilePath, ctx.projection);
    return {
      ledger: "facts",
      dryRun: false,
      olderThanMinutes,
      duplicates: plan.duplicates,
      stale: plan.stale,
      actions: plan.actions,
      appliedCount: applied.appliedCount,
      auditFactId: applied.auditFactId,
    };
  }

  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  const active = taskFile?.active ?? [];
  const completed = taskFile?.completed ?? [];
  const plan = await planActiveTaskHygiene(active, {
    olderThanMinutes,
    openclawHome: opts.openclawHome,
  });
  if (apply && !taskFile) {
    return {
      ledger: "markdown",
      dryRun: true,
      cannotApplyReason: `Cannot apply hygiene: ${ctx.activeTaskFilePath} does not exist.`,
      olderThanMinutes,
      duplicates: plan.duplicates,
      stale: plan.stale,
      actions: plan.actions,
      appliedCount: 0,
    };
  }
  if (!apply || plan.actions.length === 0) {
    return {
      ledger: "markdown",
      dryRun: !apply,
      olderThanMinutes,
      duplicates: plan.duplicates,
      stale: plan.stale,
      actions: plan.actions,
      appliedCount: 0,
    };
  }

  const actionByLabel = new Map(plan.actions.map((action) => [action.label, action] as const));
  const newActive: ActiveTaskEntry[] = [];
  const newCompleted: ActiveTaskEntry[] = [...completed];
  const now = new Date().toISOString();
  const toFlush: ActiveTaskEntry[] = [];
  for (const task of active) {
    const action = actionByLabel.get(task.label);
    if (!action) {
      newActive.push(task);
      continue;
    }
    const completedEntry: ActiveTaskEntry = {
      ...task,
      status: "Done",
      updated: now,
      next: action.reason,
      subagent: action.kind === "dead-session" ? undefined : task.subagent,
    };
    newCompleted.push(completedEntry);
    toFlush.push(completedEntry);
  }
  await writeActiveTaskFile(ctx.activeTaskFilePath, newActive, newCompleted);
  if (ctx.flushOnComplete) {
    for (const entry of toFlush) {
      await flushCompletedTaskToMemory(entry, ctx.memoryDir).catch(() => {});
    }
  }
  return {
    ledger: "markdown",
    dryRun: false,
    olderThanMinutes,
    duplicates: plan.duplicates,
    stale: plan.stale,
    actions: plan.actions,
    appliedCount: toFlush.length,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Print active task list result to console */
function printActiveTaskList(result: ActiveTaskListResult): void {
  if (!result.fileExists && result.ledger !== "facts") {
    console.log("No ACTIVE-TASKS.md found — no active tasks.");
    return;
  }
  if (result.total === 0) {
    if (result.ledger === "facts") {
      console.log("✅ No active project tasks in facts (category:project).");
    } else {
      console.log("✅ No active tasks.");
    }
    return;
  }
  const src = result.ledger === "facts" ? "facts ledger" : result.filePath;
  console.log(`Active tasks (${result.total}) [${src}]:`);
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
}

function printActiveTaskHygiene(result: ActiveTaskHygieneResult): void {
  console.log(`Active-task hygiene report [${result.ledger}] (older than ${formatDuration(result.olderThanMinutes)}):`);
  if (result.cannotApplyReason) {
    console.log(`  Apply blocked: ${result.cannotApplyReason}`);
  }
  console.log(`  Duplicate groups: ${result.duplicates.length}`);
  console.log(`  Stale candidates: ${result.stale.length}`);
  console.log(`  Actions: ${result.actions.length}`);

  if (result.duplicates.length > 0) {
    console.log("\nDuplicate groups:");
    for (const group of result.duplicates) {
      const variants = group.labels.filter((label) => label !== group.canonicalLabel);
      console.log(`  Canonical: [${group.canonicalLabel}] (normalized: ${group.normalized})`);
      if (variants.length > 0) {
        console.log(`    Variants: ${variants.map((label) => `[${label}]`).join(", ")}`);
      }
    }
  }

  if (result.stale.length > 0) {
    console.log("\nStale candidates:");
    for (const row of result.stale) {
      console.log(`  [${row.label}] ${row.status} — updated ${row.updated} (${row.hoursStale}h)`);
      console.log(`    ${row.reason}`);
    }
  }

  if (result.actions.length > 0) {
    console.log("\nPlanned actions:");
    for (const action of result.actions) {
      const canonical = action.canonicalLabel ? ` -> [${action.canonicalLabel}]` : "";
      console.log(`  [${action.label}] ${action.kind} => ${action.toStatus}${canonical}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerActiveTaskCommands(
  mem: Chainable,
  cfg: HybridMemoryConfig,
  ctx: ActiveTaskContext | undefined,
): void {
  const at = cfg.activeTask;
  const ledgerHint = ctx?.ledger === "facts" ? " (facts ledger: category:project)" : "";

  const activeTasks = mem
    .command("active-tasks")
    .description(
      ctx
        ? `Working memory: active tasks (${ctx.ledger} ledger). Subcommands: list, complete, stale, reconcile, hygiene, add, render, config`
        : "Active tasks disabled (activeTask.enabled: false). Subcommand: config. Enable: openclaw hybrid-mem config-set activeTask enabled",
    )
    .action(async () => {
      if (!ctx) {
        console.log("Active tasks are disabled (activeTask.enabled: false).");
        console.log("  Enable: openclaw hybrid-mem config-set activeTask enabled");
        console.log("  Inspect settings: openclaw hybrid-mem active-tasks config");
        return;
      }
      const result = await runActiveTaskList(ctx);
      printActiveTaskList(result);
    });

  activeTasks
    .command("config")
    .description("Show active-task settings from plugin config (activeTask.* in openclaw.json)")
    .action(() => {
      for (const line of formatActiveTaskConfigLines(at)) {
        console.log(line);
      }
    });

  if (!ctx) {
    return;
  }

  activeTasks
    .command("list")
    .description(`List active tasks${ledgerHint}`)
    .action(async () => {
      const result = await runActiveTaskList(ctx);
      printActiveTaskList(result);
    });

  activeTasks
    .command("complete <label>")
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

  activeTasks
    .command("stale")
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

  activeTasks
    .command("reconcile")
    .description(
      "Complete in-progress tasks whose OpenClaw session transcript no longer exists (subagent bookkeeping cleanup)",
    )
    .option("--dry-run", "List tasks that would be reconciled without persisting changes")
    .action(async (opts: { dryRun?: boolean }) => {
      if (ctx.ledger === "facts") {
        const { factsDb, vectorDb, embeddings } = requireFacts(ctx);
        const result = await reconcileActiveTaskInProgressSessionsFacts(
          factsDb,
          vectorDb,
          embeddings,
          ctx.staleMinutes,
          {
            flushOnComplete: ctx.flushOnComplete,
            memoryDir: ctx.memoryDir,
            dryRun: opts.dryRun === true,
          },
        );
        if (result.reconciledLabels.length === 0) {
          console.log("✅ No orphan in-progress subagent tasks to reconcile.");
          return;
        }
        if (opts.dryRun) {
          console.log(`Dry run — would reconcile ${result.reconciledLabels.length} task(s):`);
          for (const l of result.reconciledLabels) console.log(`  - [${l}]`);
          return;
        }
        console.log(`✅ Reconciled ${result.reconciledLabels.length} task(s) in facts ledger:`);
        for (const l of result.reconciledLabels) console.log(`  - [${l}]`);
        return;
      }

      const result = await reconcileActiveTaskInProgressSessions(ctx.activeTaskFilePath, ctx.staleMinutes, {
        flushOnComplete: ctx.flushOnComplete,
        memoryDir: ctx.memoryDir,
        dryRun: opts.dryRun === true,
      });
      if (result.reconciledLabels.length === 0) {
        console.log("✅ No orphan in-progress subagent tasks to reconcile.");
        return;
      }
      if (opts.dryRun) {
        console.log(`Dry run — would reconcile ${result.reconciledLabels.length} task(s):`);
        for (const l of result.reconciledLabels) console.log(`  - [${l}]`);
        return;
      }
      console.log(`✅ Reconciled ${result.reconciledLabels.length} task(s) (moved to Completed):`);
      for (const l of result.reconciledLabels) console.log(`  - [${l}]`);
    });

  activeTasks
    .command("hygiene")
    .description(
      "Detect and optionally clean stale/duplicate task entities (dead sessions, stale failures, superseded variants)",
    )
    .option("--dry-run", "Report hygiene findings and planned actions (default)")
    .option("--apply", "Apply hygiene actions and persist audit fact (facts ledger only)")
    .option("--older-than <duration>", `Age threshold, e.g. 24h or 2d (default: ${formatDuration(ctx.staleMinutes)})`)
    .action(async (opts: { dryRun?: boolean; apply?: boolean; olderThan?: string }) => {
      if (opts.apply && opts.dryRun) {
        console.error("Error: --dry-run and --apply are mutually exclusive.");
        process.exitCode = 1;
        return;
      }
      let olderThanMinutes = ctx.staleMinutes;
      if (opts.olderThan?.trim()) {
        try {
          olderThanMinutes = parseDuration(opts.olderThan.trim());
        } catch (err) {
          console.error(`Error: invalid --older-than value "${opts.olderThan}": ${String(err)}`);
          process.exitCode = 1;
          return;
        }
      }
      const apply = opts.apply === true;
      const result = await runActiveTaskHygiene(ctx, {
        apply,
        olderThanMinutes,
      });
      printActiveTaskHygiene(result);
      if (apply && result.cannotApplyReason) {
        console.error(`Error: ${result.cannotApplyReason}`);
        process.exitCode = 1;
        return;
      }
      if (!apply) {
        console.log("\nDry run only. Re-run with --apply to persist hygiene actions.");
        return;
      }
      console.log(`\nApplied ${result.appliedCount} action(s).`);
      if (result.auditFactId) {
        console.log(`Audit fact: ${result.auditFactId}`);
      }
      if (result.ledger === "facts") {
        console.log(`Projection refreshed: ${ctx.activeTaskFilePath}`);
      }
    });

  activeTasks
    .command("add <label> <description>")
    .description(
      ctx.ledger === "facts"
        ? "Add or update a project task in facts (category:project)"
        : "Add or update a task in ACTIVE-TASKS.md",
    )
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

  activeTasks
    .command("render")
    .description(
      "Write ACTIVE-TASKS.md projection from facts ledger (no-op when ledger is markdown; use with activeTask.ledger: facts)",
    )
    .action(async () => {
      if (ctx.ledger !== "facts") {
        console.log(
          "ℹ️  render applies when activeTask.ledger is 'facts'. With markdown ledger, ACTIVE-TASKS.md is already the source.",
        );
        return;
      }
      const { factsDb } = requireFacts(ctx);
      await renderActiveTaskMarkdownFile(factsDb, ctx.staleMinutes, ctx.activeTaskFilePath, ctx.projection);
      console.log(`✅ Wrote ${ctx.activeTaskFilePath}`);
    });
}
