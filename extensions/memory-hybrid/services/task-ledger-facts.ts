/**
 * Facts-backed active task ledger (category:project).
 * Aligns hybrid-mem active-tasks with memory_store / memory_recall workflows.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { ActiveTaskProjectionConfig, MemoryCategory } from "../config.js";
import type { MemoryEntry } from "../types/memory.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import {
  type ActiveTaskEntry,
  type ActiveTaskStatus,
  type PendingTaskSignal,
  OMITTED_CAP_NOTE,
  UNKNOWN_ACTIVE_TASK_TIME,
  completeTask,
  deleteSignal,
  detectStaleTasks,
  flushCompletedTaskToMemory,
  readPendingSignals,
  serializeActiveTaskFile,
  serializeTaskEntry,
  upsertTask,
} from "./active-task.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { isOpenClawSessionLikelyPresent, looksLikeOpenClawSessionRef } from "./openclaw-session-artifact.js";

export const TASK_LEDGER_CATEGORY = "project" as MemoryCategory;

const TERMINAL = new Set(["done", "completed", "cancelled", "closed", "abandoned", "superseded"]);

/** Latest value per entity+key from non-superseded project facts */
export function groupProjectFactsByEntity(facts: MemoryEntry[]): Map<string, Map<string, MemoryEntry>> {
  const byEntity = new Map<string, Map<string, MemoryEntry>>();
  for (const f of facts) {
    if (!f.entity?.trim()) continue;
    const ent = f.entity.trim();
    const k = (f.key ?? "").trim() || "_body";
    let km = byEntity.get(ent);
    if (!km) {
      km = new Map();
      byEntity.set(ent, km);
    }
    const prev = km.get(k);
    if (!prev || f.createdAt > prev.createdAt) {
      km.set(k, f);
    }
  }
  return byEntity;
}

function rowToRecord(row: Map<string, MemoryEntry>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, e] of row) {
    const key = k === "_body" ? "description" : k;
    o[key] = e.value ?? e.text ?? "";
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

export function factStatusToDisplay(raw: string): ActiveTaskStatus {
  const s = raw.trim().toLowerCase();
  if (s === "open") return "In progress";
  if (s === "in_progress" || s === "in progress") return "In progress";
  if (s === "blocked" || s.startsWith("blocked")) return "Stalled";
  if (s === "waiting") return "Waiting";
  if (s === "failed" || s === "error") return "Failed";
  if (s === "stalled") return "Stalled";
  if (TERMINAL.has(s)) return "Done";
  return "In progress";
}

export function displayStatusToFact(status: ActiveTaskStatus): string {
  switch (status) {
    case "In progress":
      return "in_progress";
    case "Done":
      return "done";
    case "Failed":
      return "failed";
    case "Waiting":
      return "waiting";
    case "Stalled":
      return "blocked";
    default:
      return "in_progress";
  }
}

function isTerminalFactStatus(raw: string): boolean {
  return TERMINAL.has(raw.trim().toLowerCase());
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
    const statusRaw = (f.status ?? "open").trim();
    const disp = factStatusToDisplay(statusRaw);
    const started = resolveTaskStarted(f, bounds);
    const updated = resolveTaskUpdated(f, bounds);
    let handoff: ActiveTaskEntry["handoff"] = undefined;
    if (f.handoff?.trim()) {
      try {
        handoff = JSON.parse(f.handoff.trim());
      } catch {
        // Ignore parse errors
      }
    }
    const entry: ActiveTaskEntry = {
      label: entity,
      description: titleFromFacts(f),
      status: disp,
      branch: f.branch?.trim() || undefined,
      stashCommit: f.stash_commit?.trim() || undefined,
      subagent: f.related_session?.trim() || undefined,
      next: f.next?.trim() || undefined,
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
): {
  active: ActiveTaskEntry[];
  completed: ActiveTaskEntry[];
} {
  const facts = factsDb.listFactsByCategory(TASK_LEDGER_CATEGORY, factLimit);
  const grouped = groupProjectFactsByEntity(facts);
  return buildTaskEntriesFromGroupedFacts(grouped);
}

export function readActiveTaskRowsFromFacts(
  factsDb: FactsDB,
  staleMinutes: number,
): { active: ActiveTaskEntry[]; completed: ActiveTaskEntry[] } {
  const { active, completed } = loadTaskLedgerFromFacts(factsDb);
  const staleActive = detectStaleTasks(active, staleMinutes);
  return { active: staleActive, completed };
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
  let out = entries;
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

export type ActiveTaskHygieneActionKind = "dead-session" | "stale-failed" | "superseded-duplicate";

export interface ActiveTaskHygieneAction {
  label: string;
  kind: ActiveTaskHygieneActionKind;
  toStatus: "abandoned" | "superseded";
  reason: string;
  canonicalLabel?: string;
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
    if (titleKey) {
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
  },
): Promise<ActiveTaskHygienePlan> {
  const nowMs = opts.nowMs ?? Date.now();
  const olderThanMinutes = Math.max(1, Math.floor(opts.olderThanMinutes));
  const olderThanMs = olderThanMinutes * 60 * 1000;
  const isOlderThan = (task: ActiveTaskEntry): boolean => {
    const updatedMs = parseTaskUpdatedMs(task.updated);
    return updatedMs == null || nowMs - updatedMs > olderThanMs;
  };
  const checkSessionPresent =
    opts.checkSessionPresent ??
    ((sessionRef: string): Promise<boolean> => isOpenClawSessionLikelyPresent(sessionRef, opts.openclawHome));

  const stale: ActiveTaskHygieneStaleCandidate[] = [];
  const actionsByLabel = new Map<string, ActiveTaskHygieneAction>();

  for (const task of tasks) {
    if (task.status !== "Failed") continue;
    if (!isOlderThan(task)) continue;
    const reason = `Failed task older than ${olderThanMinutes}m; marking abandoned.`;
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

  for (const task of tasks) {
    if (task.status !== "In progress") continue;
    const sessionRef = task.subagent?.trim();
    if (!sessionRef || !looksLikeOpenClawSessionRef(sessionRef)) continue;
    if (!isOlderThan(task)) continue;
    const present = await checkSessionPresent(sessionRef);
    if (present) continue;
    const reason = `In-progress task has missing session transcript (${sessionRef}) and is older than ${olderThanMinutes}m; marking abandoned.`;
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

export async function upsertProjectTaskKey(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  entity: string,
  key: string,
  value: string,
  log?: { warn?: (m: string) => void },
): Promise<void> {
  const facts = factsDb.listFactsByCategory(TASK_LEDGER_CATEGORY, 8000);
  const same = facts.filter((f) => f.entity === entity && (f.key ?? "") === key);
  same.sort((a, b) => b.createdAt - a.createdAt);
  const previous = same[0];
  const text = `Task [${entity}] ${key}: ${value}`;
  const entry = factsDb.store({
    text,
    category: TASK_LEDGER_CATEGORY,
    importance: CLI_STORE_IMPORTANCE,
    entity,
    key,
    value,
    source: "active-task",
    decayClass: "permanent",
  });
  if (previous) {
    factsDb.supersede(previous.id, entry.id);
  }
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
  },
): Promise<void> {
  const entity = entry.label;
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "title", entry.description, log);
  const statusValue = opts?.statusOverride?.trim() || displayStatusToFact(entry.status);
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "status", statusValue, log);
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "next", entry.next?.trim() || "", log);
  await upsertProjectTaskKey(
    factsDb,
    vectorDb,
    embeddings,
    entity,
    "related_session",
    entry.subagent?.trim() || "",
    log,
  );
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "task_updated", entry.updated, log);
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "started", entry.started, log);
  await upsertProjectTaskKey(factsDb, vectorDb, embeddings, entity, "branch", entry.branch?.trim() || "", log);
  await upsertProjectTaskKey(
    factsDb,
    vectorDb,
    embeddings,
    entity,
    "stash_commit",
    entry.stashCommit?.trim() || "",
    log,
  );
  await upsertProjectTaskKey(
    factsDb,
    vectorDb,
    embeddings,
    entity,
    "handoff",
    entry.handoff ? JSON.stringify(entry.handoff) : "",
    log,
  );
}

export interface ActiveTaskHygieneApplyResult {
  appliedCount: number;
  auditFactId?: string;
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
  const audit = {
    runAt,
    olderThanMinutes: plan.olderThanMinutes,
    duplicates: plan.duplicates,
    stale: plan.stale,
    actions: plan.actions,
  };
  const auditFact = factsDb.store({
    text: `Active-task hygiene audit ${runAt}: ${plan.actions.length} action(s), ${plan.duplicates.length} duplicate group(s).`,
    category: "episode",
    importance: CLI_STORE_IMPORTANCE,
    source: "active-task-hygiene",
    decayClass: "permanent",
    entity: `active-task-hygiene:${runAt}`,
    key: "report",
    value: JSON.stringify(audit),
  });

  const { active } = loadTaskLedgerFromFacts(factsDb);
  const byLabel = new Map(active.map((task) => [task.label, task] as const));
  let appliedCount = 0;
  for (const action of plan.actions) {
    const task = byLabel.get(action.label);
    if (!task) continue;
    const doneEntry: ActiveTaskEntry = {
      ...task,
      status: "Done",
      updated: runAt,
      next: action.reason,
      subagent: action.kind === "dead-session" ? undefined : task.subagent,
    };
    await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, doneEntry, opts.log, {
      statusOverride: action.toStatus,
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
      );
    }
    if (opts.flushOnComplete && opts.memoryDir) {
      await flushCompletedTaskToMemory(doneEntry, opts.memoryDir).catch(() => {});
    }
    appliedCount++;
  }

  return { appliedCount, auditFactId: auditFact.id };
}

export async function renderActiveTaskMarkdownFile(
  factsDb: FactsDB,
  staleMinutes: number,
  filePath: string,
  projection: ActiveTaskProjectionConfig,
): Promise<void> {
  let { active, completed } = loadTaskLedgerFromFacts(factsDb);
  active = applyActiveTaskProjectionFilters(active, projection);
  completed = applyActiveTaskProjectionFilters(completed, projection);
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
    "> **Timestamps:** **Started** / **Updated** use stored fact fields (`started`, `task_started`, `task_updated`, …) or SQLite row times (min / max `createdAt` per task). The render clock is not used. Missing values show as **Unknown** and count as stale under `staleThreshold`.",
    "> **Operators:** Update or close tasks via `memory_store` / project facts; run `hybrid-mem active-tasks reconcile` when session rows are obsolete; then `active-tasks render`. See `docs/ACTIVE-TASKS-PROJECTION.md`.",
    "",
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.join("\n"), "utf-8");
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

  const findMatchingTask = (activeEntries: ActiveTaskEntry[], signal: PendingTaskSignal): ActiveTaskEntry | null => {
    const byLabel = activeEntries.filter((t) => t.label === signal.taskRef);
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

  const touched = new Set<string>();
  let updatedActive = [...active];
  const updatedCompleted = [...rawCompleted];
  const processedSignals: PendingTaskSignal[] = [];
  const expiredSignals: PendingTaskSignal[] = [];
  const completedToFlush: ActiveTaskEntry[] = [];

  for (const signal of signals) {
    try {
      const updatedTimestamp = (() => {
        const t = Date.parse(signal.timestamp);
        return Number.isNaN(t) ? new Date().toISOString() : signal.timestamp;
      })();

      const existing = findMatchingTask(updatedActive, signal);
      if (!existing) {
        if (isSignalExpired(signal)) expiredSignals.push(signal);
        else logger?.warn?.(`memory-hybrid: no matching active task for signal ${signal.taskRef}; leaving pending`);
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
          processedSignals.push(signal);
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
      processedSignals.push(signal);
      touched.add(existing.label);
    } catch (err) {
      logger?.warn?.(`memory-hybrid: failed to process signal from ${signal._filePath}: ${err}`);
    }
  }

  if (processedSignals.length === 0) {
    if (expiredSignals.length > 0) {
      for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
      logger?.info?.(`memory-hybrid: pruned ${expiredSignals.length} expired task signal(s) (facts ledger)`);
    }
    return;
  }

  try {
    for (const label of touched) {
      const a = updatedActive.find((t) => t.label === label);
      const c = updatedCompleted.find((t) => t.label === label);
      const entry = a ?? c;
      if (entry) {
        await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, entry, logger);
      }
    }
  } catch (err) {
    logger?.warn?.(`memory-hybrid: failed to persist facts after task signals: ${err}`);
    return;
  }

  for (const signal of processedSignals) await deleteSignal(signal._filePath).catch(() => {});
  for (const signal of expiredSignals) await deleteSignal(signal._filePath).catch(() => {});
  if (flushOnComplete && completedToFlush.length > 0) {
    for (const completed of completedToFlush) {
      await flushCompletedTaskToMemory(completed, memoryDir).catch(() => {});
    }
  }
  logger?.info?.(`memory-hybrid: consumed ${processedSignals.length} pending task signal(s) into facts ledger`);
}

export interface FactsReconcileResult {
  reconciledLabels: string[];
  wrote: boolean;
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
  } = {},
): Promise<FactsReconcileResult> {
  const { active } = readActiveTaskRowsFromFacts(factsDb, staleMinutes);
  const reconciledLabels: string[] = [];
  const toFlush: ActiveTaskEntry[] = [];
  const openclawHome = opts.openclawHome;

  for (const task of active) {
    if (task.status !== "In progress") {
      continue;
    }
    const ref = task.subagent?.trim();
    if (!ref || !looksLikeOpenClawSessionRef(ref)) {
      continue;
    }
    const present = await isOpenClawSessionLikelyPresent(ref, openclawHome);
    if (present) {
      continue;
    }
    const now = new Date().toISOString();
    const doneEntry: ActiveTaskEntry = {
      ...task,
      status: "Done",
      updated: now,
      next: `Auto-reconciled: session transcript not found for ${ref} (subagent bookkeeping cleanup).`,
      subagent: undefined,
    };
    reconciledLabels.push(task.label);
    toFlush.push(doneEntry);
  }

  if (reconciledLabels.length === 0 || opts.dryRun) {
    return { reconciledLabels, wrote: false };
  }

  for (const entry of toFlush) {
    await syncActiveTaskEntryToFacts(factsDb, vectorDb, embeddings, entry, opts.log);
  }

  if (opts.flushOnComplete && opts.memoryDir) {
    for (const entry of toFlush) {
      await flushCompletedTaskToMemory(entry, opts.memoryDir).catch(() => {});
    }
  }

  return { reconciledLabels, wrote: true };
}
