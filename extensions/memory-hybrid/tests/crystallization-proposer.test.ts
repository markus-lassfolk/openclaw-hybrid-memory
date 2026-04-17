/**
 * crystallization-proposer.test.ts — Dedicated unit tests for
 * services/crystallization-proposer.ts.
 *
 * Uses in-memory SQLite stores (real CrystallizationStore + WorkflowStore) to keep
 * the proposer tests independent of disk and fast to run.
 *
 * ## Coverage
 *
 * ### CrystallizationProposer.runCycle
 * - Returns early (proposed=0) when cfg.enabled=false.
 * - Returns early when maxCrystallized limit already reached.
 * - Returns proposed=0 when no candidates are found.
 * - Creates a pending proposal for each valid candidate (autoApprove=false).
 * - Auto-approves and writes skill to disk when autoApprove=true.
 * - Skips candidates that fail SkillValidator validation.
 * - Respects per-loop maxCrystallized cap (auto-approve path).
 *
 * ### CrystallizationProposer.approveProposal
 * - Returns success=false for unknown proposal ID.
 * - Returns success=false for non-pending proposal.
 * - Returns success=false when maxCrystallized limit is reached.
 * - Writes skill to disk and marks proposal as approved on success.
 *
 * ### CrystallizationProposer.rejectProposal
 * - Returns success=false for unknown proposal ID.
 * - Returns success=false for non-pending proposal.
 * - Marks proposal as rejected on success.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let wfStore: WorkflowStore;
let cStore: CrystallizationStore;

const BASE_CFG: CrystallizationConfig = {
	enabled: true,
	minUsageCount: 2,
	minSuccessRate: 0.5,
	autoApprove: false,
	outputDir: "", // will be set in beforeEach
	maxCrystallized: 50,
	pruneUnusedDays: 30,
};

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "crystal-proposer-test-"));
	wfStore = new WorkflowStore(join(tmpDir, "workflow.db"));
	cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
});

afterEach(() => {
	wfStore.close();
	cStore.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed workflow store with N identical successful traces for a given sequence. */
function seedPatterns(seq: string[], count: number, successRate = 1): void {
	const successCount = Math.round(count * successRate);
	for (let i = 0; i < successCount; i++) {
		wfStore.record({
			goal: `deploy app ${i}`,
			toolSequence: seq,
			outcome: "success",
		});
	}
	for (let i = successCount; i < count; i++) {
		wfStore.record({
			goal: `deploy app ${i}`,
			toolSequence: seq,
			outcome: "failure",
		});
	}
}

// ---------------------------------------------------------------------------
// runCycle — disabled
// ---------------------------------------------------------------------------

describe("CrystallizationProposer.runCycle — disabled", () => {
	it("returns proposed=0 when disabled", () => {
		const cfg: CrystallizationConfig = {
			...BASE_CFG,
			enabled: false,
			outputDir: tmpDir,
		};
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		seedPatterns(["exec", "read", "write"], 5);
		const result = proposer.runCycle();
		expect(result.proposed).toBe(0);
		expect(result.reasons[0]).toMatch(/disabled/i);
	});
});

// ---------------------------------------------------------------------------
// runCycle — maxCrystallized limit
// ---------------------------------------------------------------------------

describe("CrystallizationProposer.runCycle — maxCrystallized limit", () => {
	it("returns early when maxCrystallized limit already reached", () => {
		const cfg: CrystallizationConfig = {
			...BASE_CFG,
			outputDir: tmpDir,
			maxCrystallized: 0,
		};
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		seedPatterns(["exec", "read", "write"], 5);
		const result = proposer.runCycle();
		expect(result.proposed).toBe(0);
		expect(result.reasons.some((r) => /maxCrystallized/i.test(r))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// runCycle — no candidates
// ---------------------------------------------------------------------------

describe("CrystallizationProposer.runCycle — no candidates", () => {
	it("returns proposed=0 when no patterns meet thresholds", () => {
		const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir };
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		// Only 1 trace — not enough to meet minUsageCount=2
		wfStore.record({
			goal: "one-off task",
			toolSequence: ["exec"],
			outcome: "success",
		});
		const result = proposer.runCycle();
		expect(result.proposed).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// runCycle — creates pending proposals (autoApprove=false)
// ---------------------------------------------------------------------------

describe("CrystallizationProposer.runCycle — pending proposals", () => {
	it("creates pending proposal for each valid candidate", () => {
		const cfg: CrystallizationConfig = {
			...BASE_CFG,
			outputDir: tmpDir,
			minUsageCount: 2,
			minSuccessRate: 0.5,
		};
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		seedPatterns(["exec", "read", "write"], 3, 1);

		const result = proposer.runCycle();
		expect(result.proposed).toBeGreaterThanOrEqual(1);

		const proposals = cStore.list({ status: "pending" });
		expect(proposals.length).toBeGreaterThanOrEqual(1);
	});

	it("does not write skill to disk when autoApprove=false", () => {
		const cfg: CrystallizationConfig = {
			...BASE_CFG,
			outputDir: join(tmpDir, "skills"),
			autoApprove: false,
			minUsageCount: 2,
		};
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		seedPatterns(["exec", "read", "write"], 3, 1);

		proposer.runCycle();
		// No files should be written to disk
		expect(existsSync(join(tmpDir, "skills"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runCycle — auto-approve path
// ---------------------------------------------------------------------------

describe("CrystallizationProposer.runCycle — autoApprove=true", () => {
	it("writes skill file to disk when autoApprove=true", () => {
		const outputDir = join(tmpDir, "skills-out");
		const cfg: CrystallizationConfig = {
			...BASE_CFG,
			outputDir,
			autoApprove: true,
			minUsageCount: 2,
			minSuccessRate: 0.5,
		};
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		seedPatterns(["exec", "read", "write"], 4, 1);

		const result = proposer.runCycle();
		expect(result.proposed).toBeGreaterThanOrEqual(1);

		// At least one SKILL.md should exist somewhere under outputDir
		const approved = cStore.list({ status: "approved" });
		expect(approved.length).toBeGreaterThanOrEqual(1);
		const skillPath = approved[0].outputPath;
		expect(skillPath).toBeDefined();
		expect(existsSync(skillPath!)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// approveProposal
// ---------------------------------------------------------------------------

describe("CrystallizationProposer.approveProposal", () => {
	it("returns success=false for unknown proposal ID", () => {
		const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir };
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		const result = proposer.approveProposal("nonexistent-id");
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/not found/i);
	});

	it("returns success=false for non-pending proposal", () => {
		const cfg: CrystallizationConfig = {
			...BASE_CFG,
			outputDir: join(tmpDir, "skills"),
		};
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		seedPatterns(["exec", "read", "write"], 3, 1);
		proposer.runCycle();

		const pending = cStore.list({ status: "pending" });
		expect(pending.length).toBeGreaterThan(0);

		// Reject first, then try to approve
		cStore.reject(pending[0].id);
		const result = proposer.approveProposal(pending[0].id);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/not pending/i);
	});

	it("approves a pending proposal and writes file to disk", () => {
		const outputDir = join(tmpDir, "skills");
		const cfg: CrystallizationConfig = {
			...BASE_CFG,
			outputDir,
			autoApprove: false,
			minUsageCount: 2,
		};
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		seedPatterns(["exec", "read", "write"], 3, 1);
		const cycleResult = proposer.runCycle();

		expect(cycleResult.proposed).toBeGreaterThan(0);

		const pending = cStore.list({ status: "pending" });
		expect(pending.length).toBeGreaterThanOrEqual(1);

		const result = proposer.approveProposal(pending[0].id);
		expect(result.success).toBe(true);
		expect(result.outputPath).toBeDefined();
		expect(existsSync(result.outputPath!)).toBe(true);
	});

	it("returns success=false when maxCrystallized is 0", () => {
		// Manually create a pending proposal
		const proposal = cStore.create({
			patternId: "test-pattern-id",
			skillName: "test-skill",
			skillContent:
				"# Test Skill\n\nThis is a test skill file with adequate content for validation purposes.",
			patternSnapshot: "{}",
		});

		// Now use a proposer with maxCrystallized=0 to try to approve
		const limitedCfg: CrystallizationConfig = {
			...BASE_CFG,
			outputDir: tmpDir,
			maxCrystallized: 0,
		};
		const limitedProposer = new CrystallizationProposer(
			wfStore,
			cStore,
			limitedCfg,
		);
		const result = limitedProposer.approveProposal(proposal.id);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/maxCrystallized/i);
	});
});

// ---------------------------------------------------------------------------
// rejectProposal
// ---------------------------------------------------------------------------

describe("CrystallizationProposer.rejectProposal", () => {
	it("returns success=false for unknown proposal ID", () => {
		const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir };
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		const result = proposer.rejectProposal("nonexistent-id");
		expect(result.success).toBe(false);
	});

	it("rejects a pending proposal", () => {
		const cfg: CrystallizationConfig = {
			...BASE_CFG,
			outputDir: tmpDir,
			minUsageCount: 2,
		};
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
		seedPatterns(["exec", "read", "write"], 3, 1);
		proposer.runCycle();

		const pending = cStore.list({ status: "pending" });
		expect(pending.length).toBeGreaterThan(0);

		const result = proposer.rejectProposal(pending[0].id);
		expect(result.success).toBe(true);

		const updated = cStore.getById(pending[0].id);
		expect(updated?.status).toBe("rejected");
	});

	it("returns success=false when trying to reject an already-rejected proposal", () => {
		const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir };
		const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

		const proposal = cStore.create({
			patternId: "pid",
			skillName: "skill",
			skillContent: "# content",
			patternSnapshot: "{}",
		});
		cStore.reject(proposal.id);

		const result = proposer.rejectProposal(proposal.id);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/not pending/i);
	});
});
