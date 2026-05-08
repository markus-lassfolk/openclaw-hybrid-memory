/**
 * Reflection dedupe corpus hydration: rate limits, checkpoints, lexical fallback (#1229).
 */

import { createHash } from "node:crypto";
import type { FactsDB } from "../backends/facts-db.js";
import type { MemoryEntry } from "../types/memory.js";
import { is403QuotaOrRateLimitLike, is429OrWrapped, parseRetryAfterMs } from "./chat.js";

export const REFLECTION_DEDUPE_CHECKPOINT_VERSION = 1;

/** Resolved maintenance policy for embedding-backed dedupe hydration. */
export interface ReflectionDedupeHydrationResolved {
  /** Max embedding API calls this run (0 = unlimited). */
  maxEmbedsPerRun: number;
  /** Minimum delay between consecutive embedding calls (ms). */
  minIntervalMsBetweenEmbeds: number;
  /** After this many consecutive rate-limit errors, defer remaining rows to a later run. */
  maxConsecutive429BeforeDefer: number;
  /** Base backoff (ms) when rate-limited; combined with Retry-After and exponential growth. */
  baseBackoffMsAfter429: number;
}

export const DEFAULT_REFLECTION_DEDUPE_HYDRATION: ReflectionDedupeHydrationResolved = {
  maxEmbedsPerRun: 800,
  minIntervalMsBetweenEmbeds: 400,
  maxConsecutive429BeforeDefer: 3,
  baseBackoffMsAfter429: 5000,
};

/** Unlimited embed count but still applies interval + 429 backoff (e.g. consolidate CLI). */
export const CONSOLIDATE_REFLECTION_DEDUPE_HYDRATION: ReflectionDedupeHydrationResolved = {
  maxEmbedsPerRun: 0,
  minIntervalMsBetweenEmbeds: 200,
  maxConsecutive429BeforeDefer: 5,
  baseBackoffMsAfter429: 4000,
};

export function resolveReflectionDedupeHydration(
  partial?: Partial<ReflectionDedupeHydrationResolved> | null,
): ReflectionDedupeHydrationResolved {
  const d = DEFAULT_REFLECTION_DEDUPE_HYDRATION;
  return {
    maxEmbedsPerRun:
      partial?.maxEmbedsPerRun !== undefined && Number.isFinite(partial.maxEmbedsPerRun)
        ? Math.max(0, Math.min(2_000_000, Math.floor(partial.maxEmbedsPerRun)))
        : d.maxEmbedsPerRun,
    minIntervalMsBetweenEmbeds:
      partial?.minIntervalMsBetweenEmbeds !== undefined && Number.isFinite(partial.minIntervalMsBetweenEmbeds)
        ? Math.max(0, Math.min(120_000, Math.floor(partial.minIntervalMsBetweenEmbeds)))
        : d.minIntervalMsBetweenEmbeds,
    maxConsecutive429BeforeDefer:
      partial?.maxConsecutive429BeforeDefer !== undefined && Number.isFinite(partial.maxConsecutive429BeforeDefer)
        ? Math.max(1, Math.min(50, Math.floor(partial.maxConsecutive429BeforeDefer)))
        : d.maxConsecutive429BeforeDefer,
    baseBackoffMsAfter429:
      partial?.baseBackoffMsAfter429 !== undefined && Number.isFinite(partial.baseBackoffMsAfter429)
        ? Math.max(500, Math.min(600_000, Math.floor(partial.baseBackoffMsAfter429)))
        : d.baseBackoffMsAfter429,
  };
}

export function isEmbeddingRateLimitError(err: unknown): boolean {
  const e = err instanceof Error ? err : new Error(String(err));
  return is429OrWrapped(e) || is403QuotaOrRateLimitLike(err);
}

export interface DedupeHydrationCheckpoint {
  v: number;
  fp: string;
  model: string;
  /** Progress into the sorted need-embed index list (0 = none done). */
  nextNeedIdx: number;
  updatedAt: number;
}

export function computeDedupeCorpusFingerprint(sortedFactIds: string[], embeddingModelKey: string): string {
  return createHash("sha256")
    .update(`${sortedFactIds.join(",")}|${embeddingModelKey}`)
    .digest("hex")
    .slice(0, 16);
}

export type DedupeCorpusCheckpointKind = "pattern" | "rule" | "meta";

export function dedupeHydrationStateKey(kind: DedupeCorpusCheckpointKind): string {
  switch (kind) {
    case "pattern":
      return "reflection_dedupe_hydration_pattern";
    case "rule":
      return "reflection_dedupe_hydration_rule";
    case "meta":
      return "reflection_dedupe_hydration_meta";
    default:
      return "reflection_dedupe_hydration_pattern";
  }
}

export function readDedupeHydrationCheckpoint(factsDb: FactsDB, stateKey: string): DedupeHydrationCheckpoint | null {
  const raw = factsDb.getMaintenanceState(stateKey);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<DedupeHydrationCheckpoint>;
    if (o.v !== REFLECTION_DEDUPE_CHECKPOINT_VERSION || typeof o.fp !== "string" || typeof o.model !== "string") {
      return null;
    }
    if (typeof o.nextNeedIdx !== "number" || !Number.isFinite(o.nextNeedIdx) || o.nextNeedIdx < 0) return null;
    return {
      v: REFLECTION_DEDUPE_CHECKPOINT_VERSION,
      fp: o.fp,
      model: o.model,
      nextNeedIdx: Math.floor(o.nextNeedIdx),
      updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Math.floor(Date.now() / 1000),
    };
  } catch {
    return null;
  }
}

export function writeDedupeHydrationCheckpoint(
  factsDb: FactsDB,
  stateKey: string,
  cp: Omit<DedupeHydrationCheckpoint, "updatedAt">,
): void {
  const payload: DedupeHydrationCheckpoint = { ...cp, updatedAt: Math.floor(Date.now() / 1000) };
  factsDb.setMaintenanceState(stateKey, JSON.stringify(payload));
}

export function normalizeReflectionDedupeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Cheap lexical near-duplicate check when vector for an existing row is missing (#1229).
 * Uses token Jaccard overlap and normalized substring checks.
 */
export function reflectionLexicalNearDuplicateAgainstFact(
  candidate: string,
  existingText: string,
  tokenJaccardMin = 0.82,
): boolean {
  const nc = normalizeReflectionDedupeText(candidate);
  const ne = normalizeReflectionDedupeText(existingText);
  if (nc.length < 12 || ne.length < 12) return false;
  if (nc === ne) return true;
  if (ne.includes(nc) || nc.includes(ne)) return true;
  const cw = new Set(nc.split(/\s+/).filter((w) => w.length > 1));
  const ew = new Set(ne.split(/\s+/).filter((w) => w.length > 1));
  if (cw.size === 0 || ew.size === 0) return false;
  let inter = 0;
  for (const w of cw) {
    if (ew.has(w)) inter++;
  }
  const union = new Set([...cw, ...ew]).size;
  return union > 0 && inter / union >= tokenJaccardMin;
}
