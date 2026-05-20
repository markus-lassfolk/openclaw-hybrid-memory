/**
 * Actionable workflow synthesis for procedure-generated skills (issues #1547, #1538, v2).
 */

import { MAX_STEP_SUMMARY_CHARS, MAX_WORKFLOW_STEPS_IN_SKILL } from "../config/skill-size-limits.js";
import { redactAutopilotText } from "./pending-autopilot/redaction.js";

const PLACEHOLDER_WORKFLOW_PATTERNS: RegExp[] = [
  /bounded workflow phase\s*\d+/i,
  /use\s+`[^`]+`\s+only for the bounded task/i,
];

const VERIFICATION_WORDS =
  /\b(?:verify|validate|assert|expect|confirm|check|exit\s+(?:code|status)|file\s+exists|schema)\b/i;

const ACTION_VERBS = /\b(?:inspect|read|run|check|compare|report|query|list|fetch|review|validate|verify|confirm)\b/i;

const DESTRUCTIVE_TOOLS = new Set(["write", "edit", "exec", "bash", "shell", "sessions_spawn"]);

type RecipeStep = Record<string, unknown>;

export type WorkflowBuildOptions = {
  taskPattern: string;
  riskLevel?: "low" | "medium" | "high";
};

function truncateSummary(text: string, max = MAX_STEP_SUMMARY_CHARS): string {
  const redacted = redactAutopilotText(text).redacted;
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max - 14)}… [truncated]`;
}

function domainTokens(taskPattern: string): string[] {
  return taskPattern
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

function extractCommand(step: RecipeStep): string | null {
  const args = step.args;
  if (args && typeof args === "object" && typeof (args as Record<string, unknown>).command === "string") {
    return String((args as Record<string, unknown>).command).trim();
  }
  return null;
}

function summarizeStepLow(step: RecipeStep, index: number, taskPattern: string): string {
  const tool = typeof step.tool === "string" ? step.tool : "manual check";
  const summary =
    typeof step.summary === "string" ? step.summary : "follow the recorded safe step, then verify before continuing";
  const safeSummary = truncateSummary(summary);
  const domain = domainTokens(taskPattern)[0];
  const verifyHint = VERIFICATION_WORDS.test(summary) ? "" : " Confirm outcome before continuing.";
  if (safeSummary.length > 20) {
    return `${index + 1}. ${safeSummary}.${verifyHint}`;
  }
  return `${index + 1}. Inspect ${domain ?? "the"}-related state (${tool}); stay read-only/dry-run.${verifyHint}`;
}

function summarizeStepHigh(step: RecipeStep, index: number): string {
  const tool = typeof step.tool === "string" ? step.tool : "step";
  const cmd = extractCommand(step);
  const summary = typeof step.summary === "string" ? truncateSummary(step.summary) : "";
  if (cmd) {
    return `${index + 1}. Run exactly: \`${cmd}\`. Do not modify flags or add side effects.`;
  }
  return `${index + 1}. Use \`${tool}\` as recorded: ${summary || "see recipe.json"}. Do not improvise.`;
}

function summarizeStepMedium(step: RecipeStep, index: number, taskPattern: string): string {
  const tool = typeof step.tool === "string" ? step.tool : "manual check";
  const cmd = extractCommand(step);
  const summary = typeof step.summary === "string" ? truncateSummary(step.summary) : "";
  const domain = domainTokens(taskPattern)[0] ?? "task";
  if (cmd) {
    return `${index + 1}. Run \`${cmd}\` for ${domain}; customize only if the user confirms scope.${VERIFICATION_WORDS.test(summary) ? "" : " Verify before continuing."}`;
  }
  return summarizeStepLow(step, index, taskPattern);
}

function collapsePhases(steps: string[], maxSteps: number): string[] {
  if (steps.length <= maxSteps) return steps;
  const chunk = Math.ceil(steps.length / maxSteps);
  const out: string[] = [];
  for (let i = 0; i < steps.length; i += chunk) {
    const slice = steps.slice(i, i + chunk);
    const firstNum = i + 1;
    const lastNum = i + slice.length;
    out.push(
      `${out.length + 1}. Phases ${firstNum}–${lastNum}: ${slice[0]?.replace(/^\d+\.\s*/, "").split(".")[0] ?? "bounded steps"}; verify after each sub-step.`,
    );
  }
  return out.slice(0, maxSteps);
}

function hasWriteAfterRead(recipe: unknown[]): boolean {
  let sawRead = false;
  for (const step of recipe) {
    if (!step || typeof step !== "object") continue;
    const tool = String((step as RecipeStep).tool ?? "").toLowerCase();
    if (tool === "read" || tool === "memory_recall") sawRead = true;
    if (sawRead && DESTRUCTIVE_TOOLS.has(tool)) return true;
  }
  return false;
}

function buildChecklist(stepCount: number): string {
  const lines = Array.from({ length: Math.min(stepCount, 8) }, (_, i) => `- [ ] Step ${i + 1}`);
  return `\nCopy this checklist and track progress:\n\n\`\`\`\nWorkflow progress:\n${lines.join("\n")}\n\`\`\`\n`;
}

function buildPlanValidateExecute(): string {
  return `
### Plan → validate → execute
Before any write/exec side effect:
1. Draft the intended change in \`scripts/plan.json\` (or a short plan in your reply).
2. Validate prerequisites and scope with read-only checks.
3. Execute only after validation passes; stop on ambiguity.
`;
}

/**
 * Build workflow markdown (risk-tiered freedom + optional checklist / plan scaffold).
 */
export function buildActionableWorkflow(
  recipe: unknown,
  taskPattern: string,
  riskLevel: "low" | "medium" | "high" = "low",
): string {
  if (!Array.isArray(recipe) || recipe.length === 0) {
    return "1. Reconstruct the workflow from recipe.json only after human review.";
  }
  const steps = recipe as RecipeStep[];
  const rawSteps = steps.map((step, i) => {
    const s = step && typeof step === "object" ? step : {};
    if (riskLevel === "high") return summarizeStepHigh(s, i);
    if (riskLevel === "medium") return summarizeStepMedium(s, i, taskPattern);
    return summarizeStepLow(s, i, taskPattern);
  });
  const collapsed =
    steps.length > 8
      ? collapsePhases(rawSteps, MAX_WORKFLOW_STEPS_IN_SKILL)
      : rawSteps.slice(0, MAX_WORKFLOW_STEPS_IN_SKILL);
  let body = collapsed.join("\n");
  if (collapsed.length > 3) {
    body += buildChecklist(collapsed.length);
  }
  if (hasWriteAfterRead(steps)) {
    body += buildPlanValidateExecute();
  }
  return body.trim();
}

export type WorkflowActionabilityResult = {
  actionable: boolean;
  reasons: string[];
};

export function lintWorkflowActionability(workflow: string, taskPattern: string): WorkflowActionabilityResult {
  const reasons: string[] = [];
  for (const pattern of PLACEHOLDER_WORKFLOW_PATTERNS) {
    const matches = workflow.match(new RegExp(pattern.source, pattern.flags + "g"));
    if (matches && matches.length >= 2) {
      reasons.push(`placeholder pattern: ${pattern.source}`);
    }
  }
  const genericToolOnly = (workflow.match(/only for the bounded task/gi) ?? []).length;
  if (genericToolOnly >= 3) {
    reasons.push("too many generic tool-only steps");
  }
  const tokens = domainTokens(taskPattern);
  if (tokens.length > 0 && !tokens.some((t) => workflow.toLowerCase().includes(t))) {
    reasons.push("workflow lacks domain nouns from task pattern");
  }
  if (!VERIFICATION_WORDS.test(workflow) && !ACTION_VERBS.test(workflow)) {
    reasons.push("no verification or action verbs in workflow");
  }
  return { actionable: reasons.length === 0, reasons };
}

export { PLACEHOLDER_WORKFLOW_PATTERNS, VERIFICATION_WORDS };
