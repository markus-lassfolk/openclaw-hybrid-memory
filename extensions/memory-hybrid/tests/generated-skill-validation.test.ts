import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrystallizationStore } from "../backends/crystallization-store.js";
import type { WorkflowPattern } from "../backends/workflow-store.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import { registerSkillsCommands } from "../cli/skills.js";
import { CATEGORY_SECTION_TAXONOMIES } from "../config/skill-sections.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import { CrystallizationProposer } from "../services/crystallization-proposer.js";
import { GeneratedSkillValidationService, parseSkillFrontmatter } from "../services/generated-skill-validation.js";
import { crystallizeSkill } from "../services/skill-crystallizer.js";
import { buildNonPlaceholderEmailPattern } from "../services/skill-validator.js";
import { SKILL_COMPLETE_MARKER } from "../utils/atomic-write.js";
import { discoverCompletedSkillDirs } from "../utils/skill-discovery.js";

const BASE_CFG: CrystallizationConfig = {
  enabled: true,
  minUsageCount: 2,
  minSuccessRate: 0.5,
  autoApprove: false,
  outputDir: "",
  maxCrystallized: 50,
  pruneUnusedDays: 30,
  placeholderEmailDomains: ["example.com", "localhost", "test.com", "example.org"],
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

    const result = crystallizeSkill({ patternId: "short-goal", evidenceHash: "ev-short", pattern }, cfg);
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
        .map((line: string) => line.trim())
        .filter((line: string) => line.startsWith("- ")) ?? [];

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

    const result = crystallizeSkill({ patternId: "email-goal", evidenceHash: "ev-mail", pattern }, cfg);
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

    const result = crystallizeSkill({ patternId: "abc123", evidenceHash: "ev-abc", pattern }, cfg);
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

  it("dry-load discovery skips markerless skill directories as in-progress", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-markerless-dry-load-"));
    const skillsDir = join(tmpDir, "skills");
    const markerlessDir = join(skillsDir, "half-written-skill");
    mkdirSync(markerlessDir, { recursive: true });
    writeFileSync(
      join(markerlessDir, "SKILL.md"),
      `---
name: half-written-skill
description: This markerless skill must be treated as in-progress.
---
`,
      "utf-8",
    );

    expect(discoverCompletedSkillDirs(skillsDir)).toEqual([]);
  });

  it("dry-load discovery includes only skills with the completion marker", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-complete-dry-load-"));
    const skillsDir = join(tmpDir, "skills");
    const completedDir = join(skillsDir, "complete-skill");
    mkdirSync(completedDir, { recursive: true });
    writeFileSync(
      join(completedDir, "SKILL.md"),
      `---
name: complete-skill
description: This skill has a completion marker.
---
`,
      "utf-8",
    );
    writeFileSync(join(completedDir, SKILL_COMPLETE_MARKER), "2024-01-01T00:00:00.000Z", "utf-8");

    const markerlessDir = join(skillsDir, "half-written-skill");
    mkdirSync(markerlessDir, { recursive: true });
    writeFileSync(
      join(markerlessDir, "SKILL.md"),
      `---
name: half-written-skill
description: This markerless skill must be treated as in-progress.
---
`,
      "utf-8",
    );

    expect(discoverCompletedSkillDirs(skillsDir).map((entry) => entry.name)).toEqual(["complete-skill"]);
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

  it("reports missing category as a static frontmatter violation without dry-load exceptions", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-missing-category-"));
    const service = new GeneratedSkillValidationService();
    const skillContent = `---
name: missing-category-skill
description: Use when validating missing category handling.
provenance: test-suite
---

# Missing Category Skill

## Trigger
Use this skill when validating missing category handling.

## Scope
Bounded missing-category validation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Validate frontmatter requirements.
2. Confirm dry-load does not throw generic errors.

## Verification
- Confirm missing category is reported as a static validator violation.

## Anti-patterns / Known Failures
- Do not treat missing category as a dry-load exception.

## Examples
- Validate missing category handling in generated skill validation.

## Provenance
- Source pattern ID: \`pattern-missing-category\``;

    const validation = service.validate({
      outputDir: join(tmpDir, "skills"),
      proposedOutputPath: join(tmpDir, "skills", "missing-category-skill", "SKILL.md"),
      skillName: "missing-category-skill",
      skillContent,
    });

    expect(validation.staticValidation.status).toBe("failed");
    expect(validation.staticValidation.violations.some((v) => v.includes("required category"))).toBe(true);
    expect(validation.dryLoadValidation.violations.some((v) => v.includes("Dry-load validation failed"))).toBe(false);
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
      process.exitCode = undefined;
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

  // ============================================================================
  // Issue #1383 — custom placeholder-email allow-list
  // ============================================================================
  describe("GeneratedSkillValidationService — custom placeholderEmailDomains", () => {
    let tmpDir: string;

    afterEach(() => {
      vi.restoreAllMocks();
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("flags an internal-placeholder email address with the default allow-list", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "gsv-custom-email-default-"));
      const skillContent = makeMinimalSkill("custom-domain-test", "team@company.internal");
      const defaultPattern = buildNonPlaceholderEmailPattern(["example.com", "localhost", "test.com", "example.org"]);
      expect(defaultPattern.test(skillContent)).toBe(true);
      expect(defaultPattern.test(makeMinimalSkill("custom-domain-test", "team@EXAMPLE.COM"))).toBe(false);
    });

    it("does not flag custom placeholder domain when configured with extended allow-list", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "gsv-custom-email-extended-"));
      const customEmailPattern = buildNonPlaceholderEmailPattern([
        "example.com",
        "localhost",
        "test.com",
        "example.org",
        "company.internal",
      ]);
      const service = new GeneratedSkillValidationService({ emailPattern: customEmailPattern });
      const cfg: CrystallizationConfig = {
        ...BASE_CFG,
        outputDir: join(tmpDir, "skills"),
        placeholderEmailDomains: ["example.com", "localhost", "test.com", "example.org", "company.internal"],
      };
      const pattern = {
        toolSequence: ["read", "write"],
        totalCount: 5,
        successCount: 5,
        failureCount: 0,
        successRate: 1,
        avgDurationMs: 400,
        exampleGoals: ["Send the weekly summary to ops@company.internal after deploy"],
      };
      const result = crystallize(cfg, { patternId: "custom-domain-goal", evidenceHash: "ev-custom", pattern });
      const validation = service.validate({
        outputDir: cfg.outputDir,
        proposedOutputPath: result.proposedOutputPath,
        skillName: result.skillName,
        skillContent: result.skillContent,
        pattern,
      });
      const emailViolations = validation.staticValidation.violations.filter(
        (v) => v.includes("email") || v.includes("company.internal"),
      );
      expect(emailViolations).toHaveLength(0);
    });

    it("parseCrystallizationConfig picks up custom placeholderEmailDomains", async () => {
      const { hybridConfigSchema } = await import("../config.js");
      const cfg = hybridConfigSchema.parse({
        embedding: {
          provider: "openai",
          apiKey: "sk-test-key-12345678",
          model: "text-embedding-3-small",
        },
        crystallization: {
          placeholderEmailDomains: ["example.com", "company.internal"],
        },
      });
      expect(cfg.crystallization.placeholderEmailDomains).toEqual(["example.com", "company.internal"]);
    });

    it("parseCrystallizationConfig defaults to standard domains when field is omitted", async () => {
      const { hybridConfigSchema } = await import("../config.js");
      const cfg = hybridConfigSchema.parse({
        embedding: {
          provider: "openai",
          apiKey: "sk-test-key-12345678",
          model: "text-embedding-3-small",
        },
        mode: "minimal",
      });
      expect(cfg.crystallization.placeholderEmailDomains).toEqual([
        "example.com",
        "localhost",
        "test.com",
        "example.org",
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function makeMinimalSkill(skillName: string, emailInContent: string): string {
    return `---
name: ${skillName}
description: Minimal skill for email pattern tests.
category: test
provenance: test-suite
---

# ${skillName}

## Trigger
- Use this skill for email-pattern validation tests.

## Scope
- Bounded to test fixtures.

## When not to use
- When no email validation is needed.

## Workflow
1. Contact: ${emailInContent}
2. Verify output.

## Examples
- Good: "Test the email pattern validation."

## Provenance
- Generated for email-pattern tests.
`;
  }

  // ---------------------------------------------------------------------------
  // parseSkillFrontmatter — HTML comment prefix (Issue #1363)
  // ---------------------------------------------------------------------------

  it("validateProposal produces the same outcome prediction as approveProposal (issue #1402)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-validate-vs-approve-"));
    const wfStore = new WorkflowStore(join(tmpDir, "workflow.db"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    try {
      const skillContent = `---
name: ops-validate-consistency
description: Use when the user asks to validate installation consistency.
category: crystallized-workflow
provenance: test-suite
---

# Ops Validate Consistency

## Trigger
Use this skill when the user asks to validate installation consistency.

## Scope
Bounded validation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Use \`read\` to inspect the configuration.
2. Use \`exec\` to run the validation commands.

## Verification
- Confirm validation results match expectations.

## Anti-patterns / Known Failures
- Do not skip verification steps.

## Examples
- Validate installation consistency for the latest deployment.

## Provenance
- Source pattern ID: \`pattern-validate-consistency\``;

      const pattern: WorkflowPattern = {
        toolSequence: ["read", "exec"],
        totalCount: 5,
        successCount: 5,
        failureCount: 0,
        successRate: 1,
        avgDurationMs: 500,
        exampleGoals: ["Validate installation consistency for the latest deployment."],
      };

      const proposal = cStore.create({
        patternId: "pattern-validate-consistency",
        evidenceHash: "ev-validate-consistency",
        skillName: "ops-validate-consistency",
        skillContent,
        patternSnapshot: JSON.stringify(pattern),
        status: "validated",
      });

      const proposer = new CrystallizationProposer(wfStore, cStore, cfg);

      // validateProposal must predict the same outcome as approveProposal.
      const validateResult = proposer.validateProposal(proposal.id);
      expect(validateResult).not.toBeNull();
      if (!validateResult) return;

      const approveResult = proposer.approveProposal(proposal.id, {
        overrideWarnings: validateResult.approvalDecision === "allow-with-override",
      });

      // The validate prediction must agree with the approve outcome.
      expect(approveResult.success).toBe(validateResult.approvalDecision !== "deny");
    } finally {
      wfStore.close();
      cStore.close();
    }
  });

  it("SkillValidator and GeneratedSkillValidationService agree on alias-based section names (issue #1375)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-alias-agreement-"));
    const service = new GeneratedSkillValidationService();

    // Fixture using "## When to Activate" instead of "## Trigger" — accepted by SkillValidator
    // but previously rejected by GSV's exact-match check.
    const skillWithAlias = `---
name: alias-section-skill
description: Use when the user asks to test alias-based section validation.
category: crystallized-workflow
provenance: test-suite
---

# Alias Section Skill

## When to Activate
Use this skill for alias-based section validation.

## Scope
Bounded alias validation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect the alias configuration.
2. Run the bounded alias validation.

## Verification
- Confirm alias mappings are correct.

## Anti-patterns / Known Failures
- Do not hard-code section names.

## Examples
- Test alias-based section validation for generated skills.

## Provenance
- Source pattern ID: \`pattern-alias\``;

    const validation = service.validate({
      outputDir: join(tmpDir, "skills"),
      proposedOutputPath: join(tmpDir, "skills", "alias-section-skill", "SKILL.md"),
      skillName: "alias-section-skill",
      skillContent: skillWithAlias,
      pattern: {
        toolSequence: ["read"],
        totalCount: 3,
        successCount: 3,
        failureCount: 0,
        successRate: 1,
        avgDurationMs: 100,
        exampleGoals: ["Test alias-based section validation for generated skills."],
      },
    });

    // The skill uses "## When to Activate" (a valid alias for "trigger").
    // Both SkillValidator (propagated through GSV staticValidation) and GSV itself
    // must accept it — no "Missing required section" for the trigger.
    const triggerViolation = validation.staticValidation.violations.some(
      (v) => v.toLowerCase().includes("trigger") || v.toLowerCase().includes("when to activate"),
    );
    expect(triggerViolation).toBe(false);
    expect(validation.staticValidation.status).toBe("passed");
  });

  it("both validators agree: skill using all canonical section names passes without violations (issue #1375)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-canonical-sections-"));
    const service = new GeneratedSkillValidationService();

    const skillContent = `---
name: canonical-sections-skill
description: Use when the user asks to verify canonical section naming.
category: crystallized-workflow
provenance: test-suite
---

# Canonical Sections Skill

## Trigger
Use this skill when the user asks to verify canonical section naming.

## Scope
Bounded canonical section verification workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect the canonical section names.
2. Validate each required section.

## Verification
- Confirm all required sections are present and correctly named.

## Anti-patterns / Known Failures
- Do not use section aliases when canonical names are available.

## Examples
- Verify canonical section naming for generated skills.

## Provenance
- Source pattern ID: \`pattern-canonical\``;

    const validation = service.validate({
      outputDir: join(tmpDir, "skills"),
      proposedOutputPath: join(tmpDir, "skills", "canonical-sections-skill", "SKILL.md"),
      skillName: "canonical-sections-skill",
      skillContent,
    });

    expect(validation.staticValidation.violations.filter((v) => v.includes("required section"))).toHaveLength(0);
    expect(validation.staticValidation.status).toBe("passed");
  });

  it("rejects a skill missing Scope and Provenance (unified taxonomy coverage — issue #1375, #1366)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-missing-sections-"));
    const service = new GeneratedSkillValidationService();

    // Skill that would have passed the OLD SkillValidator (which didn't check Scope/Provenance)
    // but must now fail because the unified taxonomy includes them.
    const skillMissingGsvOnlySections = `---
name: missing-scope-provenance
description: Use when the user asks to detect missing required sections.
category: crystallized-workflow
provenance: test-suite
---

# Missing Scope Provenance

## Trigger
Use this skill for missing-section detection.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect the section configuration.

## Verification
- Confirm all required sections pass.

## Anti-patterns / Known Failures
- Do not skip provenance.

## Examples
- Detect missing required sections in generated skills.`;

    // No ## Scope and no ## Provenance sections.
    const validation = service.validate({
      outputDir: join(tmpDir, "skills"),
      proposedOutputPath: join(tmpDir, "skills", "missing-scope-provenance", "SKILL.md"),
      skillName: "missing-scope-provenance",
      skillContent: skillMissingGsvOnlySections,
    });

    const missingSections = validation.staticValidation.violations.filter((v) => v.includes("required section"));
    expect(missingSections.some((v) => /scope/i.test(v))).toBe(true);
    expect(missingSections.some((v) => /provenance/i.test(v))).toBe(true);
    expect(validation.approvalDecision).toBe("deny");
  });

  it("MAX_SKILL_LINES is the same constant (300) used by both validators (issue #1366)", async () => {
    // Import both constants to confirm they resolve to the same value.
    const { MAX_SKILL_LINES: configConst } = await import("../config/skill-sections.js");
    const { MAX_SKILL_LINES: svConst } = await import("../services/skill-validator.js");
    expect(configConst).toBe(300);
    expect(svConst).toBe(300);
    expect(configConst).toBe(svConst);
  });

  it("getSectionTaxonomy returns per-category override when registered (issue #1408)", async () => {
    const { DEFAULT_REQUIRED_SECTIONS, CATEGORY_SECTION_TAXONOMIES, getSectionTaxonomy } = await import(
      "../config/skill-sections.js"
    );
    // By default, all categories use the default taxonomy.
    expect(getSectionTaxonomy("unknown-category")).toEqual(DEFAULT_REQUIRED_SECTIONS);
    expect(getSectionTaxonomy()).toEqual(DEFAULT_REQUIRED_SECTIONS);

    // Temporarily register a custom taxonomy for a test category.
    const customTaxonomy = [
      { id: "risk", label: "Risk", aliases: ["risk", "risks"] },
      { id: "examples", label: "Examples", aliases: ["examples"] },
    ];
    CATEGORY_SECTION_TAXONOMIES["test-category"] = customTaxonomy;
    try {
      const result = getSectionTaxonomy("test-category");
      expect(result).toEqual(customTaxonomy);
      expect(result).not.toEqual(DEFAULT_REQUIRED_SECTIONS);
    } finally {
      CATEGORY_SECTION_TAXONOMIES["test-category"] = [] as never;
    }
  });

  it("skills validate --json reports same outcome as skills install would produce (CLI parity — issue #1402)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-cli-validate-parity-"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    try {
      const skillContent = `---
name: cli-validate-parity
description: Use when the user asks to verify CLI validate and install parity.
category: crystallized-workflow
provenance: test-suite
---

# CLI Validate Parity

## Trigger
Use this skill when the user asks to verify CLI validate and install parity.

## Scope
Bounded CLI parity verification workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Use \`read\` to inspect the CLI configuration.
2. Use \`exec\` to run the parity verification.

## Verification
- Confirm validate and install produce consistent outcomes.

## Anti-patterns / Known Failures
- Do not bypass validation in install.

## Examples
- Positive: "Verify CLI validate and install parity for the latest deployment."
- Negative: "How do I create a GitHub issue?"

## Provenance
- Source pattern ID: \`pattern-cli-parity\``;

      const proposal = cStore.create({
        patternId: "pattern-cli-parity",
        evidenceHash: "ev-cli-parity",
        skillName: "cli-validate-parity",
        skillContent,
        patternSnapshot: JSON.stringify({
          toolSequence: ["read", "exec"],
          totalCount: 4,
          successCount: 4,
          failureCount: 0,
          successRate: 1,
          avgDurationMs: 300,
          exampleGoals: ["Verify CLI validate and install parity for the latest deployment."],
        }),
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

      // Run skills validate --json
      await program.parseAsync(["skills", "validate", proposal.id, "--json"], { from: "user" });
      const validateOutput = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
        ok?: boolean;
        approvalDecision?: string;
      };

      logSpy.mockClear();

      // Run plain skills install --json: validate predicts this outcome without an override.
      await program.parseAsync(["skills", "install", proposal.id, "--json"], { from: "user" });
      const installOutput = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { ok?: boolean };

      // Validate must predict the same success/failure outcome as plain install.
      expect(installOutput.ok).toBe(validateOutput.ok);
    } finally {
      cStore.close();
    }
  });

  it("skills install --dry-run does not write to disk and reports the same outcome as validate (issue #1402)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-dry-run-"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    try {
      const skillContent = `---
name: dry-run-test-skill
description: Use when the user asks to test the dry-run install path.
category: crystallized-workflow
provenance: test-suite
---

# Dry Run Test Skill

## Trigger
Use this skill when the user asks to test the dry-run install path.

## Scope
Bounded dry-run test workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Use \`read\` to inspect the configuration.
2. Verify the dry-run result.

## Verification
- Confirm the skill was NOT written to disk.

## Anti-patterns / Known Failures
- Do not mistake dry-run output for actual installation.

## Examples
- Positive: "Test the dry-run install path for generated skills."
- Negative: "How much does an adult emperor penguin weigh on average?"
- Edge: "Explain dry-run override handling without executing the workflow or changing files."

## Provenance
- Source pattern ID: \`pattern-dry-run\``;

      const proposal = cStore.create({
        patternId: "pattern-dry-run",
        evidenceHash: "ev-dry-run",
        skillName: "dry-run-test-skill",
        skillContent,
        patternSnapshot: JSON.stringify({
          toolSequence: ["read"],
          totalCount: 3,
          successCount: 3,
          failureCount: 0,
          successRate: 1,
          avgDurationMs: 200,
          exampleGoals: ["Test the dry-run install path for generated skills."],
        }),
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

      await program.parseAsync(["skills", "install", proposal.id, "--dry-run", "--json"], { from: "user" });

      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
        dryRun?: boolean;
        ok?: boolean;
        staticValidation?: { outputPath?: string };
      };
      expect(output.dryRun).toBe(true);
      // Dry run must NOT create the skill file on disk.
      if (output.staticValidation?.outputPath) {
        expect(existsSync(output.staticValidation.outputPath)).toBe(false);
      }
    } finally {
      cStore.close();
    }
  });

  it("skills install --dry-run requires override for allow-with-override proposals", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-dry-run-override-"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const cfg: CrystallizationConfig = { ...BASE_CFG, outputDir: join(tmpDir, "skills") };

    try {
      const skillContent = `---
name: dry-run-override-skill
description: Use when the user asks to review dry-run override behavior.
category: crystallized-workflow
provenance: test-suite
---

# Dry Run Override Skill

## Trigger
Use this skill when the user asks to review dry-run override behavior or explain dry-run override handling.

## Scope
Bounded dry-run override verification workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Use \`read\` to inspect the generated skill proposal.
2. Verify whether override handling matches install behavior.

## Verification
- Confirm dry-run reports failure without an explicit warning override.

## Anti-patterns / Known Failures
- Do not report override-required proposals as installable without override.

## Examples
- Positive: "Review dry-run override handling for generated skills."
- Negative: "How much does an adult emperor penguin weigh on average?"
- Edge: "Explain dry-run override handling without executing the workflow or changing files."

## Provenance
- Source pattern ID: \`pattern-dry-run-override\``;

      const proposal = cStore.create({
        patternId: "pattern-dry-run-override",
        evidenceHash: "ev-dry-run-override",
        skillName: "dry-run-override-skill",
        skillContent,
        patternSnapshot: JSON.stringify({
          toolSequence: ["read"],
          totalCount: 3,
          successCount: 3,
          failureCount: 0,
          successRate: 1,
          avgDurationMs: 200,
          exampleGoals: ["Review dry-run override handling for generated skills."],
        }),
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

      await program.parseAsync(["skills", "install", proposal.id, "--dry-run", "--json"], { from: "user" });
      expect(process.exitCode).toBe(2);
      const withoutOverride = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
        ok?: boolean;
        approvalDecision?: string;
      };
      expect(withoutOverride.approvalDecision).toBe("allow-with-override");
      expect(withoutOverride.ok).toBe(false);

      logSpy.mockClear();
      process.exitCode = undefined;
      await program.parseAsync(["skills", "validate", proposal.id, "--json"], { from: "user" });
      expect(process.exitCode).toBe(2);
      const validateOutput = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
        ok?: boolean;
        approvalDecision?: string;
      };
      expect(validateOutput.approvalDecision).toBe("allow-with-override");
      expect(validateOutput.ok).toBe(false);

      logSpy.mockClear();
      process.exitCode = undefined;
      await program.parseAsync(["skills", "install", proposal.id, "--dry-run", "--override-warnings", "--json"], {
        from: "user",
      });
      const withOverride = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { ok?: boolean };
      expect(withOverride.ok).toBe(true);
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = undefined;
      cStore.close();
    }
  });

  it("uses alternate category frontmatter keys for section taxonomy overrides", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-alt-category-taxonomy-"));
    const service = new GeneratedSkillValidationService();
    const skillContent = `---
name: alt-category-taxonomy
description: Use when validating alternate category metadata keys.
type: explain-skill
provenance: test-suite
---

# Alt Category Taxonomy

## Trigger
Use this skill when validating alternate category metadata keys.

## Scope
Bounded alternate-category validation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect metadata and section requirements.
2. Confirm alternate category keys drive taxonomy lookup.

## Verification
- Confirm missing category-specific sections are reported.

## Anti-patterns / Known Failures
- Do not ignore accepted category alias keys.

## Examples
- Positive: "Validate an explain skill with type frontmatter."
- Negative: "How do I create a calendar event?"

## Provenance
- Source pattern ID: \`pattern-alt-category-taxonomy\``;

    CATEGORY_SECTION_TAXONOMIES["explain-skill"] = [
      { id: "custom-required", label: "Custom Required", aliases: ["custom required"] },
    ];

    try {
      const validation = service.validate({
        outputDir: join(tmpDir, "skills"),
        proposedOutputPath: join(tmpDir, "skills", "alt-category-taxonomy", "SKILL.md"),
        skillName: "alt-category-taxonomy",
        skillContent,
        pattern: {
          toolSequence: ["read"],
          totalCount: 3,
          successCount: 3,
          failureCount: 0,
          successRate: 1,
          avgDurationMs: 200,
          exampleGoals: ["Validate an explain skill with type frontmatter."],
        },
      });

      expect(validation.staticValidation.violations).toContain("Missing required section: Custom Required");
    } finally {
      CATEGORY_SECTION_TAXONOMIES["explain-skill"] = [] as never;
    }
  });

  it("validateProposal denies proposals install would reject before validation", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-validate-preflight-"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    const baseSkillContent = `---
name: preflight-status-skill
description: Use when checking install preflight parity.
category: crystallized-workflow
provenance: test-suite
---

# Preflight Status Skill

## Trigger
Use this skill when checking install preflight parity.

## Scope
Bounded preflight validation.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect proposal state.
2. Compare validate and install preflight behavior.

## Verification
- Confirm validate denies non-approvable proposals.

## Anti-patterns / Known Failures
- Do not predict install success for terminal states.

## Examples
- Check install preflight parity for proposal states.

## Provenance
- Source pattern ID: \`pattern-preflight\``;

    try {
      const installed = cStore.create({
        patternId: "pattern-preflight-installed",
        evidenceHash: "ev-preflight-installed",
        skillName: "preflight-status-skill",
        skillContent: baseSkillContent,
        patternSnapshot: JSON.stringify({
          toolSequence: ["read"],
          totalCount: 3,
          successCount: 3,
          failureCount: 0,
          successRate: 1,
          avgDurationMs: 200,
          exampleGoals: ["Check install preflight parity for proposal states."],
        }),
        status: "installed",
      });
      const proposer = new CrystallizationProposer(null, cStore, { ...BASE_CFG, outputDir: join(tmpDir, "skills") });
      const statusResult = proposer.validateProposal(installed.id);
      expect(statusResult?.approvalDecision).toBe("deny");
      expect(statusResult?.staticValidation.violations[0]).toMatch(/not approvable/i);

      const limitedStore = new CrystallizationStore(join(tmpDir, "limited.db"));
      try {
        limitedStore.create({
          patternId: "pattern-existing-approved",
          evidenceHash: "ev-existing-approved",
          skillName: "existing-approved-skill",
          skillContent: baseSkillContent.replaceAll("preflight-status-skill", "existing-approved-skill"),
          patternSnapshot: "{}",
          status: "approved",
        });
        const candidate = limitedStore.create({
          patternId: "pattern-preflight-candidate",
          evidenceHash: "ev-preflight-candidate",
          skillName: "preflight-status-skill",
          skillContent: baseSkillContent,
          patternSnapshot: "{}",
          status: "validated",
        });
        const limited = new CrystallizationProposer(null, limitedStore, {
          ...BASE_CFG,
          outputDir: join(tmpDir, "limited-skills"),
          maxCrystallized: 1,
        });
        const maxResult = limited.validateProposal(candidate.id);
        expect(maxResult?.approvalDecision).toBe("deny");
        expect(maxResult?.staticValidation.violations[0]).toMatch(/maxCrystallized/i);
      } finally {
        limitedStore.close();
      }
    } finally {
      cStore.close();
    }
  });

  it("honors project-level section taxonomy overrides from crystallization config (issue #1408)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-project-taxonomy-"));
    const cStore = new CrystallizationStore(join(tmpDir, "crystallization.db"));
    try {
      const skillContent = `---
name: project-taxonomy-skill
description: Use when validating configured project taxonomy overrides.
category: custom-project-skill
provenance: test-suite
---

# Project Taxonomy Skill

## Trigger
Use this skill when validating configured project taxonomy overrides.

## Workflow
1. Inspect configured section taxonomy.
2. Confirm project-level overrides drive validation.

## Examples
- Validate configured project taxonomy overrides.`;
      const proposal = cStore.create({
        patternId: "pattern-project-taxonomy",
        evidenceHash: "ev-project-taxonomy",
        skillName: "project-taxonomy-skill",
        skillContent,
        patternSnapshot: JSON.stringify({
          toolSequence: ["read"],
          totalCount: 3,
          successCount: 3,
          failureCount: 0,
          successRate: 1,
          avgDurationMs: 200,
          exampleGoals: ["Validate configured project taxonomy overrides."],
        }),
        status: "validated",
      });

      const proposer = new CrystallizationProposer(null, cStore, {
        ...BASE_CFG,
        outputDir: join(tmpDir, "skills"),
        sectionTaxonomy: {
          "custom-project-skill": [
            { id: "trigger", label: "Trigger", aliases: ["trigger"] },
            { id: "workflow", label: "Workflow", aliases: ["workflow"] },
            { id: "risk", label: "Risk", aliases: ["risk"] },
            { id: "examples", label: "Examples", aliases: ["examples"] },
          ],
        },
      });

      const validation = proposer.validateProposal(proposal.id);
      const sectionViolations = validation?.staticValidation.violations.filter((v) => v.includes("required section"));
      expect(sectionViolations).toEqual(["Missing required section: Risk"]);
    } finally {
      cStore.close();
    }
  });

  it("uses quoted category frontmatter values for section taxonomy overrides", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-quoted-category-taxonomy-"));
    const service = new GeneratedSkillValidationService();
    const skillContent = `---
name: quoted-category-taxonomy
description: Use when validating quoted category metadata values.
category: "explain-skill"
provenance: test-suite
---

# Quoted Category Taxonomy

## Trigger
Use this skill when validating quoted category metadata values.

## Scope
Bounded quoted-category validation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect metadata and section requirements.
2. Confirm quoted category values drive taxonomy lookup.

## Verification
- Confirm missing category-specific sections are reported.

## Anti-patterns / Known Failures
- Do not include YAML quotes in taxonomy lookup keys.

## Examples
- Validate quoted explain skill category frontmatter.

## Provenance
- Source pattern ID: \`pattern-quoted-category-taxonomy\``;

    CATEGORY_SECTION_TAXONOMIES["explain-skill"] = [
      { id: "custom-required", label: "Custom Required", aliases: ["custom required"] },
    ];

    try {
      const validation = service.validate({
        outputDir: join(tmpDir, "skills"),
        proposedOutputPath: join(tmpDir, "skills", "quoted-category-taxonomy", "SKILL.md"),
        skillName: "quoted-category-taxonomy",
        skillContent,
        pattern: {
          toolSequence: ["read"],
          totalCount: 3,
          successCount: 3,
          failureCount: 0,
          successRate: 1,
          avgDurationMs: 200,
          exampleGoals: ["Validate quoted explain skill category frontmatter."],
        },
      });

      expect(validation.staticValidation.violations).toContain("Missing required section: Custom Required");
    } finally {
      CATEGORY_SECTION_TAXONOMIES["explain-skill"] = [] as never;
    }
  });

  it("extracts trigger aliases using shared heading normalization", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "generated-skill-normalized-alias-"));
    const service = new GeneratedSkillValidationService();
    const skillContent = `---
name: normalized-alias-skill
description: Use when a generated workflow is needed.
category: crystallized-workflow
provenance: test-suite
---

# Normalized Alias Skill

## When to Activate:
Use this skill when the user asks to investigate payroll webhook retries after timeout.

## Scope
Bounded normalized heading alias validation workflow.

## When not to use
- Do not use for unrelated tasks.

## Workflow
1. Inspect retry logs.
2. Summarize the timeout pattern.

## Verification
- Confirm normalized heading aliases feed activation evaluation.

## Anti-patterns / Known Failures
- Do not rely on exact heading punctuation.

## Examples
- Investigate payroll webhook retries after timeout.

## Provenance
- Source pattern ID: \`pattern-normalized-alias\``;

    const validation = service.validate({
      outputDir: join(tmpDir, "skills"),
      proposedOutputPath: join(tmpDir, "skills", "normalized-alias-skill", "SKILL.md"),
      skillName: "normalized-alias-skill",
      skillContent,
      pattern: {
        toolSequence: ["read"],
        totalCount: 3,
        successCount: 3,
        failureCount: 0,
        successRate: 1,
        avgDurationMs: 200,
        exampleGoals: ["Investigate payroll webhook retries after timeout."],
      },
    });

    expect(validation.staticValidation.status).toBe("passed");
    expect(validation.syntheticActivationEval.results.positiveMatched).toBe(true);
  });
});
