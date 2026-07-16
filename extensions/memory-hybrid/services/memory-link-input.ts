/**
 * Input resolution for the memory_link tool.
 *
 * The OpenClaw plugin runtime does not enforce TypeBox parameter schemas, so a caller that uses
 * natural argument names (`from` / `to` / `type`) instead of the canonical ones reaches the tool
 * body with `sourceFact` / `targetFact` / `linkType` all `undefined`. Those `undefined`s then flowed
 * straight into `factsDb.getById(undefined, …)`, which threw the opaque SQLite error
 * `Provided value cannot be bound to SQLite parameter 1.` (#2139). This helper resolves the common
 * aliases, validates each field, and returns a structured error that names the offending parameter
 * — so the tool never binds a non-string id to SQLite.
 */

import { MEMORY_LINK_TYPES, type MemoryLinkType } from "../backends/facts-db/types.js";

export type ResolvedMemoryLinkInput =
  | { ok: true; sourceFact: string; targetFact: string; linkType: MemoryLinkType; strength: number }
  | { ok: false; error: string };

const SOURCE_KEYS = ["sourceFact", "sourceFactId", "source", "from", "fromFact", "fromId"] as const;
const TARGET_KEYS = ["targetFact", "targetFactId", "target", "to", "toFact", "toId"] as const;
const TYPE_KEYS = ["linkType", "type", "relation", "relationship"] as const;
const STRENGTH_KEYS = ["strength", "weight"] as const;

function firstDefined(params: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    // A blank/whitespace-only canonical key (e.g. a wrapper injecting `sourceFact: ""`) must not
    // shadow a populated alias (`from: "<id>"`) — the whole point of alias resolution (#2139 QA).
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return undefined;
}

export function resolveMemoryLinkInput(params: Record<string, unknown>): ResolvedMemoryLinkInput {
  const rawSource = firstDefined(params, SOURCE_KEYS);
  const sourceFact = typeof rawSource === "string" ? rawSource.trim() : "";
  if (!sourceFact) {
    return {
      ok: false,
      error:
        "sourceFact is required and must be a non-empty fact id string (accepted aliases: sourceFact, source, from)",
    };
  }

  const rawTarget = firstDefined(params, TARGET_KEYS);
  const targetFact = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (!targetFact) {
    return {
      ok: false,
      error:
        "targetFact is required and must be a non-empty fact id string (accepted aliases: targetFact, target, to)",
    };
  }

  const rawType = firstDefined(params, TYPE_KEYS);
  const linkTypeUpper = typeof rawType === "string" ? rawType.trim().toUpperCase() : "";
  if (!linkTypeUpper) {
    return {
      ok: false,
      error: `linkType is required (accepted aliases: linkType, type). Valid types: ${MEMORY_LINK_TYPES.join(", ")}`,
    };
  }
  if (!(MEMORY_LINK_TYPES as readonly string[]).includes(linkTypeUpper)) {
    return {
      ok: false,
      error: `linkType "${linkTypeUpper}" is not a valid link type. Valid types: ${MEMORY_LINK_TYPES.join(", ")}`,
    };
  }
  const linkType = linkTypeUpper as MemoryLinkType;

  const rawStrength = firstDefined(params, STRENGTH_KEYS);
  let strength = 1.0;
  if (rawStrength !== undefined) {
    const parsed = typeof rawStrength === "number" ? rawStrength : Number(rawStrength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return { ok: false, error: `strength must be a finite number in [0, 1]; got ${JSON.stringify(rawStrength)}` };
    }
    strength = parsed;
  }

  return { ok: true, sourceFact, targetFact, linkType, strength };
}
