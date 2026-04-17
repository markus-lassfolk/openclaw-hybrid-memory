/**
 * Tool Proposer — generates tool proposals from detected gaps (Issue #210).
 *
 * Takes DetectedGap objects from GapDetector and generates structured ToolProposal
 * specifications. Proposals are stored in ToolProposalStore; they are SPECIFICATIONS
 * only — no code is generated. Implementation is left to humans or LLMs.
 */

import type {
	ToolProposal,
	ToolProposalStore,
} from "../backends/tool-proposal-store.js";
import type { SelfExtensionConfig } from "../config/types/features.js";
import type {
	DetectedGap,
	GapDetector,
	GapDetectorOptions,
} from "./gap-detector.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface ProposeCycleResult {
	proposed: number;
	skipped: number;
	reasons: string[];
	proposals: ToolProposal[];
}

// ---------------------------------------------------------------------------
// Parameter schema generation
// ---------------------------------------------------------------------------

/**
 * Generate a minimal JSON Schema for the proposed tool parameters based on
 * the tool sequence it replaces. This is a heuristic sketch — not a formal spec.
 */
function generateParameterSchema(gap: DetectedGap): string {
	const params: Record<string, { type: string; description: string }> = {};

	// Always include the goal the tool should accomplish
	params.goal = {
		type: "string",
		description:
			"What you want to accomplish (replaces the multi-step workflow).",
	};

	// If the sequence contains memory_recall-like tools, add a query param
	const hasMemoryTools = gap.toolSequence.some((t) => t.startsWith("memory_"));
	if (hasMemoryTools) {
		params.queries = {
			type: "array",
			description: "List of search queries to run in one batch call.",
		};
	}

	// If the sequence contains exec calls, add a commands param
	const hasExec = gap.toolSequence.some((t) => t === "exec");
	if (hasExec) {
		params.commands = {
			type: "array",
			description: "List of shell commands to execute in sequence.",
		};
	}

	return JSON.stringify({ type: "object", properties: params }, null, 2);
}

// ---------------------------------------------------------------------------
// Implementation hint generation
// ---------------------------------------------------------------------------

/**
 * Generate a plain-English implementation sketch for the proposed tool.
 */
function generateImplementationHint(gap: DetectedGap): string {
	const unique = [...new Set(gap.toolSequence)];
	const lines: string[] = [
		`This tool replaces the recurring ${gap.toolSequence.length}-step workflow: [${gap.toolSequence.join(" → ")}].`,
		"",
		"Implementation sketch:",
		"1. Accept a goal/query parameter and any tool-specific inputs (see parameters schema).",
		`2. Internally call the following tools in sequence: ${unique.join(", ")}.`,
		"3. Merge and deduplicate results before returning.",
		`4. Return a single consolidated response instead of ${gap.toolSequence.length} separate calls.`,
		"",
		`Observed success rate: ${Math.round(gap.successRate * 100)}% across ${gap.frequency} executions.`,
		`Estimated tool-call savings: ${gap.toolSavings} calls per invocation.`,
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rationale generation
// ---------------------------------------------------------------------------

function generateRationale(gap: DetectedGap): string {
	const goalExamples =
		gap.exampleGoals.length > 0
			? `\nExample goals where this pattern appeared:\n${gap.exampleGoals.map((g) => `  - "${g}"`).join("\n")}`
			: "";

	return `The agent repeatedly uses [${gap.toolSequence.join(" → ")}] (${gap.frequency} times, ${Math.round(gap.successRate * 100)}% success rate) to achieve what could be a single tool call. A purpose-built tool would save ${gap.toolSavings} tool calls per invocation.${goalExamples}`;
}

// ---------------------------------------------------------------------------
// ToolProposer
// ---------------------------------------------------------------------------

export class ToolProposer {
	constructor(
		private readonly gapDetector: GapDetector,
		private readonly proposalStore: ToolProposalStore,
		private readonly cfg: SelfExtensionConfig,
	) {}

	/**
	 * Run a full detection + proposal cycle.
	 * Returns a summary of what was proposed and what was skipped.
	 */
	runCycle(opts?: Partial<GapDetectorOptions>): ProposeCycleResult {
		const result: ProposeCycleResult = {
			proposed: 0,
			skipped: 0,
			reasons: [],
			proposals: [],
		};

		if (!this.cfg.enabled) {
			result.reasons.push(
				"Self-extension is disabled (selfExtension.enabled = false).",
			);
			return result;
		}

		// Check max pending proposals cap
		const currentCount = this.proposalStore.count("proposed");
		if (currentCount >= this.cfg.maxProposals) {
			result.reasons.push(
				`Max pending proposals reached (${currentCount}/${this.cfg.maxProposals}). Approve or reject existing proposals first.`,
			);
			return result;
		}

		// Detect gaps using config thresholds
		const detectorOpts: Partial<GapDetectorOptions> = {
			minFrequency: this.cfg.minGapFrequency,
			minToolSavings: this.cfg.minToolSavings,
		};
		const gaps = this.gapDetector.detect({ ...detectorOpts, ...opts });

		for (const gap of gaps) {
			const remaining =
				this.cfg.maxProposals - this.proposalStore.count("proposed");
			if (remaining <= 0) {
				result.skipped++;
				result.reasons.push(
					`Skipped gap "${gap.suggestedToolName}" — max proposals reached.`,
				);
				continue;
			}

			// Skip if a live proposal already exists for this tool name
			if (this.proposalStore.existsByName(gap.suggestedToolName)) {
				result.skipped++;
				result.reasons.push(
					`Skipped gap "${gap.suggestedToolName}" — active proposal already exists for this tool name.`,
				);
				continue;
			}

			const proposal = this.proposalStore.create({
				name: gap.suggestedToolName,
				description: `A single tool that consolidates the [${gap.toolSequence.join(" → ")}] workflow pattern.`,
				parameters: generateParameterSchema(gap),
				rationale: generateRationale(gap),
				sourcePatterns: JSON.stringify([gap.id]),
				implementationHint: generateImplementationHint(gap),
			});

			result.proposed++;
			result.proposals.push(proposal);
			result.reasons.push(
				`Proposed "${gap.suggestedToolName}" (gap score: ${gap.score.toFixed(2)}, saves ${gap.toolSavings} tool calls).`,
			);
		}

		if (gaps.length === 0) {
			result.reasons.push(
				"No actionable gaps detected in current workflow traces.",
			);
		}

		return result;
	}

	/**
	 * Approve a pending proposal (marks it as approved).
	 */
	approveProposal(id: string): {
		success: boolean;
		message: string;
		proposal?: ToolProposal;
	} {
		const proposal = this.proposalStore.getById(id);
		if (!proposal) {
			return { success: false, message: `Proposal "${id}" not found.` };
		}
		if (proposal.status !== "proposed") {
			return {
				success: false,
				message: `Proposal "${id}" is already ${proposal.status} — cannot approve.`,
			};
		}
		const updated = this.proposalStore.updateStatus(id, "approved", "proposed");
		if (!updated) {
			return {
				success: false,
				message: `Proposal "${id}" status changed concurrently — cannot approve.`,
			};
		}
		return {
			success: true,
			message: `Proposal "${proposal.name}" approved. Mark as implemented when the tool is built.`,
			proposal: updated,
		};
	}

	/**
	 * Reject a pending proposal (marks it as rejected).
	 */
	rejectProposal(id: string): {
		success: boolean;
		message: string;
		proposal?: ToolProposal;
	} {
		const proposal = this.proposalStore.getById(id);
		if (!proposal) {
			return { success: false, message: `Proposal "${id}" not found.` };
		}
		if (proposal.status !== "proposed") {
			return {
				success: false,
				message: `Proposal "${id}" is already ${proposal.status} — cannot reject.`,
			};
		}
		const updated = this.proposalStore.updateStatus(id, "rejected", "proposed");
		if (!updated) {
			return {
				success: false,
				message: `Proposal "${id}" status changed concurrently — cannot reject.`,
			};
		}
		return {
			success: true,
			message: `Proposal "${proposal.name}" rejected.`,
			proposal: updated,
		};
	}
}
