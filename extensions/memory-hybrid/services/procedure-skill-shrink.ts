/**
 * Deterministic SKILL.md shrink and progressive disclosure (issues #1537, #1539).
 */

import {
  MAX_REFERENCE_WORKFLOW_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_BYTES_SAFE,
  utf8ByteLength,
} from "../config/skill-size-limits.js";
import { buildActionableWorkflow } from "./procedure-skill-workflow.js";
import { addTableOfContentsIfLong } from "./skill-reference-sidecar.js";

export type SkillShrinkDiagnostics = {
  originalBytes: number;
  finalBytes: number;
  shrinkStages: string[];
  omittedSections: string[];
};

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8ByteLength(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/**
 * Replace a markdown section body between headings.
 */
function replaceSectionBody(skillMd: string, sectionHeading: string, newBody: string): string {
  const re = new RegExp(`(## ${sectionHeading}\\n)([\\s\\S]*?)(?=\\n## |$)`);
  if (!re.test(skillMd)) return skillMd;
  return skillMd.replace(re, `$1${newBody}\n`);
}

/**
 * Deterministic shrink: shorten Examples, Anti-patterns, Related tools.
 */
export function shrinkSkillMd(
  skillMd: string,
  targetBytes = MAX_SKILL_FILE_BYTES_SAFE,
): {
  skillMd: string;
  diagnostics: SkillShrinkDiagnostics;
} {
  const diagnostics: SkillShrinkDiagnostics = {
    originalBytes: utf8ByteLength(skillMd),
    finalBytes: utf8ByteLength(skillMd),
    shrinkStages: [],
    omittedSections: [],
  };
  let current = skillMd;
  const tryShrink = (stage: string, fn: (md: string) => string) => {
    if (utf8ByteLength(current) <= targetBytes) return;
    const next = fn(current);
    if (next !== current) {
      diagnostics.shrinkStages.push(stage);
      current = next;
    }
  };
  tryShrink("compress-examples", (md) =>
    replaceSectionBody(
      md,
      "Examples",
      "**Example 1:** Input: task match → Output: follow workflow and verify.\n**Example 2:** Input: near-miss → Output: decline.",
    ),
  );
  tryShrink("compress-anti-patterns", (md) =>
    replaceSectionBody(md, "Anti-patterns", "- Avoid improvising side effects when a step fails."),
  );
  diagnostics.finalBytes = utf8ByteLength(current);
  return { skillMd: current, diagnostics };
}

export type ProgressiveDisclosureResult = {
  skillMd: string;
  referenceWorkflowMd: string | null;
  diagnostics: SkillShrinkDiagnostics;
};

/**
 * When still over safe budget, offload detailed workflow to references/workflow.md.
 */
export function applyProgressiveDisclosure(
  skillMd: string,
  recipe: unknown,
  taskPattern: string,
  targetBytes = MAX_SKILL_FILE_BYTES_SAFE,
  riskLevel: "low" | "medium" | "high" = "low",
): ProgressiveDisclosureResult {
  const shrinkResult = shrinkSkillMd(skillMd, targetBytes);
  let current = shrinkResult.skillMd;
  const diagnostics = { ...shrinkResult.diagnostics };
  let referenceWorkflowMd: string | null = null;

  if (utf8ByteLength(current) > targetBytes && Array.isArray(recipe) && recipe.length > 0) {
    const detailed = `# Workflow detail\n\n${buildActionableWorkflow(recipe, taskPattern, riskLevel)}\n`;
    referenceWorkflowMd = addTableOfContentsIfLong(truncateUtf8ToBytes(detailed, MAX_REFERENCE_WORKFLOW_BYTES));
    const compactWorkflow =
      "Follow these phases; see `references/workflow.md` for step detail.\n\n" +
      buildActionableWorkflow(recipe.length > 8 ? recipe.slice(0, 8) : recipe, taskPattern, riskLevel);
    current = replaceSectionBody(current, "Workflow", compactWorkflow);
    diagnostics.shrinkStages.push("progressive-disclosure-workflow");
    diagnostics.omittedSections.push("workflow-detail-in-references");
  }

  if (utf8ByteLength(current) > MAX_SKILL_FILE_BYTES) {
    current = truncateUtf8ToBytes(current, MAX_SKILL_FILE_BYTES - 64);
    diagnostics.shrinkStages.push("hard-truncate-skill-md");
  }

  diagnostics.finalBytes = utf8ByteLength(current);
  return { skillMd: current, referenceWorkflowMd, diagnostics };
}

export { utf8ByteLength } from "../config/skill-size-limits.js";
