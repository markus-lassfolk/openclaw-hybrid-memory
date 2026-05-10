import type { MemoryEntry, MemoryScope } from "../types/memory.js";

/**
 * Exact scope matcher used by classify-before-write mutations.
 * - `global` only matches `global` entries.
 * - non-global scopes must match both `scope` and `scopeTarget` exactly.
 */
export function matchesExactScope(entry: Pick<MemoryEntry, "scope" | "scopeTarget">, scope: MemoryScope, scopeTarget: string | null): boolean {
  const entryScope = entry.scope ?? "global";
  const entryScopeTarget = entry.scopeTarget ?? null;
  if (scope === "global") return entryScope === "global";
  return entryScope === scope && entryScopeTarget === scopeTarget;
}

/**
 * Validate a destructive classification target before DELETE/UPDATE.
 * Target must exist, be present in the candidate set given to the classifier,
 * and match the expected scope boundary exactly.
 */
export function validateScopedClassificationTarget(params: {
  targetId: string;
  candidates: ReadonlyArray<{ id: string }>;
  getById: (id: string) => MemoryEntry | null;
  scope: MemoryScope;
  scopeTarget: string | null;
  warn?: (message: string) => void;
  warnMessage: string;
}): MemoryEntry | null {
  const target = params.getById(params.targetId);
  const allowed =
    !!target && params.candidates.some((candidate) => candidate.id === params.targetId) && matchesExactScope(target, params.scope, params.scopeTarget);
  if (!allowed) {
    params.warn?.(params.warnMessage);
    return null;
  }
  return target;
}
