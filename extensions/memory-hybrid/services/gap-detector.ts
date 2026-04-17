/**
 * Gap Detector — analyses workflow traces to find repeated multi-step workarounds (Issue #210).
 *
 * A "gap" is a recurring pattern where the agent uses 3+ tool calls to achieve
 * what could be a single specialised tool. The gap is scored by:
 *   score = frequency × toolSavings × successRate
 *
 * Examples:
 *  - agent always does [memory_recall, memory_recall, memory_recall] with different
 *    filters → propose `memory_bulk_recall`
 *  - agent always does [exec(grep), exec(sed), exec(grep)] → propose a structured
 *    text-transform tool
 */

import type {
	WorkflowPattern,
	WorkflowStore,
} from "../backends/workflow-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DetectedGap {
	/** Unique deterministic ID derived from the representative tool sequence. */
	id: string;
	/** The repeating tool sequence that reveals the gap. */
	toolSequence: string[];
	/** How many times this pattern has been observed. */
	frequency: number;
	/** Number of tool calls that a single purpose-built tool would save. */
	toolSavings: number;
	/** Observed success rate of the workaround pattern. */
	successRate: number;
	/** Composite score: frequency × toolSavings × successRate. */
	score: number;
	/** Example goals that were accomplished using this pattern. */
	exampleGoals: string[];
	/** Suggested new tool name derived from the pattern. */
	suggestedToolName: string;
}

export interface GapDetectorOptions {
	/** Minimum times a pattern must appear to be a gap (default: 3). */
	minFrequency: number;
	/** Minimum tool calls saved for the gap to be worth proposing (default: 2). */
	minToolSavings: number;
	/** Minimum success rate (0–1) for the workaround to be meaningful (default: 0.5). */
	minSuccessRate: number;
	/** Maximum gaps to return, sorted by score desc (default: 10). */
	limit: number;
}

const DEFAULT_OPTIONS: GapDetectorOptions = {
	minFrequency: 3,
	minToolSavings: 2,
	minSuccessRate: 0.5,
	limit: 10,
};

// ---------------------------------------------------------------------------
// Tool-name derivation helpers
// ---------------------------------------------------------------------------

/** Derive a camel_case tool name from a sequence of tool names.
 *  e.g. ["memory_recall", "memory_recall", "memory_recall"] → "memory_bulk_recall"
 *       ["exec", "exec", "exec"]                            → "exec_batch"
 */
export function deriveToolNameFromSequence(toolSequence: string[]): string {
	if (toolSequence.length === 0) return "memory_custom_tool";

	// Find the most common tool in the sequence
	const freq = new Map<string, number>();
	for (const t of toolSequence) {
		freq.set(t, (freq.get(t) ?? 0) + 1);
	}
	const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
	const dominant = sorted[0][0];
	const dominantCount = sorted[0][1];

	// All the same → bulk / batch variant
	if (dominantCount === toolSequence.length) {
		// e.g. memory_recall x3 → memory_bulk_recall
		return `${dominant}_bulk`;
	}

	// Mixed tools → combine the two most common
	const secondDominant = sorted[1][0];
	// e.g. [memory_recall, exec, memory_recall] → memory_recall_exec
	// e.g. [exec, grep, exec] → exec_grep
	const base = dominant.replace(/^memory_/, "");
	const sec = secondDominant.replace(/^memory_/, "");
	const hasMemoryPrefix =
		dominant.startsWith("memory_") || secondDominant.startsWith("memory_");
	return hasMemoryPrefix ? `memory_${base}_${sec}` : `${base}_${sec}`;
}

// ---------------------------------------------------------------------------
// computeGapId
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export function computeGapId(toolSequence: string[]): string {
	return createHash("sha256")
		.update(JSON.stringify(toolSequence))
		.digest("hex")
		.slice(0, 16);
}

// ---------------------------------------------------------------------------
// GapDetector
// ---------------------------------------------------------------------------

export class GapDetector {
	constructor(private readonly workflowStore: WorkflowStore) {}

	/**
	 * Analyse workflow patterns and return detected gaps.
	 */
	detect(opts?: Partial<GapDetectorOptions>): DetectedGap[] {
		const options: GapDetectorOptions = { ...DEFAULT_OPTIONS, ...opts };

		// Fetch all patterns from WorkflowStore
		const patterns: WorkflowPattern[] = this.workflowStore.getPatterns({
			similarityThreshold: 0.8,
			limit: 500,
		});

		const gaps: DetectedGap[] = [];

		for (const pattern of patterns) {
			const seq = pattern.toolSequence;

			// Must have 3+ tool calls to qualify as a workaround
			if (seq.length < 3) continue;

			// Must meet minimum frequency threshold
			if (pattern.totalCount < options.minFrequency) continue;

			// Must meet minimum success rate
			if (pattern.successRate < options.minSuccessRate) continue;

			// Tool savings = sequence length - 1 (a single tool replaces the whole sequence)
			const toolSavings = seq.length - 1;
			if (toolSavings < options.minToolSavings) continue;

			const score = pattern.totalCount * toolSavings * pattern.successRate;
			const id = computeGapId(seq);

			gaps.push({
				id,
				toolSequence: seq,
				frequency: pattern.totalCount,
				toolSavings,
				successRate: pattern.successRate,
				score,
				exampleGoals: pattern.exampleGoals,
				suggestedToolName: deriveToolNameFromSequence(seq),
			});
		}

		// Sort by score descending
		gaps.sort((a, b) => b.score - a.score);

		return gaps.slice(0, options.limit);
	}
}
