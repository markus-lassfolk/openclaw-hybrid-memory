/**
 * Lifecycle stage: Cleanup (Phase 2.3).
 * OpenClaw typed hooks **subagent_spawned** / **subagent_ended** (issue #966), stale session sweep timer, dispose.
 * Exports: consumePendingTaskSignals, registerCleanupHandlers, createStaleSweepTimer, getDispose.
 */

import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import {
  type ActiveTaskEntry,
  clearActiveTaskHandoff,
  completeTask,
  deleteSignal,
  flushCompletedTaskToMemory,
  isSubagentSession,
  isTerminalActiveTaskStatus,
  type PendingTaskSignal,
  readActiveTaskFile,
  readActiveTaskFileWithMtime,
  readPendingSignals,
  upsertTask,
  writeActiveTaskFileOptimistic,
} from "../services/active-task.js";
import { capturePluginError } from "../services/error-reporter.js";
import { disposeIntentClassifier, sweepStaleIntentSessionCaches } from "../services/intent-classifier.js";
import { disposeMemoryNudge, sweepStaleNudgeSessionState } from "../services/memory-nudge.js";
import {
  consumePendingTaskSignalsFacts,
  loadTaskLedgerFromFacts,
  syncActiveTaskEntryToFacts,
} from "../services/task-ledger-facts.js";
import { nowIso } from "../utils/dates.js";
import { parseDuration } from "../utils/duration.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";
import {
  findActiveTaskForSubagentEnd,
  type SubagentEndedEvent,
  subagentEndedIsSuccess,
  taskLabelsMatch,
} from "../utils/subagent-ended-utils.js";
import { resolveAgentIdFromHookEvent } from "./resolve-agent-id.js";
import { disposeToolEffectivenessStore } from "./stage-frustration.js";
import type { LifecycleContext, SessionState } from "./types.js";

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
 * their status changes to ACTIVE-TASKS.md or the facts ledger. Called after subagent completes.
 */
async function consumePendingTaskSignals(
  activeTaskPath: string,
  workspaceRoot: string,
  staleMinutes: number,
  flushOnComplete: boolean,
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void } | undefined,
  ledger: "markdown" | "facts",
  factsDb: import("../backends/facts-db.js").FactsDB,
  vectorDb: import("../backends/vector-db.js").VectorDB,
  embeddings: import("../services/embeddings.js").EmbeddingProvider,
  sessionKey?: string,
): Promise<void> {
  // Facts ledger has no markdown file lock — sub-agents may consume writeTaskSignal updates directly.
  if (isSubagentSession(sessionKey) && ledger !== "facts") {
    logger?.debug?.("memory-hybrid: skipping pending task signal consumption in sub-agent session");
    return;
  }

  if (ledger === "facts") {
    await consumePendingTaskSignalsFacts(
      workspaceRoot,
      staleMinutes,
      flushOnComplete,
      factsDb,
      vectorDb,
      embeddings,
      logger,
    );
    return;
  }

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
    logger?.warn?.(`memory-hybrid: failed to read ACTIVE-TASKS.md for signal consumption: ${err}`);
    return;
  }

  if (!taskFile) {
    const expiredSignals = signals.filter(isSignalExpired);
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
      logger?.info?.(
        `memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) while ACTIVE-TASKS.md is missing`,
      );
    }
    logger?.info?.("memory-hybrid: ACTIVE-TASKS.md missing; deferring pending task signals");
    return;
  }

  const knownMtime = taskFile.mtime;

  const findMatchingTaskInList = (entries: ActiveTaskEntry[], signal: PendingTaskSignal): ActiveTaskEntry | null => {
    const byLabel = entries.filter((t) => taskLabelsMatch(t.label, signal.taskRef));
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) {
      logger?.warn?.(`memory-hybrid: multiple active tasks share label ${signal.taskRef}; leaving signal pending`);
      return null;
    }
    const byDescription = entries.filter((t) => t.description === signal.taskRef);
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

  const findMatchingTask = (
    activeEntries: ActiveTaskEntry[],
    completedEntries: ActiveTaskEntry[],
    signal: PendingTaskSignal,
  ): ActiveTaskEntry | null =>
    findMatchingTaskInList(activeEntries, signal) ?? findMatchingTaskInList(completedEntries, signal);

  const applySignals = (
    activeEntries: ActiveTaskEntry[],
    completedEntries: ActiveTaskEntry[],
  ): {
    active: ActiveTaskEntry[];
    completed: ActiveTaskEntry[];
    processedSignals: PendingTaskSignal[];
    droppedTerminalSignals: PendingTaskSignal[];
    expiredSignals: PendingTaskSignal[];
    completedToFlush: ActiveTaskEntry[];
  } => {
    let updatedActive = [...activeEntries];
    const updatedCompleted = [...completedEntries];
    const processedSignals: PendingTaskSignal[] = [];
    const droppedTerminalSignals: PendingTaskSignal[] = [];
    const expiredSignals: PendingTaskSignal[] = [];
    const completedToFlush: ActiveTaskEntry[] = [];

    for (const signal of signals) {
      try {
        const updatedTimestamp = (() => {
          const t = Date.parse(signal.timestamp);
          return Number.isNaN(t) ? nowIso() : signal.timestamp;
        })();

        const existing = findMatchingTask(updatedActive, updatedCompleted, signal);
        if (!existing) {
          if (isSignalExpired(signal)) expiredSignals.push(signal);
          else logger?.warn?.(`memory-hybrid: no matching active task for signal ${signal.taskRef}; leaving pending`);
          continue;
        }

        if (isTerminalActiveTaskStatus(existing.status)) {
          droppedTerminalSignals.push(signal);
          logger?.info?.(
            `memory-hybrid: dropped ${signal.signal} signal for terminal task [${existing.label}] (${existing.status})`,
          );
          continue;
        }

        if (signal.signal === "completed") {
          const { updated, completed } = completeTask(updatedActive, existing.label);
          if (completed) {
            updatedActive = updated;
            const completedEntry: ActiveTaskEntry = {
              ...completed,
              updated: updatedTimestamp,
            };
            if (signal._handoff) completedEntry.handoff = signal._handoff;
            else clearActiveTaskHandoff(completedEntry);
            updatedCompleted.push(completedEntry);
            processedSignals.push(signal);
            completedToFlush.push(completedEntry);
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
        };
        if (signal._handoff) updatedEntry.handoff = signal._handoff;
        else delete updatedEntry.handoff;
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
      droppedTerminalSignals,
      expiredSignals,
      completedToFlush,
    };
  };

  let latestResult = applySignals(taskFile.active, taskFile.completed);
  let { processedSignals, droppedTerminalSignals, expiredSignals, completedToFlush } = latestResult;

  if (processedSignals.length === 0 && droppedTerminalSignals.length === 0) {
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
      logger?.info?.(`memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) with no matching task`);
    }
    return;
  }

  let wrote = false;
  if (processedSignals.length > 0) {
    try {
      wrote = await writeActiveTaskFileOptimistic(
        activeTaskPath,
        latestResult.active,
        latestResult.completed,
        knownMtime,
        async (fresh) => {
          latestResult = applySignals(fresh.active, fresh.completed);
          processedSignals = latestResult.processedSignals;
          droppedTerminalSignals = latestResult.droppedTerminalSignals;
          expiredSignals = latestResult.expiredSignals;
          completedToFlush = latestResult.completedToFlush;
          return [latestResult.active, latestResult.completed];
        },
        3,
        staleMinutes,
      );
    } catch (err) {
      logger?.warn?.(`memory-hybrid: failed to write ACTIVE-TASKS.md after signal consumption: ${err}`);
    }
  }

  for (const signal of droppedTerminalSignals) await deleteSignal(signal._filePath).catch(() => {});
  if (droppedTerminalSignals.length > 0) {
    logger?.info?.(
      `memory-hybrid: dropped ${droppedTerminalSignals.length} terminal task signal(s) without ledger mutation`,
    );
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
    logger?.info?.(`memory-hybrid: consumed ${processedSignals.length} pending task signal(s) from sub-agents`);
  } else if (expiredSignals.length > 0) {
    for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
    logger?.info?.(`memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) after write abort`);
  }
}

function sweepStaleSessions(sessionState: SessionState, injectedFactIdsBySession?: Map<string, Set<string>>): number {
  const now = Date.now();
  const cutoff = now - STALE_SESSION_TTL_MS;
  let swept = 0;
  for (const [sessionKey, lastActive] of sessionState.sessionLastActivity) {
    if (lastActive < cutoff) {
      sessionState.clearSessionState(sessionKey);
      sessionState.clearInjectedFactIdsForSession(injectedFactIdsBySession, sessionKey);
      sessionState.capabilityHintsSessionsSeen.delete(sessionKey);
      swept++;
    }
  }
  swept += sweepStaleIntentSessionCaches(cutoff);
  swept += sweepStaleNudgeSessionState(cutoff);
  return swept;
}

/**
 * Start the periodic stale session sweep timer. Returns the timer handle for dispose.
 */
export function createStaleSweepTimer(
  sessionState: SessionState,
  injectedFactIdsBySession?: Map<string, Set<string>>,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      sweepStaleSessions(sessionState, injectedFactIdsBySession);
    } catch (err) {
      // Suppress expected database connection errors during shutdown
      const e = err instanceof Error ? err : new Error(String(err));
      if (!/database connection is not open/i.test(e.message)) {
        capturePluginError(e, {
          operation: "stale-session-sweep",
          subsystem: "active-task",
        });
      }
    }
  }, STALE_SWEEP_INTERVAL_MS);
}

/**
 * Return a dispose function that clears the sweep timer and all session maps.
 */
export function getDispose(
  timerRef: ReturnType<typeof setInterval> | null,
  sessionState: SessionState,
  injectedFactIdsBySession?: Map<string, Set<string>>,
): () => void {
  return () => {
    if (timerRef) clearInterval(timerRef);
    sessionState.clearAll?.(injectedFactIdsBySession);
    disposeIntentClassifier();
    disposeMemoryNudge();
    disposeToolEffectivenessStore();
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
      const staleMinutes = parseDuration(ctx.cfg.activeTask.staleThreshold);
      const now = nowIso();

      if (!childOrSession) {
        api.logger.debug?.(
          `memory-hybrid: skipped spawn auto-checkpoint for [${label}] — missing childSessionKey/sessionKey`,
        );
        return;
      }

      if (ctx.cfg.activeTask.ledger === "facts") {
        // SECURITY: loadTaskLedgerFromFacts accepts an optional scopeFilter but silently returns
        // every tenant's task facts when it's omitted — must be threaded through explicitly
        // (matches active-task-tools-loader.ts's loadActiveTasksForTools).
        const scopeFilter = buildToolScopeFilter({}, ctx.currentAgentIdRef.value, ctx.cfg);
        const { active: existingActive } = loadTaskLedgerFromFacts(ctx.factsDb, undefined, scopeFilter);
        const existing = existingActive.find((t) => taskLabelsMatch(t.label, label));
        if (existing?.status === "Done") {
          api.logger.debug?.(
            `memory-hybrid: skipped spawn auto-checkpoint for terminal task [${existing.label}] (${existing.status})`,
          );
          return;
        }
        const reopeningFromTerminal = !!existing && isTerminalActiveTaskStatus(existing.status);
        const entry: ActiveTaskEntry = {
          ...(existing ?? {}),
          label: existing?.label ?? label.trim().toLowerCase(),
          description,
          status: "In progress",
          subagent: childOrSession,
          next: reopeningFromTerminal ? "" : existing?.next,
          started: existing?.started ?? now,
          updated: now,
        };
        if (reopeningFromTerminal) clearActiveTaskHandoff(entry);
        else delete entry.handoff;
        await syncActiveTaskEntryToFacts(ctx.factsDb, ctx.vectorDb, ctx.embeddings, entry, api.logger);
        api.logger.info?.(`memory-hybrid: auto-checkpoint — facts ledger task [${label}] for subagent spawn`);
        return;
      }

      if (isSubagentSession(api.context?.sessionKey)) {
        const reason = "sub-agent sessions are read-only for ACTIVE-TASKS.md; use writeTaskSignal instead";
        api.logger.debug?.(`memory-hybrid: skipped ACTIVE-TASKS.md write in subagent_spawned: ${reason}`);
        ctx.auditStore?.append({
          agentId: resolveAgentIdFromHookEvent(event, api) ?? ctx.currentAgentIdRef.value ?? "unknown",
          action: "cleanup:active-task-write-skipped",
          outcome: "skipped",
          sessionId: api.context?.sessionKey,
          context: { reason, taskLabel: label },
        });
        return;
      }

      // buildSpawnEntry is re-invoked against freshly-read state on optimistic-write conflict
      // (see writeActiveTaskFileOptimistic's merge callback below) rather than reusing the
      // pre-read `existing` snapshot — otherwise a concurrent subagent_spawned/subagent_ended for
      // a *different* task label could have its ACTIVE-TASKS.md update silently reverted by this
      // handler's write clobbering the array from stale data.
      const buildSpawnEntry = (existingEntry: ActiveTaskEntry | undefined): ActiveTaskEntry => {
        const reopeningFromTerminal = !!existingEntry && isTerminalActiveTaskStatus(existingEntry.status);
        const entry: ActiveTaskEntry = {
          ...(existingEntry ?? {}),
          label: existingEntry?.label ?? label,
          description,
          status: "In progress",
          subagent: childOrSession,
          next: reopeningFromTerminal ? "" : existingEntry?.next,
          started: existingEntry?.started ?? now,
          updated: now,
        };
        if (reopeningFromTerminal) clearActiveTaskHandoff(entry);
        else delete entry.handoff;
        return entry;
      };

      const taskFile = await readActiveTaskFileWithMtime(resolvedActiveTaskPath, staleMinutes);
      const existingActive = taskFile?.active ?? [];
      const existingCompleted = taskFile?.completed ?? [];
      const existing = existingActive.find((t) => taskLabelsMatch(t.label, label));
      if (existing?.status === "Done") {
        api.logger.debug?.(
          `memory-hybrid: skipped spawn auto-checkpoint for terminal task [${existing.label}] (${existing.status})`,
        );
        return;
      }

      const wrote = await writeActiveTaskFileOptimistic(
        resolvedActiveTaskPath,
        upsertTask(existingActive, buildSpawnEntry(existing)),
        existingCompleted,
        taskFile?.mtime ?? 0,
        async (fresh) => {
          const freshExisting = fresh.active.find((t) => taskLabelsMatch(t.label, label));
          if (freshExisting?.status === "Done") return null;
          return [upsertTask(fresh.active, buildSpawnEntry(freshExisting)), fresh.completed];
        },
        3,
        staleMinutes,
      );
      if (!wrote) {
        api.logger.debug?.(
          "memory-hybrid: skipped ACTIVE-TASKS.md write in subagent_spawned: conflict or terminal task",
        );
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
          ctx.cfg.activeTask.ledger,
          ctx.factsDb,
          ctx.vectorDb,
          ctx.embeddings,
          api.context?.sessionKey,
        );
        return;
      }

      let taskFile: { active: ActiveTaskEntry[]; completed: ActiveTaskEntry[] } | null = null;
      if (ctx.cfg.activeTask.ledger === "facts") {
        // SECURITY: see the scope-filter comment on the subagent_spawned handler above.
        const scopeFilter = buildToolScopeFilter({}, ctx.currentAgentIdRef.value, ctx.cfg);
        const { active, completed } = loadTaskLedgerFromFacts(ctx.factsDb, undefined, scopeFilter);
        taskFile = { active, completed };
      } else {
        taskFile = await readActiveTaskFile(resolvedActiveTaskPath, staleMinutes);
      }
      if (!taskFile) {
        await consumePendingTaskSignals(
          resolvedActiveTaskPath,
          workspaceRoot,
          staleMinutes,
          ctx.cfg.activeTask.flushOnComplete,
          api.logger,
          ctx.cfg.activeTask.ledger,
          ctx.factsDb,
          ctx.vectorDb,
          ctx.embeddings,
          api.context?.sessionKey,
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
          ctx.cfg.activeTask.ledger,
          ctx.factsDb,
          ctx.vectorDb,
          ctx.embeddings,
          api.context?.sessionKey,
        );
        return;
      }

      const statusBefore = existingTask.status;
      const taskLabel = existingTask.label;

      await consumePendingTaskSignals(
        resolvedActiveTaskPath,
        workspaceRoot,
        staleMinutes,
        ctx.cfg.activeTask.flushOnComplete,
        api.logger,
        ctx.cfg.activeTask.ledger,
        ctx.factsDb,
        ctx.vectorDb,
        ctx.embeddings,
        api.context?.sessionKey,
      );

      let knownMtime = 0;
      if (ctx.cfg.activeTask.ledger === "facts") {
        // SECURITY: see the scope-filter comment on the subagent_spawned handler above.
        const reloadScopeFilter = buildToolScopeFilter({}, ctx.currentAgentIdRef.value, ctx.cfg);
        const reloaded = loadTaskLedgerFromFacts(ctx.factsDb, undefined, reloadScopeFilter);
        taskFile = { active: reloaded.active, completed: reloaded.completed };
      } else {
        const withMtime = await readActiveTaskFileWithMtime(resolvedActiveTaskPath, staleMinutes);
        taskFile = withMtime;
        knownMtime = withMtime?.mtime ?? 0;
      }
      if (!taskFile) return;

      const taskAfterSignals = findActiveTaskForSubagentEnd(taskFile.active, ev);
      if (!taskAfterSignals) {
        api.logger.info?.(
          `memory-hybrid: subagent_ended — task [${taskLabel}] resolved by pending signal; skipping auto-checkpoint`,
        );
        return;
      }
      if (taskAfterSignals.status !== statusBefore) {
        api.logger.info?.(
          `memory-hybrid: subagent_ended — skipped auto-checkpoint for [${taskLabel}] after pending signal (${statusBefore} → ${taskAfterSignals.status})`,
        );
        return;
      }

      const now = nowIso();
      const newStatus = subagentEndedIsSuccess(ev) ? "Done" : "Failed";
      if (isTerminalActiveTaskStatus(taskAfterSignals.status)) {
        api.logger.debug?.(
          `memory-hybrid: skipped ${newStatus} auto-checkpoint for terminal task [${taskLabel}] (${taskAfterSignals.status})`,
        );
        return;
      }

      if (ctx.cfg.activeTask.ledger !== "facts" && isSubagentSession(api.context?.sessionKey)) {
        const reason = "sub-agent sessions are read-only for ACTIVE-TASKS.md; use writeTaskSignal instead";
        api.logger.debug?.(`memory-hybrid: skipped ACTIVE-TASKS.md write in subagent_ended (${newStatus}): ${reason}`);
        if (newStatus === "Done") {
          ctx.auditStore?.append({
            agentId: resolveAgentIdFromHookEvent(event, api) ?? ctx.currentAgentIdRef.value ?? "unknown",
            action: "cleanup:active-task-write-skipped",
            outcome: "skipped",
            sessionId: api.context?.sessionKey,
            context: { reason, taskLabel },
          });
        }
        return;
      }

      if (newStatus === "Done") {
        const { updated, completed } = completeTask(taskFile.active, taskLabel);
        if (completed) {
          if (ctx.cfg.activeTask.ledger === "facts") {
            const doneEntry: ActiveTaskEntry = { ...completed, status: "Done", updated: now, subagent: "" };
            await syncActiveTaskEntryToFacts(ctx.factsDb, ctx.vectorDb, ctx.embeddings, doneEntry, api.logger);
            if (ctx.cfg.activeTask.flushOnComplete) {
              const memoryDir = join(workspaceRoot, "memory");
              await flushCompletedTaskToMemory(doneEntry, memoryDir).catch(() => {});
            }
            api.logger.info?.(
              `memory-hybrid: auto-checkpoint — updated task [${taskLabel}] to ${newStatus} on subagent_ended`,
            );
          } else {
            // completeTask/findActiveTaskForSubagentEnd are re-invoked against freshly-read
            // state on optimistic-write conflict, mirroring the fix in subagent_spawned above —
            // taskFile.active here can be stale by the time this write actually lands.
            let flushCompleted: ActiveTaskEntry | null = completed;
            const wrote = await writeActiveTaskFileOptimistic(
              resolvedActiveTaskPath,
              updated,
              [...taskFile.completed, completed],
              knownMtime,
              async (fresh) => {
                const freshTask = findActiveTaskForSubagentEnd(fresh.active, ev);
                if (!freshTask || isTerminalActiveTaskStatus(freshTask.status)) {
                  flushCompleted = null;
                  return null;
                }
                const retry = completeTask(fresh.active, freshTask.label);
                if (!retry.completed) {
                  flushCompleted = null;
                  return null;
                }
                flushCompleted = retry.completed;
                return [retry.updated, [...fresh.completed, retry.completed]];
              },
              3,
              staleMinutes,
            );
            if (!wrote || !flushCompleted) {
              api.logger.debug?.(
                "memory-hybrid: skipped ACTIVE-TASKS.md write in subagent_ended (Done): conflict or already terminal",
              );
            } else {
              if (ctx.cfg.activeTask.flushOnComplete) {
                const memoryDir = join(workspaceRoot, "memory");
                await flushCompletedTaskToMemory(flushCompleted, memoryDir).catch(() => {});
              }
              api.logger.info?.(
                `memory-hybrid: auto-checkpoint — updated task [${taskLabel}] to ${newStatus} on subagent_ended`,
              );
            }
          }
        }
      } else {
        const errHint = ev.error ?? ev.reason;
        const buildFailedEntry = (task: ActiveTaskEntry): ActiveTaskEntry => {
          const entry: ActiveTaskEntry = {
            ...task,
            status: "Failed",
            updated: now,
            next: errHint ? `Fix: ${String(errHint).slice(0, 100)}` : task.next,
            subagent: "",
          };
          clearActiveTaskHandoff(entry);
          return entry;
        };
        if (ctx.cfg.activeTask.ledger === "facts") {
          await syncActiveTaskEntryToFacts(
            ctx.factsDb,
            ctx.vectorDb,
            ctx.embeddings,
            buildFailedEntry(taskAfterSignals),
            api.logger,
          );
          api.logger.info?.(
            `memory-hybrid: auto-checkpoint — updated task [${taskLabel}] to ${newStatus} on subagent_ended`,
          );
        } else {
          const wrote = await writeActiveTaskFileOptimistic(
            resolvedActiveTaskPath,
            upsertTask(taskFile.active, buildFailedEntry(taskAfterSignals)),
            taskFile.completed,
            knownMtime,
            async (fresh) => {
              const freshTask = findActiveTaskForSubagentEnd(fresh.active, ev);
              if (!freshTask || isTerminalActiveTaskStatus(freshTask.status)) return null;
              return [upsertTask(fresh.active, buildFailedEntry(freshTask)), fresh.completed];
            },
            3,
            staleMinutes,
          );
          if (!wrote) {
            api.logger.debug?.(
              "memory-hybrid: skipped ACTIVE-TASKS.md write in subagent_ended (Failed): conflict or already terminal",
            );
          } else {
            api.logger.info?.(
              `memory-hybrid: auto-checkpoint — updated task [${taskLabel}] to ${newStatus} on subagent_ended`,
            );
          }
        }
      }
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "active-task-subagent-ended",
        subsystem: "active-task",
      });
      api.logger.debug?.(`memory-hybrid: active task auto-checkpoint on subagent_ended failed: ${err}`);
    }
  });
}
