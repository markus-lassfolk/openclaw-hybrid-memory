/**
 * Deterministic usefulness evals for procedure-generated skills (issue #1546, v2 replay).
 */

import { SkillValidator } from "./skill-validator.js";
import { extractWorkflowSection, lintWorkflowActionability } from "./procedure-skill-workflow.js";

export type ProcedureSkillEvalInput = {
  /** Deterministic Unix timestamp (seconds) used for persisted eval metadata. */
  now?: number;
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
  /** Deterministic timestamp from the promotion evaluation clock. */
  evaluatedAt: string;
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
  /** Explicit fields requested by #1546 acceptance criteria. */
  functionalPrompts: string[];
  expectedVerification: string;
  safetyAssertions: string[];
  /** True when reviewer attention is required before enabling the skill. */
  humanReviewRequired: boolean;
  humanReviewReasons: string[];
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

function promptTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

function descriptionMatchesPrompt(description: string, prompt: string, taskPattern: string): boolean {
  const lower = prompt.toLowerCase().trim();
  const desc = description.toLowerCase();
  if (lower.length >= 8 && desc.includes(lower)) return true;
  const tokens = [...new Set([...promptTokens(taskPattern), ...promptTokens(prompt)])];
  if (tokens.length === 0) return false;
  const overlap = tokens.filter((t) => desc.includes(t) && lower.includes(t)).length;
  if (overlap >= Math.min(2, tokens.length)) return true;
  const taskSlice = taskPattern.toLowerCase().slice(0, Math.min(24, taskPattern.length));
  if (taskSlice.length >= 8 && lower.includes(taskSlice) && desc.includes(taskSlice)) return true;
  return false;
}

function _matchesTrigger(prompt: string, taskPattern: string, triggers: string[]): boolean {
  const lower = prompt.toLowerCase();
  if (lower.includes(taskPattern.toLowerCase().slice(0, Math.min(20, taskPattern.length)))) return true;
  return triggers.some((t) => {
    const words = promptTokens(t);
    return words.length > 0 && words.every((w) => lower.includes(w));
  });
}

/** Description explicitly scopes out destructive / near-miss misuse. */
function descriptionExcludesNearMiss(description: string): boolean {
  return /\b(?:do not use|not use for|never use|avoid using|near-?miss|destructive|credential access|external send)\b/i.test(
    description,
  );
}

function matchesNearMiss(prompt: string, shouldNot: string[]): boolean {
  const lower = prompt.toLowerCase();
  if (isNearMissNegativePrompt(lower)) return true;
  const destructiveOnPrompt = /\b(send|delete|destroy|credential|ssh|install)\b/i.test(lower);
  if (!destructiveOnPrompt) return false;
  return shouldNot.some((t) => {
    const keywords = promptTokens(t);
    const overlap = keywords.filter((w) => lower.includes(w)).length;
    return overlap >= 2;
  });
}

/** Synthesized near-miss prompts often quote the task; they must not count as wrongful triggers. */
function isNearMissNegativePrompt(lower: string): boolean {
  if (
    /\b(?:instead of|without approval|unrelated automation|destructive variant|bypass approval|credential access|external sending|arbitrary shell|unrelated to)\b/i.test(
      lower,
    )
  ) {
    return true;
  }
  return /\b(?:send|post|delete|destroy|install|ssh)\b/i.test(lower);
}

/**
 * Whether a negative eval prompt would wrongly activate via explicit trigger phrases only.
 * Omits the broad task-pattern substring shortcut used for positive shouldTrigger checks.
 */
function matchesWrongfulTriggerOnNegative(prompt: string, shouldTrigger: string[]): boolean {
  const lower = prompt.toLowerCase();
  return shouldTrigger.some((t) => {
    const words = promptTokens(t);
    return words.length > 0 && words.every((w) => lower.includes(w));
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
    if (
      matchesNearMiss(prompt, input.shouldNotTrigger) &&
      descriptionMatchesPrompt(description, prompt, input.taskPattern)
    ) {
      nearMissFalseTriggers++;
    }
  }

  const passed = withSkill > 0 && withSkill >= baseline && nearMissFalseTriggers === 0;
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

  const description = extractDescription(input.skillMd);
  for (const prompt of input.shouldTrigger) {
    const ok = descriptionMatchesPrompt(description, prompt, input.taskPattern);
    checks.push({
      name: `shouldTrigger:${prompt.slice(0, 40)}`,
      passed: ok,
      detail: ok ? "description matches prompt" : "description did not match trigger prompt",
    });
  }

  for (const prompt of input.shouldNotTrigger) {
    const nearMiss = matchesNearMiss(prompt, input.shouldNotTrigger);
    const wronglyTriggers = nearMiss
      ? descriptionMatchesPrompt(description, prompt, input.taskPattern) && !descriptionExcludesNearMiss(description)
      : matchesWrongfulTriggerOnNegative(prompt, input.shouldTrigger);
    checks.push({
      name: `shouldNotTrigger:${prompt.slice(0, 40)}`,
      passed: !wronglyTriggers,
      detail: wronglyTriggers
        ? nearMiss
          ? "description matched near-miss negative prompt (over-broad trigger)"
          : "wrongly triggered on negative query"
        : nearMiss
          ? "near-miss correctly not treated as full trigger"
          : "ok",
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
        (c.name === "workflow-actionability" ||
          c.name === "objective-verification" ||
          c.name === "replay-functional" ||
          c.name.startsWith("shouldNotTrigger:")) &&
        !c.passed,
    ) || !replay.passed;
  const safetyFailed = !staticResult.valid;

  const status = triggerFailed || functionalFailed || safetyFailed ? "failed" : "passed";

  const verificationSentence =
    (workflow.match(/^\s*\d+\.[^\n]*\b(?:verify|validate|confirm|check|assert)\b[^\n]*/im) ?? [])[0]?.trim() ??
    (hasVerification ? "verification language present in workflow" : "no objective verification step detected");

  const safetyAssertions: string[] = [];
  if (staticResult.valid)
    safetyAssertions.push("static SkillValidator passes (no secrets/prompt-injection/private paths)");
  else safetyAssertions.push(`static SkillValidator FAILED: ${staticResult.violations.join("; ")}`);
  if (!input.shouldNotTrigger.some((p) => matchesWrongfulTriggerOnNegative(p, input.shouldTrigger))) {
    safetyAssertions.push("destructive near-miss prompts do not trigger the skill");
  } else {
    safetyAssertions.push("WARNING: destructive near-miss prompt wrongly matches trigger");
  }
  if (/\bstop\b|\breport\b|\bdefer\b/i.test(workflow)) {
    safetyAssertions.push("workflow includes explicit stop/report path on failure");
  }

  const humanReviewReasons: string[] = [];
  if (triggerFailed) humanReviewReasons.push("trigger eval failed");
  if (functionalFailed) humanReviewReasons.push("functional usefulness eval failed");
  if (safetyFailed) humanReviewReasons.push("static safety validation failed");
  const humanReviewRequired = humanReviewReasons.length > 0;

  const evaluatedAt = new Date((input.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();

  return {
    evaluatedAt,
    status,
    checks,
    triggerEval: triggerFailed ? "failed" : "passed",
    functionalEval: functionalFailed ? "failed" : "passed",
    safetyEval: safetyFailed ? "failed" : "passed",
    baselineComparison: replay.baselineComparison,
    functionalPrompts: [...input.shouldTrigger, ...(input.historicalPrompts ?? [])].slice(0, 20),
    expectedVerification: verificationSentence,
    safetyAssertions,
    humanReviewRequired,
    humanReviewReasons,
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
      functionalPrompts: result.functionalPrompts,
      expectedVerification: result.expectedVerification,
      safetyAssertions: result.safetyAssertions,
      humanReviewRequired: result.humanReviewRequired,
      humanReviewReasons: result.humanReviewReasons,
      evaluatedAt: result.evaluatedAt,
    },
    null,
    2,
  )}\n`;
}
