/**
 * Shared vector-row id handling for the LanceDB backend.
 *
 * Fact ids stored in LanceDB are not always UUIDs — long-lived stores can contain slug-style
 * ids (e.g. `close-goals-2026-06-27-clean-slate-final-1782588700`) written by callers that pass
 * their own `entry.id`. Historically several VectorDB read/delete/reconcile paths validated ids
 * with a UUID-only regex, which silently dropped or rejected slug rows even though `store()`
 * happily persisted them — producing write-only orphan vectors invisible to diagnostics and
 * repair (#2079). This module centralises the widened validation so every call site agrees on
 * what a valid LanceDB row id looks like.
 */
import { UUID_REGEX } from "./constants.js";

/** Non-UUID ids must still be safe to interpolate into a LanceDB string predicate. */
export const SAFE_SLUG_REGEX = /^[A-Za-z0-9._-]{1,256}$/;

/** True when `id` is either a valid UUID or a safe slug-style id. */
export function isValidVectorId(id: string): boolean {
  const trimmed = String(id).trim();
  if (trimmed === "") return false;
  return UUID_REGEX.test(trimmed) || SAFE_SLUG_REGEX.test(trimmed);
}

/**
 * Normalise an id for storage/comparison. UUIDs are case-insensitive so they are lowercased for
 * canonical matching (matches historical behavior). Slugs are returned trimmed but otherwise
 * byte-identical — existing rows were written as-is, and lowercasing them would make them
 * unmatchable against already-stored data.
 */
export function normalizeVectorId(id: string): string {
  const trimmed = String(id).trim();
  return UUID_REGEX.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** Escape a string for safe interpolation into a LanceDB SQL-like predicate. */
export function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Validate and normalize `id`, then return it as a single-quoted, escaped LanceDB predicate
 * literal. Throws for ids that are empty or fail {@link isValidVectorId} — this is the security
 * boundary before string interpolation (LanceDB predicates have no parameter-binding API).
 */
export function toSafeIdLiteral(id: string): string {
  const normalized = normalizeVectorId(id);
  if (!isValidVectorId(normalized)) {
    throw new Error("Invalid LanceDB row id: must be a UUID or a safe slug (letters, digits, '.', '_', '-')");
  }
  return `'${escapeSqlString(normalized)}'`;
}
