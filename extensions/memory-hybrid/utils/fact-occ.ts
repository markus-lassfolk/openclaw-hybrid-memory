/**
 * Optimistic concurrency helpers for shared-scope fact writes (#2175 / Epic #2169).
 *
 * Token = sha256 of id + revision_count + normalized_hash.
 * Callers pass `expectedHash` on mutate; mismatch → structured `memory_conflict`.
 */

import { createHash } from "node:crypto";
import type { MemoryScope } from "../types/memory.js";
import { normalizedHash } from "./tags.js";

export const MEMORY_CONFLICT_CODE = "memory_conflict" as const;

export type MemoryConflictDetails = {
  error: typeof MEMORY_CONFLICT_CODE;
  code: typeof MEMORY_CONFLICT_CODE;
  expectedHash: string;
  currentHash: string;
  currentRevision?: number;
  factId?: string;
};

/** Scopes that require OCC when the caller supplies expectedHash (#2175). */
export function isSharedOccScope(scope: MemoryScope | string | null | undefined): boolean {
  return scope === "global" || scope === "user" || scope === "agent";
}

export function hashFactOccToken(parts: {
  id: string;
  revisionCount: number;
  normalizedHash: string;
}): string {
  return createHash("sha256")
    .update(`${parts.id}:${parts.revisionCount}:${parts.normalizedHash}`)
    .digest("hex");
}

/** OCC token for a live MemoryEntry-shaped row (#2175). */
export function occTokenForFact(fact: {
  id: string;
  text: string;
  revisionCount?: number | null;
}): string {
  return hashFactOccToken({
    id: fact.id,
    revisionCount: fact.revisionCount ?? 0,
    normalizedHash: normalizedHash(fact.text),
  });
}

/**
 * Cheap whole-store revision for dream promote OCC (#2170/#2175).
 * Hash of active fact count + max created_at + sample of id:hash pairs.
 */
export function computeInputStoreRevision(
  rows: Array<{ id: string; text: string; revisionCount?: number | null; createdAt?: number }>,
): string {
  const h = createHash("sha256");
  h.update(`count:${rows.length};`);
  let maxCreated = 0;
  for (const row of rows) {
    if (typeof row.createdAt === "number" && row.createdAt > maxCreated) maxCreated = row.createdAt;
  }
  h.update(`maxCreated:${maxCreated};`);
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const sample = sorted.length <= 64 ? sorted : [...sorted.slice(0, 32), ...sorted.slice(-32)];
  for (const row of sample) {
    h.update(occTokenForFact(row));
    h.update(";");
  }
  return h.digest("hex");
}

export function buildMemoryConflictDetails(params: {
  expectedHash: string;
  currentHash: string;
  currentRevision?: number;
  factId?: string;
}): MemoryConflictDetails {
  return {
    error: MEMORY_CONFLICT_CODE,
    code: MEMORY_CONFLICT_CODE,
    expectedHash: params.expectedHash,
    currentHash: params.currentHash,
    currentRevision: params.currentRevision,
    factId: params.factId,
  };
}

export class MemoryConflictError extends Error {
  readonly code = MEMORY_CONFLICT_CODE;
  readonly details: MemoryConflictDetails;

  constructor(details: MemoryConflictDetails) {
    super(
      `memory_conflict: stale base for fact ${details.factId ?? "?"} ` +
        `(expected ${details.expectedHash.slice(0, 8)}…, current ${details.currentHash.slice(0, 8)}…)`,
    );
    this.name = "MemoryConflictError";
    this.details = details;
  }
}
