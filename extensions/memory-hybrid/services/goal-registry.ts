/**
 * Goal registry — JSON files under state/goals/
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { EventLog } from "../backends/event-log.js";
import type {
  CreateGoalInput,
  Goal,
  GoalDefaults,
  GoalHistoryActor,
  GoalHistoryEntry,
  GoalIndex,
  GoalStatus,
} from "./goal-stewardship-types.js";

const INDEX_FILENAME = "_index.json";
const TERMINAL: GoalStatus[] = ["completed", "failed", "abandoned"];
const GOAL_HOUSEKEEPING_PREFIX = "_";

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

const GOAL_LOCK_RETRY_MS = 25;
const GOAL_LOCK_MAX_RETRIES = 200;
const GOAL_LOCK_STALE_MS = 2 * 60 * 1000;
const GOAL_LOCK_OWNER_FILE = "owner.json";

function lockKey(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "goal"
  );
}

async function acquireGoalLock(goalsDir: string, key: string): Promise<string> {
  const lockPath = join(goalsDir, `.lock-${lockKey(key)}`);
  await ensureDir(goalsDir);
  for (let attempt = 0; attempt < GOAL_LOCK_MAX_RETRIES; attempt++) {
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, GOAL_LOCK_OWNER_FILE),
        JSON.stringify({ pid: process.pid, acquiredAt: nowIso() }, null, 2),
        "utf-8",
      ).catch(() => {});
      return lockPath;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > GOAL_LOCK_STALE_MS) {
          let ownerPid: number | null = null;
          try {
            const raw = await readFile(join(lockPath, GOAL_LOCK_OWNER_FILE), "utf-8");
            const parsed = JSON.parse(raw) as { pid?: unknown };
            ownerPid = typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : null;
          } catch {
            ownerPid = null;
          }
          const ownerAlive = ownerPid != null ? isProcessAlive(ownerPid) : false;
          if (!ownerAlive) {
            await rm(lockPath, { recursive: true, force: true }).catch(() => {});
            continue;
          }
        }
      } catch {
        // Lock may disappear between stat/remove attempts; continue retrying.
      }
      await new Promise((resolve) => setTimeout(resolve, GOAL_LOCK_RETRY_MS));
    }
  }
  throw new Error(`Timed out waiting for goal lock: ${key}`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code !== "ESRCH";
  }
}

async function withGoalLock<T>(goalsDir: string, key: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = await acquireGoalLock(goalsDir, key);
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function isGoalRegistryJsonFilename(filename: string): boolean {
  return filename.endsWith(".json") && !filename.startsWith(GOAL_HOUSEKEEPING_PREFIX);
}

function isGoalLike(value: unknown): value is Goal {
  if (!value || typeof value !== "object") return false;
  const goal = value as Record<string, unknown>;
  return (
    typeof goal.id === "string" &&
    typeof goal.label === "string" &&
    typeof goal.status === "string" &&
    typeof goal.priority === "string" &&
    typeof goal.createdAt === "string"
  );
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
    if (!isGoalRegistryJsonFilename(f)) continue;
    try {
      const raw = await readFile(join(goalsDir, f), "utf-8");
      const g = JSON.parse(raw) as unknown;
      if (isGoalLike(g)) {
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
    linkedTasks: Array.isArray(g.linkedTasks) ? g.linkedTasks : [],
    lastBlockerFingerprint: g.lastBlockerFingerprint ?? null,
    sameBlockerStreak: g.sameBlockerStreak ?? 0,
    circuitBreakerLastProgressAssessmentCount: g.circuitBreakerLastProgressAssessmentCount ?? 0,
    humanEscalationSummary: g.humanEscalationSummary ?? null,
    escalationKind: g.escalationKind ?? null,
    lastMechanicalCheck: g.lastMechanicalCheck ?? null,
  };
}

export async function readGoal(goalsDir: string, id: string): Promise<Goal | null> {
  const path = join(goalsDir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isGoalLike(parsed)) {
      throw new Error(`Goal file has invalid schema (${path})`);
    }
    return normalizeGoalJson(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Goal file is corrupt or unreadable (${path}): ${String(err)}`);
  }
}

export async function listGoals(goalsDir: string): Promise<Goal[]> {
  if (!existsSync(goalsDir)) return [];
  const files = await readdir(goalsDir);
  const out: Goal[] = [];
  for (const f of files) {
    if (!isGoalRegistryJsonFilename(f)) continue;
    try {
      const g = await readGoal(goalsDir, f.replace(/\.json$/, ""));
      if (g) out.push(g);
    } catch {
      // Keep registry scans isolated: one corrupt goal file must not abort all goal processing.
    }
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
    const matches = index.goals.filter((g) => typeof g?.label === "string" && g.label.toLowerCase() === norm);
    const best = matches.find((g) => !isTerminalStatus(g.status)) ?? matches[0];
    if (best) return readGoal(goalsDir, best.id);
  } catch {
    /* index missing or corrupt — fall through to full scan */
  }
  const all = await listGoals(goalsDir);
  const matches = all.filter((g) => typeof g?.label === "string" && g.label.toLowerCase() === norm);
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
  const goal = await withGoalLock(goalsDir, `label:${input.label}`, async () => {
    const v = validateGoalLabel(input.label);
    if (!v.ok) throw new Error(v.error);

    const existing = await readGoalByLabel(goalsDir, input.label);
    if (existing && !isTerminalStatus(existing.status)) {
      throw new Error(`A goal with label "${input.label}" already exists (status: ${existing.status})`);
    }

    const id = randomUUID();
    const ts = nowIso();
    const draft: Goal = {
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

    if (draft.acceptanceCriteria.length === 0) {
      throw new Error("acceptanceCriteria must contain at least one item");
    }

    await writeGoal(goalsDir, draft);
    return draft;
  });

  try {
    eventLog?.append({
      sessionId: "goal-stewardship",
      timestamp: goal.createdAt,
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
      | "lastMechanicalCheck"
    >
  >,
  historyEntry: GoalHistoryEntry | GoalHistoryEntry[],
): Promise<Goal> {
  return withGoalLock(goalsDir, id, async () => {
    const g = await readGoal(goalsDir, id);
    if (!g) throw new Error(`Goal not found: ${id}`);
    const entries = Array.isArray(historyEntry) ? historyEntry : [historyEntry];
    const next = { ...g, ...patch, history: [...(g.history ?? []), ...entries] };
    await writeGoal(goalsDir, next);
    return next;
  });
}

export async function terminateGoal(
  goalsDir: string,
  id: string,
  status: "completed" | "failed" | "abandoned",
  reason: string,
  actor: GoalHistoryActor,
  eventLog?: EventLog | null,
): Promise<Goal> {
  const next = await withGoalLock(goalsDir, id, async () => {
    const g = await readGoal(goalsDir, id);
    if (!g) throw new Error(`Goal not found: ${id}`);
    const ts = nowIso();
    const updated: Goal = {
      ...g,
      status,
      lastOutcome: reason,
      history: [...(g.history ?? []), { timestamp: ts, action: status, detail: reason, actor }],
    };
    await writeGoal(goalsDir, updated);
    return updated;
  });
  const ts = next.history[next.history.length - 1]?.timestamp ?? nowIso();

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
  await withGoalLock(goalsDir, id, async () => {
    const g = await readGoal(goalsDir, id);
    if (!g) throw new Error(`Goal not found: ${id}`);
    const next = { ...g, history: [...(g.history ?? []), entry] };
    await writeGoal(goalsDir, next);
  });
}

export async function resolveGoalId(goalsDir: string, idOrLabel: string): Promise<Goal | null> {
  const t = idOrLabel.trim();
  if (!t) return null;
  const byId = await readGoal(goalsDir, t);
  if (byId) return byId;
  return readGoalByLabel(goalsDir, t);
}
