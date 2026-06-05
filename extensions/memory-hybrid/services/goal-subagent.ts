/**
 * Link subagent lifecycle to goals.
 */

import { isTerminalStatus, listActiveGoals, readGoal, readGoalByLabel, updateGoal } from "./goal-registry.js";
import type { Goal } from "./goal-stewardship-types.js";
import { nowIso } from "../utils/dates.js";
import { taskLabelsMatch } from "../utils/subagent-ended-utils.js";

export type GoalSubagentSpawnEvent = {
  childSessionKey?: string;
  sessionKey?: string;
  runId?: string;
  label?: string;
  task?: string;
  goalId?: string;
  metadata?: Record<string, unknown>;
};

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
  let bestMatch: Goal | null = null;
  let bestLen = -1;
  let tiedAtBestLen = false;
  for (const g of active) {
    const prefix = `${g.label}-`;
    const prefix2 = `${g.label}/`;
    if (label.startsWith(prefix) || label.startsWith(prefix2)) {
      const currentLen = g.label.length;
      if (currentLen > bestLen) {
        bestMatch = g;
        bestLen = currentLen;
        tiedAtBestLen = false;
      } else if (currentLen === bestLen) {
        tiedAtBestLen = true;
      }
    }
  }
  if (!bestMatch || tiedAtBestLen) return null;
  return bestMatch.id;
}

export async function linkSubagentToGoal(
  goalsDir: string,
  goalId: string,
  task: {
    label: string;
    sessionKey: string | null;
    runId?: string | null;
    status: string;
    dispatchFailureReason?: string;
  },
): Promise<void> {
  const g = await readGoal(goalsDir, goalId);
  if (!g || isTerminalStatus(g.status)) return;
  const ts = nowIso();
  const existing = g.linkedTasks.find((t) => taskLabelsMatch(t.label, task.label));
  const linkedTasks = existing
    ? g.linkedTasks.map((t) =>
        taskLabelsMatch(t.label, task.label)
          ? {
              ...t,
              sessionKey: task.sessionKey,
              runId: task.runId ?? t.runId ?? null,
              dispatchFailureReason:
                task.dispatchFailureReason === undefined
                  ? (t.dispatchFailureReason ?? null)
                  : (task.dispatchFailureReason ?? null),
              status: task.status,
              updatedAt: ts,
            }
          : t,
      )
    : [
        ...g.linkedTasks,
        {
          label: task.label,
          sessionKey: task.sessionKey,
          runId: task.runId ?? null,
          dispatchFailureReason: task.dispatchFailureReason ?? null,
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
      detail: `${task.label} (${task.sessionKey ?? "no session"}${task.runId ? `, run=${task.runId}` : ""})`,
      actor: "agent",
    },
  );
}

export async function markGoalDispatchFailure(
  goalsDir: string,
  goalId: string,
  info: { label: string; sessionKey: string | null; runId: string | null; reason: string },
): Promise<void> {
  const g = await readGoal(goalsDir, goalId);
  if (!g || isTerminalStatus(g.status)) return;
  const ts = nowIso();
  const existing = g.linkedTasks.find((t) => taskLabelsMatch(t.label, info.label));
  const linkedTasks = existing
    ? g.linkedTasks.map((t) =>
        taskLabelsMatch(t.label, info.label)
          ? {
              ...t,
              sessionKey: info.sessionKey ?? t.sessionKey ?? null,
              runId: info.runId ?? t.runId ?? null,
              dispatchFailureReason: info.reason,
              status: "failed",
              updatedAt: ts,
            }
          : t,
      )
    : [
        ...g.linkedTasks,
        {
          label: info.label,
          sessionKey: info.sessionKey,
          runId: info.runId,
          dispatchFailureReason: info.reason,
          status: "failed",
          linkedAt: ts,
          updatedAt: ts,
        },
      ];

  const mergedBlockers = g.currentBlockers.includes(info.reason)
    ? g.currentBlockers
    : [...g.currentBlockers, info.reason];
  await updateGoal(
    goalsDir,
    g.id,
    {
      linkedTasks,
      consecutiveFailures: g.consecutiveFailures + 1,
      status: "blocked",
      currentBlockers: mergedBlockers,
      lastOutcome: info.reason,
    },
    {
      timestamp: ts,
      action: "dispatch-failed",
      detail: `${info.label}: ${info.reason}`,
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

function normalizedLinkedTasks(g: Goal): Goal["linkedTasks"] {
  return Array.isArray(g.linkedTasks) ? g.linkedTasks : [];
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
  const matches: Array<{ goal: Goal; taskLabel: string }> = [];
  for (const g of goals) {
    const linkedTasks = normalizedLinkedTasks(g);
    if (info.sessionKey) {
      const task = linkedTasks.find((t) => t.sessionKey && t.sessionKey === info.sessionKey);
      if (task) matches.push({ goal: g, taskLabel: task.label });
      continue;
    }
    const task = linkedTasks.find((t) => taskLabelsMatch(t.label, info.label));
    if (task) matches.push({ goal: g, taskLabel: task.label });
  }

  let resolved = matches;
  if (resolved.length !== 1 && info.sessionKey && info.label) {
    const byLabel = matches.filter((m) => taskLabelsMatch(m.taskLabel, info.label));
    if (byLabel.length === 1) resolved = byLabel;
  }
  if (resolved.length !== 1 && info.label) {
    const labelOnly: Array<{ goal: Goal; taskLabel: string }> = [];
    for (const g of goals) {
      const linkedTasks = normalizedLinkedTasks(g);
      const task = linkedTasks.find((t) => taskLabelsMatch(t.label, info.label));
      if (task) labelOnly.push({ goal: g, taskLabel: task.label });
    }
    if (labelOnly.length === 1) resolved = labelOnly;
  }
  if (resolved.length !== 1) {
    return;
  }
  const { goal: g, taskLabel: matchedTaskLabel } = resolved[0];

  const ts = nowIso();
  const newStatus = info.success ? "completed" : "failed";
  const linkedTasks = normalizedLinkedTasks(g).map((t) =>
    taskLabelsMatch(t.label, matchedTaskLabel)
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
}
