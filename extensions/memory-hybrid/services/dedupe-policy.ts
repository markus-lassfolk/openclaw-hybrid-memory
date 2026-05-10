import type { DatabaseSync } from "node:sqlite";

import type { StoreConfig, StoreDedupeAction, StoreOverflowAction } from "../config/types/core.js";
import { normalizedHash } from "../utils/tags.js";

export type ResolvedDedupeProfile = {
  sourcePattern: string;
  vectorThreshold?: number;
  lexicalJaccard?: number;
  maxPerDay?: number;
  onDuplicate: StoreDedupeAction;
  boostBy: number;
  /** Behaviour when `maxPerDay` is exceeded (#1194). Default `drop`. */
  onOverflow: StoreOverflowAction;
};

const DEFAULT_PROFILE: ResolvedDedupeProfile = {
  sourcePattern: "<default>",
  vectorThreshold: 0.95,
  lexicalJaccard: 0.9,
  onDuplicate: "skip",
  boostBy: 0.05,
  onOverflow: "drop",
};

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function normalizeProfile(sourcePattern: string, raw?: StoreConfig["defaultProfile"]): Partial<ResolvedDedupeProfile> {
  const partial: Partial<ResolvedDedupeProfile> = { sourcePattern };
  if (typeof raw?.vectorThreshold === "number" && raw.vectorThreshold > 0 && raw.vectorThreshold <= 1) {
    partial.vectorThreshold = raw.vectorThreshold;
  }
  if (typeof raw?.lexicalJaccard === "number" && raw.lexicalJaccard > 0 && raw.lexicalJaccard <= 1) {
    partial.lexicalJaccard = raw.lexicalJaccard;
  }
  if (typeof raw?.maxPerDay === "number" && raw.maxPerDay > 0) {
    partial.maxPerDay = Math.floor(raw.maxPerDay);
  }
  if (raw?.onDuplicate !== undefined) {
    partial.onDuplicate = raw.onDuplicate;
  }
  if (typeof raw?.boostBy === "number" && raw.boostBy > 0) {
    partial.boostBy = Math.min(1, raw.boostBy);
  }
  if (raw?.onOverflow === "drop" || raw?.onOverflow === "evict-lowest-confidence") {
    partial.onOverflow = raw.onOverflow;
  }
  return partial;
}

export function resolveDedupeProfile(source: string | null | undefined, store: StoreConfig): ResolvedDedupeProfile {
  const sourceKey = source?.trim() || "conversation";
  const base = { ...DEFAULT_PROFILE, ...normalizeProfile("<default>", store.defaultProfile) };
  const profiles = store.sourceProfiles ?? {};

  if (profiles[sourceKey]) {
    const normalized = normalizeProfile(sourceKey, profiles[sourceKey]);
    const merged = { ...base, ...normalized };
    // If user configured a source-specific profile without explicit onDuplicate, default to "store"
    if (normalized.onDuplicate === undefined) {
      merged.onDuplicate = "store";
    }
    return merged;
  }

  for (const [pattern, profile] of Object.entries(profiles)) {
    if (!pattern.includes("*")) continue;
    if (globToRegExp(pattern).test(sourceKey)) {
      const normalized = normalizeProfile(pattern, profile);
      const merged = { ...base, ...normalized };
      // If user configured a glob profile without explicit onDuplicate, default to "store"
      if (normalized.onDuplicate === undefined) {
        merged.onDuplicate = "store";
      }
      return merged;
    }
  }

  return base;
}

export function shouldReportVectorDedupeFallback(input: {
  source?: string | null;
  fuzzyDedupe: boolean;
  storeConfig?: StoreConfig;
  embedding?: Float32Array | null;
  vectorCandidates?: ReadonlyArray<{ id: string; score: number }>;
}): boolean {
  if (!input.fuzzyDedupe) return false;
  const profile = resolveDedupeProfile(input.source, input.storeConfig ?? { fuzzyDedupe: input.fuzzyDedupe });
  if (profile.onDuplicate === "store") return false;
  return (
    profile.vectorThreshold != null &&
    profile.vectorThreshold > 0 &&
    profile.vectorThreshold <= 1 &&
    (input.embedding == null || input.embedding.length === 0) &&
    !input.vectorCandidates
  );
}

// ---------------------------------------------------------------------------
// Write-time dedupe (Issue #1194): normalized hash + same-source token Jaccard
// ---------------------------------------------------------------------------

export type DedupeCandidate = {
  text: string;
  source: string;
  category?: string | null;
  entity?: string | null;
  key?: string | null;
  value?: string | null;
};

export type ApplyDedupeContext = {
  db: DatabaseSync;
  nowSec: number;
  fuzzyDedupe: boolean;
  /** When set but no embedding is provided, callers may warn (vector dedupe deferred). */
  embedding?: Float32Array | null;
  /**
   * Pre-computed vector neighbour candidates for the new fact's embedding (#1186, #1194).
   * Callers that have access to the vector backend should populate this so `applyDedupe`
   * can decide vector-side without going async. Each entry is `{id, score}` where `score`
   * is cosine similarity in `[0, 1]` (higher = more similar). Sorted descending is helpful
   * but not required.
   */
  vectorCandidates?: ReadonlyArray<{ id: string; score: number }>;
  /**
   * Emit a warning once per unique key. Used to avoid per-store spam when vector
   * dedupe is configured but callers haven't plumbed `vectorCandidates` yet.
   */
  warnOnce?: (key: string, message: string) => void;
  /** Optional namespace used when constructing warn-once keys (e.g. "reflection"). */
  warnOnceKey?: string;
  /** When true, suppress the vector-candidates-missing warning entirely. */
  suppressVectorFallbackWarning?: boolean;
  warn?: (message: string) => void;
};

export type ApplyDedupeResult =
  | { action: "store" }
  | { action: "skip"; existingId: string; reason?: "exact" | "hash" | "lexical" | "vector" }
  | { action: "boost"; existingId: string; boostBy: number; reason?: "exact" | "hash" | "lexical" | "vector" }
  | { action: "merge"; existingId: string; reason?: "exact" | "hash" | "lexical" | "vector" };

function tokenizeForJaccard(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 1),
  );
}

function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const JACCARD_LOOKBACK_SEC = 120 * 24 * 60 * 60;
const JACCARD_ROW_LIMIT = 200;

/**
 * Decide how a candidate fact should be handled before insert.
 * Side-effect free (no SQL writes).
 */
export function applyDedupe(
  profile: ResolvedDedupeProfile,
  candidate: DedupeCandidate,
  ctx: ApplyDedupeContext,
): ApplyDedupeResult {
  // Issue #1276: project-task facts rely on explicit keys (title/status/next/...)
  // for ACTIVE-TASKS projection. For category=project with entity+key, treat
  // (category, entity, key) as the identity boundary and only dedupe on the same
  // key/value pair, not semantic/text similarity across different keys.
  const category = candidate.category?.trim().toLowerCase();
  const entity = candidate.entity?.trim();
  const key = candidate.key?.trim();
  if (category === "project" && entity && key) {
    const existing = candidate.value != null
      ? (ctx.db
          .prepare(
            "SELECT id FROM facts WHERE category = 'project' AND entity = ? AND key = ? AND value = ? AND superseded_at IS NULL LIMIT 1",
          )
          .get(entity, key, candidate.value) as { id: string } | undefined)
      : (ctx.db
          .prepare(
            "SELECT id FROM facts WHERE category = 'project' AND entity = ? AND key = ? AND text = ? AND superseded_at IS NULL LIMIT 1",
          )
          .get(entity, key, candidate.text) as { id: string } | undefined);
    if (existing) {
      return mapOnDuplicate(profile, existing.id, "exact");
    }
    return { action: "store" };
  }

  const exact = ctx.db
    .prepare("SELECT id FROM facts WHERE text = ? AND source = ? AND superseded_at IS NULL LIMIT 1")
    .get(candidate.text, candidate.source) as { id: string } | undefined;
  if (exact) {
    const mapped = mapOnDuplicate(profile, exact.id, "exact");
    if (mapped.action !== "store") {
      return mapped;
    }
    // onDuplicate=store: allow a second row with identical raw text (fall through).
  }

  if (profile.onDuplicate === "store") {
    return { action: "store" };
  }
  if (!ctx.fuzzyDedupe) {
    return { action: "store" };
  }

  const hash = normalizedHash(candidate.text);
  const hashRow = ctx.db
    .prepare("SELECT id FROM facts WHERE normalized_hash = ? AND source = ? AND superseded_at IS NULL LIMIT 1")
    .get(hash, candidate.source) as { id: string } | undefined;

  if (hashRow) {
    return mapOnDuplicate(profile, hashRow.id, "hash");
  }

  // Vector-side cosine dedupe (#1186, #1194). Caller pre-computes neighbour candidates so
  // `applyDedupe` can stay synchronous while still honouring `profile.vectorThreshold`.
  if (
    profile.vectorThreshold != null &&
    profile.vectorThreshold > 0 &&
    profile.vectorThreshold <= 1 &&
    ctx.vectorCandidates &&
    ctx.vectorCandidates.length > 0
  ) {
    let bestVec: { id: string; score: number } | null = null;
    for (const cand of ctx.vectorCandidates) {
      if (
        typeof cand.score === "number" &&
        cand.score >= profile.vectorThreshold &&
        (bestVec === null || cand.score > bestVec.score)
      ) {
        bestVec = { id: cand.id, score: cand.score };
      }
    }
    if (bestVec) {
      return mapOnDuplicate(profile, bestVec.id, "vector");
    }
  } else if (
    profile.vectorThreshold != null &&
    profile.vectorThreshold > 0 &&
    (ctx.embedding == null || ctx.embedding.length === 0) &&
    !ctx.vectorCandidates
  ) {
    if (!ctx.suppressVectorFallbackWarning) {
      // Caller asked for vector dedupe but supplied neither candidates nor an embedding.
      // (Write-time vector cosine requires caller-supplied `vectorCandidates` because `applyDedupe` is synchronous.)
      const message =
        `memory-hybrid: store dedupe — vectorThreshold=${profile.vectorThreshold} is set but no vector candidates were provided; falling back to lexical-only dedupe.` +
        ` (Hint: plumb vector neighbour candidates into FactsDB.store(..., { vectorCandidates }) to enable synchronous cosine checks.)`;
      const keyBase = (ctx.warnOnceKey?.trim() || profile.sourcePattern).slice(0, 80);
      const warnKey = `store-dedupe-vector-fallback:${keyBase}:${profile.vectorThreshold}`;
      if (ctx.warnOnce) {
        ctx.warnOnce(warnKey, message);
      } else {
        ctx.warn?.(message);
      }
    }
  }

  if (typeof profile.lexicalJaccard === "number" && profile.lexicalJaccard > 0 && profile.lexicalJaccard <= 1) {
    const since = ctx.nowSec - JACCARD_LOOKBACK_SEC;
    const rows = ctx.db
      .prepare(
        `SELECT id, text FROM facts WHERE source = ? AND superseded_at IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(candidate.source, since, JACCARD_ROW_LIMIT) as Array<{ id: string; text: string }>;

    const candTokens = tokenizeForJaccard(candidate.text);
    let best: { id: string; score: number } | null = null;
    for (const row of rows) {
      const score = tokenJaccard(candTokens, tokenizeForJaccard(row.text));
      if (score >= profile.lexicalJaccard && (!best || score > best.score)) {
        best = { id: row.id, score };
      }
    }
    if (best) {
      return mapOnDuplicate(profile, best.id, "lexical");
    }
  }

  return { action: "store" };
}

/**
 * Source-agnostic duplicate probe for callers that omit `source` (e.g. WAL replay, CLI
 * pre-checks that should align with cross-source exact/hash semantics, #1202).
 * Global exact text always counts as duplicate. Hash and lexical paths honour
 * `defaultProfile` / default thresholds via {@link resolveDedupeProfile}(undefined, …).
 */
export function hasGlobalDuplicateProbe(
  db: DatabaseSync,
  text: string,
  opts: { nowSec: number; fuzzyDedupe: boolean; storeConfig?: StoreConfig },
): boolean {
  const rowExact = db.prepare("SELECT id FROM facts WHERE text = ? AND superseded_at IS NULL LIMIT 1").get(text) as
    | { id: string }
    | undefined;
  if (rowExact) return true;

  if (!opts.fuzzyDedupe) return false;

  const profile = resolveDedupeProfile(undefined, opts.storeConfig ?? { fuzzyDedupe: opts.fuzzyDedupe });

  const hash = normalizedHash(text);
  const hashRow = db
    .prepare("SELECT id FROM facts WHERE normalized_hash = ? AND superseded_at IS NULL LIMIT 1")
    .get(hash) as { id: string } | undefined;

  if (hashRow) {
    return mapOnDuplicate(profile, hashRow.id, "hash").action !== "store";
  }

  if (typeof profile.lexicalJaccard === "number" && profile.lexicalJaccard > 0 && profile.lexicalJaccard <= 1) {
    const since = opts.nowSec - JACCARD_LOOKBACK_SEC;
    const rows = db
      .prepare(
        `SELECT id, text FROM facts WHERE superseded_at IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(since, JACCARD_ROW_LIMIT) as Array<{ id: string; text: string }>;

    const candTokens = tokenizeForJaccard(text);
    let best: { id: string; score: number } | null = null;
    for (const row of rows) {
      const score = tokenJaccard(candTokens, tokenizeForJaccard(row.text));
      if (score >= profile.lexicalJaccard && (!best || score > best.score)) {
        best = { id: row.id, score };
      }
    }
    if (best) {
      return mapOnDuplicate(profile, best.id, "lexical").action !== "store";
    }
  }

  return false;
}

function mapOnDuplicate(
  profile: ResolvedDedupeProfile,
  existingId: string,
  reason: "exact" | "hash" | "lexical" | "vector",
): ApplyDedupeResult {
  switch (profile.onDuplicate) {
    case "boost":
      return { action: "boost", existingId, boostBy: profile.boostBy, reason };
    case "merge":
      return { action: "merge", existingId, reason };
    case "skip":
      return { action: "skip", existingId, reason };
    case "store":
      return { action: "store" };
    default:
      return { action: "store" };
  }
}
