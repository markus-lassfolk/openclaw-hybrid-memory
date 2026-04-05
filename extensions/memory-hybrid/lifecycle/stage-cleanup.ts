/**
 * Lifecycle stage: Cleanup (Phase 2.3).
 * OpenClaw typed hooks **subagent_spawned** / **subagent_ended** (issue #966), stale session sweep timer, dispose.
 * Exports: consumePendingTaskSignals, registerCleanupHandlers, createStaleSweepTimer, getDispose.
 */

import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { capturePluginError } from "../services/error-reporter.js";
import { parseDuration } from "../utils/duration.js";
import {
  readActiveTaskFile,
  writeActiveTaskFileGuarded,
  readActiveTaskFileWithMtime,
  writeActiveTaskFileOptimistic,
  upsertTask,
  completeTask,
  flushCompletedTaskToMemory,
  readPendingSignals,
  deleteSignal,
  type ActiveTaskEntry,
  type PendingTaskSignal,
} from "../services/active-task.js";
import type { LifecycleContext, SessionState } from "./types.js";
import {
  findActiveTaskForSubagentEnd,
  subagentEndedIsSuccess,
  type SubagentEndedEvent,
} from "../utils/subagent-ended-utils.js";

const STALE_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** OpenClaw core dispatch shapes — see issue #966 / runSubagentSpawned */
type SubagentSpawnedEvent = {
  childSessionKey?: string;
  /** Legacy / alternate field names from older handlers */
  sessionKey?: string;
  label?: string;
  task?: string;
  agentId?: string;
  runId?: string;
};

/**
 * Read all pending task signals from `memory/task-signals/*.json` and apply
 * their status changes to ACTIVE-TASK.md. Called after subagent completes.
 */
async function consumePendingTaskSignals(
  activeTaskPath: string,
  workspaceRoot: string,
  staleMinutes: number,
  flushOnComplete: boolean,
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
  ctx?: LifecycleContext,
): Promise<void> {
  const memoryDir = join(workspaceRoot, "memory");
  let signals: PendingTaskSignal[];
  try {
    signals = await readPendingSignals(memoryDir);
  } catch (err) {
    logger?.warn?.(`memory-hybrid: failed to read pending task signals: ${err}`);
    return;
  }

  if (signals.length === 0) return;

  const signalTtlMs = Math.max(staleMinutes * 60 * 1000, 24 * 60 * 60 * 1000);
  const nowMs = Date.now();
  const isSignalExpired = (signal: PendingTaskSignal): boolean => {
    const parsed = Date.parse(signal.timestamp);
    if (Number.isNaN(parsed)) return true;
    return nowMs - parsed > signalTtlMs;
  };

  signals = [...signals].sort((a, b) => {
    const at = Date.parse(a.timestamp);
    const bt = Date.parse(b.timestamp);
    if (Number.isNaN(at) || Number.isNaN(bt)) return a._filePath.localeCompare(b._filePath);
    return at === bt ? a._filePath.localeCompare(b._filePath) : at - bt;
  });

  let taskFile: Awaited<ReturnType<typeof readActiveTaskFileWithMtime>> | undefined;
  try {
    taskFile = await readActiveTaskFileWithMtime(activeTaskPath, staleMinutes);
  } catch (err) {
    logger?.warn?.(`memory-hybrid: failed to read ACTIVE-TASK.md for signal consumption: ${err}`);
    return;
  }

  if (!taskFile) {
    const expiredSignals = signals.filter(isSignalExpired);
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
      logger?.info?.(
        `memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) while ACTIVE-TASK.md is missing`,
      );
    }
    logger?.info?.("memory-hybrid: ACTIVE-TASK.md missing; deferring pending task signals");
    return;
  }

  const knownMtime = taskFile.mtime;

  const findMatchingTask = (activeEntries: ActiveTaskEntry[], signal: PendingTaskSignal): ActiveTaskEntry | null => {
    const byLabel = activeEntries.filter((t) => t.label === signal.taskRef);
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) {
      logger?.warn?.(`memory-hybrid: multiple active tasks share label ${signal.taskRef}; leaving signal pending`);
      return null;
    }
    const byDescription = activeEntries.filter((t) => t.description === signal.taskRef);
    if (byDescription.length === 1) {
      logger?.warn?.(
        `memory-hybrid: matched signal for "${signal.taskRef}" by description (not label); sub-agents should use the exact task label in taskRef for reliable matching`,
      );
      return byDescription[0];
    }
    if (byDescription.length > 1) {
      logger?.warn?.(
        `memory-hybrid: multiple active tasks match description ${signal.taskRef}; leaving signal pending`,
      );
      return null;
    }
    return null;
  };

  const applySignals = (
    activeEntries: ActiveTaskEntry[],
    completedEntries: ActiveTaskEntry[],
  ): {
    active: ActiveTaskEntry[];
    completed: ActiveTaskEntry[];
    processedSignals: PendingTaskSignal[];
    expiredSignals: PendingTaskSignal[];
    completedToFlush: ActiveTaskEntry[];
  } => {
    let updatedActive = [...activeEntries];
    const updatedCompleted = [...completedEntries];
    const processedSignals: PendingTaskSignal[] = [];
    const expiredSignals: PendingTaskSignal[] = [];
    const completedToFlush: ActiveTaskEntry[] = [];

    for (const signal of signals) {
      try {
        const updatedTimestamp = (() => {
          const t = Date.parse(signal.timestamp);
          return Number.isNaN(t) ? new Date().toISOString() : signal.timestamp;
        })();

        const existing = findMatchingTask(updatedActive, signal);
        if (!existing) {
          if (isSignalExpired(signal)) expiredSignals.push(signal);
          else logger?.warn?.(`memory-hybrid: no matching active task for signal ${signal.taskRef}; leaving pending`);
          continue;
        }

        if (signal.signal === "completed") {
          const { updated, completed } = completeTask(updatedActive, existing.label);
          if (completed) {
            updatedActive = updated;
            updatedCompleted.push({
              ...completed,
              updated: updatedTimestamp,
              handoff: signal._handoff ?? completed.handoff,
            });
            processedSignals.push(signal);
            completedToFlush.push({
              ...completed,
              updated: updatedTimestamp,
              handoff: signal._handoff ?? completed.handoff,
            });
          }
          continue;
        }

        if (signal.signal !== "blocked" && signal.signal !== "escalate" && signal.signal !== "update") {
          if (isSignalExpired(signal)) expiredSignals.push(signal);
          else
            logger?.warn?.(
              `memory-hybrid: unhandled task signal "${signal.signal}" for ${signal.taskRef}; leaving pending`,
            );
          continue;
        }

        const newStatus: ActiveTaskEntry["status"] =
          signal.signal === "blocked" ? "Stalled" : signal.signal === "escalate" ? "Waiting" : existing.status;
        const updatedEntry: ActiveTaskEntry = {
          ...existing,
          status: newStatus,
          next: signal.summary ? `[Signal: ${signal.signal}] ${signal.summary}` : existing.next,
          updated: updatedTimestamp,
          handoff: signal._handoff ?? existing.handoff,
        };
        updatedActive = upsertTask(updatedActive, updatedEntry, true);
        processedSignals.push(signal);
      } catch (err) {
        logger?.warn?.(`memory-hybrid: failed to process signal from ${signal._filePath}: ${err}`);
      }
    }

    return {
      active: updatedActive,
      completed: updatedCompleted,
      processedSignals,
      expiredSignals,
      completedToFlush,
    };
  };

  let latestResult = applySignals(taskFile.active, taskFile.completed);
  let { processedSignals, expiredSignals, completedToFlush } = latestResult;

  if (processedSignals.length === 0) {
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
      logger?.info?.(`memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) with no matching task`);
    }
    return;
  }

  let wrote = false;
  try {
    wrote = await writeActiveTaskFileOptimistic(
      activeTaskPath,
      latestResult.active,
      latestResult.completed,
      knownMtime,
      async (fresh) => {
        latestResult = applySignals(fresh.active, fresh.completed);
        processedSignals = latestResult.processedSignals;
        expiredSignals = latestResult.expiredSignals;
        completedToFlush = latestResult.completedToFlush;
        return [latestResult.active, latestResult.completed];
      },
      3,
      staleMinutes,
    );
  } catch (err) {
    logger?.warn?.(`memory-hybrid: failed to write ACTIVE-TASK.md after signal consumption: ${err}`);
  }

  if (wrote) {
    for (const signal of processedSignals) await deleteSignal(signal._filePath).catch(() => {});
    for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
    if (flushOnComplete && completedToFlush.length > 0) {
      const memoryDir = join(workspaceRoot, "memory");
      for (const completed of completedToFlush) {
        await flushCompletedTaskToMemory(completed, memoryDir).catch(() => {});
      }
    }
    if (ctx?.cfg?.goalStewardship?.enabled) {
      try {
        const { resolveGoalsDir, updateGoalOnSubagentEnd } = await import("../services/goal-stewardship.js");
        const gDir = resolveGoalsDir(workspaceRoot, ctx.cfg.goalStewardship.goalsDir);
        for (const signal of processedSignals) {
          if (signal.signal === "completed" || signal.signal === "update") {
            await updateGoalOnSubagentEnd(gDir, {
              label: signal.taskRef,
              sessionKey: null,
              success: signal.signal === "completed",
              outcome: signal.summary ?? null,
            }).catch(() => {});
          }
        }
      } catch {
        /* non-fatal */
      }
    }
    logger?.info?.(`memory-hybrid: consumed ${processedSignals.length} pending task signal(s) from sub-agents`);
  } else if (expiredSignals.length > 0) {
    for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
    logger?.info?.(`memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) after write abort`);
  }
}

function sweepStaleSessions(sessionState: SessionState): number {
  const now = Date.now();
  const cutoff = now - STALE_SESSION_TTL_MS;
  let swept = 0;
  for (const [sessionKey, lastActive] of sessionState.sessionLastActivity) {
    if (lastActive < cutoff) {
      sessionState.clearSessionState(sessionKey);
      swept++;
    }
  }
  return swept;
}

/**
 * Start the periodic stale session sweep timer. Returns the timer handle for dispose.
 */
export function createStaleSweepTimer(sessionState: SessionState): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      sweepStaleSessions(sessionState);
    } catch {
      // Non-fatal
    }
  }, STALE_SWEEP_INTERVAL_MS);
}

/**
 * Return a dispose function that clears the sweep timer and all session maps.
 */
export function getDispose(timerRef: ReturnType<typeof setInterval> | null, sessionState: SessionState): () => void {
  return () => {
    if (timerRef) clearInterval(timerRef);
    sessionState.clearAll?.();
  };
}

/**
 * Register **subagent_spawned** and **subagent_ended** handlers (active-task checkpoint + signal consumption).
 * Hook names must match OpenClaw `PLUGIN_HOOK_NAMES` (issue #966).
 */
export function registerCleanupHandlers(
  api: ClawdbotPluginApi,
  ctx: LifecycleContext,
  _sessionState: SessionState,
  resolvedActiveTaskPath: string,
  workspaceRoot: string,
): void {
  if (!ctx.cfg.activeTask.enabled || !ctx.cfg.activeTask.autoCheckpoint) return;

  api.on("subagent_spawned", async (event: unknown) => {
    try {
      const ev = event as SubagentSpawnedEvent;
      const childOrSession = ev.childSessionKey ?? ev.sessionKey;
      const label = ev.label ?? childOrSession ?? `subagent-${Date.now()}`;
      const description = ev.task ?? `Subagent task (session: ${childOrSession ?? "unknown"})`;
      const taskFile = await readActiveTaskFile(
        resolvedActiveTaskPath,
        parseDuration(ctx.cfg.activeTask.staleThreshold),
      );
      const now = new Date().toISOString();
      const existingActive = taskFile?.active ?? [];
      const existingCompleted = taskFile?.completed ?? [];
      const existing = existingActive.find((t) => t.label === label);
      const entry: ActiveTaskEntry = {
        label,
        description,
        status: "In progress",
        subagent: childOrSession,
        started: existing?.started ?? now,
        updated: now,
      };
      const updated = upsertTask(existingActive, entry);
      const writeResult = await writeActiveTaskFileGuarded(
        resolvedActiveTaskPath,
        updated,
        existingCompleted,
        api.context?.sessionKey,
      );
      if (writeResult.skipped) {
        api.logger.debug?.(`memory-hybrid: skipped ACTIVE-TASK.md write in subagent_spawned: ${writeResult.reason}`);
      } else {
        api.logger.info?.(`memory-hybrid: auto-checkpoint — created active task [${label}] for subagent spawn`);
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "active-task-subagent-spawned",
        subsystem: "active-task",
      });
      api.logger.debug?.(`memory-hybrid: active task auto-checkpoint on subagent_spawned failed: ${err}`);
    }
  });

  api.on("subagent_ended", async (event: unknown) => {
    try {
      const ev = event as SubagentEndedEvent;
      const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
      const targetKey = ev.targetSessionKey ?? ev.sessionKey;
      if (!ev.label && !targetKey) {
        await consumePendingTaskSignals(
          resolvedActiveTaskPath,
          workspaceRoot,
          staleMinutes,
          ctx.cfg.activeTask.flushOnComplete,
          api.logger,
          ctx,
        );
        return;
      }

      const taskFile = await readActiveTaskFile(resolvedActiveTaskPath, staleMinutes);
      if (!taskFile) {
        await consumePendingTaskSignals(
          resolvedActiveTaskPath,
          workspaceRoot,
          staleMinutes,
          ctx.cfg.activeTask.flushOnComplete,
          api.logger,
          ctx,
        );
        return;
      }

      const existingTask = findActiveTaskForSubagentEnd(taskFile.active, ev);
      if (!existingTask) {
        await consumePendingTaskSignals(
          resolvedActiveTaskPath,
          workspaceRoot,
          staleMinutes,
          ctx.cfg.activeTask.flushOnComplete,
          api.logger,
          ctx,
        );
        return;
      }

      const taskLabel = existingTask.label;
      const now = new Date().toISOString();
      const newStatus = subagentEndedIsSuccess(ev) ? "Done" : "Failed";

      if (newStatus === "Done") {
        const { updated, completed } = completeTask(taskFile.active, taskLabel);
        if (completed) {
          const writeResult = await writeActiveTaskFileGuarded(
            resolvedActiveTaskPath,
            updated,
            [...taskFile.completed, completed],
            api.context?.sessionKey,
          );
          if (writeResult.skipped) {
            api.logger.debug?.(
              `memory-hybrid: skipped ACTIVE-TASK.md write in subagent_ended (Done): ${writeResult.reason}`,
            );
          } else {
            if (ctx.cfg.activeTask.flushOnComplete) {
              const memoryDir = join(workspaceRoot, "memory");
              await flushCompletedTaskToMemory(completed, memoryDir).catch(() => {});
            }
            api.logger.info?.(
              `memory-hybrid: auto-checkpoint — updated task [${taskLabel}] to ${newStatus} on subagent_ended`,
            );
          }
        }
      } else {
        const errHint = ev.error ?? ev.reason;
        const updatedEntry: ActiveTaskEntry = {
          ...existingTask,
          status: "Failed",
          updated: now,
          next: errHint ? `Fix: ${String(errHint).slice(0, 100)}` : existingTask.next,
        };
        const updated = upsertTask(taskFile.active, updatedEntry);
        const writeResult = await writeActiveTaskFileGuarded(
          resolvedActiveTaskPath,
          updated,
          taskFile.completed,
          api.context?.sessionKey,
        );
        if (writeResult.skipped) {
          api.logger.debug?.(
            `memory-hybrid: skipped ACTIVE-TASK.md write in subagent_ended (Failed): ${writeResult.reason}`,
          );
        } else {
          api.logger.info?.(
            `memory-hybrid: auto-checkpoint — updated task [${taskLabel}] to ${newStatus} on subagent_ended`,
          );
        }
      }

      await consumePendingTaskSignals(
        resolvedActiveTaskPath,
        workspaceRoot,
        staleMinutes,
        ctx.cfg.activeTask.flushOnComplete,
        api.logger,
        ctx,
      );
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "active-task-subagent-ended",
        subsystem: "active-task",
      });
      api.logger.debug?.(`memory-hybrid: active task auto-checkpoint on subagent_ended failed: ${err}`);
    }
  });
}
