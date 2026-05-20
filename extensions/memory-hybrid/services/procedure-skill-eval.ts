/**
 * Deterministic usefulness evals for procedure-generated skills (issue #1546, v2 replay).
 */

import { SkillValidator } from "./skill-validator.js";
import { lintWorkflowActionability } from "./procedure-skill-workflow.js";

export type ProcedureSkillEvalInput = {
  skillMd: string;
  recipeJson: string;
  taskPattern: string;
  shouldTrigger: string[];
  shouldNotTrigger: string[];
  /** Historical session prompts for replay functional eval. */
  historicalPrompts?: string[];
  /** Other skill descriptions for baseline comparison. */
  baselineDescriptions?: string[];
};

export type ProcedureSkillEvalCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type ProcedureSkillEvalResult = {
  status: "passed" | "failed";
  checks: ProcedureSkillEvalCheck[];
  triggerEval: "passed" | "failed";
  functionalEval: "passed" | "failed";
  safetyEval: "passed" | "failed";
  baselineComparison?: {
    withSkillPassed: boolean;
    withoutSkillPassed: boolean;
    improvement: string;
    historicalPositiveMatches?: number;
    baselinePositiveMatches?: number;
  };
};

function extractDescription(skillMd: string): string {
  const fm = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return skillMd.slice(0, 500);
  const block = fm[1];
  const folded = block.match(/description:\s*>-\s*\n([\s\S]*?)(?=\n[A-Za-z0-9_-]+:|$)/);
  if (folded) {
    return folded[1]
      .split("\n")
      .map((l) => l.replace(/^\s{2}/, ""))
      .join(" ")
      .trim();
  }
  const quoted = block.match(/description:\s*"((?:\\.|[^"\\])*)"/);
  if (quoted) return quoted[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
  return "";
}

function extractWorkflowSection(skillMd: string): string {
  const match = skillMd.match(/## Workflow\n([\s\S]*?)(?=\n## |$)/);
  return match?.[1]?.trim() ?? "";
}

function promptTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

function descriptionMatchesPrompt(description: string, prompt: string, taskPattern: string): boolean {
  const lower = prompt.toLowerCase();
  const desc = description.toLowerCase();
  const taskSlice = taskPattern.toLowerCase().slice(0, Math.min(24, taskPattern.length));
  if (taskSlice.length >= 8 && lower.includes(taskSlice)) return true;
  const tokens = promptTokens(taskPattern);
  const overlap = tokens.filter((t) => desc.includes(t) && lower.includes(t)).length;
  return overlap >= Math.min(2, tokens.length);
}

function matchesTrigger(prompt: string, taskPattern: string, triggers: string[]): boolean {
  const lower = prompt.toLowerCase();
  if (lower.includes(taskPattern.toLowerCase().slice(0, Math.min(20, taskPattern.length)))) return true;
  return triggers.some((t) => {
    const words = promptTokens(t);
    return words.length > 0 && words.every((w) => lower.includes(w));
  });
}

function matchesNearMiss(prompt: string, shouldNot: string[]): boolean {
  const lower = prompt.toLowerCase();
  return shouldNot.some((t) => {
    const destructive = /\b(send|delete|destroy|credential|ssh|install)\b/i.test(t);
    if (!destructive) return false;
    const keywords = promptTokens(t);
    const overlap = keywords.filter((w) => lower.includes(w)).length;
    return overlap >= 2 && destructive;
  });
}

function runReplayFunctionalEval(input: ProcedureSkillEvalInput): {
  passed: boolean;
  baselineComparison: ProcedureSkillEvalResult["baselineComparison"];
} {
  const description = extractDescription(input.skillMd);
  const historical = (input.historicalPrompts ?? []).filter((p) => p.trim().length > 0);
  if (historical.length === 0) {
    return {
      passed: true,
      baselineComparison: {
        withSkillPassed: true,
        withoutSkillPassed: false,
        improvement: "no historical prompts; heuristic functional eval only",
      },
    };
  }

  let withSkill = 0;
  let baseline = 0;
  let nearMissFalseTriggers = 0;

  for (const prompt of historical) {
    if (descriptionMatchesPrompt(description, prompt, input.taskPattern)) withSkill++;
    const baselineHit = (input.baselineDescriptions ?? []).some((d) =>
      descriptionMatchesPrompt(d, prompt, input.taskPattern),
    );
    if (baselineHit) baseline++;
    if (matchesNearMiss(prompt, input.shouldNotTrigger) && descriptionMatchesPrompt(description, prompt, input.taskPattern)) {
      nearMissFalseTriggers++;
    }
  }

  const passed = withSkill >= baseline && nearMissFalseTriggers === 0;
  return {
    passed,
    baselineComparison: {
      withSkillPassed: withSkill > 0,
      withoutSkillPassed: baseline > 0,
      improvement:
        withSkill > baseline
          ? `with-skill matched ${withSkill}/${historical.length} historical prompts vs baseline ${baseline}`
          : withSkill === baseline
            ? "with-skill tied baseline on historical prompts"
            : "with-skill did not beat baseline on historical prompts",
      historicalPositiveMatches: withSkill,
      baselinePositiveMatches: baseline,
    },
  };
}

/**
 * Run deterministic eval suite (no LLM).
 */
export function runProcedureSkillEval(input: ProcedureSkillEvalInput): ProcedureSkillEvalResult {
  const checks: ProcedureSkillEvalCheck[] = [];
  const workflow = extractWorkflowSection(input.skillMd);

  for (const prompt of input.shouldTrigger) {
    const ok = matchesTrigger(prompt, input.taskPattern, input.shouldTrigger);
    checks.push({
      name: `shouldTrigger:${prompt.slice(0, 40)}`,
      passed: ok,
      detail: ok ? "matched" : "did not match trigger heuristics",
    });
  }

  for (const prompt of input.shouldNotTrigger) {
    const nearMiss = matchesNearMiss(prompt, input.shouldNotTrigger);
    const wronglyTriggers = matchesTrigger(prompt, input.taskPattern, input.shouldTrigger);
    checks.push({
      name: `shouldNotTrigger:${prompt.slice(0, 40)}`,
      passed: !wronglyTriggers,
      detail: wronglyTriggers ? "wrongly triggered on negative query" : nearMiss ? "near-miss correctly not treated as full trigger" : "ok",
    });
  }

  const actionability = lintWorkflowActionability(workflow, input.taskPattern);
  checks.push({
    name: "workflow-actionability",
    passed: actionability.actionable,
    detail: actionability.reasons.join("; ") || "ok",
  });

  const hasVerification = /\b(?:verify|validate|confirm|check|assert)\b/i.test(workflow);
  checks.push({
    name: "objective-verification",
    passed: hasVerification,
    detail: hasVerification ? "verification language present" : "missing verification step",
  });

  const validator = new SkillValidator();
  const staticResult = validator.validate(input.skillMd);
  checks.push({
    name: "static-validation",
    passed: staticResult.valid,
    detail: staticResult.violations.join("; ") || "ok",
  });

  const replay = runReplayFunctionalEval(input);
  checks.push({
    name: "replay-functional",
    passed: replay.passed,
    detail: replay.baselineComparison?.improvement ?? "replay",
  });

  const triggerFailed = checks.some((c) => c.name.startsWith("shouldTrigger:") && !c.passed);
  const functionalFailed =
    checks.some(
      (c) =>
        c.name === "workflow-actionability" ||
        c.name === "objective-verification" ||
        c.name === "replay-functional" ||
        (c.name.startsWith("shouldNotTrigger:") && !c.passed),
    ) || !replay.passed;
  const safetyFailed = !staticResult.valid;

  const status = triggerFailed || functionalFailed || safetyFailed ? "failed" : "passed";

  return {
    status,
    checks,
    triggerEval: triggerFailed ? "failed" : "passed",
    functionalEval: functionalFailed ? "failed" : "passed",
    safetyEval: safetyFailed ? "failed" : "passed",
    baselineComparison: replay.baselineComparison,
  };
}

export function formatEvalResultsJson(result: ProcedureSkillEvalResult): string {
  return `${JSON.stringify(
    {
      status: result.status,
      triggerEval: result.triggerEval,
      functionalEval: result.functionalEval,
      safetyEval: result.safetyEval,
      checks: result.checks,
      baselineComparison: result.baselineComparison,
      evaluatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
}
