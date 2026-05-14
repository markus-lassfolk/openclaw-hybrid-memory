import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern } from "../backends/workflow-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";
import { GeneratedSkillValidationService } from "../services/generated-skill-validation.js";
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
});
