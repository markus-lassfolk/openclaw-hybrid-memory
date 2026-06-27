/**
 * Goal registry — JSON files under state/goals/
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { EventLog } from "../backends/event-log.js";
import { capturePluginError } from "./error-reporter.js";
import type {
  CreateGoalInput,
  Goal,
  GoalDefaults,
  GoalHistoryActor,
  GoalHistoryEntry,
  GoalIndex,
  GoalStatus,
} from "./goal-stewardship-types.js";
import { nowIso } from "../utils/dates.js";

const INDEX_FILENAME = "_index.json";
const TERMINAL: GoalStatus[] = ["completed", "failed", "abandoned"];
const GOAL_HOUSEKEEPING_PREFIX = "_";
const GOAL_CORRUPT_SUFFIX = ".json.corrupt";

/** Per-process dedupe so corrupt goal telemetry is not re-enqueued every sync (#1977). */
const reportedCorruptGoalFiles = new Set<string>();

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
  if (filename.endsWith(GOAL_CORRUPT_SUFFIX)) return false;
  return filename.endsWith(".json") && filename !== INDEX_FILENAME && !filename.startsWith(GOAL_HOUSEKEEPING_PREFIX);
}

function corruptGoalQuarantinePath(goalsDir: string, filename: string): string {
  const id = filename.replace(/\.json$/i, "");
  return join(goalsDir, `${id}${GOAL_CORRUPT_SUFFIX}`);
}

async function quarantineCorruptGoalFile(goalsDir: string, filename: string): Promise<void> {
  const srcPath = join(goalsDir, filename);
  const destPath = corruptGoalQuarantinePath(goalsDir, filename);
  if (!existsSync(srcPath) || existsSync(destPath)) return;
  try {
    await rename(srcPath, destPath);
  } catch {
    /* quarantine is best-effort */
  }
}

async function handleCorruptGoalRegistryEntry(goalsDir: string, filename: string, err?: unknown): Promise<void> {
  const dedupeKey = join(goalsDir, filename);
  if (reportedCorruptGoalFiles.has(dedupeKey)) return;
  reportedCorruptGoalFiles.add(dedupeKey);
  await quarantineCorruptGoalFile(goalsDir, filename);
  captureInvalidGoalRegistryEntry(filename, err);
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

function captureInvalidGoalRegistryEntry(filename: string, err?: unknown): void {
  const reason = err instanceof Error ? err.message : err === undefined ? "invalid persisted Goal shape" : String(err);
  capturePluginError(new Error(`invalid_goal_registry_entry: ${filename}: ${reason}`), {
    subsystem: "goal-registry",
    operation: "invalid_goal_registry_entry",
    severity: "warning",
    filename,
    reason,
    fingerprint: ["invalid_goal_registry_entry", filename],
  });
}

function asGoalIndexEntries(value: unknown): GoalIndex["goals"] {
  if (!value || typeof value !== "object") return [];
  const goals = (value as { goals?: unknown }).goals;
  if (!Array.isArray(goals)) return [];
  return goals.filter(
    (entry): entry is GoalIndex["goals"][number] =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string" &&
      typeof (entry as { label?: unknown }).label === "string" &&
      typeof (entry as { status?: unknown }).status === "string",
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
      } else {
        await handleCorruptGoalRegistryEntry(goalsDir, f);
      }
    } catch (err) {
      await handleCorruptGoalRegistryEntry(goalsDir, f, err);
    }
  }
  const index: GoalIndex = { updatedAt: nowIso(), goals };
  await writeFile(join(goalsDir, INDEX_FILENAME), JSON.stringify(index, null, 2), "utf-8");
}

function normalizeGoalJson(g: Goal): Goal {
  return {
    ...g,
    linkedTasks: Array.isArray(g.linkedTasks) ? g.linkedTasks : [],
    currentBlockers: Array.isArray(g.currentBlockers)
      ? g.currentBlockers
          .filter((b): b is string => typeof b === "string")
          .map((b) => b.trim())
          .filter(Boolean)
      : [],
    assessmentCount: typeof g.assessmentCount === "number" && Number.isFinite(g.assessmentCount) ? g.assessmentCount : 0,
    dispatchCount: typeof g.dispatchCount === "number" && Number.isFinite(g.dispatchCount) ? g.dispatchCount : 0,
    maxAssessments:
      typeof g.maxAssessments === "number" && Number.isFinite(g.maxAssessments) ? g.maxAssessments : 10,
    maxDispatches: typeof g.maxDispatches === "number" && Number.isFinite(g.maxDispatches) ? g.maxDispatches : 5,
    lastOutcome: typeof g.lastOutcome === "string" ? g.lastOutcome : null,
    lastAssessedAt: typeof g.lastAssessedAt === "string" ? g.lastAssessedAt : null,
    lastDispatchedAt: typeof g.lastDispatchedAt === "string" ? g.lastDispatchedAt : null,
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
    } catch (err) {
      // Keep registry scans isolated: one corrupt goal file must not abort all goal processing.
      await handleCorruptGoalRegistryEntry(goalsDir, f, err);
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
    const indexGoals = asGoalIndexEntries(JSON.parse(raw) as unknown);
    const matches = indexGoals.filter((g) => g.label.toLowerCase() === norm);
    const activeMatches = matches.filter((g) => !isTerminalStatus(g.status));
    const terminalMatches = matches.filter((g) => isTerminalStatus(g.status));
    const orderedMatches = [...activeMatches, ...terminalMatches];
    for (const match of orderedMatches) {
      try {
        const goal = await readGoal(goalsDir, match.id);
        if (goal && !isTerminalStatus(goal.status)) return goal;
      } catch {
        // Corrupt/stale index entries should not abort lookups.
      }
    }
  } catch {
    /* index missing or corrupt — fall through to full scan */
  }
  const all = await listGoals(goalsDir);
  const matches = all.filter((g) => typeof g.label === "string" && g.label.toLowerCase() === norm);
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

export type ResolveGoalIdResult =
  | { ok: true; goal: Goal }
  | { ok: false; code: "invalid_ref" | "not_found" | "corrupt"; message: string };

export async function resolveGoalIdResult(
  goalsDir: string,
  idOrLabel: string | undefined | null,
): Promise<ResolveGoalIdResult> {
  const t = typeof idOrLabel === "string" ? idOrLabel.trim() : "";
  if (!t) {
    return { ok: false, code: "invalid_ref", message: "goal_id is required." };
  }
  try {
    const byId = await readGoal(goalsDir, t);
    if (byId) return { ok: true, goal: byId };
  } catch (err) {
    return {
      ok: false,
      code: "corrupt",
      message: `Goal state could not be loaded for stewardship processing (${String(err)}). Repair or quarantine state/goals/${t}.json.`,
    };
  }
  const byLabel = await readGoalByLabel(goalsDir, t);
  if (byLabel) return { ok: true, goal: byLabel };
  return { ok: false, code: "not_found", message: "Goal not found." };
}

export async function resolveGoalId(
  goalsDir: string,
  idOrLabel: string | undefined | null,
): Promise<Goal | null> {
  const result = await resolveGoalIdResult(goalsDir, idOrLabel);
  return result.ok ? result.goal : null;
}
