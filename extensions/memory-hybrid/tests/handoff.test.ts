/**
 * Tests for the OCTAVE-style Structured Handoff Service (Issue #615).
 */

import { describe, it, expect } from "vitest";
import {
  createHandoff,
  serializeHandoff,
  parseHandoffFromText,
  parseHandoffYaml,
  extractYamlFence,
  validateHandoff,
  formatHandoffSummary,
} from "../services/handoff.js";
import type { HandoffBlock } from "../types/handoff-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBlock(overrides: Partial<HandoffBlock> = {}): HandoffBlock {
  return {
    task_id: "forge-pr583-fix",
    goal: "Fix ambientBudgetTokens cap in stage-injection.ts",
    status: "completed",
    completed: ["Changed Math.max(100, indexBudget) → Math.max(0, indexBudget) in stage-injection.ts:165"],
    pending: [],
    risks: [],
    artifacts: [
      {
        type: "commit",
        ref: "e529d11",
        branch: "feat/581-architecture-refactor-hybrid-memory-core",
      },
    ],
    verification: ["npm test: 3610 tests passed", "tsc --noEmit: clean"],
    rollback: "git revert e529d11",
    generated_at: "2026-03-18T10:00:00.000Z",
    ...overrides,
  };
}

const MINIMAL_YAML = `\`\`\`yaml
handoff:
  task_id: test-task
  goal: "Do a thing"
  status: completed
  completed:
    - "Did the thing"
  pending: []
  risks: []
  artifacts: []
  verification:
    - "tests passed"
\`\`\``;

// ---------------------------------------------------------------------------
// createHandoff
// ---------------------------------------------------------------------------

describe("createHandoff", () => {
  it("auto-populates generated_at", () => {
    const block = createHandoff({
      task_id: "task-1",
      goal: "Test goal",
      status: "completed",
      completed: ["done"],
      pending: [],
      risks: [],
      artifacts: [],
      verification: [],
    });
    expect(block.generated_at).toBeDefined();
    expect(typeof block.generated_at).toBe("string");
    // Should be a valid ISO timestamp
    expect(new Date(block.generated_at!).getTime()).not.toBeNaN();
  });

  it("preserves all provided fields", () => {
    const block = createHandoff({
      task_id: "forge-99",
      goal: "My goal",
      status: "partial",
      completed: ["step 1"],
      pending: ["step 2"],
      risks: ["risk A"],
      artifacts: [{ type: "commit", ref: "abc123" }],
      verification: ["tests: ok"],
      rollback: "git revert abc123",
    });
    expect(block.task_id).toBe("forge-99");
    expect(block.status).toBe("partial");
    expect(block.completed).toEqual(["step 1"]);
    expect(block.pending).toEqual(["step 2"]);
    expect(block.risks).toEqual(["risk A"]);
    expect(block.artifacts[0].ref).toBe("abc123");
    expect(block.rollback).toBe("git revert abc123");
  });
});

// ---------------------------------------------------------------------------
// serializeHandoff
// ---------------------------------------------------------------------------

describe("serializeHandoff", () => {
  it("wraps output in yaml fence", () => {
    const block = makeBlock();
    const yaml = serializeHandoff(block);
    expect(yaml.startsWith("```yaml\n")).toBe(true);
    expect(yaml.trimEnd().endsWith("```")).toBe(true);
  });

  it("includes all required fields", () => {
    const block = makeBlock();
    const yaml = serializeHandoff(block);
    expect(yaml).toContain("handoff:");
    expect(yaml).toContain("task_id: forge-pr583-fix");
    expect(yaml).toContain("status: completed");
    expect(yaml).toContain("rollback:");
    expect(yaml).toContain("generated_at:");
  });

  it("serializes artifacts with type and ref", () => {
    const block = makeBlock();
    const yaml = serializeHandoff(block);
    expect(yaml).toContain("type: commit");
    expect(yaml).toContain("ref: e529d11");
    expect(yaml).toContain("branch: feat/581-architecture-refactor-hybrid-memory-core");
  });

  it("emits [] for empty arrays", () => {
    const block = makeBlock({ pending: [], risks: [], artifacts: [] });
    const yaml = serializeHandoff(block);
    expect(yaml).toContain("pending:\n    []");
    expect(yaml).toContain("risks:\n    []");
    expect(yaml).toContain("artifacts:\n    []");
  });

  it("omits rollback when not set", () => {
    const block = makeBlock({ rollback: undefined });
    const yaml = serializeHandoff(block);
    expect(yaml).not.toContain("rollback:");
  });

  it("quotes strings containing special characters", () => {
    const block = makeBlock({ goal: "Fix: the bug" });
    const yaml = serializeHandoff(block);
    expect(yaml).toContain('"Fix: the bug"');
  });

  it("round-trips through parse without data loss", () => {
    const original = makeBlock();
    const yaml = serializeHandoff(original);
    const result = parseHandoffFromText(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.task_id).toBe(original.task_id);
    expect(result.block.goal).toBe(original.goal);
    expect(result.block.status).toBe(original.status);
    expect(result.block.completed).toEqual(original.completed);
    expect(result.block.rollback).toBe(original.rollback);
  });
});

// ---------------------------------------------------------------------------
// extractYamlFence
// ---------------------------------------------------------------------------

describe("extractYamlFence", () => {
  it("extracts yaml fence content", () => {
    const text = "Some text\n```yaml\nfoo: bar\n```\nMore text";
    expect(extractYamlFence(text)).toBe("foo: bar\n");
  });

  it("extracts yml fence content", () => {
    const text = "```yml\nfoo: bar\n```";
    expect(extractYamlFence(text)).toBe("foo: bar\n");
  });

  it("returns null when no fence found", () => {
    expect(extractYamlFence("just plain text")).toBeNull();
  });

  it("returns null for non-yaml fence", () => {
    expect(extractYamlFence("```json\n{}\n```")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseHandoffYaml
// ---------------------------------------------------------------------------

describe("parseHandoffYaml", () => {
  it("parses minimal valid YAML", () => {
    const yaml = `
handoff:
  task_id: test-1
  goal: "Simple goal"
  status: completed
  completed:
    - "Did thing"
  pending: []
  risks: []
  artifacts: []
  verification:
    - "tests ok"
`;
    const result = parseHandoffYaml(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.task_id).toBe("test-1");
    expect(result.block.goal).toBe("Simple goal");
    expect(result.block.status).toBe("completed");
    expect(result.block.completed).toEqual(["Did thing"]);
    expect(result.block.verification).toEqual(["tests ok"]);
  });

  it("fails when handoff key is missing", () => {
    const result = parseHandoffYaml("foo: bar\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/Missing top-level 'handoff:' key/);
  });

  it("fails when task_id is missing", () => {
    const result = parseHandoffYaml("handoff:\n  goal: foo\n  status: completed\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("task_id"))).toBe(true);
  });

  it("fails for invalid status", () => {
    const result = parseHandoffYaml("handoff:\n  task_id: x\n  goal: y\n  status: invalid\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("parses all four valid statuses", () => {
    for (const status of ["completed", "failed", "partial", "escalate"]) {
      const result = parseHandoffYaml(`handoff:\n  task_id: t\n  goal: g\n  status: ${status}\n`);
      if (!result.ok) {
        // only invalid-status errors should fail; others fail because of missing required arrays
        expect(result.errors.every((e) => !e.includes("status"))).toBe(true);
      }
    }
  });

  it("strips double-quotes from scalar values", () => {
    const result = parseHandoffYaml('handoff:\n  task_id: t\n  goal: "My goal: here"\n  status: failed\n');
    if (!result.ok) return; // missing fields ok here
    expect(result.block.goal).toBe("My goal: here");
  });
});

// ---------------------------------------------------------------------------
// parseHandoffFromText
// ---------------------------------------------------------------------------

describe("parseHandoffFromText", () => {
  it("parses a valid handoff block from prose text", () => {
    const text = `Here is my handoff:\n\n${MINIMAL_YAML}\n\nDone.`;
    const result = parseHandoffFromText(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.task_id).toBe("test-task");
    expect(result.block.status).toBe("completed");
  });

  it("fails when no yaml fence in text", () => {
    const result = parseHandoffFromText("Just some prose, no YAML.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/No YAML fence/);
  });
});

// ---------------------------------------------------------------------------
// validateHandoff
// ---------------------------------------------------------------------------

describe("validateHandoff", () => {
  it("returns empty array for valid block", () => {
    const errors = validateHandoff(makeBlock());
    expect(errors).toHaveLength(0);
  });

  it("flags empty task_id", () => {
    const errors = validateHandoff(makeBlock({ task_id: "" }));
    expect(errors.some((e) => e.includes("task_id"))).toBe(true);
  });

  it("flags empty goal", () => {
    const errors = validateHandoff(makeBlock({ goal: "" }));
    expect(errors.some((e) => e.includes("goal"))).toBe(true);
  });

  it("flags invalid status", () => {
    const errors = validateHandoff(makeBlock({ status: "unknown" as never }));
    expect(errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("flags completed status with no completed items", () => {
    const errors = validateHandoff(makeBlock({ status: "completed", completed: [] }));
    expect(errors.some((e) => e.includes("completed[]"))).toBe(true);
  });

  it("flags artifact with empty ref", () => {
    const errors = validateHandoff(makeBlock({ artifacts: [{ type: "commit", ref: "" }] }));
    expect(errors.some((e) => e.includes("artifacts[0].ref"))).toBe(true);
  });

  it("does not flag failed status with no completed items", () => {
    const errors = validateHandoff(makeBlock({ status: "failed", completed: [] }));
    expect(errors.some((e) => e.includes("completed[]"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatHandoffSummary
// ---------------------------------------------------------------------------

describe("formatHandoffSummary", () => {
  it("includes status and goal", () => {
    const summary = formatHandoffSummary(makeBlock());
    expect(summary).toContain("[COMPLETED]");
    expect(summary).toContain("Fix ambientBudgetTokens cap");
  });

  it("shows completed item count", () => {
    const block = makeBlock({ completed: ["step 1", "step 2", "step 3"] });
    const summary = formatHandoffSummary(block);
    expect(summary).toContain("(+2 more)");
  });

  it("shows pending count when non-zero", () => {
    const block = makeBlock({ pending: ["item 1", "item 2"] });
    const summary = formatHandoffSummary(block);
    expect(summary).toContain("Pending: 2 item(s)");
  });

  it("shows risks when present", () => {
    const block = makeBlock({ risks: ["deployment may fail"] });
    const summary = formatHandoffSummary(block);
    expect(summary).toContain("Risks: deployment may fail");
  });

  it("handles empty completed list gracefully", () => {
    const block = makeBlock({ status: "failed", completed: [] });
    const summary = formatHandoffSummary(block);
    expect(summary).toContain("[FAILED]");
    expect(summary).not.toContain("Completed:");
  });
});
