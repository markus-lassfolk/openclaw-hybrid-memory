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
  const precheck = await readGoal(goalsDir, goalId);
  if (!precheck || isTerminalStatus(precheck.status)) return;
  const ts = nowIso();
  // linkedTasks is computed from `fresh` (re-read inside updateGoal's lock), not from the
  // pre-check read above — a concurrent linkSubagentToGoal/markGoalDispatchFailure/
  // updateGoalOnSubagentEnd call for a different task on the same goal could otherwise have its
  // linkedTasks entry silently reverted by this call overwriting the array from stale data.
  await updateGoal(
    goalsDir,
    goalId,
    (fresh) => {
      // Re-check terminal status inside the lock: the pre-check above can be stale if the goal
      // was completed/failed/abandoned in the race window between that read and this lock being
      // acquired (e.g. a concurrent goal_complete call) — linking a task afterward would leave a
      // stray in-progress linkedTasks entry on a goal the user already accepted as done.
      if (isTerminalStatus(fresh.status)) return {};
      const existing = fresh.linkedTasks.find((t) => taskLabelsMatch(t.label, task.label));
      const linkedTasks = existing
        ? fresh.linkedTasks.map((t) =>
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
            ...fresh.linkedTasks,
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
      return { linkedTasks };
    },
    (fresh) => {
      if (isTerminalStatus(fresh.status)) return [];
      return {
        timestamp: ts,
        action: "subagent-linked",
        detail: `${task.label} (${task.sessionKey ?? "no session"}${task.runId ? `, run=${task.runId}` : ""})`,
        actor: "agent",
      };
    },
  );
}

export async function markGoalDispatchFailure(
  goalsDir: string,
  goalId: string,
  info: { label: string; sessionKey: string | null; runId: string | null; reason: string },
): Promise<void> {
  const precheck = await readGoal(goalsDir, goalId);
  if (!precheck || isTerminalStatus(precheck.status)) return;
  const ts = nowIso();
  await updateGoal(
    goalsDir,
    goalId,
    (fresh) => {
      if (isTerminalStatus(fresh.status)) return {};
      const existing = fresh.linkedTasks.find((t) => taskLabelsMatch(t.label, info.label));
      const linkedTasks = existing
        ? fresh.linkedTasks.map((t) =>
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
            ...fresh.linkedTasks,
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
      const mergedBlockers = fresh.currentBlockers.includes(info.reason)
        ? fresh.currentBlockers
        : [...fresh.currentBlockers, info.reason];
      return {
        linkedTasks,
        consecutiveFailures: fresh.consecutiveFailures + 1,
        status: "blocked",
        currentBlockers: mergedBlockers,
        lastOutcome: info.reason,
      };
    },
    (fresh) => {
      if (isTerminalStatus(fresh.status)) return [];
      return {
        timestamp: ts,
        action: "dispatch-failed",
        detail: `${info.label}: ${info.reason}`,
        actor: "agent",
      };
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
  // Label-only fallback across ALL goals is intentionally NOT attempted here when
  // info.sessionKey is set but didn't uniquely resolve above: task labels aren't enforced
  // unique across different goals, so guessing by label alone could attribute this subagent's
  // outcome to a different goal's same-named task (marking the wrong goal's task
  // completed/failed while the real one is left stuck in_progress forever). When info.sessionKey
  // is null, the loop above already matched by label directly — no separate fallback is needed
  // for that case.
  if (resolved.length !== 1) {
    return;
  }
  const { goal: matchedGoal, taskLabel: matchedTaskLabel } = resolved[0];

  const ts = nowIso();
  const newStatus = info.success ? "completed" : "failed";
  // linkedTasks/consecutiveFailures/lastOutcome — and which of the two outcome branches applies
  // — are all recomputed from `fresh` (re-read inside updateGoal's lock) rather than from
  // `matchedGoal` above: a concurrent subagent-end handler for a *different* linked task on the
  // same goal could otherwise have its own linkedTasks/consecutiveFailures update silently
  // reverted by this call overwriting the array from a stale pre-lock snapshot (matchedGoal is
  // only used to resolve WHICH goal/task this call targets — an identity that doesn't change).
  await updateGoal(
    goalsDir,
    matchedGoal.id,
    (fresh) => {
      if (isTerminalStatus(fresh.status)) return {};
      const linkedTasks = normalizedLinkedTasks(fresh).map((t) =>
        taskLabelsMatch(t.label, matchedTaskLabel)
          ? { ...t, status: newStatus, updatedAt: ts, sessionKey: info.sessionKey ?? t.sessionKey }
          : t,
      );
      const consecutiveFailures = info.success ? 0 : fresh.consecutiveFailures + 1;
      const lastOutcome = info.outcome ?? fresh.lastOutcome;
      if (info.success && allLinkedTasksTerminal({ ...fresh, linkedTasks })) {
        return {
          linkedTasks,
          consecutiveFailures,
          status: "verifying",
          lastOutcome: lastOutcome ?? "All linked tasks completed — verify goal",
        };
      }
      // Failed workers are deliberately returned to active controller ownership. A blocked
      // status used to hide the goal behind cooldown/prompt-only stewardship and stranded PR repairs.
      if (!info.success) return { linkedTasks, consecutiveFailures, status: "active", lastOutcome };
      return { linkedTasks, consecutiveFailures, lastOutcome };
    },
    (fresh, resolvedPatch) => {
      if (isTerminalStatus(fresh.status)) return [];
      if (resolvedPatch.status === "verifying") {
        return { timestamp: ts, action: "all-tasks-complete", detail: "ready for LLM verification", actor: "agent" };
      }
      return {
        timestamp: ts,
        action: info.success ? "subagent-succeeded" : "subagent-failed",
        detail: info.outcome ?? (info.success ? "ok" : "failed"),
        actor: "agent",
      };
    },
  );
}
