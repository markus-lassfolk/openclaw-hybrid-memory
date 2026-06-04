/**
 * Facts-backed active task ledger (category:project).
 * Aligns hybrid-mem active-tasks with memory_store / memory_recall workflows.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import {
  formatGoalsMirrorSection,
  mergeGoalsMirrorIntoMarkdown,
  preserveGoalsMirrorSection,
} from "./goal-active-task-mirror.js";
import type { Goal } from "./goal-stewardship-types.js";
import { listActiveGoals, resolveGoalsDir } from "./goal-stewardship.js";
import type { ActiveTaskProjectionConfig, HybridMemoryConfig, MemoryCategory } from "../config.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getEnv } from "../utils/env-manager.js";
import { escapeRegExp } from "../utils/text.js";
import { execFile } from "../utils/process-runner.js";
import {
  type ActiveTaskEntry,
  type ActiveTaskStatus,
  completeTask,
  deleteSignal,
  detectStaleTasks,
  flushCompletedTaskToMemory,
  isNonActionableSubagentPlaceholderTask,
  isTerminalActiveTaskStatus,
  normalizePlaceholderTaskNext,
  OMITTED_CAP_NOTE,
  parseHandoffRef,
  type PendingTaskSignal,
  readPendingSignals,
  serializeActiveTaskFile,
  serializeTaskEntry,
  UNKNOWN_ACTIVE_TASK_TIME,
  upsertTask,
} from "./active-task.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { ActiveTaskReconcileProgressReporter } from "./active-task-reconcile-progress.js";
import { isOpenClawSessionLikelyPresent, looksLikeOpenClawSessionRef } from "./openclaw-session-artifact.js";
import { taskLabelsMatch } from "../utils/subagent-ended-utils.js";
import { fetchLivePrBlockerStatus } from "./task-hygiene.js";
import {
  activeTaskProvenance,
  canonicalLabel,
  displayStatusToFact,
  factCanonicalLabel,
  factStatusToDisplay,
  groupProjectFactsByEntity,
  isTerminalFactStatus,
  readCanonicalLabelFromFact,
} from "./task-ledger/canonical.js";
import { cleanupEvictedVector } from "./vector-maintenance.js";

const execFileAsync = promisify(execFile);

export {
  canonicalLabel,
  displayStatusToFact,
  factStatusToDisplay,
  groupProjectFactsByEntity,
} from "./task-ledger/canonical.js";
export const TASK_LEDGER_CATEGORY = "project" as MemoryCategory;

const GENERIC_TASK_TITLE_NORMALIZED = new Set(["project task", "task", "active task"]);
const PROJECTION_STALE_MARKER_SUFFIX = ".stale.json";
const ACTIVE_TASK_PROJECTION_GLOBAL_SCOPE_FILTER: ScopeFilter = { agentId: "__active_task_projection_global__" };

type ActiveTaskProjectionStaleMarker = {
  staleAt: string;
  reason: string;
  source?: string;
  factId?: string;
};

export type ActiveTaskProjectionStatus = {
  filePath: string;
  markerPath: string;
  exists: boolean;
  stale: boolean;
  staleReasons: string[];
  latestProjectFactAt: string | null;
  renderedAt: string | null;
  marker: ActiveTaskProjectionStaleMarker | null;
};

export type ActiveTaskLedgerSelectionMetrics = {
  projectRowsFetched: number;
  rowsDroppedMissingEntityOrCanonical: number;
  groupedEntityCount: number;
  duplicateRowsCollapsed: number;
  activeCandidates: number;
  completedCandidates: number;
  entitiesSkippedWithoutStatus: number;
  elapsedMs: number;
};

export type ActiveTaskCanonicalBackfillOptions = {
  dryRun?: boolean;
  limit?: number;
};

function activeTaskFactValue(key: string, e: MemoryEntry): string {
  if (e.value !== null && e.value !== undefined) {
    return String(e.value);
  }
  const text = e.text ?? "";
  const pattern = new RegExp(`^Task\\s*\\[[^\\]]+\\]\\s+${escapeRegExp(key)}:\\s*(.*)$`, "s");
  const match = text.match(pattern);
  if (match) return match[1] ?? "";
  return text;
}

function rowToRecord(row: Map<string, MemoryEntry>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, e] of row) {
    const key = k === "_body" ? "description" : k;
    o[key] = activeTaskFactValue(k, e);
  }
  return o;
}

function parseIsoFromFactField(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function createdBoundsFromKeyMap(keyMap: Map<string, MemoryEntry>): { minSec: number; maxSec: number } | null {
  let minSec = Number.POSITIVE_INFINITY;
  let maxSec = Number.NEGATIVE_INFINITY;
  for (const e of keyMap.values()) {
    const c = e.createdAt;
    if (typeof c === "number" && Number.isFinite(c)) {
      minSec = Math.min(minSec, c);
      maxSec = Math.max(maxSec, c);
    }
  }
  if (minSec === Number.POSITIVE_INFINITY) return null;
  return { minSec, maxSec };
}

function resolveTaskStarted(f: Record<string, string>, bounds: ReturnType<typeof createdBoundsFromKeyMap>): string {
  return (
    parseIsoFromFactField(f.started) ??
    parseIsoFromFactField(f.task_started) ??
    parseIsoFromFactField(f.created_at) ??
    (bounds ? new Date(bounds.minSec * 1000).toISOString() : undefined) ??
    UNKNOWN_ACTIVE_TASK_TIME
  );
}

function resolveTaskUpdated(f: Record<string, string>, bounds: ReturnType<typeof createdBoundsFromKeyMap>): string {
  return (
    parseIsoFromFactField(f.task_updated) ??
    parseIsoFromFactField(f.updated) ??
    parseIsoFromFactField(f.updated_at) ??
    (bounds ? new Date(bounds.maxSec * 1000).toISOString() : undefined) ??
    UNKNOWN_ACTIVE_TASK_TIME
  );
}

function titleFromFacts(f: Record<string, string>): string {
  return f.title?.trim() || f.description?.trim() || f.summary?.trim() || "Project task";
}

/**
 * Build active + completed task entries from grouped project facts.
 */
export function buildTaskEntriesFromGroupedFacts(byEntity: Map<string, Map<string, MemoryEntry>>): {
  active: ActiveTaskEntry[];
  completed: ActiveTaskEntry[];
} {
  const active: ActiveTaskEntry[] = [];
  const completed: ActiveTaskEntry[] = [];
  const sorted = [...byEntity.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [entity, keyMap] of sorted) {
    const f = rowToRecord(keyMap);
    const bounds = createdBoundsFromKeyMap(keyMap);
    // Entities with no explicit `status` key must not default to in-progress.
    const statusRaw = f.status?.trim();
    if (!statusRaw) continue;
    const disp = factStatusToDisplay(statusRaw);
    const started = resolveTaskStarted(f, bounds);
    const updated = resolveTaskUpdated(f, bounds);
    let handoff: ActiveTaskEntry["handoff"];
    if (f.handoff?.trim()) {
      handoff = parseHandoffRef(f.handoff.trim(), entity) ?? undefined;
    }
    const entry: ActiveTaskEntry = {
      label: entity,
      description: titleFromFacts(f),
      status: disp,
      branch: f.branch?.trim() || undefined,
      stashCommit: f.stash_commit?.trim() || undefined,
      subagent: f.related_session?.trim() || undefined,
      next: normalizePlaceholderTaskNext(f.next?.trim(), [entity, f.related_session?.trim()]),
      relatedGoal: f.related_goal?.trim() || f.goal_id?.trim() || undefined,
      started,
      updated,
      handoff,
    };
    if (isTerminalFactStatus(statusRaw) || disp === "Done") {
      completed.push({ ...entry, status: "Done" });
    } else {
      active.push(entry);
    }
  }

  return { active, completed };
}

export function loadTaskLedgerFromFacts(
  factsDb: FactsDB,
  factLimit = 8000,
  scopeFilter?: ScopeFilter | null,
): {
  active: ActiveTaskEntry[];
  completed: ActiveTaskEntry[];
} {
  const { active, completed } = loadTaskLedgerFromFactsWithMetrics(factsDb, factLimit, scopeFilter);
  return { active, completed };
}

export function loadTaskLedgerFromFactsWithMetrics(
  factsDb: FactsDB,
  factLimit = 8000,
  scopeFilter?: ScopeFilter | null,
): {
  active: ActiveTaskEntry[];
  completed: ActiveTaskEntry[];
  metrics: ActiveTaskLedgerSelectionMetrics;
} {
  const startedAtMs = Date.now();
  // Use targeted query instead of loading all facts then filtering by category (#1553)
  const facts = factsDb.getProjectFacts(factLimit, scopeFilter);
  // groupProjectFactsByEntity silently drops rows with no entity or no canonical label;
  // count those separately so duplicateRowsCollapsed only reflects true duplicates.
  const grouped = groupProjectFactsByEntity(facts);
  const { active, completed } = buildTaskEntriesFromGroupedFacts(grouped);
  let groupedFactRows = 0;
  for (const keyMap of grouped.values()) {
    groupedFactRows += keyMap.size;
  }
  // The rows fed to groupProjectFactsByEntity = facts that passed entity/canonical guard.
  // We infer dropped rows = facts.length - sum of sizes of all keyMaps.
  // But keyMaps only count unique (entity,key) pairs — so true duplicates are also in groupedFactRows.
  // Instead: track rows fed to grouping = only rows with entity AND canonicalLabel.
  // Use canonicalLabel directly to determine eligibility.
  const eligibleRows = facts.filter((f) => f.entity?.trim() && canonicalLabel(f.entity.trim())).length;
  const metrics: ActiveTaskLedgerSelectionMetrics = {
    projectRowsFetched: facts.length,
    rowsDroppedMissingEntityOrCanonical: facts.length - eligibleRows,
    groupedEntityCount: grouped.size,
    duplicateRowsCollapsed: Math.max(0, eligibleRows - groupedFactRows),
    activeCandidates: active.length,
    completedCandidates: completed.length,
    entitiesSkippedWithoutStatus: Math.max(0, grouped.size - active.length - completed.length),
    elapsedMs: Date.now() - startedAtMs,
  };
  return { active, completed, metrics };
}

export function readActiveTaskRowsFromFacts(
  factsDb: FactsDB,
  staleMinutes: number,
  scopeFilter?: ScopeFilter | null,
): { active: ActiveTaskEntry[]; completed: ActiveTaskEntry[]; latestProjectFactSec: number | null } {
  const { active, completed } = loadTaskLedgerFromFacts(factsDb, 8000, scopeFilter);
  const staleActive = detectStaleTasks(active, staleMinutes);
  const latestProjectFactSec = getLatestProjectFactCreatedAtSec(factsDb, scopeFilter);
  return { active: staleActive, completed, latestProjectFactSec };
}

export function getActiveTaskProjectionStaleMarkerPath(filePath: string): string {
  return `${filePath}${PROJECTION_STALE_MARKER_SUFFIX}`;
}

function parseProjectionMarker(raw: string): ActiveTaskProjectionStaleMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveTaskProjectionStaleMarker>;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.staleAt === "string" &&
      parsed.staleAt.trim().length > 0 &&
      typeof parsed.reason === "string" &&
      parsed.reason.trim().length > 0
    ) {
      return {
        staleAt: parsed.staleAt.trim(),
        reason: parsed.reason.trim(),
        ...(typeof parsed.source === "string" && parsed.source.trim().length > 0
          ? { source: parsed.source.trim() }
          : {}),
        ...(typeof parsed.factId === "string" && parsed.factId.trim().length > 0
          ? { factId: parsed.factId.trim() }
          : {}),
      };
    }
  } catch {
    // ignore malformed marker JSON
  }
  return null;
}

async function readActiveTaskProjectionStaleMarker(filePath: string): Promise<ActiveTaskProjectionStaleMarker | null> {
  const markerPath = getActiveTaskProjectionStaleMarkerPath(filePath);
  try {
    const raw = await readFile(markerPath, "utf-8");
    return parseProjectionMarker(raw);
  } catch {
    return null;
  }
}

export async function markActiveTaskProjectionStale(
  filePath: string,
  reason: string,
  meta: { source?: string; factId?: string } = {},
): Promise<void> {
  const markerPath = getActiveTaskProjectionStaleMarkerPath(filePath);
  const marker: ActiveTaskProjectionStaleMarker = {
    staleAt: new Date().toISOString(),
    reason: reason.trim().length > 0 ? reason.trim() : "projection marked stale",
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.factId ? { factId: meta.factId } : {}),
  };
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
}

export async function clearActiveTaskProjectionStale(filePath: string): Promise<void> {
  await rm(getActiveTaskProjectionStaleMarkerPath(filePath), { force: true });
}

export function getLatestProjectFactCreatedAtSec(factsDb: FactsDB, scopeFilter?: ScopeFilter | null): number | null {
  // Query all project facts (any source) to detect staleness from any project fact updates.
  // Note: getProjectFacts filters by source='active-task', but we need to detect updates
  // from all sources (e.g., memory_store) to properly mark projections as stale.
  const projectFacts = factsDb
    .getAll({ scopeFilter })
    .filter((fact) => fact.category === TASK_LEDGER_CATEGORY)
    .slice(0, 8000);
  if (projectFacts.length === 0) return null;
  let maxSec = Number.NEGATIVE_INFINITY;
  for (const fact of projectFacts) {
    if (typeof fact.createdAt === "number" && Number.isFinite(fact.createdAt)) {
      maxSec = Math.max(maxSec, fact.createdAt);
    }
  }
  return maxSec === Number.NEGATIVE_INFINITY ? null : maxSec;
}

function toIsoOrNull(unixSeconds: number | null): string | null {
  if (unixSeconds === null) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

export async function getActiveTaskProjectionStatus(
  factsDb: FactsDB,
  filePath: string,
  opts: { scopeFilter?: ScopeFilter | null; latestProjectFactSec?: number | null } = {},
): Promise<ActiveTaskProjectionStatus> {
  const markerPath = getActiveTaskProjectionStaleMarkerPath(filePath);
  const marker = await readActiveTaskProjectionStaleMarker(filePath);
  const latestProjectFactSec = opts.latestProjectFactSec ?? getLatestProjectFactCreatedAtSec(factsDb, opts.scopeFilter);
  const latestProjectFactAt = toIsoOrNull(latestProjectFactSec);

  let exists = false;
  let renderedAt: string | null = null;
  let renderedMs: number | null = null;
  try {
    const fileStat = await stat(filePath);
    exists = fileStat.isFile();
    if (exists) {
      renderedMs = fileStat.mtimeMs;
      renderedAt = new Date(fileStat.mtimeMs).toISOString();
    }
  } catch {
    // no projection file
  }

  const staleReasons = new Set<string>();
  if (latestProjectFactSec !== null && !exists) {
    staleReasons.add("projection_missing");
  }
  if (latestProjectFactSec !== null && renderedMs !== null && latestProjectFactSec * 1000 > renderedMs + 1000) {
    staleReasons.add("project_facts_newer_than_projection");
  }
  if (marker) {
    staleReasons.add("projection_marked_stale");
  }

  return {
    filePath,
    markerPath,
    exists,
    stale: staleReasons.size > 0,
    staleReasons: [...staleReasons],
    latestProjectFactAt,
    renderedAt,
    marker,
  };
}

export async function refreshActiveTaskProjectionBestEffort(opts: {
  factsDb: FactsDB;
  staleMinutes: number;
  filePath: string;
  projection: ActiveTaskProjectionConfig;
  reason: string;
  source?: string;
  factId?: string;
  goalsDir?: string;
  logger?: { warn?: (m: string) => void };
}): Promise<{ rendered: boolean; staleMarked: boolean; error?: string }> {
  try {
    await renderActiveTaskMarkdownFile(opts.factsDb, opts.staleMinutes, opts.filePath, opts.projection, opts.logger, {
      goalsDir: opts.goalsDir,
    });
    return { rendered: true, staleMarked: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let staleMarked = false;
    try {
      await markActiveTaskProjectionStale(opts.filePath, opts.reason, { source: opts.source, factId: opts.factId });
      staleMarked = true;
    } catch {
      // Ignore stale marker write failures (best-effort)
    }
    opts.logger?.warn?.(`memory-hybrid: active-task projection refresh failed: ${message}`);
    return { rendered: false, staleMarked, error: message };
  }
}

/** Normalize description for `dedupeBy: normalizedTitle`. */
function normalizeActiveTaskTitleForDedupe(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Filter/dedupe rows for facts markdown projection (`readable` mode). */
export function applyActiveTaskProjectionFilters(
  entries: ActiveTaskEntry[],
  config: ActiveTaskProjectionConfig,
): ActiveTaskEntry[] {
  if (config.mode === "full") {
    return entries;
  }
  let out = entries.filter((entry) => !isNonActionableSubagentPlaceholderTask(entry));
  if (config.excludeGenericTitle) {
    out = out.filter((e) => e.description.trim() !== "Project task");
  }
  if (config.titleMinChars > 0) {
    out = out.filter((e) => e.description.trim().length >= config.titleMinChars);
  }
  if (config.dedupeBy === "none") {
    return out;
  }
  const seen = new Set<string>();
  const result: ActiveTaskEntry[] = [];
  for (const e of out) {
    const key =
      config.dedupeBy === "label" ? e.label.trim().toLowerCase() : normalizeActiveTaskTitleForDedupe(e.description);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(e);
  }
  return result;
}

async function recordActiveTaskSessionReconcileAudit(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  runAt: string,
  entries: ActiveTaskEntry[],
  log?: { warn?: (m: string) => void },
): Promise<string | undefined> {
  if (entries.length === 0) return undefined;
  const audit = {
    runAt,
    reconciledLabels: entries.map((entry) => entry.label),
    count: entries.length,
    tasks: entries.map((entry) => ({
      label: entry.label,
      status: entry.status,
      updated: entry.updated,
      next: entry.next,
      relatedSession: entry.subagent ?? null,
    })),
  };
  const storeResult = factsDb.storeWithResult({
    text: `Active-task session reconcile ${runAt}: ${entries.length} orphan subagent row(s) completed.`,
    category: "episode",
    importance: CLI_STORE_IMPORTANCE,
    source: "active-task-session-reconcile",
    decayClass: "permanent",
    entity: `active-task-session-reconcile:${runAt}`,
    key: "report",
    value: JSON.stringify(audit),
  });
  if (storeResult.skipped) {
    return undefined;
  }
  if (storeResult.evictedFactId) {
    await cleanupEvictedVector({
      vectorDb,
      evictedFactId: storeResult.evictedFactId,
      logger: log,
      context: "active-task-session-reconcile-audit",
    });
  }
  if (storeResult.newlyStored) {
    try {
      if (!vectorDb.isLanceAvailable()) {
        log?.warn?.(
          "memory-hybrid: active-task session reconcile audit vector store skipped (Lance unavailable in degraded FTS-only mode)",
        );
        return storeResult.entry.id;
      }
      const vector = await embeddings.embed(storeResult.entry.text);
      factsDb.setEmbeddingModel(storeResult.entry.id, embeddings.modelName);
      await vectorDb.store({
        text: storeResult.entry.text,
        vector,
        importance: CLI_STORE_IMPORTANCE,
        category: "episode",
        id: storeResult.entry.id,
      });
    } catch (err) {
      log?.warn?.(`memory-hybrid: active-task session reconcile audit vector store failed: ${err}`);
    }
  }
  return storeResult.entry.id;
}

export interface ActiveTaskHygieneDuplicateGroup {
  normalized: string;
  canonicalLabel: string;
  labels: string[];
}

export interface ActiveTaskHygieneStaleCandidate {
  label: string;
  status: ActiveTaskStatus;
  updated: string;
  hoursStale: number | "?";
  reason: string;
}

export type ActiveTaskHygieneActionKind = "dead-session" | "stale-failed" | "superseded-duplicate" | "pr-live-blocker";

export interface ActiveTaskHygieneAction {
  label: string;
  kind: ActiveTaskHygieneActionKind;
  toStatus: "abandoned" | "superseded" | "stage-4-feedback";
  reason: string;
  canonicalLabel?: string;
  /** Set when kind is "pr-live-blocker" — the actual GitHub-classified blocker */
  prBlockerStatus?: string;
}

export interface ActiveTaskHygienePlan {
  olderThanMinutes: number;
  duplicates: ActiveTaskHygieneDuplicateGroup[];
  stale: ActiveTaskHygieneStaleCandidate[];
  actions: ActiveTaskHygieneAction[];
}

function parseTaskUpdatedMs(updated: string): number | null {
  if (!updated || updated === UNKNOWN_ACTIVE_TASK_TIME) return null;
  const ms = Date.parse(updated);
  if (Number.isNaN(ms)) return null;
  return ms;
}

function normalizeTaskString(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\-.:/]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericTaskTitle(value: string): boolean {
  const normalized = normalizeTaskString(value);
  if (!normalized) return true;
  return GENERIC_TASK_TITLE_NORMALIZED.has(normalized);
}

function staleHoursFromUpdated(updated: string, nowMs: number): number | "?" {
  const ms = parseTaskUpdatedMs(updated);
  if (ms == null) return "?";
  return Math.floor((nowMs - ms) / (60 * 60 * 1000));
}

function statusRankForCanonical(status: ActiveTaskStatus): number {
  switch (status) {
    case "In progress":
      return 0;
    case "Waiting":
      return 1;
    case "Stalled":
      return 2;
    case "Failed":
      return 3;
    default:
      return 4;
  }
}

function buildDuplicateComponents(tasks: ActiveTaskEntry[]): number[][] {
  const byLabel = new Map<string, number[]>();
  const byTitle = new Map<string, number[]>();
  for (let i = 0; i < tasks.length; i++) {
    const labelKey = normalizeTaskString(tasks[i].label);
    const titleKey = normalizeTaskString(tasks[i].description);
    if (labelKey) {
      const arr = byLabel.get(labelKey) ?? [];
      arr.push(i);
      byLabel.set(labelKey, arr);
    }
    if (titleKey && !isGenericTaskTitle(tasks[i].description)) {
      const arr = byTitle.get(titleKey) ?? [];
      arr.push(i);
      byTitle.set(titleKey, arr);
    }
  }

  const edges = new Map<number, Set<number>>();
  const linkGroup = (indices: number[]): void => {
    if (indices.length < 2) return;
    const root = indices[0];
    let rootSet = edges.get(root);
    if (!rootSet) {
      rootSet = new Set<number>();
      edges.set(root, rootSet);
    }
    for (let i = 1; i < indices.length; i++) {
      const idx = indices[i];
      rootSet.add(idx);
      let setI = edges.get(idx);
      if (!setI) {
        setI = new Set<number>();
        edges.set(idx, setI);
      }
      setI.add(root);
    }
  };

  for (const indices of byLabel.values()) linkGroup(indices);
  for (const indices of byTitle.values()) linkGroup(indices);

  const components: number[][] = [];
  const seen = new Set<number>();
  for (const idx of edges.keys()) {
    if (seen.has(idx)) continue;
    const stack = [idx];
    const comp: number[] = [];
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      if (seen.has(cur)) continue;
      seen.add(cur);
      comp.push(cur);
      for (const n of edges.get(cur) ?? []) {
        if (!seen.has(n)) stack.push(n);
      }
    }
    if (comp.length > 1) components.push(comp);
  }
  return components;
}

export async function planActiveTaskHygiene(
  tasks: ActiveTaskEntry[],
  opts: {
    olderThanMinutes: number;
    nowMs?: number;
    openclawHome?: string;
    checkSessionPresent?: (sessionRef: string) => Promise<boolean>;
    /** When true, fetch live PR state for tasks whose labels contain an "owner/repo#N" PR reference. */
    checkPrLiveBlocker?: boolean;
  },
): Promise<ActiveTaskHygienePlan> {
  const nowMs = opts.nowMs ?? Date.now();
  const olderThanMinutes = Math.max(1, Math.floor(opts.olderThanMinutes));
  const olderThanMs = olderThanMinutes * 60 * 1000;
  const classifyAge = (
    task: ActiveTaskEntry,
  ): {
    stale: boolean;
    reasonQualifier: string;
  } => {
    const updatedMs = parseTaskUpdatedMs(task.updated);
    if (updatedMs == null) {
      return {
        stale: true,
        reasonQualifier: "missing/unknown updated timestamp",
      };
    }
    return {
      stale: nowMs - updatedMs > olderThanMs,
      reasonQualifier: `older than ${olderThanMinutes}m`,
    };
  };
  const checkSessionPresent =
    opts.checkSessionPresent ??
    ((sessionRef: string): Promise<boolean> => isOpenClawSessionLikelyPresent(sessionRef, opts.openclawHome));

  const stale: ActiveTaskHygieneStaleCandidate[] = [];
  const actionsByLabel = new Map<string, ActiveTaskHygieneAction>();

  for (const task of tasks) {
    if (task.status !== "Failed") continue;
    const age = classifyAge(task);
    if (!age.stale) continue;
    const reason = `Failed task ${age.reasonQualifier}; marking abandoned.`;
    stale.push({
      label: task.label,
      status: task.status,
      updated: task.updated,
      hoursStale: staleHoursFromUpdated(task.updated, nowMs),
      reason,
    });
    actionsByLabel.set(task.label, {
      label: task.label,
      kind: "stale-failed",
      toStatus: "abandoned",
      reason,
    });
  }

  const staleSessionCandidates = tasks
    .filter((task) => task.status === "In progress")
    .map((task) => ({ task, sessionRef: task.subagent?.trim() ?? "" }))
    .filter(({ sessionRef }) => sessionRef.length > 0 && looksLikeOpenClawSessionRef(sessionRef))
    .map(({ task, sessionRef }) => ({ task, sessionRef, age: classifyAge(task) }))
    .filter(({ age }) => age.stale);
  const uniqueSessionRefs = [...new Set(staleSessionCandidates.map((c) => c.sessionRef))];
  const sessionPresentByRef = new Map<string, boolean>();
  await Promise.all(
    uniqueSessionRefs.map(async (sessionRef) => {
      const present = await checkSessionPresent(sessionRef);
      sessionPresentByRef.set(sessionRef, present);
    }),
  );
  for (const { task, sessionRef, age } of staleSessionCandidates) {
    const present = sessionPresentByRef.get(sessionRef) ?? false;
    if (present) continue;
    const reason = `In-progress task has missing session transcript (${sessionRef}) and is ${age.reasonQualifier}; marking abandoned.`;
    stale.push({
      label: task.label,
      status: task.status,
      updated: task.updated,
      hoursStale: staleHoursFromUpdated(task.updated, nowMs),
      reason,
    });
    actionsByLabel.set(task.label, {
      label: task.label,
      kind: "dead-session",
      toStatus: "abandoned",
      reason,
    });
  }

  // -----------------------------------------------------------------------------------------
  // PR live blocker check: verify tasks with "In progress" / "Waiting" / "Stalled" status
  // actually have a live GitHub blocker before classifying them as blocked/waiting.
  // This prevents hygiene from incorrectly marking PR-backed tasks as stalled when
  // mergeStateStatus says BLOCKED but unresolved review threads exist.
  // -----------------------------------------------------------------------------------------
  if (opts.checkPrLiveBlocker === true) {
    // Collect tasks that reference a PR (owner/repo#N pattern in label or description)
    const PR_REF_RE = /(?:^|[\s/])([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)#(\d+)/;
    const prCandidateTasks = tasks.filter((t) => {
      if (t.status !== "In progress" && t.status !== "Waiting" && t.status !== "Stalled") return false;
      const text = `${t.label} ${t.description}`;
      return PR_REF_RE.test(text);
    });

    if (prCandidateTasks.length > 0) {
      // Group by owner/repo to avoid duplicate API calls for the same repo
      const prKeys = new Map<string, { tasks: ActiveTaskEntry[]; owner: string; repo: string; number: number }>();
      for (const task of prCandidateTasks) {
        const m = PR_REF_RE.exec(`${task.label} ${task.description}`);
        if (!m) continue;
        const key = `${m[1]}#${m[2]}`;
        const existing = prKeys.get(key);
        if (existing) {
          existing.tasks.push(task);
        } else {
          const [owner, repo] = m[1].split("/");
          prKeys.set(key, { tasks: [task], owner, repo, number: Number(m[2]) });
        }
      }

      // Fetch live blocker status for each unique PR (parallel, deduped)
      const prStatuses = await Promise.all(
        [...prKeys.values()].map(async ({ owner, repo, number }) => {
          const status = await fetchLivePrBlockerStatus(owner, repo, number);
          return { owner, repo, number, status };
        }),
      );
      const statusByKey = new Map(prStatuses.map((p) => [`${p.owner}/${p.repo}#${p.number}`, p]));

      for (const { tasks, owner, repo, number } of prKeys.values()) {
        const blockerStatus = statusByKey.get(`${owner}/${repo}#${number}`);
        if (!blockerStatus) continue;

        if (blockerStatus.status !== "no_live_blocker") {
          const reason = `[PR hygiene #${number}] Live GitHub state: ${blockerStatus.status} — task updated to reflect actual PR state.`;

          // Apply action to ALL tasks referencing this PR
          for (const task of tasks) {
            // Skip if already handled by a dead-session or stale-failed action
            if (actionsByLabel.has(task.label)) continue;

            stale.push({
              label: task.label,
              status: task.status,
              updated: task.updated,
              hoursStale: staleHoursFromUpdated(task.updated, nowMs),
              reason,
            });
            actionsByLabel.set(task.label, {
              label: task.label,
              kind: "pr-live-blocker",
              toStatus: "stage-4-feedback",
              reason,
              // Store actual blocker classification, plus PR coordinates for parsing
              prBlockerStatus: `${blockerStatus.status}|${owner}:${repo}:${number}`,
            });
          }
        }
      }
    }
  }

  const duplicates: ActiveTaskHygieneDuplicateGroup[] = [];
  const components = buildDuplicateComponents(tasks);
  for (const comp of components) {
    const members = comp.map((idx) => tasks[idx]);
    const ranked = [...members].sort((a, b) => {
      const actionA = actionsByLabel.has(a.label) ? 1 : 0;
      const actionB = actionsByLabel.has(b.label) ? 1 : 0;
      if (actionA !== actionB) return actionA - actionB;
      const rankDiff = statusRankForCanonical(a.status) - statusRankForCanonical(b.status);
      if (rankDiff !== 0) return rankDiff;
      const updA = parseTaskUpdatedMs(a.updated) ?? Number.NEGATIVE_INFINITY;
      const updB = parseTaskUpdatedMs(b.updated) ?? Number.NEGATIVE_INFINITY;
      if (updA !== updB) return updB - updA;
      if (a.label.length !== b.label.length) return a.label.length - b.label.length;
      return a.label.localeCompare(b.label);
    });
    const canonical = ranked[0];
    const normalized = normalizeTaskString(canonical.description) || normalizeTaskString(canonical.label);
    const labels = ranked.map((m) => m.label);
    duplicates.push({
      normalized,
      canonicalLabel: canonical.label,
      labels,
    });
    for (const row of ranked.slice(1)) {
      if (actionsByLabel.has(row.label)) continue;
      actionsByLabel.set(row.label, {
        label: row.label,
        kind: "superseded-duplicate",
        toStatus: "superseded",
        canonicalLabel: canonical.label,
        reason: `Superseded duplicate of [${canonical.label}] after normalization.`,
      });
    }
  }

  stale.sort((a, b) => a.label.localeCompare(b.label));
  duplicates.sort((a, b) => a.canonicalLabel.localeCompare(b.canonicalLabel));
  const actions = [...actionsByLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
  return {
    olderThanMinutes,
    duplicates,
    stale,
    actions,
  };
}

function capRows<T extends ActiveTaskEntry>(rows: T[], max?: number): { rows: T[]; omitted: number } {
  if (max === undefined || rows.length <= max) return { rows, omitted: 0 };
  return { rows: rows.slice(0, max), omitted: rows.length - max };
}

/** Sectioned markdown for facts projection (## Active / ## Stale — revisit / ## Completed). */
export function buildFactsSectionedMarkdownBody(
  hot: ActiveTaskEntry[],
  stale: ActiveTaskEntry[],
  completed: ActiveTaskEntry[],
  omitted: { active: number; stale: number; completed: number },
): string {
  if (
    hot.length === 0 &&
    stale.length === 0 &&
    completed.length === 0 &&
    omitted.active === 0 &&
    omitted.stale === 0 &&
    omitted.completed === 0
  ) {
    return "# ACTIVE-TASKS.md — Working Memory\n\n## Active\n\n_No active tasks._\n";
  }

  const parts: string[] = ["# ACTIVE-TASKS.md — Working Memory\n"];

  if (hot.length > 0 || omitted.active > 0) {
    parts.push("## Active\n");
    if (hot.length === 0 && omitted.active === 0) {
      parts.push("_None._\n");
    } else {
      for (const entry of hot) {
        parts.push(serializeTaskEntry(entry));
        parts.push("");
      }
    }
    if (omitted.active > 0) {
      parts.push(`> ${omitted.active} ${OMITTED_CAP_NOTE}\n\n`);
    } else if (hot.length > 0) {
      parts.push("");
    }
  }

  if (stale.length > 0 || omitted.stale > 0) {
    parts.push("## Stale — revisit\n");
    if (stale.length === 0 && omitted.stale === 0) {
      parts.push("_None._\n");
    } else {
      for (const entry of stale) {
        parts.push(serializeTaskEntry(entry));
        parts.push("");
      }
    }
    if (omitted.stale > 0) {
      parts.push(`> ${omitted.stale} ${OMITTED_CAP_NOTE}\n\n`);
    } else if (stale.length > 0) {
      parts.push("");
    }
  }

  if (completed.length > 0 || omitted.completed > 0) {
    parts.push("## Completed\n");
    for (const entry of completed) {
      parts.push(serializeTaskEntry(entry));
      parts.push("");
    }
    if (omitted.completed > 0) {
      parts.push(`> ${omitted.completed} ${OMITTED_CAP_NOTE}\n`);
    }
  }

  return parts.join("\n");
}

export function taskEntityKey(entity: string, key: string): string {
  return `${canonicalLabel(entity)}\u0000${key.trim()}`;
}

export async function upsertProjectTaskKey(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  entity: string,
  key: string,
  value: string,
  log?: { warn?: (m: string) => void },
  opts?: { latestByEntityKey?: Map<string, MemoryEntry> },
): Promise<void> {
  // Normalise entity labels on write (trim + lowercase) to prevent case-variant
  // collisions (e.g. "Humanizer" and "humanizer" stored as separate entities).
  const normalizedEntity = entity.trim().toLowerCase();
  const canonical = canonicalLabel(normalizedEntity);
  const cacheKey = taskEntityKey(normalizedEntity, key);
  let previous: MemoryEntry | undefined;
  const cached = opts?.latestByEntityKey?.get(cacheKey);
  // Keep supersession scoped to active-task ledger rows only; cached
  // memory_store rows must never be retired by active-task checkpoints.
  if (cached?.source === "active-task") {
    previous = cached;
  } else if (!opts?.latestByEntityKey || cached || key === "status") {
    // Query database if: (a) no cache was provided, or (b) cache had a non-active-task
    // entry (which we must not supersede, but an active-task row may still exist), or
    // (c) this is a status write and cache missed (status must not become append-only).
    const facts = factsDb.listFactsByCategory(TASK_LEDGER_CATEGORY, 8000);
    const nowSec = Math.floor(Date.now() / 1000);
    // Supersede by canonical label to match grouping logic (strips suffixes, normalizes separators).
    // Only supersede facts from the active-task ledger (source:"active-task"), not memory_store.
    // Exclude expired facts to match projection logic (groupProjectFactsByEntity).
    const same = facts.filter(
      (f) =>
        f.source === "active-task" &&
        canonicalLabel(f.entity ?? "") === canonical &&
        (f.key ?? "") === key &&
        !(typeof f.expiresAt === "number" && Number.isFinite(f.expiresAt) && f.expiresAt <= nowSec),
    );
    same.sort((a, b) => b.createdAt - a.createdAt);
    previous = same[0];
  }
  const text = `Task [${normalizedEntity}] ${key}: ${value}`;
  const storeResult = factsDb.storeWithResult({
    text,
    category: TASK_LEDGER_CATEGORY,
    importance: CLI_STORE_IMPORTANCE,
    entity: normalizedEntity,
    key,
    value,
    source: "active-task",
    decayClass: "permanent",
    provenanceJson: activeTaskProvenance(canonical),
  });
  if (storeResult.skipped) {
    throw new Error(
      `memory-hybrid: active-task ledger upsert blocked by pre-store guard (${normalizedEntity}/${key})`,
    );
  }
  const entry = storeResult.entry;
  if (storeResult.evictedFactId) {
    await cleanupEvictedVector({
      vectorDb,
      evictedFactId: storeResult.evictedFactId,
      logger: log,
      context: "active-task-ledger-upsert",
    });
  }
  if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
    opts?.latestByEntityKey?.set(cacheKey, entry);
    return;
  }
  if (previous && storeResult.newlyStored) {
    factsDb.supersede(previous.id, entry.id);
  }
  opts?.latestByEntityKey?.set(cacheKey, entry);
  try {
    const vector = await embeddings.embed(text);
    factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
    if (!(await vectorDb.hasDuplicate(vector))) {
      await vectorDb.store({
        text,
        vector,
        importance: CLI_STORE_IMPORTANCE,
        category: TASK_LEDGER_CATEGORY,
        id: entry.id,
      });
    }
  } catch (err) {
    log?.warn?.(`memory-hybrid: active-task ledger vector store failed: ${err}`);
  }
}

/** Persist one task row to project facts (multi-key upsert). */
export async function syncActiveTaskEntryToFacts(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  entry: ActiveTaskEntry,
  log?: { warn?: (m: string) => void },
  opts?: {
    statusOverride?: string;
    latestByEntityKey?: Map<string, MemoryEntry>;
  },
): Promise<void> {
  const entity = entry.label;
  const upsertOpts = { latestByEntityKey: opts?.latestByEntityKey };
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "title", entry.description, log, upsertOpts);
  const statusValue = opts?.statusOverride?.trim() || displayStatusToFact(entry.status);
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "status", statusValue, log, upsertOpts);
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "task_updated", entry.updated, log, upsertOpts);
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "started", entry.started, log, upsertOpts);

  // Optional fields: only upsert when explicitly provided on the entry so partial syncs
  // (e.g. subagent_spawned auto-checkpoint) do not wipe existing next/branch/goal links.
  if (entry.next !== undefined) {
    await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "next", entry.next.trim(), log, upsertOpts);
  }
  if (entry.subagent !== undefined) {
    await upsertProjectTaskKey(
      factsDb,
      vectorDb,
      embeddings,
      entity,
      "related_session",
      entry.subagent.trim(),
      log,
      upsertOpts,
    );
  }
  if (entry.branch !== undefined) {
    await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "branch", entry.branch.trim(), log, upsertOpts);
  }
  if (entry.stashCommit !== undefined) {
    await upsertProjectTaskKey(
      factsDb,
      vectorDb,
      embeddings,
      entity,
      "stash_commit",
      entry.stashCommit.trim(),
      log,
      upsertOpts,
    );
  }
  if (entry.handoff !== undefined) {
    await upsertProjectTaskKey(
      factsDb,
      vectorDb,
      embeddings,
      entity,
      "handoff",
      entry.handoff ? JSON.stringify(entry.handoff) : "",
      log,
      upsertOpts,
    );
  }
  if (entry.relatedGoal !== undefined) {
    await upsertProjectTaskKey(
      factsDb,
      vectorDb,
      embeddings,
      entity,
      "related_goal",
      entry.relatedGoal.trim(),
      log,
      upsertOpts,
    );
  }
}

export interface ActiveTaskHygieneApplyResult {
  appliedCount: number;
  auditFactId?: string;
  /** Tasks whose live PR state has an actionable blocker (unresolved threads, red CI, etc.) */
  prBlockerTasks?: Array<{
    label: string;
    owner: string;
    repo: string;
    number: number;
    blockerStatus: string;
    reason: string;
  }>;
}

export interface ActiveTaskCanonicalBackfillResult {
  scannedFacts: number;
  canonicalLabelsUpdated: number;
  supersededFacts: number;
  duplicateGroups: Array<{ canonicalLabel: string; facts: number; activeBefore: number; superseded: number }>;
}

export function backfillActiveTaskCanonicalLabels(
  factsDb: FactsDB,
  opts: ActiveTaskCanonicalBackfillOptions = {},
): ActiveTaskCanonicalBackfillResult {
  const facts = factsDb.listFactsByCategory(TASK_LEDGER_CATEGORY, opts.limit ?? 50_000);
  const groups = new Map<string, MemoryEntry[]>();
  let canonicalLabelsUpdated = 0;

  const verifiedLookup = (() => {
    try {
      return factsDb.getRawDb().prepare("SELECT 1 FROM verified_facts WHERE fact_id = ? LIMIT 1");
    } catch {
      return null;
    }
  })();

  for (const fact of facts) {
    if (!fact.entity?.trim()) continue;
    const canonical = factCanonicalLabel(fact);
    const existing = readCanonicalLabelFromFact(fact);
    if (existing !== canonical) {
      canonicalLabelsUpdated++;
      if (!opts.dryRun) {
        const rawDb = (
          factsDb as unknown as {
            getRawDb?: () => { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
          }
        ).getRawDb?.();
        rawDb
          ?.prepare("UPDATE facts SET provenance_json = ? WHERE id = ?")
          .run(activeTaskProvenance(canonical, fact.provenanceJson), fact.id);
      }
    }
    const arr = groups.get(canonical) ?? [];
    arr.push(fact);
    groups.set(canonical, arr);
  }

  const duplicateGroups: ActiveTaskCanonicalBackfillResult["duplicateGroups"] = [];
  let supersededFacts = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [canonical, rows] of groups) {
    const activeBefore = rows.filter((f) => !f.supersededAt).length;
    let groupSuperseded = 0;
    const byKey = new Map<string, MemoryEntry[]>();
    for (const row of rows) {
      const key = (row.key ?? "").trim() || "_body";
      const arr = byKey.get(key) ?? [];
      arr.push(row);
      byKey.set(key, arr);
    }
    let terminalStatus: MemoryEntry | undefined;
    const statusRows = byKey.get("status") ?? [];
    for (const row of statusRows) {
      const isExpired = row.expiresAt !== null && row.expiresAt <= nowSec;
      if (
        !isExpired &&
        !row.supersededAt &&
        isTerminalFactStatus(row.value ?? row.text ?? "") &&
        (!terminalStatus || row.createdAt > terminalStatus.createdAt)
      ) {
        terminalStatus = row;
      }
    }
    const supersede = (oldId: string, newId: string | null): void => {
      if (verifiedLookup?.get(oldId)) {
        return;
      }
      supersededFacts++;
      groupSuperseded++;
      if (!opts.dryRun) factsDb.supersede(oldId, newId);
    };
    if (terminalStatus) {
      for (const [key, sameKey] of byKey) {
        const ranked = [...sameKey].sort((a, b) => b.createdAt - a.createdAt);
        const keeper = key === "status" ? terminalStatus : ranked[0];
        for (const row of ranked) {
          if (row.id !== keeper.id && !row.supersededAt) supersede(row.id, keeper.id);
        }
      }
    } else {
      for (const sameKey of byKey.values()) {
        const ranked = [...sameKey].sort((a, b) => b.createdAt - a.createdAt);
        const keeper = ranked[0];
        for (const row of ranked.slice(1)) {
          if (!row.supersededAt) supersede(row.id, keeper.id);
        }
      }
    }
    if (activeBefore > 1 || groupSuperseded > 0) {
      duplicateGroups.push({
        canonicalLabel: canonical,
        facts: rows.length,
        activeBefore,
        superseded: groupSuperseded,
      });
    }
  }

  if (!opts.dryRun) {
    (factsDb as unknown as { invalidateSupersededTextsCache?: () => void }).invalidateSupersededTextsCache?.();
  }

  return {
    scannedFacts: facts.length,
    canonicalLabelsUpdated,
    supersededFacts,
    duplicateGroups: duplicateGroups.sort((a, b) => a.canonicalLabel.localeCompare(b.canonicalLabel)),
  };
}

export async function applyActiveTaskHygieneFacts(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  plan: ActiveTaskHygienePlan,
  opts: {
    flushOnComplete?: boolean;
    memoryDir?: string;
    log?: { warn?: (m: string) => void };
  } = {},
): Promise<ActiveTaskHygieneApplyResult> {
  if (plan.actions.length === 0) {
    return { appliedCount: 0 };
  }

  const runAt = new Date().toISOString();
  const { active } = loadTaskLedgerFromFacts(factsDb);
  const byLabel = new Map(active.map((task) => [task.label, task] as const));
  const latestByEntityKey = new Map<string, MemoryEntry>();
  const nowSec = Math.floor(Date.now() / 1000);
  // Only index active-task ledger facts, not memory_store project facts.
  // Exclude expired facts to match projection logic (groupProjectFactsByEntity).
  for (const fact of factsDb.listFactsByCategory(TASK_LEDGER_CATEGORY, 8000)) {
    if (fact.source !== "active-task") continue;
    if (typeof fact.expiresAt === "number" && Number.isFinite(fact.expiresAt) && fact.expiresAt <= nowSec) continue;
    const entity = fact.entity?.trim().toLowerCase();
    if (!entity) continue;
    const key = (fact.key ?? "").trim();
    const cacheKey = taskEntityKey(entity, key);
    const prev = latestByEntityKey.get(cacheKey);
    if (!prev || fact.createdAt > prev.createdAt) {
      latestByEntityKey.set(cacheKey, fact);
    }
  }
  let appliedCount = 0;
  const prBlockerTasks: ActiveTaskHygieneApplyResult["prBlockerTasks"] = [];

  for (const action of plan.actions) {
    const task = byLabel.get(action.label);
    if (!task) continue;

    try {
      if (action.kind === "pr-live-blocker") {
        // Update task in-place: set status to "Waiting" and record the live blocker reason.
        // Do NOT complete the task — it is actively blocked and needs Forge attention.
        const updatedEntry: ActiveTaskEntry = {
          ...task,
          status: "Waiting",
          updated: runAt,
          next: action.reason,
          // Keep subagent so we know who is working on it
          subagent: task.subagent,
        };
        await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, updatedEntry, opts.log, {
          statusOverride: displayStatusToFact("Waiting"),
          latestByEntityKey,
        });
        // Record so caller can dispatch Forge for these tasks
        const parsed = action.prBlockerStatus ?? "";
        const [actualStatus, prRef] = parsed.includes("|") ? parsed.split("|", 2) : ["", parsed];
        const prParts = prRef.split(":");
        prBlockerTasks.push({
          label: task.label,
          owner: prParts[0] ?? "",
          repo: prParts[1] ?? "",
          number: Number(prParts[2] ?? 0) || 0,
          blockerStatus: actualStatus,
          reason: action.reason,
        });
        appliedCount++;
        continue;
      }

      const doneEntry: ActiveTaskEntry = {
        ...task,
        status: "Done",
        updated: runAt,
        next: action.reason,
        subagent: "",
      };
      await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, doneEntry, opts.log, {
        statusOverride: action.toStatus,
        latestByEntityKey,
      });
      if (action.kind === "superseded-duplicate" && action.canonicalLabel) {
        await upsertProjectTaskKey(
          factsDb,
          vectorDb,
          embeddings,
          doneEntry.label,
          "superseded_by",
          action.canonicalLabel,
          opts.log,
          { latestByEntityKey },
        );
      }
      if (opts.flushOnComplete && opts.memoryDir) {
        await flushCompletedTaskToMemory(doneEntry, opts.memoryDir).catch(() => {});
      }
      appliedCount++;
    } catch (err) {
      opts.log?.warn?.(
        `memory-hybrid: active-task hygiene apply failed for [${action.label}] (${action.kind}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const audit = {
    runAt,
    olderThanMinutes: plan.olderThanMinutes,
    duplicates: plan.duplicates,
    stale: plan.stale,
    actions: plan.actions,
    appliedCount,
  };
  const auditFactResult = factsDb.storeWithResult({
    text: `Active-task hygiene audit ${runAt}: ${plan.actions.length} action(s), ${plan.duplicates.length} duplicate group(s), ${appliedCount} applied.`,
    category: "episode",
    importance: CLI_STORE_IMPORTANCE,
    source: "active-task-hygiene",
    decayClass: "permanent",
    entity: `active-task-hygiene:${runAt}`,
    key: "report",
    value: JSON.stringify(audit),
  });
  if (auditFactResult.skipped) {
    return { appliedCount, auditFactId: undefined, prBlockerTasks };
  }
  if (auditFactResult.evictedFactId) {
    await cleanupEvictedVector({
      vectorDb,
      evictedFactId: auditFactResult.evictedFactId,
      logger: opts.log,
      context: "active-task-hygiene-audit",
    });
  }
  const auditFactId = auditFactResult.newlyStored !== false ? auditFactResult.entry.id : undefined;

  return { appliedCount, auditFactId, prBlockerTasks };
}

export async function renderActiveTaskMarkdownFile(
  factsDb: FactsDB,
  staleMinutes: number,
  filePath: string,
  projection: ActiveTaskProjectionConfig,
  logger?: { debug?: (message: string) => void },
  opts: { includeCompleted?: boolean; goals?: Goal[]; goalsDir?: string } = {},
): Promise<void> {
  const renderStartMs = Date.now();
  const includeCompleted = opts.includeCompleted === true;
  let { active, completed, metrics } = loadTaskLedgerFromFactsWithMetrics(
    factsDb,
    8000,
    ACTIVE_TASK_PROJECTION_GLOBAL_SCOPE_FILTER,
  );
  active = applyActiveTaskProjectionFilters(active, projection);
  completed = includeCompleted ? applyActiveTaskProjectionFilters(completed, projection) : [];
  active = detectStaleTasks(active, staleMinutes);

  const hotRaw = active.filter((t) => !t.stale);
  const staleRaw = active.filter((t) => t.stale);

  let capAct: { rows: ActiveTaskEntry[]; omitted: number };
  let capStale: { rows: ActiveTaskEntry[]; omitted: number };
  let capDone: { rows: ActiveTaskEntry[]; omitted: number };
  let combinedActiveOmitted = 0;

  if (projection.sectioned) {
    capAct = capRows(hotRaw, projection.maxRowsPerSection);
    capStale = capRows(staleRaw, projection.maxRowsPerSection);
    capDone = capRows(completed, projection.maxRowsPerSection);
  } else {
    const combinedActive = [...hotRaw, ...staleRaw];
    const cappedCombined = capRows(combinedActive, projection.maxRowsPerSection);
    capAct = { rows: cappedCombined.rows.filter((t) => !t.stale), omitted: 0 };
    capStale = { rows: cappedCombined.rows.filter((t) => t.stale), omitted: 0 };
    combinedActiveOmitted = cappedCombined.omitted;
    capDone = capRows(completed, projection.maxRowsPerSection);
  }

  const body = projection.sectioned
    ? buildFactsSectionedMarkdownBody(capAct.rows, capStale.rows, capDone.rows, {
        active: capAct.omitted,
        stale: capStale.omitted,
        completed: capDone.omitted,
      })
    : serializeActiveTaskFile([...capAct.rows, ...capStale.rows], capDone.rows, undefined, {
        active: combinedActiveOmitted,
        completed: capDone.omitted,
      });

  const lines = body.split("\n");
  lines.splice(
    1,
    0,
    "",
    "> **Projection** of hybrid-memory `category:project` facts (`activeTask.ledger: facts`). Regenerate via `hybrid-mem active-tasks render`.",
    includeCompleted
      ? "> **History mode:** includes terminal rows (`--include-completed`) for audit context."
      : "> **Default mode:** hides terminal rows; `ACTIVE-TASKS.md` is for active/stale work only. Use `active-tasks render --include-completed` for audit/history.",
    "> **Timestamps:** **Started** / **Updated** use stored fact fields (`started`, `task_started`, `task_updated`, …) or SQLite row times (min / max `createdAt` per task). The render clock is not used. Missing values show as **Unknown** and count as stale under `staleThreshold`.",
    "> **Operators:** Update or close tasks via `memory_store` / project facts; run `hybrid-mem active-tasks reconcile` when session rows are obsolete; then `active-tasks render`. See `docs/ACTIVE-TASKS-PROJECTION.md`.",
    "",
  );
  let finalContent = lines.join("\n");
  let goalsForMirror = opts.goals;
  if (!goalsForMirror && opts.goalsDir) {
    goalsForMirror = await listActiveGoals(opts.goalsDir);
  }
  if (goalsForMirror) {
    finalContent = mergeGoalsMirrorIntoMarkdown(finalContent, formatGoalsMirrorSection(goalsForMirror));
  } else {
    try {
      const existing = await readFile(filePath, "utf-8");
      finalContent = preserveGoalsMirrorSection(existing, finalContent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger?.debug?.(`memory-hybrid: active-task projection could not preserve goals mirror: ${String(err)}`);
      }
    }
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, finalContent, "utf-8");
  try {
    await clearActiveTaskProjectionStale(filePath);
  } catch {
    // Keep render success best-effort even when marker cleanup fails.
  }
  logger?.debug?.(
    `memory-hybrid: active-task projection rowsFetched=${metrics.projectRowsFetched} groupedEntities=${metrics.groupedEntityCount} duplicatesCollapsed=${metrics.duplicateRowsCollapsed} activeCandidates=${metrics.activeCandidates} staleBucketed=${staleRaw.length} renderedActive=${capAct.rows.length} renderedStale=${capStale.rows.length} renderedCompleted=${capDone.rows.length} elapsedMs=${Date.now() - renderStartMs}`,
  );
}

/** Pass to `renderActiveTaskMarkdownFile` when goal stewardship is enabled. */
export function activeTaskRenderGoalsOpts(
  cfg: HybridMemoryConfig,
  workspaceRoot: string,
): { goalsDir?: string } {
  if (!cfg.goalStewardship?.enabled) return {};
  return { goalsDir: resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir) };
}

/**
 * Apply pending sub-agent task signals to the facts ledger (no markdown).
 */
export async function consumePendingTaskSignalsFacts(
  workspaceRoot: string,
  staleMinutes: number,
  flushOnComplete: boolean,
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<void> {
  const memoryDir = join(workspaceRoot, "memory");
  let signals: PendingTaskSignal[];
  try {
    signals = await readPendingSignals(memoryDir);
  } catch (err) {
    logger?.warn?.(`memory-hybrid: failed to read pending task signals: ${err}`);
    return;
  }
  if (signals.length === 0) return;

  const signalTtlMs = Math.max(staleMinutes * 60 * 1000, 24 * 60 * 60 * 1000);
  const nowMs = Date.now();
  const isSignalExpired = (signal: PendingTaskSignal): boolean => {
    const parsed = Date.parse(signal.timestamp);
    if (Number.isNaN(parsed)) return true;
    return nowMs - parsed > signalTtlMs;
  };

  signals = [...signals].sort((a, b) => {
    const at = Date.parse(a.timestamp);
    const bt = Date.parse(b.timestamp);
    if (Number.isNaN(at) || Number.isNaN(bt)) return a._filePath.localeCompare(b._filePath);
    return at === bt ? a._filePath.localeCompare(b._filePath) : at - bt;
  });

  const { active: rawActive, completed: rawCompleted } = loadTaskLedgerFromFacts(factsDb);
  const active = detectStaleTasks(rawActive, staleMinutes);

  const findMatchingTaskInList = (
    activeEntries: ActiveTaskEntry[],
    signal: PendingTaskSignal,
  ): ActiveTaskEntry | null => {
    const normalizedTaskRef = signal.taskRef.trim();
    const byLabel = activeEntries.filter((t) => taskLabelsMatch(t.label, normalizedTaskRef));
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) {
      logger?.warn?.(`memory-hybrid: multiple active tasks share label ${signal.taskRef}; leaving signal pending`);
      return null;
    }
    const byDescription = activeEntries.filter((t) => t.description === signal.taskRef);
    if (byDescription.length === 1) {
      logger?.warn?.(
        `memory-hybrid: matched signal for "${signal.taskRef}" by description (not label); sub-agents should use the exact task label in taskRef for reliable matching`,
      );
      return byDescription[0];
    }
    if (byDescription.length > 1) {
      logger?.warn?.(
        `memory-hybrid: multiple active tasks match description ${signal.taskRef}; leaving signal pending`,
      );
      return null;
    }
    return null;
  };

  const findMatchingTask = (signal: PendingTaskSignal): ActiveTaskEntry | null =>
    findMatchingTaskInList(updatedActive, signal) ?? findMatchingTaskInList(updatedCompleted, signal);

  const touched = new Set<string>();
  let updatedActive = [...active];
  const updatedCompleted = [...rawCompleted];
  const processedEntries: Array<{ signal: PendingTaskSignal; label: string }> = [];
  const droppedTerminalSignals: PendingTaskSignal[] = [];
  const expiredSignals: PendingTaskSignal[] = [];
  const completedToFlush: ActiveTaskEntry[] = [];

  for (const signal of signals) {
    try {
      const updatedTimestamp = (() => {
        const t = Date.parse(signal.timestamp);
        return Number.isNaN(t) ? new Date().toISOString() : signal.timestamp;
      })();

      const existing = findMatchingTask(signal);
      if (!existing) {
        if (isSignalExpired(signal)) expiredSignals.push(signal);
        else logger?.warn?.(`memory-hybrid: no matching active task for signal ${signal.taskRef}; leaving pending`);
        continue;
      }

      if (isTerminalActiveTaskStatus(existing.status)) {
        droppedTerminalSignals.push(signal);
        logger?.info?.(
          `memory-hybrid: dropped ${signal.signal} signal for terminal task [${existing.label}] (${existing.status})`,
        );
        continue;
      }

      if (signal.signal === "completed") {
        const { updated, completed } = completeTask(updatedActive, existing.label);
        if (completed) {
          updatedActive = updated;
          updatedCompleted.push({
            ...completed,
            updated: updatedTimestamp,
            handoff: signal._handoff ?? completed.handoff,
          });
          processedEntries.push({ signal, label: existing.label });
          completedToFlush.push({
            ...completed,
            updated: updatedTimestamp,
            handoff: signal._handoff ?? completed.handoff,
          });
          touched.add(existing.label);
        }
        continue;
      }

      if (signal.signal !== "blocked" && signal.signal !== "escalate" && signal.signal !== "update") {
        if (isSignalExpired(signal)) expiredSignals.push(signal);
        else
          logger?.warn?.(
            `memory-hybrid: unhandled task signal "${signal.signal}" for ${signal.taskRef}; leaving pending`,
          );
        continue;
      }

      const newStatus: ActiveTaskEntry["status"] =
        signal.signal === "blocked" ? "Stalled" : signal.signal === "escalate" ? "Waiting" : existing.status;
      const updatedEntry: ActiveTaskEntry = {
        ...existing,
        status: newStatus,
        next: signal.summary ? `[Signal: ${signal.signal}] ${signal.summary}` : existing.next,
        updated: updatedTimestamp,
        handoff: signal._handoff ?? existing.handoff,
      };
      updatedActive = upsertTask(updatedActive, updatedEntry, true);
      processedEntries.push({ signal, label: existing.label });
      touched.add(existing.label);
    } catch (err) {
      logger?.warn?.(`memory-hybrid: failed to process signal from ${signal._filePath}: ${err}`);
    }
  }

  if (processedEntries.length === 0 && droppedTerminalSignals.length === 0) {
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
      logger?.info?.(`memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) (facts ledger)`);
    }
    return;
  }

  const persistedLabels = new Set<string>();
  if (processedEntries.length > 0) {
    for (const label of touched) {
      const a = updatedActive.find((t) => t.label === label);
      const c = updatedCompleted.find((t) => t.label === label);
      const entry = a ?? c;
      if (!entry) continue;
      try {
        await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, entry, logger);
        persistedLabels.add(label);
      } catch (err) {
        logger?.warn?.(
          `memory-hybrid: failed to persist facts for task [${label}] after signals: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (persistedLabels.size === 0 && droppedTerminalSignals.length === 0) {
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
      logger?.info?.(`memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) (facts ledger)`);
    }
    return;
  }

  const consumedSignals = processedEntries.filter(({ label }) => persistedLabels.has(label));
  for (const { signal } of consumedSignals) await deleteSignal(signal._filePath).catch(() => {});
  for (const signal of droppedTerminalSignals) await deleteSignal(signal._filePath).catch(() => {});
  for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
  if (flushOnComplete && completedToFlush.length > 0) {
    for (const completed of completedToFlush) {
      if (!persistedLabels.has(completed.label)) continue;
      await flushCompletedTaskToMemory(completed, memoryDir).catch(() => {});
    }
  }
  logger?.info?.(
    `memory-hybrid: consumed ${consumedSignals.length + droppedTerminalSignals.length} pending task signal(s) into facts ledger`,
  );
}

export interface FactsReconcileResult {
  reconciledLabels: string[];
  wrote: boolean;
  candidates: number;
  scanned: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
  factsWritten: number;
}

export async function reconcileActiveTaskInProgressSessionsFacts(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  staleMinutes: number,
  opts: {
    openclawHome?: string;
    flushOnComplete?: boolean;
    memoryDir?: string;
    dryRun?: boolean;
    log?: { warn?: (m: string) => void };
    progress?: ActiveTaskReconcileProgressReporter;
  } = {},
): Promise<FactsReconcileResult> {
  const startedAt = Date.now();
  const progress = opts.progress;

  progress?.start();
  progress?.phaseStart("session-index");

  const { active } = readActiveTaskRowsFromFacts(factsDb, staleMinutes);
  const reconciledLabels: string[] = [];
  const toFlush: ActiveTaskEntry[] = [];
  const toAudit: ActiveTaskEntry[] = [];
  const openclawHome = opts.openclawHome;
  let scanned = 0;
  let skipped = 0;
  const scanTotal = active.length;
  progress?.setScanTotal(scanTotal);

  for (const task of active) {
    scanned += 1;
    const elapsedMs = Date.now() - startedAt;
    if (task.status !== "In progress") {
      skipped += 1;
      progress?.onScanItem({
        index: scanned,
        total: scanTotal,
        entity: task.label,
        action: "skip",
        reason: "not_in_progress",
        previousStatus: task.status,
        elapsedMs,
      });
      continue;
    }
    const ref = task.subagent?.trim();
    if (!ref || !looksLikeOpenClawSessionRef(ref)) {
      skipped += 1;
      progress?.onScanItem({
        index: scanned,
        total: scanTotal,
        entity: task.label,
        action: "skip",
        reason: "no_session_ref",
        previousStatus: task.status,
        elapsedMs,
      });
      continue;
    }
    const present = await isOpenClawSessionLikelyPresent(ref, openclawHome);
    if (present) {
      skipped += 1;
      progress?.onScanItem({
        index: scanned,
        total: scanTotal,
        entity: task.label,
        action: "skip",
        reason: "session_present",
        previousStatus: task.status,
        elapsedMs,
      });
      continue;
    }
    const now = new Date().toISOString();
    const doneEntry: ActiveTaskEntry = {
      ...task,
      status: "Failed",
      updated: now,
      next: `Auto-reconciled: session transcript not found for ${ref} (subagent bookkeeping cleanup).`,
      subagent: "",
    };
    reconciledLabels.push(task.label);
    toFlush.push(doneEntry);
    toAudit.push(task);
    progress?.onScanItem({
      index: scanned,
      total: scanTotal,
      entity: task.label,
      action: "mark_abandoned",
      reason: "session_missing",
      previousStatus: task.status,
      elapsedMs,
    });
  }

  progress?.phaseComplete("session-index", {
    sessions: scanTotal,
    candidates: reconciledLabels.length,
  });
  progress?.setWriteTotal(reconciledLabels.length);

  const baseResult = {
    reconciledLabels,
    candidates: reconciledLabels.length,
    scanned,
    skipped,
    failed: 0,
    factsWritten: 0,
    elapsedMs: Date.now() - startedAt,
  };

  if (reconciledLabels.length === 0 || opts.dryRun) {
    return { ...baseResult, wrote: false };
  }

  progress?.phaseStart("fact-write", { candidates: reconciledLabels.length });
  let factsWritten = 0;
  let failed = 0;
  const successfullyWritten: ActiveTaskEntry[] = [];
  for (let i = 0; i < toFlush.length; i++) {
    const entry = toFlush[i]!;
    try {
      await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, entry, opts.log, {
        statusOverride: "abandoned",
      });
      factsWritten += 1;
      successfullyWritten.push(entry);
      progress?.onWriteItem(entry.label, i + 1, toFlush.length, false);
    } catch (err) {
      failed += 1;
      opts.log?.warn?.(
        `memory-hybrid: active-task reconcile failed for [${entry.label}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      progress?.onWriteItem(entry.label, i + 1, toFlush.length, true);
    }
  }
  progress?.phaseComplete("fact-write", { factsWritten, failed });

  const auditRunAt = new Date().toISOString();
  await recordActiveTaskSessionReconcileAudit(factsDb, vectorDb, embeddings, auditRunAt, successfullyWritten, opts.log);

  if (opts.flushOnComplete && opts.memoryDir) {
    for (const entry of successfullyWritten) {
      if (entry.status === "Failed") continue;
      await flushCompletedTaskToMemory(entry, opts.memoryDir).catch(() => {});
    }
  }

  return {
    ...baseResult,
    reconciledLabels: successfullyWritten.map((e) => e.label),
    wrote: failed === 0,
    failed,
    factsWritten,
    elapsedMs: Date.now() - startedAt,
  };
}

// -----------------------------------------------------------------------------------------
// Issue #1625: live-state reconciliation
// Fetches live GitHub issue/PR state for active tasks that reference external resources
// and checkpoints terminal live state into the task ledger so agents don't repeat audits.
// -----------------------------------------------------------------------------------------

export interface ReconcileLiveStateOptions {
  /** Maximum GitHub API calls per invocation (budget guard). */
  maxRequests?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  log?: {
    debug?: (m: string) => void;
    warn?: (m: string) => void;
    info?: (m: string) => void;
  };
}

interface LiveStateRef {
  owner: string;
  repo: string;
  number: number;
  /** "pr" or "issue" */
  kind: "pr" | "issue";
}

type LiveStateFetchStatus = "merged" | "closed" | "open" | "unknown" | "unavailable";

const LIVE_STATE_GH_TIMEOUT_MS = 20_000;
let liveStateBudgetCursor = 0;

function hasGitHubToken(): boolean {
  return (getEnv("GITHUB_TOKEN") ?? getEnv("GH_TOKEN") ?? "").trim().length > 0;
}

async function runGhJsonCommand(args: string[], signal?: AbortSignal): Promise<unknown> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), LIVE_STATE_GH_TIMEOUT_MS);
  const onAbort = (): void => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const { stdout } = await execFileAsync("gh", args, {
      encoding: "utf-8",
      signal: ac.signal,
      timeout: LIVE_STATE_GH_TIMEOUT_MS,
    });
    const raw = typeof stdout === "string" ? stdout.trim() : "";
    if (!raw) return null;
    return JSON.parse(raw);
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function selectRoundRobinEntries<T>(entries: T[], maxRequests: number): T[] {
  if (entries.length === 0 || maxRequests <= 0) return [];
  if (entries.length <= maxRequests) {
    liveStateBudgetCursor = 0;
    return entries;
  }
  const start = ((liveStateBudgetCursor % entries.length) + entries.length) % entries.length;
  const selected: T[] = [];
  for (let i = 0; i < maxRequests; i++) {
    selected.push(entries[(start + i) % entries.length]);
  }
  liveStateBudgetCursor = (start + maxRequests) % entries.length;
  return selected;
}

/** Extract "owner/repo#N" references from a task label or description.
 *  Handles: "owner/repo#123", "owner/repo pull request #123" (case-insensitive).
 *  Returns one ref per task (first match wins). */
function extractLiveStateRef(task: ActiveTaskEntry): LiveStateRef | null {
  const text = `${task.label} ${task.description}`;
  // Pattern: "owner/repo issue #123" or "owner/repo pull request #123" (GitHub's own URL form)
  // Check this first to avoid ambiguity with the bare owner/repo#N pattern
  const issueMatch = text.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\s+(issue|pull\s+request|pr)\s*#(\d+)\b/i);
  if (issueMatch) {
    const number = Number(issueMatch[4]);
    if (!Number.isFinite(number) || number < 1) return null;
    const kindString = issueMatch[3];
    const kind: "pr" | "issue" = /pull\s*request|pr/i.test(kindString) ? "pr" : "issue";
    return { owner: issueMatch[1], repo: issueMatch[2], number, kind };
  }
  // Pattern: owner/repo#number (most common - defaults to issue as per GitHub convention)
  const refMatch = text.match(/\b([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\s*#(\d+)\b/i);
  if (refMatch) {
    const number = Number(refMatch[3]);
    if (!Number.isFinite(number) || number < 1) return null;
    return { owner: refMatch[1], repo: refMatch[2], number, kind: "issue" };
  }
  return null;
}

/** Fetch live state for a GitHub PR via `gh pr view`.
 *  Returns "merged", "closed", "open", "unknown", or "unavailable". */
async function fetchLivePrState(
  owner: string,
  repo: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<LiveStateFetchStatus> {
  if (!hasGitHubToken()) return "unavailable";
  try {
    const payload = await runGhJsonCommand(
      ["pr", "view", String(prNumber), "--repo", `${owner}/${repo}`, "--json", "state,mergedAt,closedAt"],
      signal,
    );
    const data = payload as { state?: unknown; mergedAt?: unknown; closedAt?: unknown } | null;
    const state = typeof data?.state === "string" ? data.state.trim().toUpperCase() : "";
    const mergedAt = typeof data?.mergedAt === "string" && data.mergedAt.trim().length > 0;
    const closedAt = typeof data?.closedAt === "string" && data.closedAt.trim().length > 0;
    if (state === "MERGED" || mergedAt) return "merged";
    if (state === "CLOSED" || (closedAt && !mergedAt)) return "closed";
    if (state === "OPEN") return "open";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Fetch live state for a GitHub issue.
 *  Returns "closed" when the issue is closed, "open" when still open, "unknown" when
 *  state cannot be determined, or "unavailable" when the token/network is missing. */
async function fetchLiveIssueState(
  owner: string,
  repo: string,
  issueNumber: number,
  signal?: AbortSignal,
): Promise<LiveStateFetchStatus> {
  if (!hasGitHubToken()) return "unavailable";
  try {
    const payload = await runGhJsonCommand(
      ["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "state"],
      signal,
    );
    const data = payload as { state?: unknown } | null;
    const state = typeof data?.state === "string" ? data.state.trim().toUpperCase() : "";
    if (state === "CLOSED") return "closed";
    if (state === "OPEN") return "open";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Reconcile active tasks with live GitHub state.
 *
 *  For each active task that references an external GitHub issue or PR:
 *  - Fetch the current live state from GitHub.
 *  - If the live state is terminal (issue closed, PR merged/closed), checkpoint the
 *    task as "Done" in the facts ledger with evidence in `next` and `task_updated`.
 *  - If live state is non-terminal/unknown, leave the task unchanged.
 *
 *  This is intended to run during normal reconcile/hygiene/render cycles when enabled.
 *  The function is safe to call repeatedly: it only checkpoints terminal
 *  live-state transitions (merged/closed) and degrades gracefully when GitHub is unavailable.
 *
 *  Returns the number of tasks that were updated (for telemetry).
 */
export async function reconcileActiveTaskLiveState(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  opts: ReconcileLiveStateOptions = {},
): Promise<{ updatedCount: number; checkedCount: number; skippedCount: number }> {
  const maxRequests = Math.max(1, Math.min(opts.maxRequests ?? 20, 50));
  const signal = opts.signal;

  const { active } = loadTaskLedgerFromFacts(factsDb);
  let updatedCount = 0;
  let skippedCount = 0;

  // Collect all tasks with refs (allow multiple tasks per ref)
  const refMap = new Map<string, { tasks: ActiveTaskEntry[]; ref: LiveStateRef }>();
  for (const task of active) {
    if (task.status === "Done" || task.status === "Failed") continue;
    const ref = extractLiveStateRef(task);
    if (!ref) {
      skippedCount++;
      continue;
    }
    const key = `${ref.kind}:${ref.owner}/${ref.repo}#${ref.number}`;
    const existing = refMap.get(key);
    if (existing) {
      existing.tasks.push(task);
    } else {
      refMap.set(key, { tasks: [task], ref });
    }
  }

  const entries = [...refMap.entries()];
  const toFetch = selectRoundRobinEntries(entries, maxRequests);
  skippedCount += Math.max(0, entries.length - toFetch.length);

  // Fetch live state in parallel, up to budget
  let fetchedResults: Array<{ key: string; ref: LiveStateRef; state: LiveStateFetchStatus }> = [];
  try {
    const settled = await Promise.allSettled(
      toFetch.map(async ([key, { ref }]) => {
        const state: LiveStateFetchStatus =
          ref.kind === "pr"
            ? await fetchLivePrState(ref.owner, ref.repo, ref.number, signal)
            : await fetchLiveIssueState(ref.owner, ref.repo, ref.number, signal);
        return { key, ref, state };
      }),
    );
    fetchedResults = settled
      .filter(
        (result): result is PromiseFulfilledResult<{ key: string; ref: LiveStateRef; state: LiveStateFetchStatus }> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);
  } catch {
    opts.log?.debug?.("memory-hybrid: live-state reconcile fetch failed, skipping update");
    return { updatedCount, checkedCount: fetchedResults.length, skippedCount };
  }
  const checkedCount = fetchedResults.length;

  const terminalRefKeys = new Set<string>();
  for (const { key, state } of fetchedResults) {
    const isTerminal = state === "merged" || state === "closed";
    if (isTerminal) terminalRefKeys.add(key);
  }

  // Apply updates: for each terminal ref, update ALL tasks that point to it
  for (const [key, { tasks }] of entries) {
    if (!terminalRefKeys.has(key)) continue;
    const { ref } = refMap.get(key)!;
    const state = fetchedResults.find((r) => r.key === key)?.state ?? "unknown";
    const isTerminal = state === "merged" || state === "closed";
    if (!isTerminal) continue;

    const now = new Date().toISOString();
    const terminalState = state === "merged" ? "merged" : "closed";
    const next = `Auto-reconciled from live GitHub (${ref.owner}/${ref.repo} ${ref.kind} #${ref.number}): ${terminalState}.`;

    for (const task of tasks) {
      const doneEntry: ActiveTaskEntry = {
        ...task,
        status: "Done",
        updated: now,
        next,
        subagent: "",
      };
      try {
        await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, doneEntry, opts.log);
        updatedCount++;
        opts.log?.info?.(`memory-hybrid: live-state reconcile marked "${task.label}" done (${terminalState})`);
      } catch (err) {
        opts.log?.warn?.(
          `memory-hybrid: live-state reconcile failed for [${task.label}]: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { updatedCount, checkedCount, skippedCount };
}
