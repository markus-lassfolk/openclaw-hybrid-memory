/**
 * RRF Fusion Module (Issue #152).
 *
 * Implements Reciprocal Rank Fusion (Cormack et al., 2009) for combining ranked
 * results from multiple retrieval strategies (semantic, FTS5, graph walk).
 *
 * After fusion, applies post-RRF score adjustments for recency, confidence,
 * and access frequency using fact metadata from the facts table.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A result from one retrieval strategy, with a 1-based rank within that list. */
export interface RankedResult {
	/** UUID of the matching fact. */
	factId: string;
	/** 1-based rank within the strategy's result list (1 = best). */
	rank: number;
	/** Which strategy produced this result. Additional strategies (e.g. multi-model semantic) use string keys. */
	source: "semantic" | "fts5" | "graph" | "aliases" | (string & {});
}

/** A fused result after RRF combining and post-RRF score adjustments. */
export interface FusedResult {
	/** UUID of the fact. */
	factId: string;
	/** Raw RRF score before post-RRF adjustments: Σ 1/(k + rank_i). */
	rrfScore: number;
	/** Which strategies contributed to this result and at what rank. */
	sources: Array<{ strategy: string; rank: number }>;
	/** Final score after post-RRF multipliers (recency, confidence, access frequency). */
	finalScore: number;
}

/**
 * Minimal fact metadata needed for post-RRF adjustments.
 * Matches the subset of MemoryEntry that is always available.
 */
export interface FactMetadata {
	/** Fact UUID. */
	id: string;
	/** Confidence score 0-1. Default 1.0. */
	confidence: number;
	/** Unix epoch seconds when the fact was last accessed. Null if never. */
	lastAccessed?: number | null;
	/** Number of times the fact has been recalled. Default 0. */
	recallCount?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default RRF k constant (Cormack et al., 2009). Higher = less rank-position sensitivity. */
export const RRF_K_DEFAULT = 60;

// ---------------------------------------------------------------------------
// fuseResults
// ---------------------------------------------------------------------------

/**
 * Fuse ranked results from multiple retrieval strategies using Reciprocal Rank Fusion.
 *
 * RRF formula: `score(fact) = Σ 1/(k + rank_i)` summed over all strategies
 * where the fact appears. Facts appearing in multiple strategies receive higher
 * combined scores than those from a single strategy.
 *
 * @param strategyResults - Map from strategy name to its ranked result list.
 *   Each list should already be sorted best-first; rank is assigned by list position.
 * @param k - RRF constant (default 60). Higher = more lenient toward lower-ranked items.
 * @returns Fused results sorted by rrfScore descending. finalScore equals rrfScore
 *   until applyPostRrfAdjustments() is called.
 */
export function fuseResults(
	strategyResults: Map<string, RankedResult[]>,
	k: number = RRF_K_DEFAULT,
): FusedResult[] {
	if (!Number.isFinite(k) || k <= 0) {
		throw new Error(`RRF k must be a positive finite number (got ${k})`);
	}
	// factId -> { rrfScore, sources }
	const accumulator = new Map<
		string,
		{ rrfScore: number; sources: Array<{ strategy: string; rank: number }> }
	>();

	for (const [strategy, results] of strategyResults) {
		for (const result of results) {
			if (!Number.isFinite(result.rank) || result.rank < 1) {
				continue;
			}
			const existing = accumulator.get(result.factId);
			const contribution = 1 / (k + result.rank);
			if (existing) {
				existing.rrfScore += contribution;
				existing.sources.push({ strategy, rank: result.rank });
			} else {
				accumulator.set(result.factId, {
					rrfScore: contribution,
					sources: [{ strategy, rank: result.rank }],
				});
			}
		}
	}

	const fused: FusedResult[] = [];
	for (const [factId, { rrfScore, sources }] of accumulator) {
		fused.push({ factId, rrfScore, sources, finalScore: rrfScore });
	}

	// Sort by RRF score descending
	fused.sort((a, b) => b.rrfScore - a.rrfScore);
	return fused;
}

// ---------------------------------------------------------------------------
// applyPostRrfAdjustments
// ---------------------------------------------------------------------------

/**
 * Apply post-RRF score adjustments to a list of fused results.
 *
 * Adjustments are multiplicative and applied to `rrfScore` to produce `finalScore`:
 *
 * - **Recency**: `score *= 1 + log(days_since_last_access + 1) * -0.01`
 *   Slightly penalises facts that haven't been accessed in a long time.
 *   A fact accessed today has multiplier ≈ 1.0; accessed 30 days ago ≈ 0.965.
 *
 * - **Confidence**: `score *= confidence`
 *   Low-confidence facts are down-weighted proportionally.
 *
 * - **Access frequency**: `score *= 1 + min(recallCount * 0.02, 0.2)`
 *   Facts recalled more often get a small boost (capped at +20%).
 *
 * @param results - Fused results list (mutated in place).
 * @param facts - Map from factId to fact metadata. Facts not found in the map
 *   get neutral adjustments (confidence=1, no recency penalty, no frequency boost).
 * @param nowSec - Current time as Unix epoch seconds (default: Date.now()/1000).
 * @returns The same array, mutated, re-sorted by finalScore descending.
 */
export function applyPostRrfAdjustments(
	results: FusedResult[],
	facts: Map<string, FactMetadata>,
	nowSec: number = Math.floor(Date.now() / 1000),
): FusedResult[] {
	const SECONDS_PER_DAY = 86_400;

	for (const result of results) {
		const fact = facts.get(result.factId);
		let score = result.rrfScore;

		// Recency adjustment
		const lastAccessedRaw = fact?.lastAccessed;
		const lastAccessedSec = Number.isFinite(lastAccessedRaw ?? Number.NaN)
			? (lastAccessedRaw as number)
			: null;
		const daysSince =
			lastAccessedSec != null
				? Math.max(0, (nowSec - lastAccessedSec) / SECONDS_PER_DAY)
				: 0; // no access record → treat as fresh (neutral)
		score *= 1 + Math.log(daysSince + 1) * -0.01;

		// Confidence adjustment
		const confidenceRaw = fact?.confidence;
		const confidence = Number.isFinite(confidenceRaw ?? Number.NaN)
			? (confidenceRaw as number)
			: 1.0;
		score *= Math.max(0, Math.min(1, confidence));

		// Access frequency adjustment
		const rawRecall = fact?.recallCount;
		const recallCount = Number.isFinite(rawRecall ?? Number.NaN)
			? Math.max(0, rawRecall as number)
			: 0;
		score *= 1 + Math.min(recallCount * 0.02, 0.2);

		result.finalScore = score;
	}

	results.sort((a, b) => b.finalScore - a.finalScore);
	return results;
}
