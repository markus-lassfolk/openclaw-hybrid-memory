/**
 * Knowledge Gap Analysis Service (Issue #141).
 *
 * Detects three categories of knowledge gaps in the memory graph:
 *  1. Orphans  — facts with zero inbound or outbound links
 *  2. Weak     — facts with exactly 1 link total (dead ends)
 *  3. Suggested links — semantically similar pairs with no existing link
 *
 * Each gap fact is ranked by age × isolation score so that old, isolated facts
 * bubble to the top (they have been waiting longest for connections).
 */

import type { MemoryEntry } from "../types/memory.js";

// ---------------------------------------------------------------------------
// Minimal interfaces (avoid circular deps — only what the service needs)
// ---------------------------------------------------------------------------

export interface GapFactsDB {
  getAll(options?: { includeSuperseded?: boolean }): MemoryEntry[];
  getLinksFrom(factId: string): Array<{ id: string; targetFactId: string; linkType: string; strength: number }>;
  getLinksTo(factId: string): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }>;
}

export interface GapVectorDB {
  search(vector: number[], limit: number, minScore: number): Promise<Array<{ entry: { id: string }; score: number }>>;
}

export interface GapEmbeddings {
  embed(text: string): Promise<number[]>;
}

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

export type GapMode = "orphans" | "weak" | "all";

/** A fact identified as an orphan (0 links) or weak (1 link). */
export interface GapFact {
  factId: string;
  text: string;
  createdAt: number;
  linkCount: number;
  /** 1.0 for orphan, 0.5 for weak */
  isolationScore: number;
  /** age_factor × isolationScore — higher = more urgently needs a connection */
  rankScore: number;
}

/** A pair of facts that are semantically similar but have no existing link. */
export interface SuggestedLink {
  sourceId: string;
  targetId: string;
  sourceText: string;
  targetText: string;
  similarity: number;
}

export interface KnowledgeGapReport {
  orphans: GapFact[];
  weak: GapFact[];
  suggestedLinks: SuggestedLink[];
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** 30-day period used to normalise age. */
const AGE_UNIT_SEC = 30 * 86_400;

/**
 * Compute isolation score from a link count.
 *  0 links → 1.0 (fully isolated / orphan)
 *  1 link  → 0.5 (weak — dead end)
 *  n links → 1 / (n + 1)  (diminishing isolation)
 */
export function computeIsolationScore(linkCount: number): number {
  if (linkCount === 0) return 1.0;
  if (linkCount === 1) return 0.5;
  return 1 / (linkCount + 1);
}

/**
 * Rank score = age_factor × isolation_score.
 * age_factor = max(1, ageSeconds / AGE_UNIT_SEC) so brand-new facts still score ≥ 1.
 */
export function computeRankScore(createdAt: number, isolationScore: number, nowSec: number): number {
  const ageSeconds = Math.max(0, nowSec - createdAt);
  const ageFactor = Math.max(1, ageSeconds / AGE_UNIT_SEC);
  return ageFactor * isolationScore;
}

// ---------------------------------------------------------------------------
// Core detection functions
// ---------------------------------------------------------------------------

/**
 * Detect orphan facts — facts with zero inbound AND outbound links.
 * Results are ranked by age × isolation score (descending).
 */
export function detectOrphans(
  factsDb: GapFactsDB,
  limit: number,
  nowSec: number,
  linkCounts?: Map<string, number>,
): GapFact[] {
  const facts = factsDb.getAll({ includeSuperseded: false });
  const results: GapFact[] = [];

  for (const fact of facts) {
    const linkCount =
      linkCounts?.get(fact.id) ?? factsDb.getLinksFrom(fact.id).length + factsDb.getLinksTo(fact.id).length;
    if (linkCount === 0) {
      const isolationScore = computeIsolationScore(linkCount);
      results.push({
        factId: fact.id,
        text: fact.text,
        createdAt: fact.createdAt,
        linkCount,
        isolationScore,
        rankScore: computeRankScore(fact.createdAt, isolationScore, nowSec),
      });
    }
  }

  results.sort((a, b) => b.rankScore - a.rankScore);
  return results.slice(0, limit);
}

/**
 * Detect weak-link facts — facts with exactly 1 total link (inbound + outbound).
 * Results are ranked by age × isolation score (descending).
 */
export function detectWeak(
  factsDb: GapFactsDB,
  limit: number,
  nowSec: number,
  linkCounts?: Map<string, number>,
): GapFact[] {
  const facts = factsDb.getAll({ includeSuperseded: false });
  const results: GapFact[] = [];

  for (const fact of facts) {
    const linkCount =
      linkCounts?.get(fact.id) ?? factsDb.getLinksFrom(fact.id).length + factsDb.getLinksTo(fact.id).length;
    if (linkCount === 1) {
      const isolationScore = computeIsolationScore(linkCount);
      results.push({
        factId: fact.id,
        text: fact.text,
        createdAt: fact.createdAt,
        linkCount,
        isolationScore,
        rankScore: computeRankScore(fact.createdAt, isolationScore, nowSec),
      });
    }
  }

  results.sort((a, b) => b.rankScore - a.rankScore);
  return results.slice(0, limit);
}

/**
 * Detect suggested links — semantically similar pairs of facts that currently
 * have no direct link.
 *
 * Strategy (efficient):
 *  1. Consider only orphan and weak-link facts (most in need of connections).
 *  2. For each candidate fact, embed its text and search the vector index.
 *  3. Filter out pairs that already share a direct link.
 *  4. Deduplicate symmetric pairs (A→B and B→A are the same suggestion).
 *  5. Return up to `limit` suggestions sorted by similarity descending.
 *
 * Candidates are ordered by rank score so the most isolated/oldest facts are
 * processed first and hit the `limit` budget first.
 */
export async function detectSuggestedLinks(
  factsDb: GapFactsDB,
  vectorDb: GapVectorDB,
  embeddings: GapEmbeddings,
  threshold: number,
  limit: number,
  nowSec: number,
  linkCounts?: Map<string, number>,
): Promise<SuggestedLink[]> {
  const facts = factsDb.getAll({ includeSuperseded: false });

  // Build a lookup map for fast id → MemoryEntry access.
  const factMap = new Map<string, MemoryEntry>(facts.map((f) => [f.id, f]));

  // Collect orphan + weak candidates and rank them.
  const candidates: Array<{ fact: MemoryEntry; rankScore: number }> = [];
  for (const fact of facts) {
    const linkCount =
      linkCounts?.get(fact.id) ?? factsDb.getLinksFrom(fact.id).length + factsDb.getLinksTo(fact.id).length;
    if (linkCount <= 1) {
      const iso = computeIsolationScore(linkCount);
      candidates.push({
        fact,
        rankScore: computeRankScore(fact.createdAt, iso, nowSec),
      });
    }
  }
  candidates.sort((a, b) => b.rankScore - a.rankScore);

  const suggestions: SuggestedLink[] = [];
  const seenPairs = new Set<string>();

  // Process candidates until we have enough suggestions or run out of candidates.
  const MAX_CANDIDATES = 50; // cap for performance
  for (const { fact } of candidates.slice(0, MAX_CANDIDATES)) {
    if (suggestions.length >= limit) break;

    let vector: number[];
    try {
      vector = await embeddings.embed(fact.text);
    } catch {
      continue; // skip if embedding fails
    }

    // Use the threshold as minScore so the vector DB pre-filters.
    const similar = await vectorDb.search(vector, 10, threshold);

    // Collect this fact's direct neighbours for fast lookup.
    const directNeighbours = new Set<string>();
    for (const l of factsDb.getLinksFrom(fact.id)) directNeighbours.add(l.targetFactId);
    for (const l of factsDb.getLinksTo(fact.id)) directNeighbours.add(l.sourceFactId);

    for (const r of similar) {
      if (suggestions.length >= limit) break;

      const otherId = r.entry.id;
      if (otherId === fact.id) continue;
      if (directNeighbours.has(otherId)) continue;

      // Canonical pair key (order-independent)
      const pairKey = fact.id < otherId ? `${fact.id}:${otherId}` : `${otherId}:${fact.id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const other = factMap.get(otherId);
      if (!other) continue;

      suggestions.push({
        sourceId: fact.id,
        targetId: otherId,
        sourceText: fact.text,
        targetText: other.text,
        similarity: r.score,
      });
    }
  }

  suggestions.sort((a, b) => b.similarity - a.similarity);
  return suggestions.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyse knowledge gaps in the memory graph.
 *
 * @param factsDb   - SQLite facts DB adapter.
 * @param vectorDb  - LanceDB vector search adapter (needed for suggestedLinks).
 * @param embeddings - Embedding provider (needed for suggestedLinks).
 * @param mode      - Which gaps to detect.
 * @param limit     - Max items per category.
 * @param threshold - Minimum cosine similarity for suggested links (default 0.8).
 * @param nowSec    - Current epoch time in seconds (injectable for tests).
 */
export async function analyzeKnowledgeGaps(
  factsDb: GapFactsDB,
  vectorDb: GapVectorDB,
  embeddings: GapEmbeddings,
  mode: GapMode,
  limit: number,
  threshold: number,
  nowSec?: number,
): Promise<KnowledgeGapReport> {
  const now = nowSec ?? Math.floor(Date.now() / 1000);

  let linkCounts: Map<string, number> | undefined;
  if (mode === "all") {
    const facts = factsDb.getAll({ includeSuperseded: false });
    linkCounts = new Map<string, number>();
    for (const fact of facts) {
      const out = factsDb.getLinksFrom(fact.id);
      const inn = factsDb.getLinksTo(fact.id);
      linkCounts.set(fact.id, out.length + inn.length);
    }
  }

  const orphans: GapFact[] = mode === "orphans" || mode === "all" ? detectOrphans(factsDb, limit, now, linkCounts) : [];

  const weak: GapFact[] = mode === "weak" || mode === "all" ? detectWeak(factsDb, limit, now, linkCounts) : [];

  const suggestedLinks: SuggestedLink[] =
    mode === "all" ? await detectSuggestedLinks(factsDb, vectorDb, embeddings, threshold, limit, now, linkCounts) : [];

  return { orphans, weak, suggestedLinks };
}
