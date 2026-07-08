/**
 * Fragment recall UX (#1914): prefer fragment hits over parent docs and hydrate parent context at injection.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry, ScopeFilter, SearchResult } from "../types/memory.js";
import type { VaultHandle } from "./vault-registry.js";

export function resolveFactsDbForEntry(entry: MemoryEntry, defaultDb: FactsDB, vaultHandles?: VaultHandle[]): FactsDB {
  if (!vaultHandles || vaultHandles.length <= 1) return defaultDb;
  for (const handle of vaultHandles) {
    if (handle.factsDb.getById(entry.id)) return handle.factsDb;
  }
  return defaultDb;
}

export function isFragmentEntry(entry: MemoryEntry): boolean {
  return entry.source?.startsWith("fragment-of:") === true || (entry.tags?.includes("fragment") ?? false);
}

export function resolveFragmentParentId(entry: MemoryEntry): string | null {
  if (entry.parentFactId) return entry.parentFactId;
  const match = entry.source?.match(/^fragment-of:(.+)$/);
  return match?.[1]?.trim() || null;
}

/** Drop parent facts when a more specific fragment from the same parent is already ranked. */
export function preferFragmentsOverParents(candidates: SearchResult[]): SearchResult[] {
  const parentsWithFragments = new Set<string>();
  for (const c of candidates) {
    if (!isFragmentEntry(c.entry)) continue;
    const parentId = resolveFragmentParentId(c.entry);
    if (parentId) parentsWithFragments.add(parentId);
  }
  if (parentsWithFragments.size === 0) return candidates;
  return candidates.filter((c) => !parentsWithFragments.has(c.entry.id));
}

/** Text shown in recall / injection when a fragment child is selected. */
export function formatFragmentRecallText(entry: MemoryEntry, parent: MemoryEntry | null, useSummary: boolean): string {
  const body = useSummary && entry.summary?.trim() ? entry.summary : entry.text;
  if (!isFragmentEntry(entry) || !parent) return body;
  const parentTitle = parent.summary?.trim() || parent.text.slice(0, 160).replace(/\s+/g, " ").trim();
  return `[§ ${parentTitle}]\n${body}`;
}

export function resolveRecallInjectionText(
  entry: MemoryEntry,
  factsDb: FactsDB,
  useSummary: boolean,
  scopeFilter?: ScopeFilter | null,
): string {
  if (!isFragmentEntry(entry)) {
    return useSummary && entry.summary?.trim() ? entry.summary : entry.text;
  }
  const parentId = resolveFragmentParentId(entry);
  // SECURITY: getById accepts an optional scopeFilter but returns any tenant's fact when it's
  // omitted — must be threaded through so a fragment's parent hydration can't leak a different
  // tenant's fact text into this caller's recall/injection output.
  const parent = parentId ? factsDb.getById(parentId, { scopeFilter }) : null;
  return formatFragmentRecallText(entry, parent, useSummary);
}

/** Post-process ranked recall: demote parents, optional fragment score boost. */
export function applyFragmentRecallPostProcess(
  candidates: SearchResult[],
  opts?: { fragmentScoreBoost?: number },
): SearchResult[] {
  let results = preferFragmentsOverParents(candidates);
  const boost = opts?.fragmentScoreBoost ?? 1.05;
  if (boost !== 1) {
    results = results.map((r) => (isFragmentEntry(r.entry) ? { ...r, score: r.score * boost } : r));
    results.sort((a, b) => b.score - a.score);
  }
  return results;
}
