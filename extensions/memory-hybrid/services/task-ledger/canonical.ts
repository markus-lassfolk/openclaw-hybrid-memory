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

/** Latest value per entity+key from non-superseded project facts.
 *  Entity labels are normalized via factCanonicalLabel() (provenance-aware + trim + toLowerCase + suffix/separator cleanup)
 *  so that case-variant entries (e.g. "Humanizer" / "humanizer") are merged into one group. */
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
    if (!prev || f.createdAt > prev.createdAt) {
      km.set(k, f);
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
