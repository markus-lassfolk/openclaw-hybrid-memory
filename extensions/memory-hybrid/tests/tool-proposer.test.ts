/**
 * tool-proposer.test.ts — Dedicated unit tests for services/tool-proposer.ts.
 *
 * Uses mock GapDetector and a disk-backed ToolProposalStore (temp SQLite file under
 * a tmpdir) so ToolProposer is tested in isolation. This complements
 * self-extension.test.ts which uses an integration approach with real databases.
 *
 * ## Coverage
 *
 * ### ToolProposer.runCycle
 * - Returns early when cfg.enabled=false.
 * - Returns early when maxProposals limit already reached.
 * - Returns proposed=0 when no gaps detected.
 * - Creates a proposal for each detected gap.
 * - Skips gaps when a live proposal already exists for that tool name.
 * - Stops when maxProposals is reached mid-cycle.
 * - Passes minGapFrequency and minToolSavings to GapDetector.
 *
 * ### ToolProposer.approveProposal
 * - Returns success=false for unknown proposal ID.
 * - Returns success=false for non-proposed proposal.
 * - Returns success=true and updated proposal on success.
 *
 * ### ToolProposer.rejectProposal
 * - Returns success=false for unknown proposal ID.
 * - Returns success=false for non-proposed proposal.
 * - Returns success=true and updated proposal on success.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { SelfExtensionConfig } from "../config/types/features.js";
import type { DetectedGap, GapDetector } from "../services/gap-detector.js";
import { ToolProposer } from "../services/tool-proposer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let proposalStore: ToolProposalStore;

const ENABLED_CFG: SelfExtensionConfig = {
	enabled: true,
	minGapFrequency: 3,
	minToolSavings: 2,
	maxProposals: 20,
};

const DISABLED_CFG: SelfExtensionConfig = {
	enabled: false,
	minGapFrequency: 3,
	minToolSavings: 2,
	maxProposals: 20,
};

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tool-proposer-test-"));
	proposalStore = new ToolProposalStore(join(tmpDir, "tool-proposals.db"));
});

afterEach(() => {
	proposalStore.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock GapDetector
// ---------------------------------------------------------------------------

function makeMockDetector(gaps: DetectedGap[] = []): GapDetector {
	return {
		detect: vi.fn().mockReturnValue(gaps),
	} as unknown as GapDetector;
}

function makeGap(name: string, score = 5, toolSavings = 2): DetectedGap {
	return {
		id: `gap-${name}`,
		toolSequence: ["exec", "read", "write"],
		frequency: 5,
		toolSavings,
		successRate: 0.8,
		score,
		exampleGoals: [`accomplish ${name}`],
		suggestedToolName: name,
	};
}

// ---------------------------------------------------------------------------
// runCycle — disabled
// ---------------------------------------------------------------------------

describe("ToolProposer.runCycle — disabled", () => {
	it("returns early when disabled", () => {
		const detector = makeMockDetector([makeGap("memory_recall_bulk")]);
		const proposer = new ToolProposer(detector, proposalStore, DISABLED_CFG);
		const result = proposer.runCycle();
		expect(result.proposed).toBe(0);
		expect(result.reasons.some((r) => /disabled/i.test(r))).toBe(true);
		expect(detector.detect).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// runCycle — maxProposals limit already reached
// ---------------------------------------------------------------------------

describe("ToolProposer.runCycle — maxProposals limit", () => {
	it("returns early when maxProposals already reached", () => {
		const cfg: SelfExtensionConfig = { ...ENABLED_CFG, maxProposals: 1 };
		const detector = makeMockDetector([
			makeGap("tool-one"),
			makeGap("tool-two"),
		]);
		const proposer = new ToolProposer(detector, proposalStore, cfg);

		// Pre-fill the store to its cap
		proposalStore.create({
			name: "existing-tool",
			description: "pre-existing proposal",
			parameters: "{}",
			rationale: "reason",
			sourcePatterns: "[]",
			implementationHint: "hint",
		});

		const result = proposer.runCycle();
		expect(result.proposed).toBe(0);
		expect(result.reasons.some((r) => /max pending proposals/i.test(r))).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// runCycle — no gaps
// ---------------------------------------------------------------------------

describe("ToolProposer.runCycle — no gaps", () => {
	it("returns proposed=0 when no gaps detected", () => {
		const detector = makeMockDetector([]);
		const proposer = new ToolProposer(detector, proposalStore, ENABLED_CFG);
		const result = proposer.runCycle();
		expect(result.proposed).toBe(0);
		expect(result.reasons.some((r) => /no actionable gaps/i.test(r))).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// runCycle — creates proposals
// ---------------------------------------------------------------------------

describe("ToolProposer.runCycle — creates proposals", () => {
	it("creates a proposal for each detected gap", () => {
		const detector = makeMockDetector([
			makeGap("memory_recall_bulk"),
			makeGap("exec_batch"),
		]);
		const proposer = new ToolProposer(detector, proposalStore, ENABLED_CFG);
		const result = proposer.runCycle();
		expect(result.proposed).toBe(2);
		expect(result.proposals.length).toBe(2);
		expect(proposalStore.count("proposed")).toBe(2);
	});

	it("proposal has name, description, rationale, parameters, implementationHint", () => {
		const detector = makeMockDetector([makeGap("memory_recall_bulk", 10, 3)]);
		const proposer = new ToolProposer(detector, proposalStore, ENABLED_CFG);
		const result = proposer.runCycle();
		expect(result.proposals.length).toBe(1);
		const p = result.proposals[0];
		expect(p.name).toBe("memory_recall_bulk");
		expect(p.description.length).toBeGreaterThan(0);
		expect(p.rationale.length).toBeGreaterThan(0);
		expect(p.implementationHint.length).toBeGreaterThan(0);
		expect(JSON.parse(p.parameters)).toBeDefined();
	});

	it("passes config thresholds to detector", () => {
		const cfg: SelfExtensionConfig = {
			...ENABLED_CFG,
			minGapFrequency: 7,
			minToolSavings: 4,
		};
		const detector = makeMockDetector([]);
		const proposer = new ToolProposer(detector, proposalStore, cfg);
		proposer.runCycle();
		const callArg = (detector.detect as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(callArg.minFrequency).toBe(7);
		expect(callArg.minToolSavings).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// runCycle — skip duplicates
// ---------------------------------------------------------------------------

describe("ToolProposer.runCycle — skip duplicates", () => {
	it("skips gap when live proposal already exists for that tool name", () => {
		proposalStore.create({
			name: "memory_recall_bulk",
			description: "existing",
			parameters: "{}",
			rationale: "reason",
			sourcePatterns: "[]",
			implementationHint: "hint",
		});

		const detector = makeMockDetector([makeGap("memory_recall_bulk")]);
		const proposer = new ToolProposer(detector, proposalStore, ENABLED_CFG);
		const result = proposer.runCycle();
		expect(result.proposed).toBe(0);
		expect(result.skipped).toBe(1);
		expect(result.reasons.some((r) => /already exists/i.test(r))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// runCycle — stops at maxProposals mid-cycle
// ---------------------------------------------------------------------------

describe("ToolProposer.runCycle — stops at maxProposals mid-cycle", () => {
	it("stops proposing once maxProposals is reached", () => {
		const cfg: SelfExtensionConfig = { ...ENABLED_CFG, maxProposals: 1 };
		const detector = makeMockDetector([
			makeGap("tool-a"),
			makeGap("tool-b"),
			makeGap("tool-c"),
		]);
		const proposer = new ToolProposer(detector, proposalStore, cfg);
		const result = proposer.runCycle();
		expect(result.proposed).toBe(1);
		expect(result.skipped).toBeGreaterThanOrEqual(1);
		expect(proposalStore.count("proposed")).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// approveProposal
// ---------------------------------------------------------------------------

describe("ToolProposer.approveProposal", () => {
	it("returns success=false for unknown proposal ID", () => {
		const proposer = new ToolProposer(
			makeMockDetector(),
			proposalStore,
			ENABLED_CFG,
		);
		const result = proposer.approveProposal("nonexistent-id");
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/not found/i);
	});

	it("returns success=false for non-proposed status", () => {
		const proposal = proposalStore.create({
			name: "test-tool",
			description: "desc",
			parameters: "{}",
			rationale: "r",
			sourcePatterns: "[]",
			implementationHint: "hint",
		});
		proposalStore.updateStatus(proposal.id, "rejected", "proposed");

		const proposer = new ToolProposer(
			makeMockDetector(),
			proposalStore,
			ENABLED_CFG,
		);
		const result = proposer.approveProposal(proposal.id);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/already rejected/i);
	});

	it("returns success=true and updated proposal on valid approval", () => {
		const proposal = proposalStore.create({
			name: "my-tool",
			description: "desc",
			parameters: "{}",
			rationale: "r",
			sourcePatterns: "[]",
			implementationHint: "hint",
		});

		const proposer = new ToolProposer(
			makeMockDetector(),
			proposalStore,
			ENABLED_CFG,
		);
		const result = proposer.approveProposal(proposal.id);
		expect(result.success).toBe(true);
		expect(result.proposal?.status).toBe("approved");
	});
});

// ---------------------------------------------------------------------------
// rejectProposal
// ---------------------------------------------------------------------------

describe("ToolProposer.rejectProposal", () => {
	it("returns success=false for unknown proposal ID", () => {
		const proposer = new ToolProposer(
			makeMockDetector(),
			proposalStore,
			ENABLED_CFG,
		);
		const result = proposer.rejectProposal("nonexistent-id");
		expect(result.success).toBe(false);
	});

	it("returns success=false for non-proposed status", () => {
		const proposal = proposalStore.create({
			name: "existing-tool",
			description: "desc",
			parameters: "{}",
			rationale: "r",
			sourcePatterns: "[]",
			implementationHint: "hint",
		});
		proposalStore.updateStatus(proposal.id, "approved", "proposed");

		const proposer = new ToolProposer(
			makeMockDetector(),
			proposalStore,
			ENABLED_CFG,
		);
		const result = proposer.rejectProposal(proposal.id);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/already approved/i);
	});

	it("returns success=true and rejected proposal on valid rejection", () => {
		const proposal = proposalStore.create({
			name: "reject-me",
			description: "desc",
			parameters: "{}",
			rationale: "r",
			sourcePatterns: "[]",
			implementationHint: "hint",
		});

		const proposer = new ToolProposer(
			makeMockDetector(),
			proposalStore,
			ENABLED_CFG,
		);
		const result = proposer.rejectProposal(proposal.id);
		expect(result.success).toBe(true);
		expect(result.proposal?.status).toBe("rejected");
	});
});
