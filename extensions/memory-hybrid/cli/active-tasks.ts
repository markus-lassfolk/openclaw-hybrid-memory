/**
 * CLI commands for active task working memory.
 *
 * With activeTask.ledger `markdown` (default): reads/writes ACTIVE-TASKS.md.
 * With activeTask.ledger `facts`: reads/writes hybrid-memory category:project facts
 * (aligned with memory_store). Optional `active-tasks render` writes markdown projection.
 */

import { stat } from "node:fs/promises";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ActiveTaskProjectionConfig, HybridMemoryConfig } from "../config.js";
import {
  ACTIVE_TASK_STATUSES,
  type ActiveTaskEntry,
  type ActiveTaskStatus,
  completeTask,
  flushCompletedTaskToMemory,
  isTerminalActiveTaskStatus,
  readActiveTaskFile,
  reconcileActiveTaskInProgressSessions,
  upsertTask,
  writeActiveTaskFile,
} from "../services/active-task.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import {
  activeTaskRenderGoalsOpts,
  applyActiveTaskHygieneFacts,
  backfillActiveTaskCanonicalLabels,
  loadTaskLedgerFromFacts,
  planActiveTaskHygiene,
  readActiveTaskRowsFromFacts,
  reconcileActiveTaskInProgressSessionsFacts,
  reconcileActiveTaskLiveState,
  renderActiveTaskMarkdownFile,
  subagentRefIfSessionPresent,
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
  ActiveTaskMaintainResult,
  ActiveTaskReconcileResult,
  ActiveTaskRenderResult,
  ActiveTaskStaleResult,
} from "./types.js";
import { type CommanderOptsParent, readHybridMemVerbose } from "./global-verbose.js";

function isReopeningActiveTaskEntry(
  existing: ActiveTaskEntry | undefined,
  newStatus: ActiveTaskStatus,
  fromCompleted: boolean,
): boolean {
  if (!existing || newStatus === "Done") return false;
  if (fromCompleted) return true;
  return isTerminalActiveTaskStatus(existing.status) && newStatus !== existing.status;
}
import { ActiveTaskReconcileProgressReporter } from "../services/active-task-reconcile-progress.js";

/** Context injected into all active-task CLI commands */
export type ActiveTaskContext = {
  /** Absolute path to ACTIVE-TASKS.md (markdown ledger or render target) */
  activeTaskFilePath: string;
  /** Workspace root (for goal mirror refresh on projection renders). */
  workspaceRoot?: string;
  /** Plugin config (for goal mirror refresh on projection renders). */
  cfg?: HybridMemoryConfig;
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

function renderProjectionOpts(ctx: ActiveTaskContext, extra: { includeCompleted?: boolean } = {}) {
  const goals =
    ctx.cfg && ctx.workspaceRoot ? activeTaskRenderGoalsOpts(ctx.cfg, ctx.workspaceRoot) : {};
  return { ...goals, ...extra };
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
    const normalizedLabel = label.trim().toLowerCase();
    const matchedTask = active.find((t) => t.label.toLowerCase() === normalizedLabel);
    const labelToUse = matchedTask?.label ?? label;
    const { completed } = completeTask(active, labelToUse);
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
    const normalizedLabel = opts.label.trim().toLowerCase();
    const wasExisting =
      active.some((t) => t.label.toLowerCase() === normalizedLabel) ||
      completed.some((t) => t.label.toLowerCase() === normalizedLabel);
    const existing =
      active.find((t) => t.label.toLowerCase() === normalizedLabel) ??
      completed.find((t) => t.label.toLowerCase() === normalizedLabel);
    const status: ActiveTaskStatus = (() => {
      if (opts.status && ACTIVE_TASK_STATUSES.includes(opts.status as ActiveTaskStatus)) {
        return opts.status as ActiveTaskStatus;
      }
      return existing?.status ?? "In progress";
    })();
    const existingInCompleted = completed.some((t) => t.label.toLowerCase() === normalizedLabel);
    const reopening = isReopeningActiveTaskEntry(existing, status, existingInCompleted);
    const entry: ActiveTaskEntry = {
      label: opts.label.trim().toLowerCase(),
      description: opts.description,
      status,
      branch: opts.branch ?? existing?.branch,
      subagent: opts.subagent ?? (status === "Done" || reopening ? "" : existing?.subagent),
      next: opts.next ?? (reopening ? "" : existing?.next),
      stashCommit: existing?.stashCommit,
      handoff: existing?.handoff,
      relatedGoal: existing?.relatedGoal,
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
  const wasExisting =
    existingActive.some((t) => t.label === opts.label) || existingCompleted.some((t) => t.label === opts.label);
  const existing =
    existingActive.find((t) => t.label === opts.label) ?? existingCompleted.find((t) => t.label === opts.label);

  const status: ActiveTaskStatus = (() => {
    if (opts.status && ACTIVE_TASK_STATUSES.includes(opts.status as ActiveTaskStatus)) {
      return opts.status as ActiveTaskStatus;
    }
    return existing?.status ?? "In progress";
  })();

  const existingInCompleted = existingCompleted.some((t) => t.label === opts.label);
  const reopening = isReopeningActiveTaskEntry(existing, status, existingInCompleted);

  const entry: ActiveTaskEntry = {
    label: opts.label,
    description: opts.description,
    status,
    branch: opts.branch ?? existing?.branch,
    subagent: opts.subagent ?? (status === "Done" || reopening ? "" : existing?.subagent),
    next: opts.next ?? (reopening ? "" : existing?.next),
    stashCommit: existing?.stashCommit,
    started: existing?.started ?? now,
    updated: now,
  };

  if (status === "Done") {
    const updatedActive = existingActive.filter((t) => t.label !== opts.label);
    const updatedCompleted = [...existingCompleted.filter((t) => t.label !== opts.label), entry];
    await writeActiveTaskFile(ctx.activeTaskFilePath, updatedActive, updatedCompleted);
    if (ctx.flushOnComplete) {
      try {
        await flushCompletedTaskToMemory(entry, ctx.memoryDir);
      } catch {
        // Non-fatal
      }
    }
  } else {
    const updatedActive = upsertTask(
      existingActive.filter((t) => t.label !== opts.label),
      entry,
    );
    const updatedCompleted = existingCompleted.filter((t) => t.label !== opts.label);
    await writeActiveTaskFile(ctx.activeTaskFilePath, updatedActive, updatedCompleted);
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
    /** When true, fetch live PR state for tasks with PR references (default: false). */
    checkPrLiveBlocker?: boolean;
  } = {},
): Promise<ActiveTaskHygieneResult> {
  const olderThanMinutes = Math.max(1, Math.floor(opts.olderThanMinutes ?? ctx.staleMinutes));
  const apply = opts.apply === true;
  const checkPrLiveBlocker = opts.checkPrLiveBlocker === true;
  if (ctx.ledger === "facts") {
    const { factsDb, vectorDb, embeddings } = requireFacts(ctx);
    const { active } = loadTaskLedgerFromFacts(factsDb);
    const plan = await planActiveTaskHygiene(active, {
      olderThanMinutes,
      openclawHome: opts.openclawHome,
      checkPrLiveBlocker,
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
      openclawHome: opts.openclawHome,
    });
    await renderActiveTaskMarkdownFile(
      factsDb,
      ctx.staleMinutes,
      ctx.activeTaskFilePath,
      ctx.projection,
      undefined,
      renderProjectionOpts(ctx),
    );
    return {
      ledger: "facts",
      dryRun: false,
      olderThanMinutes,
      duplicates: plan.duplicates,
      stale: plan.stale,
      actions: plan.actions,
      appliedCount: applied.appliedCount,
      auditFactId: applied.auditFactId,
      prBlockerTasks: applied.prBlockerTasks,
    };
  }

  const taskFile = await readActiveTaskFile(ctx.activeTaskFilePath, ctx.staleMinutes);
  const active = taskFile?.active ?? [];
  const completed = taskFile?.completed ?? [];
  const plan = await planActiveTaskHygiene(active, {
    olderThanMinutes,
    openclawHome: opts.openclawHome,
    checkPrLiveBlocker,
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
  let appliedCount = 0;
  for (const task of active) {
    const action = actionByLabel.get(task.label);
    if (!action) {
      newActive.push(task);
      continue;
    }
    if (action.kind === "pr-live-blocker") {
      const subagent = await subagentRefIfSessionPresent(task.subagent, opts.openclawHome);
      newActive.push({
        ...task,
        status: "Waiting",
        updated: now,
        next: action.reason,
        subagent,
      });
      appliedCount++;
      continue;
    }
    const completedEntry: ActiveTaskEntry = {
      ...task,
      status: "Done",
      updated: now,
      next: action.reason,
      subagent: "",
    };
    newCompleted.push(completedEntry);
    toFlush.push(completedEntry);
    appliedCount++;
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
    appliedCount,
  };
}

type ActiveTaskUserLog = {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  liveStateLog: {
    info: (m: string) => void;
    debug: (m: string) => void;
    warn: (m: string) => void;
  };
};

function activeTaskUserLog(jsonMode?: boolean): ActiveTaskUserLog {
  if (jsonMode) {
    const writeStderr = (m: string) => process.stderr.write(`${m}\n`);
    return {
      log: writeStderr,
      warn: writeStderr,
      liveStateLog: { info: writeStderr, debug: () => {}, warn: writeStderr },
    };
  }
  return {
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    liveStateLog: { info: (m) => console.log(m), debug: () => {}, warn: (m) => console.warn(m) },
  };
}

/** Reconcile orphan in-progress subagent tasks against session transcripts (#978, #1864). */
export async function runActiveTaskReconcile(
  ctx: ActiveTaskContext,
  cfg: HybridMemoryConfig,
  opts: {
    dryRun?: boolean;
    verbose?: boolean;
    openclawHome?: string;
    jsonMode?: boolean;
  } = {},
): Promise<ActiveTaskReconcileResult> {
  const dryRun = opts.dryRun === true;
  const mode = dryRun ? "dry-run" : "apply";
  const userLog = activeTaskUserLog(opts.jsonMode);
  const progress =
    mode === "apply" || opts.verbose
      ? new ActiveTaskReconcileProgressReporter({
          mode,
          ledger: ctx.ledger,
          verbose: opts.verbose === true,
          emit: opts.jsonMode ? (line: string) => process.stderr.write(`${line}\n`) : undefined,
        })
      : undefined;

  if (ctx.ledger === "facts") {
    const { factsDb, vectorDb, embeddings } = requireFacts(ctx);
    const result = await reconcileActiveTaskInProgressSessionsFacts(factsDb, vectorDb, embeddings, ctx.staleMinutes, {
      flushOnComplete: ctx.flushOnComplete,
      memoryDir: ctx.memoryDir,
      dryRun,
      openclawHome: opts.openclawHome,
      progress,
    });

    let liveState: ActiveTaskReconcileResult["liveState"];
    if (!dryRun && cfg.activeTask.liveStateReconcile.enabled) {
      try {
        const liveResult = await reconcileActiveTaskLiveState(factsDb, vectorDb, embeddings, {
          maxRequests: 20,
          log: userLog.liveStateLog,
        });
        liveState = {
          updatedCount: liveResult.updatedCount,
          checkedCount: liveResult.checkedCount,
          skippedCount: liveResult.skippedCount,
        };
        if (liveResult.updatedCount > 0) {
          await renderActiveTaskMarkdownFile(
      factsDb,
      ctx.staleMinutes,
      ctx.activeTaskFilePath,
      ctx.projection,
      undefined,
      renderProjectionOpts(ctx),
    );
        }
      } catch (liveErr) {
        userLog.warn(`⚠️  Live-state reconcile failed (non-fatal): ${liveErr}`);
      }
    }
    progress?.complete();

    return {
      mode,
      ledger: "facts",
      reconciledLabels: result.reconciledLabels,
      candidates: result.candidates,
      reconciled: dryRun ? result.candidates : result.factsWritten,
      skipped: result.skipped,
      failed: result.failed,
      scanned: result.scanned,
      wrote: result.wrote,
      elapsedMs: result.elapsedMs,
      factsWritten: result.factsWritten,
      liveState,
    };
  }

  const result = await reconcileActiveTaskInProgressSessions(ctx.activeTaskFilePath, ctx.staleMinutes, {
    flushOnComplete: ctx.flushOnComplete,
    memoryDir: ctx.memoryDir,
    dryRun,
    openclawHome: opts.openclawHome,
    progress,
  });
  progress?.complete();

  return {
    mode,
    ledger: "markdown",
    reconciledLabels: result.reconciledLabels,
    candidates: result.candidates,
    reconciled: dryRun ? result.candidates : result.wrote ? result.reconciledLabels.length : 0,
    skipped: result.skipped,
    failed: result.failed,
    scanned: result.scanned,
    wrote: result.wrote,
    elapsedMs: result.elapsedMs,
  };
}

function printActiveTaskReconcile(result: ActiveTaskReconcileResult, log: (msg: string) => void = console.log): void {
  const reconciledCount = result.reconciled ?? 0;
  if (reconciledCount === 0 && result.candidates === 0) {
    log("✅ No orphan in-progress subagent tasks to reconcile.");
    return;
  }

  if (result.mode === "dry-run") {
    log(`Dry run — would reconcile ${result.candidates} task(s):`);
    for (const label of result.reconciledLabels) {
      log(`  - [${label}]`);
    }
    return;
  }

  if (result.ledger === "facts") {
    log(`✅ Reconciled ${reconciledCount} task(s) in facts ledger:`);
  } else {
    log(`✅ Reconciled ${reconciledCount} task(s) (moved to Completed):`);
  }
  for (let i = 0; i < Math.min(reconciledCount, result.reconciledLabels.length); i++) {
    log(`  - [${result.reconciledLabels[i]}]`);
  }
  if (result.failed > 0) {
    log(`⚠️  ${result.failed} task(s) failed to write.`);
  }

  if (result.liveState) {
    const { updatedCount, checkedCount, skippedCount } = result.liveState;
    if (updatedCount > 0) {
      log(
        `✅ Live-state reconcile: marked ${updatedCount} task(s) done (checked ${checkedCount}, skipped ${skippedCount})`,
      );
    } else {
      log(`✅ Live-state reconcile: no terminal states found (checked ${checkedCount}, skipped ${skippedCount})`);
    }
  }
}

function createMaintainLineEmitter(jsonMode?: boolean): (line: string) => void {
  const target = jsonMode ? process.stderr : process.stdout;
  return (line: string) => target.write(`${line}\n`);
}

/** Write ACTIVE-TASKS.md projection from facts ledger (#1865). */
export async function runActiveTaskRender(
  ctx: ActiveTaskContext,
  cfg: HybridMemoryConfig,
  opts: { includeCompleted?: boolean; jsonMode?: boolean } = {},
): Promise<ActiveTaskRenderResult> {
  if (ctx.ledger !== "facts") {
    return {
      ok: false,
      skipped: true,
      reason: "markdown ledger (ACTIVE-TASKS.md is the source of truth)",
    };
  }
  const { factsDb, vectorDb, embeddings } = requireFacts(ctx);
  const userLog = activeTaskUserLog(opts.jsonMode);
  if (cfg.activeTask.liveStateReconcile.enabled) {
    try {
      const liveResult = await reconcileActiveTaskLiveState(factsDb, vectorDb, embeddings, {
        maxRequests: 20,
        log: userLog.liveStateLog,
      });
      if (liveResult.updatedCount > 0) {
        userLog.log(
          `✅ Live-state reconcile: marked ${liveResult.updatedCount} task(s) done (checked ${liveResult.checkedCount}, skipped ${liveResult.skippedCount})`,
        );
      }
    } catch (liveErr) {
      userLog.warn(`⚠️  Live-state reconcile failed (non-fatal): ${liveErr}`);
    }
  }
  await renderActiveTaskMarkdownFile(
    factsDb,
    ctx.staleMinutes,
    ctx.activeTaskFilePath,
    ctx.projection,
    undefined,
    renderProjectionOpts(ctx, { includeCompleted: opts.includeCompleted === true }),
  );
  const list = await runActiveTaskList(ctx);
  const stale = await runActiveTaskStale(ctx);
  let bytes = 0;
  try {
    bytes = (await stat(ctx.activeTaskFilePath)).size;
  } catch {
    // Non-fatal — projection path may be unreadable in edge cases.
  }
  return {
    ok: true,
    path: ctx.activeTaskFilePath,
    active: list.total,
    stale: stale.total,
    bytes,
  };
}

function printActiveTaskStaleSummary(
  result: ActiveTaskStaleResult,
  log: (msg: string) => void = console.log,
  headingPrefix = "",
): void {
  if (result.total === 0) {
    log("✅ No stale tasks.");
    return;
  }
  log(`${headingPrefix}Stale tasks (${result.total}):`);
  for (const t of result.tasks) {
    log(`  [${t.label}] ${t.description}`);
    log(`    Status: ${t.status}`);
    log(`    Last updated: ${t.updated} (${t.hoursStale}h ago)`);
  }
}

function summarizeReconcileLine(result: ActiveTaskReconcileResult): string {
  return `active-tasks reconcile: candidates=${result.candidates} reconciled=${result.reconciled} skipped=${result.skipped} failed=${result.failed} elapsedMs=${result.elapsedMs}`;
}

function summarizeHygieneLine(result: ActiveTaskHygieneResult): string {
  const audit = result.auditFactId ? ` auditFact=${result.auditFactId}` : "";
  const failed = result.dryRun ? 0 : Math.max(0, result.actions.length - result.appliedCount);
  const skipped = result.dryRun
    ? result.actions.length
    : Math.max(0, result.actions.length - result.appliedCount - failed);
  return `active-tasks hygiene: actions=${result.actions.length} applied=${result.appliedCount} skipped=${skipped} failed=${failed}${audit}`;
}

export type ActiveTaskMaintainCompleteEvent = {
  event: "active_tasks_maintain_complete";
  status: "ok" | "failed" | "partial";
  mode: "apply" | "dry-run" | "qa";
  ledger: "markdown" | "facts";
  reconcile?: {
    candidates: number;
    reconciled: number;
    skipped: number;
    failed: number;
  };
  hygiene?: {
    actions: number;
    applied: number;
    failed: number;
    auditFact?: string;
  };
  render?: {
    wrote: string;
    active: number;
    stale: number;
    bytes?: number;
  };
  staleBefore?: number;
  staleAfter?: number;
  elapsedMs: number;
  error?: string;
};

export function buildMaintainCompleteEvent(result: ActiveTaskMaintainResult): ActiveTaskMaintainCompleteEvent {
  const reconcile = result.reconcile ?? result.reconcileDryRun;
  const hygiene = result.hygiene ?? result.hygieneDryRun;
  return {
    event: "active_tasks_maintain_complete",
    status: result.status,
    mode: result.mode,
    ledger: result.ledger,
    ...(reconcile
      ? {
          reconcile: {
            candidates: reconcile.candidates,
            reconciled: reconcile.reconciled,
            skipped: reconcile.skipped,
            failed: reconcile.failed,
          },
        }
      : {}),
    ...(hygiene
      ? {
          hygiene: {
            actions: hygiene.actions.length,
            applied: hygiene.appliedCount,
            failed: hygiene.dryRun ? 0 : Math.max(0, hygiene.actions.length - hygiene.appliedCount),
            ...(hygiene.auditFactId ? { auditFact: hygiene.auditFactId } : {}),
          },
        }
      : {}),
    ...(result.render?.ok
      ? {
          render: {
            wrote: result.render.path,
            active: result.render.active,
            stale: result.render.stale,
            bytes: result.render.bytes,
          },
        }
      : {}),
    ...(result.staleBefore !== undefined ? { staleBefore: result.staleBefore } : {}),
    ...(result.staleAfter !== undefined ? { staleAfter: result.staleAfter } : {}),
    elapsedMs: result.elapsedMs,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Run reconcile + hygiene + optional render/stale summary in one plugin process (#1865). */
export async function runActiveTaskMaintain(
  ctx: ActiveTaskContext,
  cfg: HybridMemoryConfig,
  opts: {
    apply?: boolean;
    dryRun?: boolean;
    qa?: boolean;
    render?: boolean;
    staleSummary?: boolean;
    beforeStale?: boolean;
    verbose?: boolean;
    olderThanMinutes?: number;
    openclawHome?: string;
    jsonMode?: boolean;
  } = {},
): Promise<ActiveTaskMaintainResult> {
  const emitMaintainLine = createMaintainLineEmitter(opts.jsonMode);
  const log = opts.jsonMode ? (msg: string) => process.stderr.write(`${msg}\n`) : (msg: string) => console.log(msg);
  const startedAt = Date.now();
  const qa = opts.qa === true;
  const apply = qa || opts.apply === true;
  const dryRunPass = qa || opts.dryRun === true || !apply;
  const applyPass = apply;
  const render = qa || opts.render === true;
  const staleSummary = qa || opts.staleSummary === true;
  const beforeStale = qa || opts.beforeStale === true;
  const mode: ActiveTaskMaintainResult["mode"] = qa ? "qa" : apply ? "apply" : "dry-run";
  const maintainMode = apply ? "apply" : "dry-run";

  emitMaintainLine(`active-tasks maintain: start mode=${maintainMode} ledger=${ctx.ledger}`);

  let status: ActiveTaskMaintainResult["status"] = "ok";
  let error: string | undefined;
  let staleBefore: number | undefined;
  let staleAfter: number | undefined;
  let reconcileDryRun: ActiveTaskReconcileResult | undefined;
  let reconcile: ActiveTaskReconcileResult | undefined;
  let hygieneDryRun: ActiveTaskHygieneResult | undefined;
  let hygiene: ActiveTaskHygieneResult | undefined;
  let renderResult: ActiveTaskRenderResult | undefined;

  const hygieneOpts = {
    olderThanMinutes: opts.olderThanMinutes,
    openclawHome: opts.openclawHome,
  };
  const reconcileOpts = {
    verbose: opts.verbose,
    openclawHome: opts.openclawHome,
    jsonMode: opts.jsonMode,
  };

  if (beforeStale) {
    const stale = await runActiveTaskStale(ctx);
    staleBefore = stale.total;
    printActiveTaskStaleSummary(stale, log);
  }

  if (dryRunPass) {
    emitMaintainLine("active-tasks maintain: phase=reconcile start mode=dry-run");
    reconcileDryRun = await runActiveTaskReconcile(ctx, cfg, { ...reconcileOpts, dryRun: true });
    emitMaintainLine(summarizeReconcileLine(reconcileDryRun));
    printActiveTaskReconcile(reconcileDryRun, log);

    emitMaintainLine("active-tasks maintain: phase=hygiene start mode=dry-run");
    hygieneDryRun = await runActiveTaskHygiene(ctx, { ...hygieneOpts, apply: false });
    emitMaintainLine(summarizeHygieneLine(hygieneDryRun));
    printActiveTaskHygiene(hygieneDryRun, log);
  }

  if (applyPass) {
    emitMaintainLine("active-tasks maintain: phase=reconcile start mode=apply");
    reconcile = await runActiveTaskReconcile(ctx, cfg, { ...reconcileOpts, dryRun: false });
    emitMaintainLine(summarizeReconcileLine(reconcile));
    printActiveTaskReconcile(reconcile, log);
    if (reconcile.failed > 0) {
      status = "partial";
      error = `reconcile failed ${reconcile.failed} task write(s)`;
    }

    emitMaintainLine("active-tasks maintain: phase=hygiene start mode=apply");
    hygiene = await runActiveTaskHygiene(ctx, { ...hygieneOpts, apply: true });
    emitMaintainLine(summarizeHygieneLine(hygiene));
    printActiveTaskHygiene(hygiene, log);
    if (hygiene.cannotApplyReason) {
      status = "failed";
      error = error ? `${error}; ${hygiene.cannotApplyReason}` : hygiene.cannotApplyReason;
    } else if (apply && hygiene.actions.length > 0) {
      log(`\nApplied ${hygiene.appliedCount} action(s).`);
      if (hygiene.auditFactId) {
        log(`Audit fact: ${hygiene.auditFactId}`);
      }
      if (hygiene.ledger === "facts") {
        log(`Projection refreshed: ${ctx.activeTaskFilePath}`);
      }
    }
  }

  if (render && applyPass) {
    emitMaintainLine("active-tasks maintain: phase=render start");
    renderResult = await runActiveTaskRender(ctx, cfg, { jsonMode: opts.jsonMode });
    if (renderResult.ok) {
      emitMaintainLine(
        `active-tasks render: wrote=${renderResult.path} active=${renderResult.active} stale=${renderResult.stale} bytes=${renderResult.bytes}`,
      );
      log(`✅ Wrote ${renderResult.path}`);
    } else {
      emitMaintainLine(`active-tasks render: skipped reason=${renderResult.reason}`);
    }
  }

  if (staleSummary) {
    const stale = await runActiveTaskStale(ctx);
    staleAfter = stale.total;
    printActiveTaskStaleSummary(stale, log);
  }

  const elapsedMs = Date.now() - startedAt;
  const result: ActiveTaskMaintainResult = {
    status,
    mode,
    ledger: ctx.ledger,
    ...(staleBefore !== undefined ? { staleBefore } : {}),
    ...(staleAfter !== undefined ? { staleAfter } : {}),
    ...(reconcileDryRun ? { reconcileDryRun } : {}),
    ...(reconcile ? { reconcile } : {}),
    ...(hygieneDryRun ? { hygieneDryRun } : {}),
    ...(hygiene ? { hygiene } : {}),
    ...(renderResult ? { render: renderResult } : {}),
    elapsedMs,
    ...(error ? { error } : {}),
  };

  emitMaintainLine(
    `active-tasks maintain: complete status=${status}${staleBefore !== undefined ? ` staleBefore=${staleBefore}` : ""}${staleAfter !== undefined ? ` staleAfter=${staleAfter}` : ""} elapsedMs=${elapsedMs}`,
  );
  return result;
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

function printActiveTaskHygiene(result: ActiveTaskHygieneResult, log: (msg: string) => void = console.log): void {
  log(`Active-task hygiene report [${result.ledger}] (older than ${formatDuration(result.olderThanMinutes)}):`);
  if (result.cannotApplyReason) {
    log(`  Apply blocked: ${result.cannotApplyReason}`);
  }
  log(`  Duplicate groups: ${result.duplicates.length}`);
  log(`  Stale candidates: ${result.stale.length}`);
  log(`  Actions: ${result.actions.length}`);

  if (result.duplicates.length > 0) {
    log("\nDuplicate groups:");
    for (const group of result.duplicates) {
      const variants = group.labels.filter((label) => label !== group.canonicalLabel);
      log(`  Canonical: [${group.canonicalLabel}] (normalized: ${group.normalized})`);
      if (variants.length > 0) {
        log(`    Variants: ${variants.map((label) => `[${label}]`).join(", ")}`);
      }
    }
  }

  if (result.stale.length > 0) {
    log("\nStale candidates:");
    for (const row of result.stale) {
      log(`  [${row.label}] ${row.status} — updated ${row.updated} (${row.hoursStale}h)`);
      log(`    ${row.reason}`);
    }
  }

  if (result.actions.length > 0) {
    log("\nPlanned actions:");
    for (const action of result.actions) {
      const canonical = action.canonicalLabel ? ` -> [${action.canonicalLabel}]` : "";
      log(`  [${action.label}] ${action.kind} => ${action.toStatus}${canonical}`);
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
        ? `Working memory: active tasks (${ctx.ledger} ledger). Subcommands: list, complete, stale, reconcile, maintain, hygiene, add, render, config`
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
      printActiveTaskStaleSummary(await runActiveTaskStale(ctx));
    });

  activeTasks
    .command("reconcile")
    .description(
      "Complete in-progress tasks whose OpenClaw session transcript no longer exists (subagent bookkeeping cleanup)",
    )
    .option("--dry-run", "List tasks that would be reconciled without persisting changes")
    .option("-v, --verbose", "Log per-task reconciliation decisions and phase markers")
    .action(async (opts: { dryRun?: boolean; verbose?: boolean }, cmd?: CommanderOptsParent) => {
      const verbose = !!opts.verbose || readHybridMemVerbose(cmd);
      const result = await runActiveTaskReconcile(ctx, cfg, {
        dryRun: opts.dryRun === true,
        verbose,
      });
      printActiveTaskReconcile(result);
      if (!opts.dryRun && result.failed > 0) {
        process.exitCode = 2;
      }
    });

  activeTasks
    .command("maintain")
    .description("Run reconcile + hygiene (+ optional render/stale summary) in one plugin process (#1865)")
    .option("--apply", "Apply reconcile/hygiene mutations (default: dry-run/report only)")
    .option("--dry-run", "Report planned reconcile/hygiene actions without mutations")
    .option("--qa", "Operator QA: before-stale + dry-run summaries + apply + render + final stale summary")
    .option("--render", "Write ACTIVE-TASKS.md projection after apply (facts ledger)")
    .option("--stale-summary", "Print stale task summary after maintenance")
    .option("--before-stale", "Print stale task summary before mutations")
    .option("--json", "Emit machine-readable final summary JSON line")
    .option("-v, --verbose", "Log per-task reconciliation decisions and phase markers")
    .option("--older-than <duration>", `Hygiene age threshold (default: ${formatDuration(ctx.staleMinutes)})`)
    .action(
      async (
        opts: {
          apply?: boolean;
          dryRun?: boolean;
          qa?: boolean;
          render?: boolean;
          staleSummary?: boolean;
          beforeStale?: boolean;
          json?: boolean;
          verbose?: boolean;
          olderThan?: string;
        },
        cmd?: CommanderOptsParent,
      ) => {
        if (opts.apply && opts.dryRun && !opts.qa) {
          console.error("Error: --dry-run and --apply are mutually exclusive (use --qa for both passes).");
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
        const verbose = !!opts.verbose || readHybridMemVerbose(cmd);
        const result = await runActiveTaskMaintain(ctx, cfg, {
          apply: opts.apply,
          dryRun: opts.dryRun,
          qa: opts.qa,
          render: opts.render,
          staleSummary: opts.staleSummary,
          beforeStale: opts.beforeStale,
          verbose,
          olderThanMinutes,
          jsonMode: opts.json,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(buildMaintainCompleteEvent(result))}\n`);
        }
        if (result.status === "failed") {
          process.exitCode = 1;
        } else if (result.status === "partial") {
          process.exitCode = 2;
        }
      },
    );

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
      let liveUpdatedCount = 0;
      let liveCheckedCount = 0;
      let liveSkippedCount = 0;
      if (ctx.ledger === "facts" && cfg.activeTask.liveStateReconcile.enabled) {
        const { factsDb, vectorDb, embeddings } = requireFacts(ctx);
        try {
          const liveResult = await reconcileActiveTaskLiveState(factsDb, vectorDb, embeddings, {
            maxRequests: 20,
            log: { info: (m) => console.log(m), debug: () => {}, warn: (m) => console.warn(m) },
          });
          liveUpdatedCount = liveResult.updatedCount;
          liveCheckedCount = liveResult.checkedCount;
          liveSkippedCount = liveResult.skippedCount;
          if (liveResult.updatedCount > 0) {
            await renderActiveTaskMarkdownFile(
      factsDb,
      ctx.staleMinutes,
      ctx.activeTaskFilePath,
      ctx.projection,
      undefined,
      renderProjectionOpts(ctx),
    );
          }
        } catch (liveErr) {
          console.warn(`⚠️  Live-state reconcile failed (non-fatal): ${liveErr}`);
        }
      }
      console.log(`\nApplied ${result.appliedCount} action(s).`);
      if (result.auditFactId) {
        console.log(`Audit fact: ${result.auditFactId}`);
      }
      if (result.ledger === "facts") {
        console.log(`Projection refreshed: ${ctx.activeTaskFilePath}`);
        if (cfg.activeTask.liveStateReconcile.enabled) {
          if (liveUpdatedCount > 0) {
            console.log(
              `Live-state reconcile: marked ${liveUpdatedCount} task(s) done (checked ${liveCheckedCount}, skipped ${liveSkippedCount}).`,
            );
          } else {
            console.log(
              `Live-state reconcile: no terminal states found (checked ${liveCheckedCount}, skipped ${liveSkippedCount}).`,
            );
          }
        }
      }
    });

  activeTasks
    .command("backfill-canonical-labels")
    .description("Backfill active-task canonical labels and collapse case-variant duplicate facts (facts ledger only)")
    .option("--dry-run", "Report planned changes without updating facts")
    .option("--limit <n>", "Maximum project facts to scan (default: 50000)")
    .action(async (opts: { dryRun?: boolean; limit?: string }) => {
      if (ctx.ledger !== "facts") {
        console.log("ℹ️  backfill-canonical-labels applies only when activeTask.ledger is 'facts'.");
        return;
      }
      const { factsDb } = requireFacts(ctx);
      const parsedLimit = opts.limit == null ? undefined : Number.parseInt(String(opts.limit), 10);
      if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit <= 0)) {
        console.error(`Error: invalid --limit value "${opts.limit}"`);
        process.exitCode = 1;
        return;
      }
      const result = backfillActiveTaskCanonicalLabels(factsDb, {
        dryRun: opts.dryRun === true,
        limit: parsedLimit,
      });
      console.log(`${opts.dryRun ? "Dry run — " : ""}Scanned ${result.scannedFacts} project fact(s).`);
      console.log(`Canonical label updates: ${result.canonicalLabelsUpdated}`);
      console.log(`Superseded duplicate facts: ${result.supersededFacts}`);
      if (result.duplicateGroups.length > 0) {
        console.log("Duplicate canonical groups:");
        for (const group of result.duplicateGroups) {
          console.log(
            `  - ${group.canonicalLabel}: facts=${group.facts}, activeBefore=${group.activeBefore}, superseded=${group.superseded}`,
          );
        }
      }
      if (!opts.dryRun) {
        await renderActiveTaskMarkdownFile(
      factsDb,
      ctx.staleMinutes,
      ctx.activeTaskFilePath,
      ctx.projection,
      undefined,
      renderProjectionOpts(ctx),
    );
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
    .option("--include-completed", "Include terminal/completed rows for history/audit output")
    .action(async (opts: { includeCompleted?: boolean }) => {
      if (ctx.ledger !== "facts") {
        console.log(
          "ℹ️  render applies when activeTask.ledger is 'facts'. With markdown ledger, ACTIVE-TASKS.md is already the source.",
        );
        return;
      }
      const renderResult = await runActiveTaskRender(ctx, cfg, {
        includeCompleted: opts.includeCompleted === true,
      });
      if (renderResult.ok) {
        console.log(`✅ Wrote ${renderResult.path}`);
      }
    });
}
