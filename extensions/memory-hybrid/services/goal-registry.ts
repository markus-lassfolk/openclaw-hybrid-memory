/**
 * Goal registry — JSON files under state/goals/
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

import type { EventLog } from "../backends/event-log.js";
import type {
  CreateGoalInput,
  Goal,
  GoalDefaults,
  GoalHistoryEntry,
  GoalHistoryActor,
  GoalIndex,
  GoalStatus,
} from "./goal-stewardship-types.js";

const INDEX_FILENAME = "_index.json";
const TERMINAL: GoalStatus[] = ["completed", "failed", "abandoned"];

export function isTerminalStatus(s: GoalStatus): boolean {
  return TERMINAL.includes(s);
}

export function resolveGoalsDir(workspaceRoot: string, goalsDir: string): string {
  if (isAbsolute(goalsDir)) return goalsDir;
  return join(workspaceRoot, goalsDir);
}

const LABEL_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function validateGoalLabel(label: string): { ok: true } | { ok: false; error: string } {
  const t = label.trim();
  if (t.length === 0) return { ok: false, error: "label is empty" };
  if (t.length > 64) return { ok: false, error: "label exceeds 64 characters" };
  if (!LABEL_RE.test(t)) return { ok: false, error: "label must be alphanumeric, underscore, or hyphen only" };
  return { ok: true };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function rebuildGoalIndex(goalsDir: string): Promise<void> {
  await ensureDir(goalsDir);
  let files: string[];
  try {
    files = await readdir(goalsDir);
  } catch {
    return;
  }
  const goals: GoalIndex["goals"] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f === INDEX_FILENAME) continue;
    try {
      const raw = await readFile(join(goalsDir, f), "utf-8");
      const g = JSON.parse(raw) as Goal;
      if (g?.id && g?.label && g?.status) {
        goals.push({
          id: g.id,
          label: g.label,
          status: g.status,
          priority: g.priority,
          createdAt: g.createdAt,
          lastAssessedAt: g.lastAssessedAt,
        });
      }
    } catch {
      /* skip corrupt */
    }
  }
  const index: GoalIndex = { updatedAt: nowIso(), goals };
  await writeFile(join(goalsDir, INDEX_FILENAME), JSON.stringify(index, null, 2), "utf-8");
}

function normalizeGoalJson(g: Goal): Goal {
  return {
    ...g,
    lastBlockerFingerprint: g.lastBlockerFingerprint ?? null,
    sameBlockerStreak: g.sameBlockerStreak ?? 0,
    circuitBreakerLastProgressAssessmentCount: g.circuitBreakerLastProgressAssessmentCount ?? 0,
    humanEscalationSummary: g.humanEscalationSummary ?? null,
    escalationKind: g.escalationKind ?? null,
  };
}

export async function readGoal(goalsDir: string, id: string): Promise<Goal | null> {
  const path = join(goalsDir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return normalizeGoalJson(JSON.parse(raw) as Goal);
  } catch {
    return null;
  }
}

export async function listGoals(goalsDir: string): Promise<Goal[]> {
  if (!existsSync(goalsDir)) return [];
  const files = await readdir(goalsDir);
  const out: Goal[] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f === INDEX_FILENAME) continue;
    const g = await readGoal(goalsDir, f.replace(/\.json$/, ""));
    if (g) out.push(g);
  }
  return out;
}

export async function listActiveGoals(goalsDir: string): Promise<Goal[]> {
  const all = await listGoals(goalsDir);
  return all.filter((g) => !isTerminalStatus(g.status));
}

export async function readGoalByLabel(goalsDir: string, label: string): Promise<Goal | null> {
  const norm = label.trim().toLowerCase();
  try {
    const raw = await readFile(join(goalsDir, INDEX_FILENAME), "utf-8");
    const index = JSON.parse(raw) as GoalIndex;
    const matches = index.goals.filter((g) => g.label.toLowerCase() === norm);
    const best = matches.find((g) => !isTerminalStatus(g.status)) ?? matches[0];
    if (best) return readGoal(goalsDir, best.id);
  } catch {
    /* index missing or corrupt — fall through to full scan */
  }
  const all = await listGoals(goalsDir);
  const matches = all.filter((g) => g.label.toLowerCase() === norm);
  return matches.find((g) => !isTerminalStatus(g.status)) ?? matches[0] ?? null;
}

export async function writeGoal(goalsDir: string, goal: Goal): Promise<void> {
  await ensureDir(goalsDir);
  await writeFile(join(goalsDir, `${goal.id}.json`), JSON.stringify(goal, null, 2), "utf-8");
  await rebuildGoalIndex(goalsDir);
}

export async function createGoal(
  goalsDir: string,
  input: CreateGoalInput,
  defaults: GoalDefaults,
  eventLog?: EventLog | null,
): Promise<Goal> {
  const v = validateGoalLabel(input.label);
  if (!v.ok) throw new Error(v.error);

  const existing = await readGoalByLabel(goalsDir, input.label);
  if (existing && !isTerminalStatus(existing.status)) {
    throw new Error(`A goal with label "${input.label}" already exists (status: ${existing.status})`);
  }

  const id = randomUUID();
  const ts = nowIso();
  const goal: Goal = {
    id,
    label: input.label.trim(),
    description: input.description.trim(),
    acceptanceCriteria: input.acceptanceCriteria.map((c) => c.trim()).filter(Boolean),
    verification: input.verification,
    status: "active",
    priority: input.priority ?? defaults.priority,
    createdAt: ts,
    lastAssessedAt: null,
    lastDispatchedAt: null,
    assessmentCount: 0,
    dispatchCount: 0,
    currentBlockers: [],
    lastOutcome: null,
    maxDispatches: input.maxDispatches ?? defaults.maxDispatches,
    maxAssessments: input.maxAssessments ?? defaults.maxAssessments,
    cooldownMinutes: input.cooldownMinutes ?? defaults.cooldownMinutes,
    escalateAfterFailures: input.escalateAfterFailures ?? defaults.escalateAfterFailures,
    consecutiveFailures: 0,
    lastBlockerFingerprint: null,
    sameBlockerStreak: 0,
    circuitBreakerLastProgressAssessmentCount: 0,
    humanEscalationSummary: null,
    escalationKind: null,
    linkedTasks: [],
    history: [{ timestamp: ts, action: "created", detail: input.description.slice(0, 500), actor: "user" }],
  };

  if (goal.acceptanceCriteria.length === 0) {
    throw new Error("acceptanceCriteria must contain at least one item");
  }

  await writeGoal(goalsDir, goal);

  try {
    eventLog?.append({
      sessionId: "goal-stewardship",
      timestamp: ts,
      eventType: "action_taken",
      content: {
        kind: "goal.created",
        goalId: goal.id,
        label: goal.label,
        priority: goal.priority,
        criteriaCount: goal.acceptanceCriteria.length,
      },
    });
  } catch {
    /* non-fatal */
  }

  return goal;
}

export async function updateGoal(
  goalsDir: string,
  id: string,
  patch: Partial<
    Pick<
      Goal,
      | "status"
      | "currentBlockers"
      | "lastOutcome"
      | "lastAssessedAt"
      | "lastDispatchedAt"
      | "assessmentCount"
      | "dispatchCount"
      | "consecutiveFailures"
      | "linkedTasks"
      | "description"
      | "acceptanceCriteria"
      | "priority"
      | "lastBlockerFingerprint"
      | "sameBlockerStreak"
      | "circuitBreakerLastProgressAssessmentCount"
      | "humanEscalationSummary"
      | "escalationKind"
    >
  >,
  historyEntry: GoalHistoryEntry | GoalHistoryEntry[],
): Promise<Goal> {
  const g = await readGoal(goalsDir, id);
  if (!g) throw new Error(`Goal not found: ${id}`);
  const entries = Array.isArray(historyEntry) ? historyEntry : [historyEntry];
  const next = { ...g, ...patch, history: [...(g.history ?? []), ...entries] };
  await writeGoal(goalsDir, next);
  return next;
}

export async function terminateGoal(
  goalsDir: string,
  id: string,
  status: "completed" | "failed" | "abandoned",
  reason: string,
  actor: GoalHistoryActor,
  eventLog?: EventLog | null,
): Promise<Goal> {
  const g = await readGoal(goalsDir, id);
  if (!g) throw new Error(`Goal not found: ${id}`);
  const ts = nowIso();
  const next: Goal = {
    ...g,
    status,
    lastOutcome: reason,
    history: [...(g.history ?? []), { timestamp: ts, action: status, detail: reason, actor }],
  };
  await writeGoal(goalsDir, next);

  const kind = status === "completed" ? "goal.completed" : status === "failed" ? "goal.failed" : "goal.abandoned";
  try {
    eventLog?.append({
      sessionId: "goal-stewardship",
      timestamp: ts,
      eventType: "action_taken",
      content: {
        kind,
        goalId: next.id,
        label: next.label,
        reason,
        assessmentCount: next.assessmentCount,
        dispatchCount: next.dispatchCount,
      },
    });
  } catch {
    /* non-fatal */
  }

  return next;
}

export async function appendGoalHistory(goalsDir: string, id: string, entry: GoalHistoryEntry): Promise<void> {
  const g = await readGoal(goalsDir, id);
  if (!g) throw new Error(`Goal not found: ${id}`);
  const next = { ...g, history: [...(g.history ?? []), entry] };
  await writeGoal(goalsDir, next);
}

export async function resolveGoalId(goalsDir: string, idOrLabel: string): Promise<Goal | null> {
  const t = idOrLabel.trim();
  if (!t) return null;
  const byId = await readGoal(goalsDir, t);
  if (byId) return byId;
  return readGoalByLabel(goalsDir, t);
}
