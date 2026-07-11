/**
 * Serendipity slot (LIVING-MEMORY.md, staged default-OFF): the "daydreaming" sliver of the
 * living-memory critique. Once per N prompts, one headline joins ambient injection from
 * (a) strong-but-never-recalled graph neighbors of this recall's top results — memories the graph
 * says belong to the current topic but retrieval has never surfaced — falling back to
 * (b) stale-important facts. Exposure is index-only (a 60-char title, never full text), so a
 * serendipitous surfacing doesn't consume the fact's "never recalled" eligibility.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry } from "../types/memory.js";
import { expandGraph, type GraphFactLookup } from "./graph-retrieval.js";

export interface SerendipityPickConfig {
  minLinkStrength: number;
  staleImportanceMin: number;
  staleDays: number;
  hubDegreeCap?: number | null;
  hubScorePenalty?: number | null;
}

export interface SerendipityPick {
  factId: string;
  title: string;
  category: string;
  reason: "graph-neighbor" | "stale-important";
}

// Extends the real expandGraph() contract instead of a hand-copied subset — a prior narrowed
// copy (unknown[] link arrays, no getByIds) silently drifted from GraphFactLookup and could only
// be passed to expandGraph via an `as never` cast, which would have hidden a genuine mismatch.
interface SerendipityFactsDb extends GraphFactLookup {
  getRawDb(): DatabaseSync;
}

function titleOf(entry: MemoryEntry, maxChars = 60): string {
  const collapsed = entry.text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

function weightedRandom<T>(items: Array<{ item: T; weight: number }>, random: () => number): T | null {
  const total = items.reduce((sum, x) => sum + Math.max(0.001, x.weight), 0);
  if (total <= 0 || items.length === 0) return null;
  let roll = random() * total;
  for (const x of items) {
    roll -= Math.max(0.001, x.weight);
    if (roll <= 0) return x.item;
  }
  return items[items.length - 1]?.item ?? null;
}

export function pickSerendipityFact(
  factsDb: SerendipityFactsDb,
  topResults: Array<{ factId: string; score: number; entry: MemoryEntry }>,
  cfg: SerendipityPickConfig,
  opts: {
    scopeFilter?: unknown;
    excludeIds: ReadonlySet<string>;
    nowSec?: number;
    random?: () => number;
  },
): SerendipityPick | null {
  const random = opts.random ?? Math.random;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  // (a) Strong-but-never-recalled graph neighbors of the current results.
  if (topResults.length > 0) {
    try {
      const { results } = expandGraph(factsDb, topResults.slice(0, 3), {
        maxDepth: 1,
        maxExpandedResults: 10,
        scopeFilter: opts.scopeFilter,
        hubDegreeCap: cfg.hubDegreeCap,
        hubScorePenalty: cfg.hubScorePenalty,
      });
      const pool: Array<{ item: SerendipityPick; weight: number }> = [];
      for (const ex of results) {
        if (ex.expansionSource !== "graph" || opts.excludeIds.has(ex.entry.id)) continue;
        if ((ex.entry.recallCount ?? 0) > 0) continue; // "never recalled" is the whole point
        if (ex.entry.supersededAt) continue;
        // Strong meaning-edges only — session adjacency (PRECEDED_BY) is not serendipity.
        const path = ex.linkPath;
        if (path.length === 0) continue;
        if (path.some((step) => step.linkType === "PRECEDED_BY" || step.strength < cfg.minLinkStrength)) continue;
        const linkStrength = Math.min(...path.map((s) => s.strength));
        pool.push({
          item: {
            factId: ex.entry.id,
            title: titleOf(ex.entry),
            category: ex.entry.category,
            reason: "graph-neighbor",
          },
          weight: linkStrength * Math.max(0.1, ex.entry.importance),
        });
      }
      const picked = weightedRandom(pool, random);
      if (picked) return picked;
    } catch {
      /* serendipity is best-effort; fall through to the stale pool */
    }
  }

  // (b) Fallback: stale-important facts (same pool the session-start briefing resurfaces from).
  try {
    const rows = factsDb
      .getRawDb()
      .prepare(
        `SELECT id FROM facts
          WHERE importance >= ? AND superseded_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
            AND COALESCE(last_accessed, created_at) < ?
          ORDER BY importance DESC LIMIT 5`,
      )
      .all(cfg.staleImportanceMin, nowSec, nowSec - cfg.staleDays * 86_400) as Array<{ id: string }>;
    const pool: Array<{ item: SerendipityPick; weight: number }> = [];
    for (const row of rows) {
      if (opts.excludeIds.has(row.id)) continue;
      const entry = factsDb.getById(row.id, opts.scopeFilter ? { scopeFilter: opts.scopeFilter } : undefined);
      if (!entry || entry.supersededAt) continue;
      pool.push({
        item: { factId: entry.id, title: titleOf(entry), category: entry.category, reason: "stale-important" },
        weight: entry.importance,
      });
    }
    return weightedRandom(pool, random);
  } catch {
    return null;
  }
}
