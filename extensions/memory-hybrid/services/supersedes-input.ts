/**
 * Normalization for the memory_store `supersedes` argument.
 *
 * The tool schema advertises `supersedes` as a string, but the OpenClaw plugin runtime does not
 * enforce TypeBox schemas at call time, so callers legitimately pass an array of fact ids (a very
 * natural shape when correcting several stale facts at once). Previously that array reached
 * `supersedes.trim()` and threw an opaque `supersedes?.trim is not a function` (#2139). This helper
 * accepts a string, an array of id strings, or nothing, and returns a de-duplicated list of trimmed
 * ids. Any other shape yields a structured error so the tool can reply with a clear validation
 * message instead of a raw JS exception.
 */

export type NormalizedSupersedes = { ok: true; ids: string[] } | { ok: false; error: string };

const EXPECTED = "supersedes must be a fact id string or an array of fact id strings";

export function normalizeSupersedesInput(input: unknown): NormalizedSupersedes {
  if (input == null) return { ok: true, ids: [] };

  if (typeof input === "string") {
    const trimmed = input.trim();
    return { ok: true, ids: trimmed ? [trimmed] : [] };
  }

  if (Array.isArray(input)) {
    const ids: string[] = [];
    for (const element of input) {
      if (typeof element !== "string") {
        const kind = element === null ? "null" : Array.isArray(element) ? "array" : typeof element;
        return { ok: false, error: `${EXPECTED}; got an array containing a ${kind} element` };
      }
      const trimmed = element.trim();
      if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
    }
    return { ok: true, ids };
  }

  return { ok: false, error: `${EXPECTED}; got ${typeof input}` };
}
