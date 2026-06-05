/**
 * Apply Workboard pull (column → status) back into hybrid-memory facts / goals.
 */

import type { EmbeddingProvider } from "../backends/embeddings.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { nowIso } from "../utils/dates.js";
import type { ActiveTaskStatus } from "./active-task.js";
import type { GoalStatus } from "./goal-stewardship-types.js";
import { updateGoal } from "./goal-registry.js";
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
  await updateGoal(
    goalsDir,
    goalId,
    { status: newStatus, lastAssessedAt: nowIso() },
    {
      timestamp: nowIso(),
      action: "workboard_pull",
      detail: `Status updated from Workboard column → ${newStatus}`,
      actor: "steward",
    },
  );
}
