/**
 * Maps hybrid-memory active tasks and goals to Workboard card representations
 * and vice versa. Pure data transformation — no I/O.
 */

import type { ActiveTaskEntry, ActiveTaskStatus } from "./active-task.js";
import type { Goal, GoalStatus } from "./goal-stewardship-types.js";
import type { WorkboardColumnMapping } from "../config/types/workboard.js";

export type WorkboardCardPayload = {
  title: string;
  column: string;
  description?: string;
  tags?: string[];
  /** Opaque external ID used for idempotent upsert. */
  externalId: string;
  metadata?: Record<string, string>;
};

export type WorkboardCardRecord = {
  id: string;
  title: string;
  column: string;
  description?: string;
  tags?: string[];
  externalId?: string;
  metadata?: Record<string, string>;
  updatedAt?: string;
};

const TASK_EXTERNAL_PREFIX = "hm-task:";
const GOAL_EXTERNAL_PREFIX = "hm-goal:";

export function taskExternalId(label: string): string {
  return `${TASK_EXTERNAL_PREFIX}${label}`;
}

export function goalExternalId(goalId: string): string {
  return `${GOAL_EXTERNAL_PREFIX}${goalId}`;
}

export function resolveWorkboardExternalId(card: WorkboardCardRecord): string | undefined {
  const meta = card.metadata as { automation?: { idempotencyKey?: string } } | undefined;
  const key = meta?.automation?.idempotencyKey;
  if (typeof key === "string" && key.length > 0) return key;
  return card.externalId;
}

export function isHybridMemoryCard(card: WorkboardCardRecord): boolean {
  const extId = resolveWorkboardExternalId(card);
  return !!extId?.startsWith(TASK_EXTERNAL_PREFIX) || !!extId?.startsWith(GOAL_EXTERNAL_PREFIX);
}

export function parseExternalId(
  extId: string,
): { type: "task"; label: string } | { type: "goal"; goalId: string } | null {
  if (extId.startsWith(TASK_EXTERNAL_PREFIX)) {
    return { type: "task", label: extId.slice(TASK_EXTERNAL_PREFIX.length) };
  }
  if (extId.startsWith(GOAL_EXTERNAL_PREFIX)) {
    return { type: "goal", goalId: extId.slice(GOAL_EXTERNAL_PREFIX.length) };
  }
  return null;
}

export function taskToCard(
  task: ActiveTaskEntry,
  columns: WorkboardColumnMapping,
  cardTag: string,
): WorkboardCardPayload | null {
  const column = taskStatusToColumn(task.status, task.stale, columns);
  if (!column) return null;

  const descParts: string[] = [];
  if (task.description) descParts.push(task.description);
  if (task.branch) descParts.push(`Branch: ${task.branch}`);
  if (task.next) descParts.push(`Next: ${task.next}`);
  if (task.subagent) descParts.push(`Subagent: ${task.subagent}`);
  if (task.relatedGoal) descParts.push(`Related goal: ${task.relatedGoal}`);

  return {
    title: `[Task] ${task.label}`,
    column,
    description: descParts.join("\n") || undefined,
    tags: [cardTag],
    externalId: taskExternalId(task.label),
    metadata: {
      type: "active-task",
      label: task.label,
      status: task.status,
      started: task.started,
      updated: task.updated,
    },
  };
}

export function goalToCard(goal: Goal, columns: WorkboardColumnMapping, cardTag: string): WorkboardCardPayload | null {
  const column = goalStatusToColumn(goal.status, columns);
  if (!column) return null;

  const descParts: string[] = [];
  if (goal.description) descParts.push(goal.description);
  if (goal.acceptanceCriteria.length > 0) {
    descParts.push(`\nAcceptance criteria:\n${goal.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`);
  }
  if (goal.currentBlockers.length > 0) {
    descParts.push(`\nBlockers:\n${goal.currentBlockers.map((b) => `- ${b}`).join("\n")}`);
  }
  if (goal.lastOutcome) descParts.push(`\nLast outcome: ${goal.lastOutcome}`);

  return {
    title: `[Goal] ${goal.label}`,
    column,
    description: descParts.join("\n") || undefined,
    tags: [cardTag, `priority:${goal.priority}`],
    externalId: goalExternalId(goal.id),
    metadata: {
      type: "goal",
      goalId: goal.id,
      status: goal.status,
      priority: goal.priority,
      createdAt: goal.createdAt,
    },
  };
}

function taskStatusToColumn(
  status: ActiveTaskStatus,
  stale: boolean | undefined,
  columns: WorkboardColumnMapping,
): string | null {
  if (stale && columns.taskStale !== null) return columns.taskStale;

  switch (status) {
    case "In progress":
      return columns.taskInProgress;
    case "Waiting":
      return columns.taskWaiting;
    case "Stalled":
      return columns.taskStale;
    case "Done":
      return columns.taskDone;
    case "Failed":
      return columns.taskFailed;
    default:
      return columns.taskInProgress;
  }
}

function goalStatusToColumn(status: GoalStatus, columns: WorkboardColumnMapping): string | null {
  switch (status) {
    case "active":
    case "verifying":
      return columns.goalActive;
    case "blocked":
      return columns.goalBlocked;
    case "stalled":
      return columns.goalStalled;
    case "completed":
      return columns.goalCompleted;
    case "failed":
    case "abandoned":
      return columns.taskFailed;
    default:
      return columns.goalActive;
  }
}

export function columnToTaskStatus(column: string, columns: WorkboardColumnMapping): ActiveTaskStatus | null {
  const lower = column.toLowerCase();
  const match = (col: string | null) => col?.toLowerCase() === lower;

  if (match(columns.taskInProgress)) return "In progress";
  if (match(columns.taskWaiting)) return "Waiting";
  if (match(columns.taskDone)) return "Done";
  if (match(columns.taskFailed)) return "Failed";
  if (match(columns.taskStale)) return "Stalled";
  if (match(columns.taskParked)) return "Stalled";
  return null;
}

export function columnToGoalStatus(column: string, columns: WorkboardColumnMapping): GoalStatus | null {
  const lower = column.toLowerCase();
  const match = (col: string | null) => col?.toLowerCase() === lower;

  if (match(columns.goalActive)) return "active";
  if (match(columns.goalCompleted)) return "completed";
  if (match(columns.goalBlocked)) return "blocked";
  if (match(columns.goalStalled)) return "stalled";
  if (match(columns.taskFailed)) return "failed";
  return null;
}
