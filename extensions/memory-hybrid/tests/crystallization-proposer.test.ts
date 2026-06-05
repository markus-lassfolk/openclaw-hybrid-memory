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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { CrystallizationProposer, patchOpeningYamlField } from "../services/crystallization-proposer.js";

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
  maxPendingProposals: 100,
  evidenceCountBucketSize: 5,
  placeholderEmailDomains: ["example.com", "localhost", "test.com", "example.org"],
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
      goal: `Deploy production application release ${i}`,
      toolSequence: seq,
      outcome: "success",
    });
  }
  for (let i = successCount; i < count; i++) {
    wfStore.record({
      goal: `Deploy production application release ${i}`,
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
    const cfg: CrystallizationConfig = { ...BASE_CFG, enabled: false, outputDir: tmpDir };
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
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir, maxCrystallized: 0 };
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
    wfStore.record({ goal: "one-off task", toolSequence: ["exec"], outcome: "success" });
    const result = proposer.runCycle();
    expect(result.proposed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runCycle — creates pending proposals (autoApprove=false)
// ---------------------------------------------------------------------------

describe("CrystallizationProposer.runCycle — pending proposals", () => {
  it("creates pending proposal for each valid candidate", () => {
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir, minUsageCount: 2, minSuccessRate: 0.5 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    seedPatterns(["exec", "read", "write"], 3, 1);

    const result = proposer.runCycle();
    expect(result.proposed).toBeGreaterThanOrEqual(1);

    const proposals = cStore.list({ status: "pending" });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
  });

  it("stores a proposal card with required fields", () => {
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir, minUsageCount: 2, minSuccessRate: 0.5 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    seedPatterns(["exec", "read", "write"], 3, 1);

    proposer.runCycle();
    const proposals = cStore.list({ status: "pending", limit: 1 });
    expect(proposals.length).toBe(1);
    const p = proposals[0];
    expect(["drafted", "validated"]).toContain(p.status);
    expect(p.proposalCardJson).toBeTruthy();
    const card = JSON.parse(p.proposalCardJson!) as Record<string, unknown>;
    for (const key of ["name", "category", "captures", "risks", "confidence", "recommended_output", "provenance"]) {
      expect(card).toHaveProperty(key);
    }
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
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    seedPatterns(["exec", "read", "write"], 3, 1);
    proposer.runCycle();

    const pending = cStore.list({ status: "pending" });
    expect(pending.length).toBeGreaterThan(0);

    // Reject first, then try to approve
    cStore.reject(pending[0].id);
    const result = proposer.approveProposal(pending[0].id);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not approvable|not pending/i);
  });

  it("approves a pending proposal and writes file to disk", () => {
    const outputDir = join(tmpDir, "skills");
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, autoApprove: false, minUsageCount: 2 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    seedPatterns(["exec", "read", "write"], 3, 1);
    const cycleResult = proposer.runCycle();

    expect(cycleResult.proposed).toBeGreaterThan(0);

    const pending = cStore.list({ status: "pending" });
    expect(pending.length).toBeGreaterThanOrEqual(1);

    let result = proposer.approveProposal(pending[0].id);
    if (!result.success && /explicit override/i.test(result.message)) {
      result = proposer.approveProposal(pending[0].id, { overrideWarnings: true });
    }
    expect(result.success).toBe(true);
    expect(result.outputPath).toBeDefined();
    expect(existsSync(result.outputPath!)).toBe(true);
  });

  it("applies rename/category overrides before installation", () => {
    const outputDir = join(tmpDir, "skills");
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, autoApprove: false, minUsageCount: 2 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    seedPatterns(["exec", "read", "write"], 3, 1);
    proposer.runCycle();

    const pending = cStore.list({ status: "pending" });
    expect(pending.length).toBeGreaterThanOrEqual(1);

    let result = proposer.approveProposal(pending[0].id, {
      name: "renamed-skill",
      category: "workflow-automation",
    });
    if (!result.success && /explicit override/i.test(result.message)) {
      result = proposer.approveProposal(pending[0].id, {
        name: "renamed-skill",
        category: "workflow-automation",
        overrideWarnings: true,
      });
    }
    expect(result.success).toBe(true);
    expect(result.outputPath).toContain("renamed-skill");
    const body = readFileSync(result.outputPath!, "utf-8");
    expect(body).toContain("# renamed-skill");
    expect(body).toContain("**Category:** workflow-automation");
    expect(body).toContain("openclaw:skill-proposal");
  });

  it("supersedes an older installed proposal for the same pattern without depending on global list order", () => {
    const outputDir = join(tmpDir, "skills");
    const cfg: CrystallizationConfig = {
      ...BASE_CFG,
      outputDir,
      maxCrystallized: 200,
      autoApprove: false,
    };
    const adequate = "This is a test skill file with adequate content for validation purposes.";
    const oldP = cStore.create({
      patternId: "p-shared-target",
      evidenceHash: "ev-old",
      skillName: "shared-target-v1",
      skillContent: `# shared-target-v1\n\n${adequate}`,
      patternSnapshot: "{}",
      status: "validated",
    });
    cStore.approve(oldP.id);
    cStore.install(oldP.id, join(outputDir, "shared-target-v1", "SKILL.md"));

    for (let i = 0; i < 60; i++) {
      cStore.create({
        patternId: `noise-pattern-${i}`,
        evidenceHash: `noise-ev-${i}`,
        skillName: `noise-skill-${i}`,
        skillContent: "#c\n",
        patternSnapshot: "{}",
        status: "rejected",
      });
    }

    const newP = cStore.create({
      patternId: "p-shared-target",
      evidenceHash: "ev-new",
      skillName: "shared-target-v2",
      skillContent: `# shared-target-v2\n\n${adequate}`,
      patternSnapshot: "{}",
      status: "validated",
    });

    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    let result = proposer.approveProposal(newP.id);
    if (!result.success && /explicit override/i.test(result.message)) {
      result = proposer.approveProposal(newP.id, { overrideWarnings: true });
    }
    expect(result.success).toBe(true);

    // Regression target: superseding must use the pattern-scoped scan instead of
    // depending on whether unrelated rows push the old proposal out of a global list window.
    expect(cStore.getById(oldP.id)?.status).toBe("superseded");
    expect(cStore.getById(newP.id)?.status).toBe("installed");
  });
  it("reverts approval when disk write fails so the proposal stays installable", () => {
    const outputDir = join(tmpDir, "readonly-out");
    mkdirSync(outputDir, { recursive: true });
    chmodSync(outputDir, 0o444);

    const proposal = cStore.create({
      patternId: "p-write-fail",
      evidenceHash: "ev-write-fail",
      skillName: "write-fail-skill",
      skillContent: skillFixture("write-fail-skill", "Write Fail Skill"),
      patternSnapshot: "{}",
      status: "validated",
    });

    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, maxCrystallized: 50 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

    let result = proposer.approveProposal(proposal.id);
    if (!result.success && /explicit override/i.test(result.message)) {
      result = proposer.approveProposal(proposal.id, { overrideWarnings: true });
    }
    if (result.success) {
      chmodSync(outputDir, 0o755);
      throw new Error("expected write failure in read-only output directory");
    }

    expect(result.message).toMatch(/reverted/i);
    expect(cStore.getById(proposal.id)?.status).toBe("validated");
    chmodSync(outputDir, 0o755);
  });

  it("falls back to auto-generated-skill when rename slug is empty", () => {
    const outputDir = join(tmpDir, "empty-slug");
    const proposal = cStore.create({
      patternId: "p-empty-slug",
      evidenceHash: "ev-empty-slug",
      skillName: "orig-skill",
      skillContent: skillFixture("orig-skill", "Orig Skill"),
      patternSnapshot: "{}",
      status: "validated",
    });
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, maxCrystallized: 50 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

    let result = proposer.approveProposal(proposal.id, { name: "!!!" });
    if (!result.success && /explicit override/i.test(result.message)) {
      result = proposer.approveProposal(proposal.id, { name: "!!!", overrideWarnings: true });
    }
    expect(result.success, result.message).toBe(true);
    expect(result.outputPath).toContain("auto-generated-skill");
  });

  it("returns success=false when maxCrystallized is 0", () => {
    // Manually create a pending proposal
    const proposal = cStore.create({
      patternId: "test-pattern-id",
      evidenceHash: "ev1",
      skillName: "test-skill",
      skillContent: "# Test Skill\n\nThis is a test skill file with adequate content for validation purposes.",
      patternSnapshot: "{}",
      status: "validated",
    });

    // Now use a proposer with maxCrystallized=0 to try to approve
    const limitedCfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir, maxCrystallized: 0 };
    const limitedProposer = new CrystallizationProposer(wfStore, cStore, limitedCfg);
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
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir, minUsageCount: 2 };
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
      evidenceHash: "ev1",
      skillName: "skill",
      skillContent: "# content",
      patternSnapshot: "{}",
    });
    cStore.reject(proposal.id);

    const result = proposer.rejectProposal(proposal.id);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not rejectable|not pending/i);
  });
});

// ---------------------------------------------------------------------------
// patchOpeningYamlField — multiline YAML (Issue #1427)
// ---------------------------------------------------------------------------

describe("patchOpeningYamlField", () => {
  it("replaces a literal block scalar (|) through the next top-level key", () => {
    const src = `---
description: |
  line one
  line two
category: keep-me
---

# Title
`;
    const out = patchOpeningYamlField(src, "description", "short");
    expect(out).toMatch(/description: short\r?\n/);
    expect(out).not.toContain("line one");
    expect(out).toContain("category: keep-me");
  });

  it("replaces a folded block scalar (>) through the next top-level key", () => {
    const src = `---
notes: >
  folded a
  folded b
name: keep-name
---
`;
    const out = patchOpeningYamlField(src, "notes", "x");
    expect(out).toMatch(/notes: x\r?\n/);
    expect(out).not.toContain("folded a");
    expect(out).toContain("name: keep-name");
  });

  it("replaces plain multiline values with indented continuation lines", () => {
    const src = `---
title: first line
  second line
category: cat
---
`;
    const out = patchOpeningYamlField(src, "title", "single");
    expect(out).toMatch(/title: single\r?\n/);
    expect(out).not.toContain("second line");
    expect(out).toContain("category: cat");
  });

  it("preserves CRLF inside frontmatter when present", () => {
    const src = "---\r\ndescription: |\r\n  a\r\n  b\r\ncategory: z\r\n---\r\n\r\n# x\r\n";
    const out = patchOpeningYamlField(src, "description", "n");
    expect(out).toContain("\r\n");
    expect(out).toMatch(/description: n\r\n/);
    expect(out).not.toContain("  a");
    expect(out).toContain("category: z");
  });

  it("preserves CRLF in single-key frontmatter", () => {
    const src = "---\r\nname: foo\r\n---\r\n\r\n# x\r\n";
    const out = patchOpeningYamlField(src, "name", "bar");
    expect(out).toBe("---\r\nname: bar\r\n---\r\n\r\n# x\r\n");
    // Verify all line endings are CRLF, not just LF
    const linesWithCrlf = out.split("\r\n");
    expect(linesWithCrlf).toHaveLength(6);
    // Ensure no standalone LF (would indicate mixed line endings)
    expect(out.replace(/\r\n/g, "X").includes("\n")).toBe(false);
  });

  it("stops block scalar replacement at a top-level key with no inline value", () => {
    const src = `---
description: |
  line one
  line two
tags:
  - keep-me
category: keep-category
---
`;
    const out = patchOpeningYamlField(src, "description", "short");
    expect(out).toMatch(/description: short\r?\n/);
    expect(out).not.toContain("line one");
    expect(out).toContain("tags:");
    expect(out).toContain("  - keep-me");
    expect(out).toContain("category: keep-category");
  });

  it("recognizes combined YAML block scalar indicators", () => {
    const src = `---
description: |2-
    indented line

category: keep-category
---
`;
    const out = patchOpeningYamlField(src, "description", "short");
    expect(out).toBe(`---
description: short
category: keep-category
---
`);
  });
});

// ---------------------------------------------------------------------------
// approveProposal — H1 override when renaming (Issue #1427)
// ---------------------------------------------------------------------------

const MINIMAL_VALID_SKILL_SECTIONS = `## Trigger

Positive: user asks to run a minimal workflow for deployment tasks without explain-only fluff.

## Scope

Covers only scripted steps described in workflow.

## When not to use

Avoid when credentials or secrets appear in goals.

## Workflow

First gather context then apply changes safely.

## Examples

- Good: user says, "Run the deployment checklist for this release and report the command output."

## Provenance

Synthetic fixture for crystallization proposer tests.`;

function skillFixture(skillName: string, h1Title: string, lineBreak = "\n"): string {
  return `---
name: ${skillName}
description: Short description for validation.
category: testing
source_pattern_id: p-h1
metadata:
  provenance: "crystallization-test-fixture"
---

# ${h1Title}

${MINIMAL_VALID_SKILL_SECTIONS}
## Verification

Run this workflow in a temporary workspace and confirm expected output.

## Anti-patterns / Known Failures

Do not run it for unrelated explain-only prompts.
`.replace(/\n/g, lineBreak);
}

describe("CrystallizationProposer.approveProposal — custom H1 on rename", () => {
  it("replaces the first body H1 when it differs from the proposal skill name", () => {
    const outputDir = join(tmpDir, "skills-h1");
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, maxCrystallized: 50 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

    const proposal = cStore.create({
      patternId: "p-h1",
      evidenceHash: "ev-h1",
      skillName: "orig-skill-name",
      skillContent: skillFixture("orig-skill-name", "Custom Human Title"),
      patternSnapshot: "{}",
      status: "validated",
    });

    let result = proposer.approveProposal(proposal.id, { name: "renamed-h1-skill" });
    if (!result.success && /explicit override/i.test(result.message)) {
      result = proposer.approveProposal(proposal.id, { name: "renamed-h1-skill", overrideWarnings: true });
    }
    expect(result.success, result.message).toBe(true);
    const written = readFileSync(result.outputPath!, "utf-8");
    expect(written).toMatch(/^#\s+renamed-h1-skill\s*$/m);
    expect(written).not.toContain("# Custom Human Title");
    expect(written).toMatch(/name:\s*renamed-h1-skill/);
  });

  it("preserves CRLF line endings when replacing the body H1", () => {
    const outputDir = join(tmpDir, "skills-h1-crlf");
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, maxCrystallized: 50 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

    const proposal = cStore.create({
      patternId: "p-h1-crlf",
      evidenceHash: "ev-h1-crlf",
      skillName: "orig-crlf-skill",
      skillContent: skillFixture("orig-crlf-skill", "Custom Human Title", "\r\n"),
      patternSnapshot: "{}",
      status: "validated",
    });

    let result = proposer.approveProposal(proposal.id, { name: "renamed-crlf-skill" });
    if (!result.success && /explicit override/i.test(result.message)) {
      result = proposer.approveProposal(proposal.id, { name: "renamed-crlf-skill", overrideWarnings: true });
    }
    expect(result.success, result.message).toBe(true);
    const written = readFileSync(result.outputPath!, "utf-8");
    const h1Index = written.indexOf("# renamed-crlf-skill");
    expect(h1Index).toBeGreaterThanOrEqual(0);
    expect(written.slice(h1Index, h1Index + "# renamed-crlf-skill\r\n".length)).toBe("# renamed-crlf-skill\r\n");
  });
});

// ---------------------------------------------------------------------------
// isLegacyMarkdownCrystallizationProposal — HTML comment prefix (Issue #1362)
// ---------------------------------------------------------------------------

describe("CrystallizationProposer — legacy detection with HTML comment prefix", () => {
  const FULL_SKILL_CONTENT = `---
name: html-prefix-skill
description: Use when the user asks to validate HTML-prefixed skills.
category: crystallized-workflow
provenance: test-suite
---

# Html-Prefix-Skill

## Trigger
Use this skill when the user asks to validate HTML-prefixed skills.

## Scope
Bounded HTML prefix validation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect the HTML comment prefix.
2. Validate the YAML frontmatter.

## Verification
- Confirm frontmatter fields are correctly parsed.

## Anti-patterns / Known Failures
- Do not treat injected metadata comments as content.

## Examples
- Validate an HTML-prefixed crystallized skill for correct frontmatter parsing.

## Provenance
- Source pattern ID: \`html-prefix-pattern\`
`;

  it("does not treat an HTML-prefixed YAML-frontmatter skill as legacy (approves successfully)", () => {
    const outputDir = join(tmpDir, "html-prefix-skills");
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, autoApprove: false };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

    const htmlComment = `<!-- openclaw:skill-proposal id=test-id pattern_id=html-prefix-pattern evidence_hash=ev-html output_path=${outputDir}/html-prefix-skill/SKILL.md -->`;
    const contentWithHtmlPrefix = `\uFEFF\n\t\n${htmlComment}\n${FULL_SKILL_CONTENT}`;

    const proposal = cStore.create({
      patternId: "html-prefix-pattern",
      evidenceHash: "ev-html",
      skillName: "html-prefix-skill",
      skillContent: contentWithHtmlPrefix,
      patternSnapshot: "{}",
      status: "validated",
    });

    const result = proposer.approveProposal(proposal.id);
    expect(result.success).toBe(true);
    expect(result.outputPath).toBeDefined();

    // Verify the stored validation result is not the legacy bypass.
    const stored = cStore.getById(proposal.id);
    const activationNotes = stored?.validationResult?.syntheticActivationEval?.notes ?? [];
    expect(activationNotes.every((n: string) => !n.includes("legacy crystallization"))).toBe(true);
  });

  it("does not treat skills with multiple leading HTML comments as legacy", () => {
    const outputDir = join(tmpDir, "multi-html-prefix-skills");
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, autoApprove: false };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

    const contentWithHtmlPrefix = `<!-- first metadata wrapper -->
<!-- second metadata wrapper -->
${FULL_SKILL_CONTENT}`;

    const proposal = cStore.create({
      patternId: "html-prefix-pattern",
      evidenceHash: "ev-html-multiple",
      skillName: "html-prefix-skill",
      skillContent: contentWithHtmlPrefix,
      patternSnapshot: "{}",
      status: "validated",
    });

    const result = proposer.approveProposal(proposal.id, { overrideWarnings: true });
    expect(result.success).toBe(true);

    const stored = cStore.getById(proposal.id);
    const activationNotes = stored?.validationResult?.syntheticActivationEval?.notes ?? [];
    expect(activationNotes.every((n: string) => !n.includes("legacy crystallization"))).toBe(true);
  });

  it("still treats a plain markdown skill without frontmatter as legacy", () => {
    const outputDir = join(tmpDir, "legacy-markdown-skills");
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, autoApprove: false };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

    const legacyContent = `# Legacy Crystallized Workflow

> Auto-crystallized from workflow pattern on 2020-01-01.

Bounded narrative body without YAML.
`;

    const proposal = cStore.create({
      patternId: "legacy-pattern",
      evidenceHash: "ev-legacy",
      skillName: "legacy-skill",
      skillContent: legacyContent,
      patternSnapshot: "{}",
      status: "validated",
    });

    const result = proposer.approveProposal(proposal.id);
    // Legacy proposals without frontmatter are approved via the legacy bypass path.
    expect(result.success).toBe(true);
    const stored = cStore.getById(proposal.id);
    const activationNotes = stored?.validationResult?.syntheticActivationEval?.notes ?? [];
    expect(activationNotes.some((n: string) => n.includes("legacy crystallization"))).toBe(true);
  });
});

describe("CrystallizationProposer — exec-only script install", () => {
  it("writes scripts/run.sh for exec-only patterns on approve", () => {
    const outputDir = join(tmpDir, "exec-script-skills");
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir, minUsageCount: 2 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    seedPatterns(["exec", "exec"], 3, 1);

    proposer.runCycle();
    const pending = cStore.list({ status: "pending", limit: 1 });
    expect(pending.length).toBe(1);

    let result = proposer.approveProposal(pending[0].id);
    if (!result.success && /explicit override/i.test(result.message)) {
      result = proposer.approveProposal(pending[0].id, { overrideWarnings: true });
    }
    expect(result.success, result.message).toBe(true);
    const scriptPath = join(dirname(result.outputPath!), "scripts", "run.sh");
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, "utf-8")).toContain("#!/usr/bin/env bash");
  });
});

describe("CrystallizationProposer.runCycle — maxPendingProposals", () => {
  it("returns early when pending queue is at cap", () => {
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: tmpDir, maxPendingProposals: 2 };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    for (let i = 0; i < 2; i++) {
      cStore.create({
        patternId: `pending-cap-${i}`,
        evidenceHash: `ev-${i}`,
        skillName: `pending-${i}`,
        skillContent: "# pending",
        patternSnapshot: "{}",
        status: "validated",
      });
    }
    seedPatterns(["exec", "read", "write"], 5, 1);
    const result = proposer.runCycle();
    expect(result.proposed).toBe(0);
    expect(result.reasons.some((r) => /maxPendingProposals/i.test(r))).toBe(true);
  });
});

describe("CrystallizationProposer.restoreProposal", () => {
  it("restores a quarantined legacy skill back to the active output tree", () => {
    const outputDir = join(tmpDir, "restore-skills");
    mkdirSync(outputDir, { recursive: true });
    const quarantineDir = join(outputDir, "..", "crystallization-quarantine", "2026-06-05", "legacy-restore");
    mkdirSync(quarantineDir, { recursive: true });
    const quarantineSkillPath = join(quarantineDir, "SKILL.md");
    writeFileSync(
      quarantineSkillPath,
      `# Legacy Crystallized Workflow

> Auto-crystallized from workflow pattern on 2020-01-01.

Bounded narrative body without YAML.
`,
      "utf-8",
    );

    const proposal = cStore.create({
      patternId: "restore-pattern",
      evidenceHash: "ev-restore",
      skillName: "legacy-restore",
      skillContent: readFileSync(quarantineSkillPath, "utf-8"),
      patternSnapshot: "{}",
      status: "quarantined",
      rejectionReason: "stale validation: test",
    });
    cStore.updateOutputPath(proposal.id, quarantineSkillPath);

    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir };
    const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
    const result = proposer.restoreProposal(proposal.id);
    expect(result.success, result.message).toBe(true);
    expect(result.outputPath).toBe(join(outputDir, "legacy-restore", "SKILL.md"));
    expect(existsSync(result.outputPath!)).toBe(true);
    expect(cStore.getById(proposal.id)?.status).toBe("installed");
  });
});
