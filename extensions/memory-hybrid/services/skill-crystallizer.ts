import { getEnv } from "../utils/env-manager.js";
/**
 * Skill Crystallizer — generate SKILL.md files from workflow patterns (Issue #208).
 *
 * Takes a crystallization candidate (pattern + metadata) and produces a SKILL.md
 * following the AgentSkill format. Optionally generates a helper shell script
 * when the pattern is composed entirely of exec calls.
 */

import { homedir } from "node:os";
import type { WorkflowPattern } from "../backends/workflow-store.js";
import type { CrystallizationConfig } from "../config/types/features.js";
import type { SkillProposalCard, SkillProposalRecommendedOutput } from "../backends/crystallization-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface CrystallizationInput {
  patternId: string;
  evidenceHash: string;
  pattern: WorkflowPattern;
}

interface CrystallizationResult {
  skillName: string;
  skillContent: string;
  proposalCard: SkillProposalCard;
  /** Resolved output path for the SKILL.md (not yet written to disk — requires approval) */
  proposedOutputPath: string;
  /** Whether a companion shell script was generated */
  hasScript: boolean;
  /** Shell script content if hasScript === true */
  scriptContent?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a kebab-case skill name from example goals and tool sequence.
 * Prefers the first example goal, falls back to tool sequence hash.
 */
export function deriveSkillName(exampleGoals: string[], toolSequence: string[], patternId: string): string {
  // Try to extract a short phrase from the first example goal
  const firstGoal = exampleGoals[0];
  if (firstGoal && firstGoal.trim().length > 0) {
    const slug = firstGoal
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join("-");
    if (slug.length >= 3) return `auto-${slug}`;
  }

  // Fall back: use the first two tool names + hash fragment (lowercase for consistency)
  const toolSlug = toolSequence
    .slice(0, 2)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  return `auto-${toolSlug}-${patternId.slice(0, 6)}`;
}

/**
 * Check whether a tool sequence is entirely exec calls (shell-automatable).
 */
export function isExecOnlySequence(toolSequence: string[]): boolean {
  return toolSequence.length > 0 && toolSequence.every((t) => t === "exec");
}

// ---------------------------------------------------------------------------
// SKILL.md template builder
// ---------------------------------------------------------------------------

function buildSkillContent(
  skillName: string,
  pattern: WorkflowPattern,
  patternId: string,
  evidenceHash: string,
  createdAt: string,
  card: SkillProposalCard,
): string {
  const toolSequence = pattern.toolSequence;
  const successPct = Math.round(pattern.successRate * 100);
  const exampleGoalsText = card.provenance.example_goals.length
    ? card.provenance.example_goals.map((g) => `- ${g.replace(/\n/g, " ")}`).join("\n")
    : "- (no example goals recorded)";
  const capturesText = card.captures.length ? card.captures.map((c) => `- ${c}`).join("\n") : "- (none)";

  const stepsText = toolSequence
    .map(
      (tool, i) =>
        `${i + 1}. Use \`${tool}\` only for the bounded task, follow the host tool schema, keep side-effects minimal, and verify before continuing.`,
    )
    .join("\n");

  const antiPatterns =
    pattern.failureCount > 0
      ? `- Do not assume the pattern always succeeds (${pattern.failureCount} recorded failures). Add a verification gate and record feedback on failure.\n- Do not paste raw logs or tool-call blobs into this skill; summarize as workflow phases and checklists.\n- Do not broaden scope beyond the example goals; ask for clarification on near-miss tasks.\n- Do not claim implementation work is complete unless a PR exists or the change is merged to \`main\`.\n- Do not poll subagents in a tight loop; yield and wait for push-based completion.`
      : `- Do not paste raw logs or tool-call blobs into this skill; summarize as workflow phases and checklists.\n- Do not broaden scope beyond the example goals; ask for clarification on near-miss tasks.\n- Do not treat tool sequencing as sufficient; always include verification and failure handling.\n- Do not claim implementation work is complete unless a PR exists or the change is merged to \`main\`.\n- Do not poll subagents in a tight loop; yield and wait for push-based completion.`;

  return `---
name: ${skillName}
description: Reusable workflow distilled from a repeated tool-sequence pattern (${successPct}% success). Use for tasks that match the activation examples.
category: crystallized
provenance: workflow-pattern:${patternId}
generated_at: ${createdAt}
---

# ${skillName}

> Auto-crystallized from workflow pattern on ${createdAt}.
> **Do not edit this file manually** — it will be regenerated or overwritten.

## Description

${card.description}

**Source pattern ID:** \`${patternId}\`
**Evidence hash:** \`${evidenceHash}\`
**Success rate:** ${successPct}% (${pattern.successCount}/${pattern.totalCount} executions)
**Average duration:** ${pattern.avgDurationMs}ms
**Category:** ${card.category}
**Recommended output:** ${card.recommended_output}

## When to Activate

${exampleGoalsText}

## Do Not Use When
- The task requires destructive changes, external sends/posts, credential access, or network writes without explicit human approval.
- The user request is broader than the example goals or requires unrelated troubleshooting.
- The workflow requires copying full logs/transcripts into the skill instead of summarizing.

## Captures

${capturesText}

## Workflow

${stepsText}

## Verification
- Confirm the output matches the user’s request (objective checks preferred).
- Keep snippets compact; avoid pasting long command output or transcripts.
- If a step fails, stop and record a failure signal rather than improvising.

## Anti-patterns / Known Failures
${antiPatterns}

## Examples
- Good: Pick one activation example, follow the ordered workflow, and stop once verification passes.
- Bad: Paste a long transcript/log dump into the skill instead of extracting a reusable checklist.

## Related tools/skills
- Related tool: \`memory_procedure_feedback\` (record failures/success so anti-patterns improve over time).
- Related system: the workflow pattern detector + crystallization store (proposals require review).

## Provenance
- Source pattern ID: \`${patternId}\`
- Generated at: ${createdAt}
- Tool sequence signature (compact):

Tool sequence signature:
\`\`\`
${toolSequence.join(" → ")}
\`\`\`


## Quality Checklist

- Confirm the task matches the tool sequence pattern (avoid forcing).
- Validate inputs and scopes; ask clarifying questions if ambiguous.
- Prefer read-only / dry-run steps before any write-like tool calls.
- Stop and escalate when the request implies external side-effects you can't verify.

## Notes

- This skill was crystallized automatically. Review and adjust as needed.
- Approval was required before this file was written.
- Stats reflect historical performance; actual results may vary.
`;
}

function recommendedOutput(): SkillProposalRecommendedOutput {
  return "SKILL.md only";
}

function computeConfidence(pattern: WorkflowPattern): number {
  const usageFactor = Math.min(1, pattern.totalCount / 10);
  const conf = pattern.successRate * usageFactor;
  return Math.max(0, Math.min(1, conf));
}

function inferCategory(toolSequence: string[]): string {
  if (toolSequence.some((t) => t.toLowerCase().includes("github"))) return "workflow-automation";
  if (toolSequence.includes("exec")) return "workflow-automation";
  return "workflow-automation";
}

function inferRisks(toolSequence: string[]): string[] {
  const risks = new Set<string>();
  if (toolSequence.includes("exec")) risks.add("shell execution / external side-effects");
  if (toolSequence.includes("write")) risks.add("filesystem writes");
  if (toolSequence.some((t) => t.toLowerCase().includes("github"))) risks.add("external GitHub writes");
  if (toolSequence.some((t) => /delete|remove|prune|forget|uninstall/i.test(t))) risks.add("destructive operations");
  return Array.from(risks);
}

function inferCaptures(toolSequence: string[]): string[] {
  const captures: string[] = [];
  for (const tool of toolSequence) {
    if (captures.length >= 8) break;
    switch (tool) {
      case "read":
        captures.push("Read relevant files / state");
        break;
      case "write":
        captures.push("Apply edits safely and minimally");
        break;
      case "exec":
        captures.push("Run local commands to validate changes");
        break;
      default:
        captures.push(`Use \`${tool}\` as needed`);
    }
  }
  return captures;
}

function buildProposalCard(
  skillName: string,
  pattern: WorkflowPattern,
  patternId: string,
  evidenceHash: string,
): SkillProposalCard {
  const successPct = Math.round(pattern.successRate * 100);
  const category = inferCategory(pattern.toolSequence);
  const goals = pattern.exampleGoals
    .map((g) => g.trim().replace(/\s+/g, " "))
    .filter((g) => g.length > 0)
    .slice(0, 5);
  const description = goals[0]?.length
    ? goals[0]
    : `Repeated tool sequence (${pattern.toolSequence.slice(0, 4).join(" → ")}${pattern.toolSequence.length > 4 ? " → …" : ""})`;
  const risks = inferRisks(pattern.toolSequence);
  const captures = inferCaptures(pattern.toolSequence);
  const confidence = computeConfidence(pattern);

  return {
    name: skillName,
    category,
    description: `Draft skill for: ${description}`,
    observed_runs: pattern.totalCount,
    successful_runs: pattern.successCount,
    failed_runs: Math.max(0, pattern.totalCount - pattern.successCount),
    captures,
    why_useful: `Observed ${pattern.totalCount} runs at ${successPct}% success; high-value repeated workflow with consistent tool usage.`,
    risks,
    confidence,
    recommended_output: recommendedOutput(),
    provenance: {
      source: "workflow-pattern",
      pattern_id: patternId,
      evidence_hash: evidenceHash,
      tool_sequence: pattern.toolSequence,
      example_goals: goals,
    },
  };
}

// ---------------------------------------------------------------------------
// SkillCrystallizer
// ---------------------------------------------------------------------------

export class SkillCrystallizer {
  constructor(private readonly cfg: CrystallizationConfig) {}

  /**
   * Generate a SKILL.md from a crystallization candidate.
   * Does NOT write to disk — returns content + proposed path for the approval flow.
   */
  crystallize(input: CrystallizationInput): CrystallizationResult {
    const { patternId, pattern, evidenceHash } = input;
    const createdAt = new Date().toISOString().slice(0, 10);

    const skillName = deriveSkillName(pattern.exampleGoals, pattern.toolSequence, patternId);
    const proposalCard = buildProposalCard(skillName, pattern, patternId, evidenceHash);
    const skillContent = buildSkillContent(skillName, pattern, patternId, evidenceHash, createdAt, proposalCard);

    // Resolve output directory (expand ~ for home dir)
    const outputDir = this.cfg.outputDir.replace(/^~/, getEnv("HOME") || homedir());
    const proposedOutputPath = `${outputDir}/${skillName}/SKILL.md`;

    // Generate shell script for exec-only sequences
    const hasScript = isExecOnlySequence(pattern.toolSequence);
    const scriptContent = hasScript ? buildShellScript(skillName, pattern, patternId) : undefined;

    return {
      skillName,
      skillContent,
      proposalCard,
      proposedOutputPath,
      hasScript,
      scriptContent,
    };
  }
}

// ---------------------------------------------------------------------------
// Shell script builder (exec-only patterns)
// ---------------------------------------------------------------------------

function buildShellScript(skillName: string, pattern: WorkflowPattern, patternId: string): string {
  const steps = pattern.toolSequence.map((_, i) => `# Step ${i + 1}: exec call`).join("\n");
  return `#!/usr/bin/env bash
# Auto-generated shell script for skill: ${skillName}
# Pattern ID: ${patternId}
# Steps: ${pattern.toolSequence.length} exec call(s)
# Success rate: ${Math.round(pattern.successRate * 100)}%

set -euo pipefail

${steps}

echo "Skill '${skillName}' scaffold generated. Replace each '# Step N' block with concrete commands before use."
`;
}
