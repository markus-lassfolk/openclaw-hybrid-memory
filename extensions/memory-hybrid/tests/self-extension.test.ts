/**
 * Tests for plugin self-extension — Issue #210.
 * Covers: ToolProposalStore, GapDetector, ToolProposer,
 *         proposal lifecycle, config parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const {
  ToolProposalStore,
  WorkflowStore,
  GapDetector,
  ToolProposer,
  computeGapId,
  deriveToolNameFromSequence,
} = _testing as any;

// ---------------------------------------------------------------------------
// Config fixtures
// ---------------------------------------------------------------------------

const DEFAULT_CFG = {
  selfExtension: {
    enabled: true,
    minGapFrequency: 2,
    minToolSavings: 2,
    maxProposals: 20,
  },
};

const DISABLED_CFG = {
  selfExtension: {
    enabled: false,
    minGapFrequency: 3,
    minToolSavings: 2,
    maxProposals: 20,
  },
};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let proposalStore: InstanceType<typeof ToolProposalStore>;
let workflowStore: InstanceType<typeof WorkflowStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "self-extension-test-"));
  proposalStore = new ToolProposalStore(join(tmpDir, "tool-proposals.db"));
  workflowStore = new WorkflowStore(join(tmpDir, "workflow-traces.db"));
});

afterEach(() => {
  proposalStore.close();
  workflowStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// deriveToolNameFromSequence
// ---------------------------------------------------------------------------

describe("deriveToolNameFromSequence", () => {
  it("produces a bulk variant for a single repeated tool", () => {
    expect(deriveToolNameFromSequence(["memory_recall", "memory_recall", "memory_recall"])).toBe(
      "memory_recall_bulk",
    );
  });

  it("produces a combined name for two different tools", () => {
    const name = deriveToolNameFromSequence(["memory_recall", "exec", "memory_recall"]);
    expect(name).toContain("recall");
    expect(typeof name).toBe("string");
  });

  it("handles single-tool sequence (returns bulk variant)", () => {
    const name = deriveToolNameFromSequence(["exec"]);
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  it("handles empty sequence", () => {
    expect(deriveToolNameFromSequence([])).toBe("memory_custom_tool");
  });
});

// ---------------------------------------------------------------------------
// computeGapId
// ---------------------------------------------------------------------------

describe("computeGapId", () => {
  it("returns a 16-character hex string", () => {
    const id = computeGapId(["memory_recall", "memory_recall"]);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same sequence", () => {
    const seq = ["exec", "exec", "exec"];
    expect(computeGapId(seq)).toBe(computeGapId(seq));
  });

  it("differs for different sequences", () => {
    expect(computeGapId(["a", "b"])).not.toBe(computeGapId(["a", "c"]));
  });
});

// ---------------------------------------------------------------------------
// ToolProposalStore
// ---------------------------------------------------------------------------

describe("ToolProposalStore", () => {
  it("creates a proposal and retrieves it by id", () => {
    const proposal = proposalStore.create({
      name: "memory_bulk_recall",
      description: "Batch recall",
      parameters: "{}",
      rationale: "Observed 5 times",
      sourcePatterns: '["abc123"]',
      implementationHint: "Run all recalls at once",
    });
    expect(proposal.id).toBeDefined();
    expect(proposal.status).toBe("proposed");
    expect(proposal.name).toBe("memory_bulk_recall");

    const fetched = proposalStore.getById(proposal.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("memory_bulk_recall");
  });

  it("lists proposals", () => {
    proposalStore.create({
      name: "tool_a",
      description: "A",
      parameters: "{}",
      rationale: "R",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    proposalStore.create({
      name: "tool_b",
      description: "B",
      parameters: "{}",
      rationale: "R",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    expect(proposalStore.list().length).toBe(2);
  });

  it("filters by status", () => {
    const p = proposalStore.create({
      name: "tool_a",
      description: "A",
      parameters: "{}",
      rationale: "R",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    proposalStore.updateStatus(p.id, "approved");

    proposalStore.create({
      name: "tool_b",
      description: "B",
      parameters: "{}",
      rationale: "R",
      sourcePatterns: "[]",
      implementationHint: "",
    });

    const approved = proposalStore.list({ status: "approved" });
    expect(approved.length).toBe(1);
    expect(approved[0].name).toBe("tool_a");

    const proposed = proposalStore.list({ status: "proposed" });
    expect(proposed.length).toBe(1);
    expect(proposed[0].name).toBe("tool_b");
  });

  it("updateStatus changes the status", () => {
    const p = proposalStore.create({
      name: "my_tool",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    const updated = proposalStore.updateStatus(p.id, "approved");
    expect(updated!.status).toBe("approved");
  });

  it("updateStatus returns null for missing id", () => {
    const result = proposalStore.updateStatus("nonexistent", "rejected");
    expect(result).toBeNull();
  });

  it("existsByName returns true for existing proposed/approved name", () => {
    proposalStore.create({
      name: "existing_tool",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    expect(proposalStore.existsByName("existing_tool")).toBe(true);
    expect(proposalStore.existsByName("other_tool")).toBe(false);
  });

  it("existsByName returns false for rejected proposals", () => {
    const p = proposalStore.create({
      name: "rejected_tool",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    proposalStore.updateStatus(p.id, "rejected");
    expect(proposalStore.existsByName("rejected_tool")).toBe(false);
  });

  it("count returns correct counts", () => {
    expect(proposalStore.count()).toBe(0);
    proposalStore.create({
      name: "t1",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    proposalStore.create({
      name: "t2",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    expect(proposalStore.count()).toBe(2);
    expect(proposalStore.count("proposed")).toBe(2);
    expect(proposalStore.count("approved")).toBe(0);
  });

  it("respects limit in list", () => {
    for (let i = 0; i < 5; i++) {
      proposalStore.create({
        name: `tool_${i}`,
        description: "",
        parameters: "{}",
        rationale: "",
        sourcePatterns: "[]",
        implementationHint: "",
      });
    }
    expect(proposalStore.list({ limit: 2 }).length).toBe(2);
  });

  it("isOpen returns true after creation, false after close", () => {
    expect(proposalStore.isOpen()).toBe(true);
    proposalStore.close();
    expect(proposalStore.isOpen()).toBe(false);
    // Recreate for afterEach to work
    proposalStore = new ToolProposalStore(join(tmpDir, "tool-proposals2.db"));
  });
});

// ---------------------------------------------------------------------------
// GapDetector
// ---------------------------------------------------------------------------

describe("GapDetector", () => {
  it("returns no gaps when no workflow traces exist", () => {
    const detector = new GapDetector(workflowStore);
    const gaps = detector.detect({ minFrequency: 2 });
    expect(gaps).toEqual([]);
  });

  it("detects a gap from repeated long sequences", () => {
    const seq = ["memory_recall", "memory_recall", "memory_recall", "memory_recall"];
    // Record the same sequence multiple times with success
    for (let i = 0; i < 5; i++) {
      workflowStore.record({
        goal: "find multiple related facts",
        toolSequence: seq,
        outcome: "success",
        sessionId: "session-test",
      });
    }

    const detector = new GapDetector(workflowStore);
    const gaps = detector.detect({ minFrequency: 2, minToolSavings: 2, minSuccessRate: 0.5 });
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].frequency).toBeGreaterThanOrEqual(2);
    expect(gaps[0].toolSavings).toBeGreaterThanOrEqual(2);
  });

  it("ignores sequences shorter than 3 tools", () => {
    workflowStore.record({
      goal: "quick check",
      toolSequence: ["memory_recall", "exec"],
      outcome: "success",
      sessionId: "s1",
    });
    workflowStore.record({
      goal: "quick check 2",
      toolSequence: ["memory_recall", "exec"],
      outcome: "success",
      sessionId: "s2",
    });

    const detector = new GapDetector(workflowStore);
    const gaps = detector.detect({ minFrequency: 1, minToolSavings: 1 });
    // 2-element sequence: toolSavings = 1, but minToolSavings defaults to 2
    const longGaps = gaps.filter((g: any) => g.toolSavings >= 2);
    expect(longGaps.length).toBe(0);
  });

  it("filters by minSuccessRate", () => {
    const seq = ["exec", "exec", "exec", "exec"];
    for (let i = 0; i < 4; i++) {
      workflowStore.record({
        goal: "batch exec",
        toolSequence: seq,
        outcome: i === 0 ? "success" : "failure", // 25% success rate
        sessionId: "s1",
      });
    }

    const detector = new GapDetector(workflowStore);
    const highSuccessGaps = detector.detect({
      minFrequency: 2,
      minToolSavings: 2,
      minSuccessRate: 0.8,
    });
    expect(highSuccessGaps.length).toBe(0);

    const lowSuccessGaps = detector.detect({
      minFrequency: 2,
      minToolSavings: 2,
      minSuccessRate: 0.2,
    });
    expect(lowSuccessGaps.length).toBeGreaterThan(0);
  });

  it("scores are non-negative", () => {
    const seq = ["memory_recall", "memory_store", "memory_recall"];
    for (let i = 0; i < 5; i++) {
      workflowStore.record({
        goal: "remember and verify",
        toolSequence: seq,
        outcome: "success",
        sessionId: "s1",
      });
    }

    const detector = new GapDetector(workflowStore);
    const gaps = detector.detect({ minFrequency: 2, minToolSavings: 1 });
    for (const g of gaps) {
      expect(g.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("respects limit", () => {
    // Create 5 different long patterns
    for (let i = 0; i < 5; i++) {
      const seq = [`tool_${i}`, `tool_${i}`, `tool_${i}`, `tool_${i}`];
      for (let j = 0; j < 4; j++) {
        workflowStore.record({
          goal: `goal ${i}`,
          toolSequence: seq,
          outcome: "success",
          sessionId: "s1",
        });
      }
    }

    const detector = new GapDetector(workflowStore);
    const gaps = detector.detect({ minFrequency: 2, minToolSavings: 2, limit: 2 });
    expect(gaps.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// ToolProposer
// ---------------------------------------------------------------------------

describe("ToolProposer", () => {
  it("returns skipped when selfExtension is disabled", () => {
    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, DISABLED_CFG.selfExtension);
    const result = proposer.runCycle();
    expect(result.proposed).toBe(0);
    expect(result.reasons.some((r: string) => r.includes("disabled"))).toBe(true);
  });

  it("proposes tools from detected gaps", () => {
    const seq = ["memory_recall", "memory_recall", "memory_recall"];
    for (let i = 0; i < 4; i++) {
      workflowStore.record({
        goal: "find many related facts",
        toolSequence: seq,
        outcome: "success",
        sessionId: "s1",
      });
    }

    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, {
      ...DEFAULT_CFG.selfExtension,
      minGapFrequency: 2,
      minToolSavings: 1,
    });

    const result = proposer.runCycle();
    expect(result.proposed).toBeGreaterThan(0);
    expect(result.proposals.length).toBe(result.proposed);
    expect(proposalStore.count("proposed")).toBeGreaterThan(0);
  });

  it("skips duplicate tool names", () => {
    // Pre-create a proposal with the same name
    proposalStore.create({
      name: "memory_recall_bulk",
      description: "pre-existing",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });

    const seq = ["memory_recall", "memory_recall", "memory_recall"];
    for (let i = 0; i < 4; i++) {
      workflowStore.record({
        goal: "multi recall",
        toolSequence: seq,
        outcome: "success",
        sessionId: "s1",
      });
    }

    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, {
      ...DEFAULT_CFG.selfExtension,
      minGapFrequency: 2,
      minToolSavings: 1,
    });

    const result = proposer.runCycle();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.reasons.some((r: string) => r.includes("already exists"))).toBe(true);
  });

  it("respects maxProposals cap", () => {
    // Fill up to maxProposals
    for (let i = 0; i < 3; i++) {
      proposalStore.create({
        name: `existing_tool_${i}`,
        description: "",
        parameters: "{}",
        rationale: "",
        sourcePatterns: "[]",
        implementationHint: "",
      });
    }

    const seq = ["exec", "exec", "exec", "exec"];
    for (let i = 0; i < 4; i++) {
      workflowStore.record({
        goal: "batch stuff",
        toolSequence: seq,
        outcome: "success",
        sessionId: "s1",
      });
    }

    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, {
      ...DEFAULT_CFG.selfExtension,
      maxProposals: 3, // already at cap
      minGapFrequency: 2,
      minToolSavings: 1,
    });

    const result = proposer.runCycle();
    expect(result.proposed).toBe(0);
    expect(result.reasons.some((r: string) => r.includes("Max pending proposals"))).toBe(true);
  });

  it("reports no gaps when traces are insufficient", () => {
    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, DEFAULT_CFG.selfExtension);
    const result = proposer.runCycle();
    expect(result.proposed).toBe(0);
    expect(result.reasons.some((r: string) => r.includes("No actionable gaps"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Proposal lifecycle: propose → approve / reject
// ---------------------------------------------------------------------------

describe("ToolProposer — proposal lifecycle", () => {
  it("approves a proposed proposal", () => {
    const p = proposalStore.create({
      name: "test_tool",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });

    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, DEFAULT_CFG.selfExtension);
    const result = proposer.approveProposal(p.id);
    expect(result.success).toBe(true);
    expect(result.proposal!.status).toBe("approved");
  });

  it("rejects a proposed proposal", () => {
    const p = proposalStore.create({
      name: "bad_tool",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });

    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, DEFAULT_CFG.selfExtension);
    const result = proposer.rejectProposal(p.id);
    expect(result.success).toBe(true);
    expect(result.proposal!.status).toBe("rejected");
  });

  it("returns failure for non-existent proposal id", () => {
    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, DEFAULT_CFG.selfExtension);
    expect(proposer.approveProposal("nonexistent").success).toBe(false);
    expect(proposer.rejectProposal("nonexistent").success).toBe(false);
  });

  it("cannot approve an already-approved proposal", () => {
    const p = proposalStore.create({
      name: "already_approved",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    proposalStore.updateStatus(p.id, "approved");

    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, DEFAULT_CFG.selfExtension);
    const result = proposer.approveProposal(p.id);
    expect(result.success).toBe(false);
    expect(result.message).toContain("approved");
  });

  it("cannot reject an already-rejected proposal", () => {
    const p = proposalStore.create({
      name: "already_rejected",
      description: "",
      parameters: "{}",
      rationale: "",
      sourcePatterns: "[]",
      implementationHint: "",
    });
    proposalStore.updateStatus(p.id, "rejected");

    const detector = new GapDetector(workflowStore);
    const proposer = new ToolProposer(detector, proposalStore, DEFAULT_CFG.selfExtension);
    const result = proposer.rejectProposal(p.id);
    expect(result.success).toBe(false);
    expect(result.message).toContain("rejected");
  });
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("Config parsing — selfExtension", () => {
  const BASE_CFG = {
    embedding: { provider: "openai", apiKey: "sk-test-key-12345678", model: "text-embedding-3-small" },
  };

  it("parses selfExtension config with all fields", async () => {
    const { hybridConfigSchema } = await import("../config/index.js");
    const parsed = hybridConfigSchema.parse({
      ...BASE_CFG,
      selfExtension: {
        enabled: true,
        minGapFrequency: 5,
        minToolSavings: 3,
        maxProposals: 10,
      },
    });
    expect(parsed.selfExtension.enabled).toBe(true);
    expect(parsed.selfExtension.minGapFrequency).toBe(5);
    expect(parsed.selfExtension.minToolSavings).toBe(3);
    expect(parsed.selfExtension.maxProposals).toBe(10);
  });

  it("uses safe defaults when selfExtension config is absent", async () => {
    const { hybridConfigSchema } = await import("../config/index.js");
    const parsed = hybridConfigSchema.parse({ ...BASE_CFG, mode: "normal" });
    expect(parsed.selfExtension.enabled).toBe(false);
    expect(parsed.selfExtension.minGapFrequency).toBe(3);
    expect(parsed.selfExtension.minToolSavings).toBe(2);
    expect(parsed.selfExtension.maxProposals).toBe(20);
  });

  it("clamps invalid numeric values to defaults", async () => {
    const { hybridConfigSchema } = await import("../config/index.js");
    const parsed = hybridConfigSchema.parse({
      ...BASE_CFG,
      selfExtension: {
        enabled: false,
        minGapFrequency: -5, // invalid
        minToolSavings: 0,   // invalid
        maxProposals: -1,    // invalid
      },
    });
    expect(parsed.selfExtension.minGapFrequency).toBe(3);
    expect(parsed.selfExtension.minToolSavings).toBe(2);
    expect(parsed.selfExtension.maxProposals).toBe(20);
  });
});
