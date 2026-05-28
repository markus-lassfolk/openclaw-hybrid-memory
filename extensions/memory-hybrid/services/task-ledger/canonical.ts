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

/** Deterministic tie-break for two facts with equal createdAt.
 *
 *  Rules:
 *  1. For the `status` key, terminal status wins over non-terminal when timestamps are equal.
 *     This prevents a stale "in_progress" from persisting when a terminal "done"/"closed" update
 *     lands in the same second/millisecond bucket.
 *  2. In all other cases, newer id wins (lexicographic: later ids are "greater").
 *     This gives a stable total order without depending on insertion/iteration order.
 *
 *  Returns a positive number if `b" is preferred (b wins), negative if `a` wins, 0 if identical.
 */
function factTieBreak(a: MemoryEntry, b: MemoryEntry, key: string): number {
  if (a.createdAt === b.createdAt) {
    // Rule 1: status terminal-vs-nonterminal tie-break
    if (key === "status") {
      const aTerminal = isTerminalFactStatus(a.value ?? a.text ?? "") ? 1 : 0;
      const bTerminal = isTerminalFactStatus(b.value ?? b.text ?? "") ? 1 : 0;
      if (aTerminal !== bTerminal) return bTerminal - aTerminal; // terminal (1) wins
    }
    // Rule 2: lexicographic id tie-break (stable, later id = newer fact)
    return b.id.localeCompare(a.id);
  }
  return 0; // caller already compared createdAt; this is only for equal timestamps
}

/** Latest value per entity+key from non-superseded project facts.
 *  Entity labels are normalized via factCanonicalLabel() (provenance-aware + trim + toLowerCase + suffix/separator cleanup)
 *  so that case-variant entries (e.g. "Humanizer" / "humanizer") are merged into one group.
 *
 *  Selection is deterministic: newer createdAt wins, and when timestamps are equal a stable
 *  tie-break (id + status-terminal override for the `status` key) ensures no stale fact
 *  can shadow a newer terminal update.
 */
export function groupProjectFactsByEntity(facts: MemoryEntry[]): Map<string, Map<string, MemoryEntry>> {
  const byEntity = new Map<string, Map<string, MemoryEntry>>();
  for (const f of facts) {
    if (!f.entity?.trim()) continue;
    const canonical = factCanonicalLabel(f);
    if (!canonical) continue;
    const k = (f.key ?? "").trim() || "_body";
    let km = byEntity.get(canonical);
    if (!km) {
      km = new Map();
      byEntity.set(canonical, km);
    }
    const prev = km.get(k);
    if (!prev) {
      km.set(k, f);
    } else if (f.createdAt > prev.createdAt) {
      km.set(k, f);
    } else if (f.createdAt === prev.createdAt) {
      // Same timestamp: apply deterministic tie-break
      const prefer = factTieBreak(prev, f, k);
      if (prefer > 0) {
        km.set(k, f);
      }
      // If prefer <= 0, keep prev (prev is strictly preferred or identical)
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
