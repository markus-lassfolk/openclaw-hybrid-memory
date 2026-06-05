/**
 * Link subagent_spawned / subagent_ended to goal registry when goal stewardship is enabled.
 */
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { capturePluginError } from "../services/error-reporter.js";
import { isTerminalActiveTaskStatus, clearActiveTaskHandoff, type ActiveTaskEntry } from "../services/active-task.js";
import {
  markGoalDispatchFailure,
  type GoalSubagentSpawnEvent,
  linkSubagentToGoal,
  resolveGoalForSpawn,
  updateGoalOnSubagentEnd,
} from "../services/goal-stewardship.js";
import { loadTaskLedgerFromFacts, syncActiveTaskEntryToFacts } from "../services/task-ledger-facts.js";
import { type SubagentEndedEvent, subagentEndedIsSuccess, taskLabelsMatch } from "../utils/subagent-ended-utils.js";
import { nowIso } from "../utils/dates.js";
import type { LifecycleContext } from "./types.js";

async function syncGoalLinkedTaskToFactsLedger(
  ctx: LifecycleContext,
  label: string,
  goalId: string,
  childOrSession: string | null | undefined,
  description: string | undefined,
  logger?: ClawdbotPluginApi["logger"],
  overrides?: { status?: ActiveTaskEntry["status"]; next?: string },
): Promise<void> {
  if (!ctx.cfg.activeTask.enabled || ctx.cfg.activeTask.ledger !== "facts") return;
  const { active } = loadTaskLedgerFromFacts(ctx.factsDb);
  const existing = active.find((t) => taskLabelsMatch(t.label, label));
  const now = nowIso();
  const reopeningFromTerminal =
    !!childOrSession && !overrides?.status && !!existing && isTerminalActiveTaskStatus(existing.status);
  const markingFailed = overrides?.status === "Failed";
  const entry: ActiveTaskEntry = {
    ...(existing ?? {}),
    label: existing?.label ?? label,
    description: description ?? existing?.description ?? `Subagent task (session: ${childOrSession ?? "unknown"})`,
    status: overrides?.status ?? "In progress",
    subagent: childOrSession === null ? "" : (childOrSession ?? existing?.subagent),
    relatedGoal: goalId,
    next: overrides?.next ?? (reopeningFromTerminal ? "" : existing?.next),
    started: existing?.started ?? now,
    updated: now,
  };
  if (reopeningFromTerminal || markingFailed) clearActiveTaskHandoff(entry);
  else delete entry.handoff;
  await syncActiveTaskEntryToFacts(ctx.factsDb, ctx.vectorDb, ctx.embeddings, entry, logger);
}

function getEventStringField(event: unknown, key: string): string | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function getEventBooleanField(event: unknown, key: string): boolean | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

export function registerGoalSubagentHandlers(api: ClawdbotPluginApi, ctx: LifecycleContext, goalsDir: string): void {
  if (!ctx.cfg.goalStewardship.enabled) return;

  api.on("subagent_spawned", async (event: unknown) => {
    try {
      const ev = event as GoalSubagentSpawnEvent;
      const gid = await resolveGoalForSpawn(ev, goalsDir);
      if (!gid) return;
      const childOrSession =
        ev.childSessionKey ??
        ev.sessionKey ??
        (typeof ev.metadata?.childSessionKey === "string" ? ev.metadata.childSessionKey : null) ??
        (typeof ev.metadata?.sessionKey === "string" ? ev.metadata.sessionKey : null);
      const runId =
        ev.runId ??
        (typeof ev.metadata?.runId === "string" ? ev.metadata.runId : null) ??
        (typeof ev.metadata?.run_id === "string" ? ev.metadata.run_id : null);
      const label = ev.label ?? childOrSession ?? `subagent-${Date.now()}`;
      if (!childOrSession) {
        const reason = runId
          ? "Subagent dispatch missing ACP session metadata (runId-only dispatch cannot be correlated without childSessionKey/sessionKey)."
          : "Subagent dispatch missing ACP session metadata (no childSessionKey/sessionKey in spawn event).";
        await markGoalDispatchFailure(goalsDir, gid, {
          label,
          sessionKey: null,
          runId: runId ?? null,
          reason,
        });
        await syncGoalLinkedTaskToFactsLedger(ctx, label, gid, null, ev.task ?? reason, api.logger, {
          status: "Failed",
          next: reason,
        });
        return;
      }
      await linkSubagentToGoal(goalsDir, gid, {
        label,
        sessionKey: childOrSession ?? null,
        runId: runId ?? null,
        status: "in_progress",
      });
      await syncGoalLinkedTaskToFactsLedger(ctx, label, gid, childOrSession, ev.task, api.logger);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "goal-subagent",
        operation: "subagent_spawned",
      });
    }
  });

  api.on("subagent_ended", async (event: unknown) => {
    try {
      const ev = event as SubagentEndedEvent;
      const targetKey = ev.targetSessionKey ?? ev.sessionKey;
      const label = ev.label ?? (targetKey ? String(targetKey) : "");
      if (!label && !targetKey) return;
      const success = subagentEndedIsSuccess(ev);
      const outcome = ev.outcome ?? ev.error ?? ev.reason ?? null;
      await updateGoalOnSubagentEnd(goalsDir, {
        label: label || (targetKey as string),
        sessionKey: targetKey ?? null,
        success,
        outcome: outcome ? String(outcome) : null,
      });
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "goal-subagent",
        operation: "subagent_ended",
        eventLabel: getEventStringField(event, "label"),
        eventSessionKey: getEventStringField(event, "sessionKey"),
        eventTargetSessionKey: getEventStringField(event, "targetSessionKey"),
        eventSuccess: getEventBooleanField(event, "success"),
        eventOutcome: getEventStringField(event, "outcome"),
      });
    }
  });
}
