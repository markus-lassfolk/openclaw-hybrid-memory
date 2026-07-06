/**
 * Apply Workboard pull (column → status) back into hybrid-memory facts / goals.
 */

import type { EmbeddingProvider } from "./embeddings.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { nowIso } from "../utils/dates.js";
import type { ActiveTaskStatus } from "./active-task.js";
import type { GoalStatus } from "./goal-stewardship-types.js";
import { isTerminalStatus, readGoal, updateGoal } from "./goal-registry.js";
import { displayStatusToFact, loadTaskLedgerFromFacts, syncActiveTaskEntryToFacts } from "./task-ledger-facts.js";

export async function applyWorkboardTaskStatusUpdate(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  label: string,
  newStatus: ActiveTaskStatus,
  log?: { warn?: (m: string) => void },
): Promise<void> {
  const { active, completed } = loadTaskLedgerFromFacts(factsDb);
  const task = active.find((t) => t.label === label) ?? completed.find((t) => t.label === label);
  if (!task) {
    throw new Error(`Active task not found: ${label}`);
  }
  const updated = { ...task, status: newStatus, updated: nowIso() };
  await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, updated, log, {
    statusOverride: displayStatusToFact(newStatus),
  });
}

export async function applyWorkboardGoalStatusUpdate(
  goalsDir: string,
  goalId: string,
  newStatus: GoalStatus,
): Promise<void> {
  const precheck = await readGoal(goalsDir, goalId);
  if (!precheck || isTerminalStatus(precheck.status)) return;
  const ts = nowIso();
  // Re-check terminal status inside the lock (not just the pre-check above): a concurrent
  // goal_complete/goal_fail/goal_abandon call could land in the race window between that read
  // and this lock being acquired. Without this, dragging a completed/failed/abandoned goal's
  // Workboard card to a non-terminal column would silently reopen a goal the user already
  // closed — same pattern as linkSubagentToGoal/markGoalDispatchFailure in goal-subagent.ts.
  await updateGoal(
    goalsDir,
    goalId,
    (fresh) => (isTerminalStatus(fresh.status) ? {} : { status: newStatus, lastAssessedAt: ts }),
    (fresh) =>
      isTerminalStatus(fresh.status)
        ? []
        : {
            timestamp: ts,
            action: "workboard_pull",
            detail: `Status updated from Workboard column → ${newStatus}`,
            actor: "steward",
          },
  );
}
