import type { MemoryEntry } from "../../types/memory.js";
import type { ActiveTaskStatus } from "../active-task.js";

const TERMINAL = new Set(["done", "completed", "cancelled", "closed", "abandoned", "superseded"]);

export function canonicalLabel(entity: string): string {
  if (!entity?.trim()) return "";
  return entity
    .trim()
    .toLowerCase()
    .replace(/\s+(?:pr\s+queue|pull\s+request\s+queue|pr-stewardship|pull\s+request\s+stewardship)\s*$/i, "")
    .replace(/[\s/_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function readCanonicalLabelFromFact(fact: MemoryEntry): string | null {
  if (!fact.provenanceJson) return null;
  try {
    const parsed = JSON.parse(fact.provenanceJson) as {
      activeTask?: { canonicalLabel?: unknown };
      canonical_label?: unknown;
    };
    const raw = parsed.activeTask?.canonicalLabel ?? parsed.canonical_label;
    return typeof raw === "string" && raw.trim().length > 0 ? canonicalLabel(raw) : null;
  } catch {
    return null;
  }
}

export function factCanonicalLabel(fact: MemoryEntry): string {
  const fromProvenance = readCanonicalLabelFromFact(fact);
  if (fromProvenance) return fromProvenance;
  return canonicalLabel(fact.entity ?? "");
}

export function activeTaskProvenance(canonical: string, existing?: string | null): string {
  const base = { activeTask: { canonicalLabel: canonical }, canonical_label: canonical };
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Record<string, unknown>;
      return JSON.stringify({ ...parsed, ...base });
    } catch {
      // If existing provenance is not valid JSON, use base only
    }
  }
  return JSON.stringify(base);
}

function readFactRowid(fact: MemoryEntry): number | null {
  const rowid = (fact as MemoryEntry & { rowid?: unknown; _rowid?: unknown }).rowid;
  if (typeof rowid === "number" && Number.isFinite(rowid)) return rowid;
  const fallback = (fact as MemoryEntry & { _rowid?: unknown })._rowid;
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : null;
}

/** Tie-break comparator: returns negative if a is newer than b, positive if b is newer than a.
 *  Comparison order: createdAt → sourceDate (when both finite) → rowid (when available) → insertion order.
 *  Rowid/insertion-order fallback provides stable last-write wins semantics for timestamp ties. */
function factNewerThan(a: MemoryEntry, b: MemoryEntry, aOrder: number, bOrder: number): number {
  // Return < 0 when a is newer than b (a should win the slot).
  // createdAt: larger = newer
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  // sourceDate: larger = more recent external event
  const aSrc = typeof a.sourceDate === "number" && Number.isFinite(a.sourceDate) ? a.sourceDate : null;
  const bSrc = typeof b.sourceDate === "number" && Number.isFinite(b.sourceDate) ? b.sourceDate : null;
  // Check if this is a status comparison where one is terminal and the other is not.
  // Terminal status should always win, regardless of sourceDate.
  const aKey = (a.key ?? "").trim() || "_body";
  const bKey = (b.key ?? "").trim() || "_body";
  if (aKey === bKey && aKey === "status") {
    const aVal = a.value ?? "";
    const bVal = b.value ?? "";
    const aIsTerminal = isTerminalFactStatus(aVal);
    const bIsTerminal = isTerminalFactStatus(bVal);
    if (aIsTerminal !== bIsTerminal) {
      // Prefer terminal status over non-terminal.
      return aIsTerminal ? -1 : 1;
    }
  }
  // Now compare sourceDate values (both present, or exactly one present).
  if (aSrc !== null && bSrc !== null && aSrc !== bSrc) return bSrc - aSrc;
  if ((aSrc === null) !== (bSrc === null)) {
    // Prefer fresh local writes (no sourceDate) over stale external sourceDate events.
    if (aSrc === null && bSrc !== null) return -1;
    if (aSrc !== null && bSrc === null) return 1;
  }
  const aRowid = readFactRowid(a);
  const bRowid = readFactRowid(b);
  if (aRowid !== null && bRowid !== null && aRowid !== bRowid) return bRowid - aRowid;
  // Last-resort deterministic tie-break when rowid is unavailable.
  return bOrder - aOrder;
}

/** Latest value per entity+key from non-superseded project facts.
 *  Entity labels are normalized via factCanonicalLabel() (provenance-aware + trim + toLowerCase + suffix/separator cleanup)
 *  so that case-variant entries (e.g. "Humanizer" / "humanizer") are merged into one group.
 *  When multiple facts for the same entity+key have equal timestamps, last-write-wins ensures
 *  newer writes always win — terminal status updates will not be silently dropped behind earlier
 *  non-terminal facts with equal createdAt. */
export function groupProjectFactsByEntity(facts: MemoryEntry[]): Map<string, Map<string, MemoryEntry>> {
  const byEntity = new Map<string, Map<string, MemoryEntry>>();
  const winnerOrderByEntity = new Map<string, Map<string, number>>();
  for (const [idx, f] of facts.entries()) {
    if (!f.entity?.trim()) continue;
    const canonical = factCanonicalLabel(f);
    if (!canonical) continue;
    const k = (f.key ?? "").trim() || "_body";
    let km = byEntity.get(canonical);
    let winnerOrders = winnerOrderByEntity.get(canonical);
    if (!km) {
      km = new Map();
      byEntity.set(canonical, km);
      winnerOrders = new Map();
      winnerOrderByEntity.set(canonical, winnerOrders);
    }
    if (!winnerOrders) {
      winnerOrders = new Map();
      winnerOrderByEntity.set(canonical, winnerOrders);
    }
    const prev = km.get(k);
    const prevOrder = winnerOrders.get(k) ?? Number.NEGATIVE_INFINITY;
    if (!prev || factNewerThan(f, prev, idx, prevOrder) < 0) {
      km.set(k, f);
      winnerOrders.set(k, idx);
    }
  }
  return byEntity;
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

export function isTerminalFactStatus(raw: string): boolean {
  return TERMINAL.has(raw.trim().toLowerCase());
}
