/**
 * Shared filtering/formatting for memory-wiki surfaces (publicArtifacts + workspace mirror).
 */

import type { MemoryEntry } from "../types/memory.js";

export type WikiFactKind = "fact" | "dream-report" | "pattern" | "episode";

export function isCredentialFact(entry: MemoryEntry): boolean {
  return entry.entity?.toLowerCase() === "credentials" || entry.category === "credential";
}

/** Hide internal bookkeeping facts from wiki surfaces. */
export function isInternalWikiArtifact(entry: MemoryEntry): boolean {
  if (entry.tags?.includes("dream-ingester-sentinel")) return true;
  if (entry.entity === "system" && entry.key?.startsWith("dream-ingested-run:")) return true;
  return false;
}

export function isWikiExportableFact(entry: MemoryEntry): boolean {
  return !isCredentialFact(entry) && !isInternalWikiArtifact(entry);
}

export function wikiFactTitle(entry: MemoryEntry): string {
  if (entry.entity && entry.key) return `${entry.entity} / ${entry.key}`;
  if (entry.entity) return entry.entity;
  const first = entry.text.split("\n")[0]?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first || entry.id;
}

export function wikiFactKind(entry: MemoryEntry): WikiFactKind {
  if (entry.source?.startsWith("dream-cycle")) return "dream-report";
  if (entry.category === "meta" && entry.entity === "behavioral-pattern") return "pattern";
  return "fact";
}

export function wikiFactUpdatedIso(entry: MemoryEntry): string {
  const epoch = entry.lastAccessed ?? entry.sourceDate ?? entry.createdAt;
  if (!epoch) return new Date().toISOString();
  try {
    return new Date(epoch * 1000).toISOString();
  } catch {
    return new Date().toISOString();
  }
}
