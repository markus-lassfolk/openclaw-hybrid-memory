import type { DatabaseSync } from "node:sqlite";

import type { StoreConfig, StoreDedupeAction } from "../config/types/core.js";
import { normalizedHash } from "../utils/tags.js";

export type ResolvedDedupeProfile = {
  sourcePattern: string;
  vectorThreshold?: number;
  lexicalJaccard?: number;
  maxPerDay?: number;
  onDuplicate: StoreDedupeAction;
  boostBy: number;
};

const DEFAULT_PROFILE: ResolvedDedupeProfile = {
  sourcePattern: "<default>",
  vectorThreshold: 0.95,
  lexicalJaccard: 0.9,
  onDuplicate: "skip",
  boostBy: 0.05,
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

// ---------------------------------------------------------------------------
// Write-time dedupe (Issue #1194): normalized hash + same-source token Jaccard
// ---------------------------------------------------------------------------

export type DedupeCandidate = {
  text: string;
  source: string;
};

export type ApplyDedupeContext = {
  db: DatabaseSync;
  nowSec: number;
  fuzzyDedupe: boolean;
  /** When set but no embedding is provided, callers may warn (vector dedupe deferred). */
  embedding?: Float32Array | null;
  warn?: (message: string) => void;
};

export type ApplyDedupeResult =
  | { action: "store" }
  | { action: "skip"; existingId: string }
  | { action: "boost"; existingId: string; boostBy: number }
  | { action: "merge"; existingId: string };

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
  if (
    profile.vectorThreshold != null &&
    profile.vectorThreshold > 0 &&
    (ctx.embedding == null || ctx.embedding.length === 0)
  ) {
    ctx.warn?.(
      `memory-hybrid: store dedupe — vectorThreshold=${profile.vectorThreshold} is set but no pre-store embedding; vector cosine dedupe at write time is not implemented yet (TODO #1194-vector).`,
    );
  }

  const exact = ctx.db
    .prepare("SELECT id FROM facts WHERE text = ? AND superseded_at IS NULL LIMIT 1")
    .get(candidate.text) as { id: string } | undefined;
  if (exact) {
    const mapped = mapOnDuplicate(profile, exact.id);
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
    return mapOnDuplicate(profile, hashRow.id);
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
      return mapOnDuplicate(profile, best.id);
    }
  }

  return { action: "store" };
}

function mapOnDuplicate(profile: ResolvedDedupeProfile, existingId: string): ApplyDedupeResult {
  switch (profile.onDuplicate) {
    case "boost":
      return { action: "boost", existingId, boostBy: profile.boostBy };
    case "merge":
      return { action: "merge", existingId };
    case "skip":
      return { action: "skip", existingId };
    case "store":
      return { action: "store" };
    default:
      return { action: "store" };
  }
}
