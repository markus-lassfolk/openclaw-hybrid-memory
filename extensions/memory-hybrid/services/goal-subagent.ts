/**
 * Link subagent lifecycle to goals.
 */

import type { Goal } from "./goal-stewardship-types.js";
import { isTerminalStatus, listActiveGoals, readGoal, readGoalByLabel, updateGoal } from "./goal-registry.js";

export type GoalSubagentSpawnEvent = {
  childSessionKey?: string;
  sessionKey?: string;
  label?: string;
  task?: string;
  goalId?: string;
  metadata?: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

export async function resolveGoalForSpawn(event: GoalSubagentSpawnEvent, goalsDir: string): Promise<string | null> {
  const metaGoal =
    (typeof event.goalId === "string" && event.goalId) ||
    (typeof event.metadata?.goalId === "string" && event.metadata.goalId) ||
    null;
  if (metaGoal) {
    const byId = await readGoal(goalsDir, metaGoal);
    if (byId && !isTerminalStatus(byId.status)) return byId.id;
    const byLabel = await readGoalByLabel(goalsDir, metaGoal);
    if (byLabel && !isTerminalStatus(byLabel.status)) return byLabel.id;
  }
  const label = event.label?.trim();
  if (!label) return null;
  const active = await listActiveGoals(goalsDir);
  for (const g of active.sort((a, b) => b.label.length - a.label.length)) {
    const prefix = `${g.label}-`;
    const prefix2 = `${g.label}/`;
    if (label.startsWith(prefix) || label.startsWith(prefix2)) {
      return g.id;
    }
  }
  return null;
}

export async function linkSubagentToGoal(
  goalsDir: string,
  goalId: string,
  task: { label: string; sessionKey: string | null; status: string },
): Promise<void> {
  const g = await readGoal(goalsDir, goalId);
  if (!g || isTerminalStatus(g.status)) return;
  const ts = nowIso();
  const existing = g.linkedTasks.find((t) => t.label === task.label);
  const linkedTasks = existing
    ? g.linkedTasks.map((t) =>
        t.label === task.label ? { ...t, sessionKey: task.sessionKey, status: task.status, updatedAt: ts } : t,
      )
    : [
        ...g.linkedTasks,
        {
          label: task.label,
          sessionKey: task.sessionKey,
          status: task.status,
          linkedAt: ts,
          updatedAt: ts,
        },
      ];
  await updateGoal(
    goalsDir,
    g.id,
    { linkedTasks },
    {
      timestamp: ts,
      action: "subagent-linked",
      detail: `${task.label} (${task.sessionKey ?? "no session"})`,
      actor: "agent",
    },
  );
}

function allLinkedTasksTerminal(g: Goal): boolean {
  if (g.linkedTasks.length === 0) return false;
  return g.linkedTasks.every(
    (t) => t.status === "completed" || t.status === "Done" || t.status === "skipped" || t.status === "done",
  );
}

export async function updateGoalOnSubagentEnd(
  goalsDir: string,
  info: {
    label: string;
    sessionKey: string | null;
    success: boolean;
    outcome: string | null;
  },
): Promise<void> {
  const goals = await listActiveGoals(goalsDir);
  for (const g of goals) {
    const sessionMatch = info.sessionKey
      ? g.linkedTasks.find((t) => t.sessionKey && t.sessionKey === info.sessionKey)
      : undefined;
    const match = sessionMatch ?? g.linkedTasks.find((t) => t.label === info.label);
    if (!match) continue;

    const ts = nowIso();
    const newStatus = info.success ? "completed" : "failed";
    const linkedTasks = g.linkedTasks.map((t) =>
      t.label === match.label
        ? { ...t, status: newStatus, updatedAt: ts, sessionKey: info.sessionKey ?? t.sessionKey }
        : t,
    );
    const consecutiveFailures = info.success ? 0 : g.consecutiveFailures + 1;
    const lastOutcome = info.outcome ?? g.lastOutcome;

    if (info.success && allLinkedTasksTerminal({ ...g, linkedTasks })) {
      await updateGoal(
        goalsDir,
        g.id,
        {
          linkedTasks,
          consecutiveFailures,
          status: "verifying",
          lastOutcome: lastOutcome ?? "All linked tasks completed — verify goal",
        },
        {
          timestamp: ts,
          action: "all-tasks-complete",
          detail: "ready for LLM verification",
          actor: "agent",
        },
      );
    } else {
      await updateGoal(
        goalsDir,
        g.id,
        {
          linkedTasks,
          consecutiveFailures,
          lastOutcome,
        },
        {
          timestamp: ts,
          action: info.success ? "subagent-succeeded" : "subagent-failed",
          detail: info.outcome ?? (info.success ? "ok" : "failed"),
          actor: "agent",
        },
      );
    }
    return;
  }
}
