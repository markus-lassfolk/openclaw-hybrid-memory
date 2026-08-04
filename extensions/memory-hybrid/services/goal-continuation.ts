/**
 * Durable controller-side continuation decisions for goal-backed work.
 *
 * This deliberately does not launch an arbitrary process: launches remain subject to
 * goal_dispatch's request-scoped host authority.  It records the next authorized action
 * atomically so a heartbeat, restart, or duplicate lifecycle event cannot lose (or repeat)
 * the repair instruction.
 */
import { readGoal, updateGoal } from "./goal-registry.js";
import type { Goal } from "./goal-stewardship-types.js";
import { nowIso } from "../utils/dates.js";

export type GoalContinuationKind = "diagnose" | "repair" | "verify" | "wait" | "hitl" | "terminal";
export type GoalContinuationDecision = { kind: GoalContinuationKind; reason: string; fingerprint: string };

function activeTask(g: Goal): boolean {
  return g.linkedTasks.some((t) => /^(in_progress|in progress)$/i.test(t.status));
}

/** Pure, restart-safe policy. The canonical PR target stays in dispatchPolicy; it is never inferred from a worker. */
export function decideGoalContinuation(g: Goal): GoalContinuationDecision {
  if (["completed", "failed", "abandoned"].includes(g.status))
    return { kind: "terminal", reason: `goal is ${g.status}`, fingerprint: `terminal:${g.status}` };
  if (g.humanEscalationSummary || g.escalationKind)
    return { kind: "hitl", reason: "circuit breaker requires human unblock", fingerprint: "hitl:circuit-breaker" };
  if (activeTask(g))
    return { kind: "wait", reason: "authorized worker is still active", fingerprint: "wait:worker-active" };
  const failed = g.linkedTasks.filter((t) => /^(failed|error)$/i.test(t.status));
  if (failed.length) {
    const details = failed
      .map((t) => `${t.label}:${t.dispatchFailureReason ?? "worker failed"}`)
      .sort()
      .join("|");
    return { kind: "repair", reason: `worker/check failure: ${details}`, fingerprint: `repair:${details}` };
  }
  if (g.status === "verifying")
    return {
      kind: "verify",
      reason: "work ended; inspect live PR head, checks, review threads, and diff",
      fingerprint: "verify:live-pr",
    };
  return {
    kind: "diagnose",
    reason: "no active authorized worker; inspect live state before dispatch",
    fingerprint: "diagnose:no-worker",
  };
}

/** Persist a decision exactly once per fingerprint.  This is the durable duplicate-pulse fence. */
export async function reconcileGoalContinuation(
  goalsDir: string,
  goalId: string,
): Promise<GoalContinuationDecision | null> {
  const current = await readGoal(goalsDir, goalId);
  if (!current) return null;
  const decision = decideGoalContinuation(current);
  if (decision.kind === "terminal" || decision.kind === "wait") return decision;
  await updateGoal(
    goalsDir,
    goalId,
    (fresh) => {
      const next = decideGoalContinuation(fresh);
      if (next.fingerprint !== decision.fingerprint) return {};
      // A failure must remain eligible for the controller; blocked is not terminal.
      return next.kind === "repair" || next.kind === "diagnose" ? { status: "active", lastOutcome: next.reason } : {};
    },
    (fresh) => {
      const next = decideGoalContinuation(fresh);
      const already = [...fresh.history].reverse().find((h) => h.action === "continuation-decision")?.detail;
      const detail = `${next.kind}|${next.fingerprint}|${next.reason}`;
      return already === detail
        ? []
        : { timestamp: nowIso(), action: "continuation-decision", detail, actor: "watchdog" };
    },
  );
  return decision;
}

export function buildContinuationDirective(goal: Goal, decision: GoalContinuationDecision): string | null {
  if (!["diagnose", "repair", "verify"].includes(decision.kind)) return null;
  const canonical =
    goal.dispatchPolicy && Object.values(goal.dispatchPolicy.classes).find((c) => !c.readOnly)?.canonical;
  if (!canonical)
    return `Continuation ${decision.kind}: ${decision.reason}. No canonical authorized target exists; request HITL instead of creating a branch or PR.`;
  return [
    `Continuation required (${decision.kind}): ${decision.reason}.`,
    `Live-check ${canonical.repository}#${canonical.prNumber} branch ${canonical.branch}: head, checks, review threads, and substantive diff.`,
    `If repair is needed, dispatch only the policy-authorized agent with the same canonical repository/PR/branch/write scope; creates_pr=false and creates_branch=false.`,
    `Do not declare done without verification evidence; record the dispatch or HITL reason with goal_assess.`,
  ].join(" ");
}
