import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern } from "../backends/workflow-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import { registerSkillsCommands } from "../cli/skills.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";
import { GeneratedSkillValidationService, parseSkillFrontmatter } from "../services/generated-skill-validation.js";
import { SkillCrystallizer } from "../services/skill-crystallizer.js";

const BASE_CFG: CrystallizationConfig = {
  enabled: true,
  minUsageCount: 2,
  minSuccessRate: 0.5,
  autoApprove: false,
  outputDir: "",
  maxCrystallized: 50,
  pruneUnusedDays: 30,
};
const MIN_CONCRETE_EXAMPLE_LENGTH_THRESHOLD_CHARS = 18;

describe("GeneratedSkillValidationService", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes activation eval for terse example goals (short tokens)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-validation-short-goal-"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };
    const crystallizer = new SkillCrystallizer(cfg);
    const service = new GeneratedSkillValidationService();
    const pattern = {
      toolSequence: ["exec", "read"],
      totalCount: 4,
      successCount: 3,
      failureCount: 1,
      successRate: 0.75,
      avgDurationMs: 800,
      exampleGoals: ["fix bug", "run CI"],
    };

    const result = crystallizer.crystallize({ patternId: "short-goal", evidenceHash: "ev-short", pattern });
    const validation = service.validate({
      outputDir: cfg.outputDir,
      proposedOutputPath: result.proposedOutputPath,
      skillName: result.skillName,
      skillContent: result.skillContent,
      pattern,
    });
    const examplesSection = result.skillContent.match(/## Examples\s+([\s\S]*?)\n## Provenance/);
    expect(examplesSection, "Generated skill should keep an Examples section before Provenance.").not.toBeNull();
    const exampleLines =
      examplesSection?.[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- ")) ?? [];

    expect(
      exampleLines.some((line) => line.length >= MIN_CONCRETE_EXAMPLE_LENGTH_THRESHOLD_CHARS),
      "At least one example line must satisfy the SkillValidator concrete-example length threshold.",
    ).toBe(true);
    expect(validation.staticValidation.status).toBe("passed");
    expect(validation.dryLoadValidation.status).toBe("passed");
    expect(validation.syntheticActivationEval.status).toBe("passed");
    expect(validation.approvalDecision).toBe("allow");
  });

  it("allows placeholder example.com emails in crystallized examples", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-validation-example-email-"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };
    const crystallizer = new SkillCrystallizer(cfg);
    const service = new GeneratedSkillValidationService();
    const pattern = {
      toolSequence: ["read", "write"],
      totalCount: 5,
      successCount: 5,
      failureCount: 0,
      successRate: 1,
      avgDurationMs: 400,
      exampleGoals: ["Send the weekly summary to ops@example.com after deploy"],
    };

    const result = crystallizer.crystallize({ patternId: "email-goal", evidenceHash: "ev-mail", pattern });
    expect(result.skillContent).toContain("ops@example.com");

    const validation = service.validate({
      outputDir: cfg.outputDir,
      proposedOutputPath: result.proposedOutputPath,
      skillName: result.skillName,
      skillContent: result.skillContent,
      pattern,
    });
    expect(validation.staticValidation.status).toBe("passed");
    expect(validation.approvalDecision).toBe("allow");
  });

  it("accepts frontmatter names produced by approval rename sanitization", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-validation-rename-"));
    const service = new GeneratedSkillValidationService();
    const skillContent = `---
name: Release_Health
description: Use when the user asks to review release health checks.
category: crystallized-workflow
provenance: test
---

# Release_Health

## Trigger
Use this skill when the user asks to review release health checks.

## Scope
Bounded release-health review workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect the release health report.
2. Run the bounded validation checklist.

## Verification
- Confirm release health findings are summarized with objective evidence.

## Anti-patterns / Known Failures
- Do not broaden into generic release management.

## Examples
- Review release health checks for the latest deployment.

## Provenance
- Source pattern ID: \`pattern-1\``;

    const validation = service.validate({
      outputDir: join(tmpDir, "skills"),
      proposedOutputPath: join(tmpDir, "skills", "Release_Health", "SKILL.md"),
      skillName: "Release_Health",
      skillContent,
      pattern: {
        toolSequence: ["read", "exec"],
        totalCount: 3,
        successCount: 3,
        failureCount: 0,
        successRate: 1,
        avgDurationMs: 100,
        exampleGoals: ["Review release health checks for the latest deployment."],
      },
    });

    expect(validation.staticValidation.status).toBe("passed");
    expect(validation.dryLoadValidation.status).toBe("passed");
    expect(validation.approvalDecision).toBe("allow-with-override");
  });

  it("passes static, dry-load, and activation eval for crystallized skills", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-validation-"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };
    const crystallizer = new SkillCrystallizer(cfg);
    const service = new GeneratedSkillValidationService();
    const pattern = {
      toolSequence: ["exec", "read", "memory_store"],
      totalCount: 6,
      successCount: 5,
      failureCount: 1,
      successRate: 5 / 6,
      avgDurationMs: 1200,
      exampleGoals: ["Deploy the app and capture the release notes"],
    };

    const result = crystallizer.crystallize({ patternId: "abc123", evidenceHash: "ev-abc", pattern });
    const validation = service.validate({
      outputDir: cfg.outputDir,
      proposedOutputPath: result.proposedOutputPath,
      skillName: result.skillName,
      skillContent: result.skillContent,
      pattern,
    });

    expect(validation.staticValidation.status).toBe("passed");
    expect(validation.dryLoadValidation.status).toBe("passed");
    expect(validation.syntheticActivationEval.status).toBe("passed");
    expect(validation.approvalDecision).toBe("allow");
    expect(validation.syntheticActivationEval.score).toBeGreaterThanOrEqual(100 / 3);
  });

  it("uses a deterministic fallback negative prompt when canned prompts overlap the skill surface", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-deterministic-negative-"));
    const service = new GeneratedSkillValidationService();
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };
    const skillContent = `---
name: trivia-collision-review
description: Use when the user asks to handle adult emperor penguin Byzantine Empire Ottomans cups millilitres baking speed sound dry air Celsius Goldberg Variations harpsichord postal code South Georgia research station checks.
category: crystallized-workflow
provenance: test-suite
---

# Trivia Collision Review

## Trigger
Use this skill when the user asks to handle adult emperor penguin Byzantine Empire Ottomans cups millilitres baking speed sound dry air Celsius Goldberg Variations harpsichord postal code South Georgia research station checks.

## Scope
Bounded collision review workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect the collision review input.
2. Report deterministic findings.

## Verification
- Confirm deterministic findings are summarized with objective evidence.

## Anti-patterns / Known Failures
- Do not introduce random prompts during revalidation.

## Examples
- Review collision checks for deterministic generated skill validation.

## Provenance
- Source pattern ID: \`pattern-deterministic-negative\``;
    const pattern: WorkflowPattern = {
      toolSequence: ["read", "exec"],
      totalCount: 3,
      successCount: 3,
      failureCount: 0,
      successRate: 1,
      avgDurationMs: 100,
      exampleGoals: ["Review collision checks for deterministic generated skill validation."],
    };

    const first = service.validate({
      outputDir: cfg.outputDir,
      proposedOutputPath: join(cfg.outputDir, "trivia-collision-review", "SKILL.md"),
      skillName: "trivia-collision-review",
      skillContent,
      pattern,
    });
    const second = service.validate({
      outputDir: cfg.outputDir,
      proposedOutputPath: join(cfg.outputDir, "trivia-collision-review", "SKILL.md"),
      skillName: "trivia-collision-review",
      skillContent,
      pattern,
    });

    expect(first.syntheticActivationEval.cases.negative).toBe(second.syntheticActivationEval.cases.negative);
    expect(first.syntheticActivationEval.cases.negative).toMatch(/^[0-9a-f]{16} [0-9a-f]{16}$/);
    expect(first.syntheticActivationEval.results.negativeMatched).toBe(false);
  });

  it("fails static validation for transcript dumps and path escapes", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-static-fail-"));
    const service = new GeneratedSkillValidationService();
    const content = `---
name: transcript-skill
description: Use when the user asks to dump a transcript.
category: crystallized-workflow
provenance: test-suite
---

# Transcript Skill

## Trigger
Use this skill for transcript dumps.

## Scope
Bounded transcript export.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Read the transcript.

## Examples
- Positive: "Dump the transcript"

## Provenance
- Source pattern ID: \`p-1\`

user: show the full transcript
assistant: here is the full log
2026-05-14T11:30:00Z exported raw transcript`;

    const validation = service.validate({
      outputDir: join(tmpDir, "skills"),
      proposedOutputPath: join(tmpDir, "..", "escape", "SKILL.md"),
      skillName: "transcript-skill",
      skillContent: content,
    });

    expect(validation.staticValidation.status).toBe("failed");
    expect(validation.approvalDecision).toBe("deny");
    expect(validation.staticValidation.violations.some((v) => v.includes("Unsafe proposed output path"))).toBe(true);
    expect(validation.staticValidation.violations.some((v) => v.includes("transcript"))).toBe(true);
  });

  it("extracts trigger sections through the next markdown heading for activation eval", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-section-extract-"));
    const service = new GeneratedSkillValidationService();
    const skillContent = `---
name: ops-helper
description: Use when the user asks for a bounded operations helper.
category: crystallized-workflow
provenance: test-suite
---

# Ops Helper

## Trigger
Use this skill for staged kube rollout checks and rollout validation.

## Scope
Bounded operational helper workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect the rollout plan.
2. Run the bounded validation checklist.

## Verification
- Confirm rollout checks are grounded in command output.

## Anti-patterns / Known Failures
- Do not broaden into generic cluster administration.

## Examples
- Perform staged kube rollout checks for the latest deployment.

## Provenance
- Source pattern ID: \`pattern-section\``;

    const validation = service.validate({
      outputDir: join(tmpDir, "skills"),
      proposedOutputPath: join(tmpDir, "skills", "ops-helper", "SKILL.md"),
      skillName: "ops-helper",
      skillContent,
      pattern: {
        toolSequence: ["read", "exec"],
        totalCount: 3,
        successCount: 3,
        failureCount: 0,
        successRate: 1,
        avgDurationMs: 100,
        exampleGoals: ["Perform staged kube rollout checks for the latest deployment."],
      },
    });

    expect(validation.syntheticActivationEval.results.positiveMatched).toBe(true);
    expect(validation.syntheticActivationEval.status).not.toBe("failed");
  });

  it("rejects existing symlinks at the output skill directory or SKILL.md path", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-symlink-"));
    const service = new GeneratedSkillValidationService();
    const outputDir = join(tmpDir, "skills");
    const outsideDir = join(tmpDir, "outside");
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(tmpDir, "placeholder"), "x", "utf-8");
    symlinkSync(outsideDir, join(outputDir, "symlinked-skill"), "dir");

    const validation = service.validate({
      outputDir,
      proposedOutputPath: join(outputDir, "symlinked-skill", "SKILL.md"),
      skillName: "symlinked-skill",
      skillContent: `---
name: symlinked-skill
description: Use when the user asks for symlink safety validation.
category: crystallized-workflow
provenance: test-suite
---

# Symlinked Skill

## Trigger
Use this skill for symlink safety validation.

## Scope
Bounded symlink validation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect candidate paths.
2. Reject symlink escapes.

## Verification
- Confirm output paths stay inside the skills directory.

## Anti-patterns / Known Failures
- Do not follow symlinks during writes.

## Examples
- Validate symlink safety for generated skills.

## Provenance
- Source pattern ID: \`pattern-symlink\``,
    });

    expect(validation.staticValidation.status).toBe("failed");
    expect(validation.staticValidation.violations.some((v) => v.includes("Unsafe proposed output path"))).toBe(true);
  });

  it("requires explicit override for activation warnings during approval", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-override-"));
    const validationService = new GeneratedSkillValidationService();
    const wfStore = new WorkflowStore(join(tmpDir, "workflow.db"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    try {
      const skillContent = `---
name: release-health-review
description: Use when the user asks to review release health checks.
category: crystallized-workflow
provenance: test-suite
---

# Release Health Review

## Trigger
Use this skill when the user asks to review release health checks or explain the release health workflow.

## Scope
Bounded release-health review workflow.

## When not to use
- Do not use for unrelated tasks.
- Do not use for generic GitHub help.

## Workflow
1. Use \`read\` to inspect the release report.
2. Use \`exec\` only for the bounded release-health validation command.

## Verification
- Confirm release health findings are grounded in the report.

## Anti-patterns / Known Failures
- Do not broaden into generic release management.

## Examples
- Positive: "Review release health checks for the latest deployment."
- Negative: "How do I create a GitHub issue?"
- Edge: "Explain release health workflow without executing the workflow or changing files."

## Provenance
- Source pattern ID: \`pattern-1\``;

      const validation = validationService.validate({
        outputDir: cfg.outputDir,
        proposedOutputPath: join(cfg.outputDir, "release-health-review", "SKILL.md"),
        skillName: "release-health-review",
        skillContent,
      });
      expect(validation.approvalDecision).toBe("allow-with-override");

      const proposal = cStore.create({
        patternId: "pattern-1",
        evidenceHash: "ev-pattern-1",
        skillName: "release-health-review",
        skillContent,
        patternSnapshot: "{}",
        validationResult: validation,
        status: "validated",
      });
      const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

      expect(proposer.approveProposal(proposal.id).message).toMatch(/explicit override/i);

      const approved = proposer.approveProposal(proposal.id, { overrideWarnings: true });
      expect(approved.success).toBe(true);
      expect(approved.outputPath).toBeDefined();
      if (!approved.outputPath) return;
      expect(existsSync(approved.outputPath)).toBe(true);
    } finally {
      wfStore.close();
      cStore.close();
    }
  });

  it("allows CLI install callers to explicitly override activation warnings", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-cli-override-"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    try {
      const skillContent = `---
name: cli-release-health-review
description: Use when the user asks to review CLI release health checks.
category: crystallized-workflow
provenance: test-suite
---

# CLI Release Health Review

## Trigger
Use this skill when the user asks to review CLI release health checks or explain the CLI release health workflow.

## Scope
Bounded CLI release-health review workflow.

## When not to use
- Do not use for unrelated tasks.
- Do not use for generic GitHub help.

## Workflow
1. Use \`read\` to inspect the release report.
2. Use \`exec\` only for the bounded release-health validation command.

## Verification
- Confirm release health findings are grounded in the report.

## Anti-patterns / Known Failures
- Do not broaden into generic release management.

## Examples
- Positive: "Review CLI release health checks for the latest deployment."
- Negative: "How do I create a GitHub issue?"
- Edge: "Explain CLI release health workflow without executing the workflow or changing files."

## Provenance
- Source pattern ID: \`pattern-cli\``;
      const proposal = cStore.create({
        patternId: "pattern-cli",
        evidenceHash: "ev-pattern-cli",
        skillName: "cli-release-health-review",
        skillContent,
        patternSnapshot: "{}",
        status: "validated",
      });
      const program = new Command("hybrid-mem");
      program.exitOverride();
      registerSkillsCommands(program, {
        crystallizationStore: cStore,
        factsDb: null,
        cfg: { crystallization: cfg } as never,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["skills", "install", proposal.id, "--override-warnings", "--json"], { from: "user" });

      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { ok?: boolean; outputPath?: string };
      expect(output.ok).toBe(true);
      expect(output.outputPath).toBeDefined();
      expect(existsSync(output.outputPath!)).toBe(true);
    } finally {
      cStore.close();
    }
  });

  it("approveProposal re-validates activation using patternSnapshot goals", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-pattern-snapshot-"));
    const validationService = new GeneratedSkillValidationService();
    const wfStore = new WorkflowStore(join(tmpDir, "workflow.db"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    const pattern: WorkflowPattern = {
      toolSequence: ["read", "exec"],
      totalCount: 10,
      successCount: 9,
      failureCount: 1,
      successRate: 0.9,
      avgDurationMs: 1200,
      exampleGoals: ["Review release health checks for the latest deployment."],
    };

    const skillContent = `---
name: release-health-review
description: Use when the user asks to review release health checks.
category: crystallized-workflow
provenance: test-suite
---

# Release Health Review

## Trigger
Use this skill when the user asks to review release health checks or explain the release health workflow.

## Scope
Bounded release-health review workflow.

## When not to use
- Do not use for unrelated tasks.
- Do not use for generic GitHub help.

## Workflow
1. Use \`read\` to inspect the release report.
2. Use \`exec\` only for the bounded release-health validation command.

## Verification
- Confirm release health findings are grounded in the report.

## Anti-patterns / Known Failures
- Do not broaden into generic release management.

## Examples
- Positive: "Review release health checks for the latest deployment."
- Negative: "How do I create a GitHub issue?"
- Edge: "Explain release health workflow without executing the workflow or changing files."

## Provenance
- Source pattern ID: \`pattern-1\``;

    try {
      const initial = validationService.validate({
        outputDir: cfg.outputDir,
        proposedOutputPath: join(cfg.outputDir, "release-health-review", "SKILL.md"),
        skillName: "release-health-review",
        skillContent,
        pattern,
      });
      const expectedPositive = pattern.exampleGoals[0]?.replace(/\s+/g, " ").trim();
      expect(initial.syntheticActivationEval.cases.positive).toBe(expectedPositive);

      const proposal = cStore.create({
        patternId: "pattern-1",
        evidenceHash: "ev-pattern-1",
        skillName: "release-health-review",
        skillContent,
        patternSnapshot: JSON.stringify(pattern),
        validationResult: initial,
        status: "validated",
      });
      const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
      const approved = proposer.approveProposal(proposal.id, {
        overrideWarnings: initial.approvalDecision === "allow-with-override",
      });
      expect(approved.success).toBe(true);

      const stored = cStore.getById(proposal.id);
      expect(stored?.validationResult?.syntheticActivationEval.cases.positive).toBe(expectedPositive);
    } finally {
      wfStore.close();
      cStore.close();
    }
  });

  it("keeps YAML frontmatter at the start when installing approval metadata", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-install-metadata-"));
    const wfStore = new WorkflowStore(join(tmpDir, "workflow.db"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };
    const skillContent = `---
name: metadata-safe-skill
description: Use when the user asks to install metadata safely.
category: crystallized-workflow
provenance: test-suite
---

# Metadata Safe Skill

## Trigger
Use this skill for metadata-safe installation.

## Scope
Bounded metadata installation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Keep frontmatter first.
2. Insert metadata after frontmatter.

## Verification
- Confirm SKILL.md starts with YAML frontmatter.

## Anti-patterns / Known Failures
- Do not put HTML comments before YAML frontmatter.

## Examples
- Install generated skill metadata safely.

## Provenance
- Source pattern ID: \`pattern-metadata\``;

    try {
      const proposal = cStore.create({
        patternId: "pattern-metadata",
        evidenceHash: "ev-pattern-metadata",
        skillName: "metadata-safe-skill",
        skillContent,
        patternSnapshot: JSON.stringify({
          toolSequence: ["read", "write"],
          totalCount: 3,
          successCount: 3,
          failureCount: 0,
          successRate: 1,
          avgDurationMs: 100,
          exampleGoals: ["Install generated skill metadata safely."],
        }),
        status: "validated",
      });
      const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
      const approved = proposer.approveProposal(proposal.id);
      expect(approved.success).toBe(true);
      expect(approved.outputPath).toBeDefined();
      if (!approved.outputPath) return;
      const installed = readFileSync(approved.outputPath, "utf-8");
      expect(installed.startsWith("---\n")).toBe(true);
      expect(installed.indexOf("<!-- openclaw:skill-proposal")).toBeGreaterThan(installed.indexOf("\n---"));
      expect(installed.match(/^---[\s\S]*?---/)?.[0]).toContain("name: metadata-safe-skill");
    } finally {
      wfStore.close();
      cStore.close();
    }
  });

  it("approves legacy auto-crystallized queued drafts without YAML frontmatter", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-legacy-marker-"));
    const wfStore = new WorkflowStore(join(tmpDir, "workflow.db"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    try {
      const proposal = cStore.create({
        patternId: "legacy-marker-pattern",
        evidenceHash: "legacy-marker-evidence",
        skillName: "legacy-marker-skill",
        skillContent: [
          "# Legacy Crystallized Workflow",
          "",
          "> Auto-crystallized from workflow pattern on 2026-05-01.",
          "",
          "Bounded narrative body without YAML.",
        ].join("\n"),
        patternSnapshot: "{}",
        status: "validated",
      });
      const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
      const approved = proposer.approveProposal(proposal.id);
      expect(approved.success).toBe(true);
      expect(approved.outputPath).toBeDefined();
      if (!approved.outputPath) return;
      expect(existsSync(approved.outputPath)).toBe(true);
    } finally {
      wfStore.close();
      cStore.close();
    }
  });

  it("stores actionable validation details when rejecting without an explicit reason", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-rejection-details-"));
    const wfStore = new WorkflowStore(join(tmpDir, "workflow.db"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    try {
      const proposal = cStore.create({
        patternId: "p-validation",
        evidenceHash: "ev-validation",
        skillName: "validation-failure-skill",
        skillContent: "# invalid",
        patternSnapshot: "{}",
        status: "validated",
        validationResult: {
          schemaVersion: 1,
          validatedAt: new Date().toISOString(),
          overallStatus: "failed",
          approvalDecision: "deny",
          staticValidation: {
            status: "failed",
            violations: ["Missing required frontmatter field: name", "Missing required section: ## Trigger"],
            frontmatter: {},
            safeOutputPath: join(tmpDir, "skills", "validation-failure-skill", "SKILL.md"),
          },
          dryLoadValidation: { status: "passed", violations: [], discovered: {} },
          syntheticActivationEval: {
            status: "failed",
            score: 0,
            cases: { positive: "", negative: "", edge: "" },
            results: { positiveMatched: false, negativeMatched: false, edgeMatched: false },
            notes: ["Positive eval did not match the skill trigger"],
          },
          canarySession: { status: "not-run" },
        },
      });
      const proposer = new CrystallizationProposer(wfStore, cStore, cfg);
      const rejected = proposer.rejectProposal(proposal.id);
      expect(rejected.success).toBe(true);
      const stored = cStore.getById(proposal.id);
      expect(stored?.rejectionReason).toContain("Missing required frontmatter field: name");
      expect(stored?.rejectionReason).toContain("Positive eval did not match");
    } finally {
      wfStore.close();
      cStore.close();
    }
  });
});

// ---------------------------------------------------------------------------
// parseSkillFrontmatter — HTML comment prefix (Issue #1363)
// ---------------------------------------------------------------------------

describe("parseSkillFrontmatter — HTML comment prefix", () => {
  const FRONTMATTER_BODY = `---
name: test-skill
description: Use when the user asks to test things.
category: crystallized-workflow
provenance: test-suite
---

# Test Skill
`;

  it("parses frontmatter from content that starts with --- (baseline)", () => {
    const fm = parseSkillFrontmatter(FRONTMATTER_BODY);
    expect(fm.name).toBe("test-skill");
    expect(fm.description).toBe("Use when the user asks to test things.");
    expect(fm.category).toBe("crystallized-workflow");
    expect(fm.provenance).toBe("test-suite");
  });

  it("parses frontmatter when a single-line HTML comment precedes ---", () => {
    const content = `<!-- openclaw:skill-proposal id=abc123 pattern_id=p1 evidence_hash=eh1 output_path=/skills/test-skill/SKILL.md -->\n${FRONTMATTER_BODY}`;
    const fm = parseSkillFrontmatter(content);
    expect(fm.name).toBe("test-skill");
    expect(fm.description).toBe("Use when the user asks to test things.");
  });

  it("parses frontmatter when BOM and whitespace precede an HTML comment", () => {
    const content = `\uFEFF\n  \t\n<!-- openclaw:skill-proposal id=abc123 -->\n${FRONTMATTER_BODY}`;
    const fm = parseSkillFrontmatter(content);
    expect(fm.name).toBe("test-skill");
    expect(fm.description).toBe("Use when the user asks to test things.");
  });

  it("parses frontmatter when a multi-line HTML comment precedes ---", () => {
    const content = `<!-- openclaw:skill-proposal\n  id=abc123\n  pattern_id=p1\n-->\n${FRONTMATTER_BODY}`;
    const fm = parseSkillFrontmatter(content);
    expect(fm.name).toBe("test-skill");
    expect(fm.description).toBe("Use when the user asks to test things.");
  });

  it("parses frontmatter after multiple leading HTML comments", () => {
    const content = `<!-- first metadata wrapper -->
<!-- second metadata wrapper -->
${FRONTMATTER_BODY}`;
    const fm = parseSkillFrontmatter(content);
    expect(fm.name).toBe("test-skill");
    expect(fm.description).toBe("Use when the user asks to test things.");
  });

  it("parses frontmatter after an inline closing HTML comment marker", () => {
    const content = `<!-- openclaw:skill-proposal id=abc123 --> ${FRONTMATTER_BODY}`;
    const fm = parseSkillFrontmatter(content);
    expect(fm.name).toBe("test-skill");
    expect(fm.description).toBe("Use when the user asks to test things.");
  });

  it("returns empty object when content is only an HTML comment with no frontmatter", () => {
    const content = "<!-- openclaw:skill-proposal id=abc123 -->\n# Plain Markdown\n\nNo frontmatter here.";
    const fm = parseSkillFrontmatter(content);
    expect(fm).toEqual({});
  });

  it("returns empty object for plain markdown with no frontmatter and no HTML comment", () => {
    const fm = parseSkillFrontmatter("# Plain Markdown\n\nNo frontmatter here.");
    expect(fm).toEqual({});
  });
});
