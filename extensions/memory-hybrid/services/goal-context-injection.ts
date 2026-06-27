/**
 * Compact active-goals prepend for every agent turn (not only heartbeat).
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { isTerminalStatus, readGoal } from "./goal-registry.js";
import { resolveGoalForSpawn } from "./goal-subagent.js";
import { sessionRefMatches } from "./pre-finalization-guard.js";
import { loadTaskLedgerFromFacts } from "./task-ledger-facts.js";
import { sanitizePromptInjection } from "./skill-prompt-injection.js";
import type { Goal } from "./goal-stewardship-types.js";

function sanitizeField(text: string): string {
  return sanitizePromptInjection(text);
}

export function buildLightweightStewardshipDirective(
  goals: Goal[],
  staleAssessmentHours = 24,
): string | null {
  if (goals.length === 0) return null;
  const staleMs = staleAssessmentHours * 60 * 60 * 1000;
  const now = Date.now();
  const staleGoals = goals.filter((g) => {
    const assessedAt = g.lastAssessedAt ?? g.createdAt;
    const t = Date.parse(assessedAt);
    return Number.isFinite(t) && now - t >= staleMs;
  });
  if (staleGoals.length === 0) return null;

  const sorted = [...staleGoals].sort((a, b) => {
    const pr = (p: Goal["priority"]) => (p === "critical" ? 4 : p === "high" ? 3 : p === "normal" ? 2 : 1);
    return pr(b.priority) - pr(a.priority);
  });
  const top = sorted[0];
  return [
    "<goal-stewardship-hint>",
    `Goal "${sanitizeField(top.label)}" (${top.id}, ${top.status}) has not been assessed in ~${staleAssessmentHours}h.`,
    "Call goal_assess with next_action and take one concrete step toward acceptance criteria this turn.",
    "</goal-stewardship-hint>",
    "",
  ].join("\n");
}

export function buildCompactActiveGoalsPrepend(
  goals: Goal[],
  opts: { maxChars: number; maxGoals: number },
): string | null {
  if (goals.length === 0) return null;

  const sorted = [...goals].sort((a, b) => {
    const priorityRank = (p: Goal["priority"]) =>
      p === "critical" ? 4 : p === "high" ? 3 : p === "normal" ? 2 : 1;
    const statusRank = (s: Goal["status"]) =>
      s === "blocked" || s === "stalled" ? 3 : s === "verifying" ? 2 : 1;
    const pr = priorityRank(b.priority) - priorityRank(a.priority);
    if (pr !== 0) return pr;
    const sr = statusRank(b.status) - statusRank(a.status);
    if (sr !== 0) return sr;
    return Date.parse(a.lastAssessedAt ?? a.createdAt) - Date.parse(b.lastAssessedAt ?? b.createdAt);
  });

  const selected = sorted.slice(0, Math.max(1, opts.maxGoals));
  const lines: string[] = [
    "<active-goals-summary>",
    `Active goals (${goals.length} total; showing ${selected.length}). Use goal_list / goal_get for full detail.`,
    "",
  ];

  for (const g of selected) {
    const blockers =
      g.currentBlockers.length > 0 ? ` | blockers: ${g.currentBlockers.slice(0, 2).join("; ")}` : "";
    lines.push(
      `- [${g.priority}] ${sanitizeField(g.label)} (${g.status}, id: ${g.id}) — ${sanitizeField(g.description.slice(0, 120))}${g.description.length > 120 ? "…" : ""}${blockers}`,
    );
  }

  lines.push(
    "",
    "When the user assigns a new multi-session outcome, call goal_register with measurable acceptance_criteria.",
    "Before ending a turn with pending external work, call active_task_checkpoint and goal_assess (goal-backed tasks).",
    "memory_recall does NOT list registered goals — use goal_list / goal_get.",
    "</active-goals-summary>",
    "",
  );

  let text = lines.join("\n");
  if (text.length > opts.maxChars) {
    text = `${text.slice(0, Math.max(0, opts.maxChars - 40))}\n…(truncated)\n</active-goals-summary>\n\n`;
  }
  return text;
}

/** Resolve goals linked to a subagent session via active-task facts or label-prefix convention. */
export async function resolveGoalsForSubagentContext(
  sessionKey: string,
  goalsDir: string,
  factsDb: FactsDB,
  cfg: HybridMemoryConfig,
): Promise<Goal[]> {
  const resolved: Goal[] = [];
  const seen = new Set<string>();

  const pushGoal = async (goalId: string): Promise<void> => {
    if (seen.has(goalId)) return;
    const g = await readGoal(goalsDir, goalId);
    if (!g || isTerminalStatus(g.status)) return;
    seen.add(g.id);
    resolved.push(g);
  };

  if (cfg.activeTask.enabled && cfg.activeTask.ledger === "facts") {
    const { active } = loadTaskLedgerFromFacts(factsDb);
    for (const task of active) {
      const sessionRef = task.subagent?.trim();
      if (!sessionRef || !sessionRefMatches(sessionRef, sessionKey)) continue;
      if (task.relatedGoal?.trim()) {
        await pushGoal(task.relatedGoal.trim());
      }
    }
  }

  const labelHint = sessionKey.split(":").pop()?.trim();
  if (labelHint) {
    const goalId = await resolveGoalForSpawn({ label: labelHint, sessionKey }, goalsDir);
    if (goalId) await pushGoal(goalId);
  }

  return resolved;
}

export function buildSubagentLinkedGoalsPrepend(
  goals: Goal[],
  opts: { maxChars: number },
): string | null {
  if (goals.length === 0) return null;
  const built = buildCompactActiveGoalsPrepend(goals, {
    maxChars: opts.maxChars,
    maxGoals: Math.min(2, goals.length),
  });
  if (!built) return null;
  return [
    built.trimEnd(),
    "",
    "<subagent-goal-context>",
    "This subagent session is linked to the goal(s) above. Call goal_assess when you finish meaningful progress or hit blockers.",
    "Before ending with pending external work, call active_task_checkpoint with relatedGoal set.",
    "</subagent-goal-context>",
    "",
  ].join("\n");
}
