/**
 * Validate goal_register payloads for measurable acceptance criteria (#goal-clarity).
 */

const VAGUE_CRITERION_RE =
  /^(?:done|complete|completed|finished|success(?:ful)?|ok(?:ay)?|working|fixed|deployed|merged|ready)\.?$/i;

const VERIFIABLE_SIGNAL_RE =
  /\b(?:file|path|exists|http|https|url|command|exit|test|tests|pass(?:ing|ed)?|merge(?:d)?|pr\b|pull request|deploy(?:ed|ment)?|ci\b|green|status|200|404|curl|grep|json|yaml|md\b|readme|artifact|release|tag|version|sha|commit|branch|main|master|prod|staging|health|endpoint|api\b|cron|job|schedule|metric|threshold|count|zero|errors?)\b/i;

const VAGUE_DESCRIPTION_RE =
  /^(?:fix(?:\s+it)?|deploy|ship|finish|complete|do\s+it|make\s+it\s+work|handle\s+this|take\s+care\s+of\s+it)\.?$/i;

export interface GoalRegisterClarityInput {
  label: string;
  description: string;
  acceptance_criteria: string[];
  priority?: string;
}

export interface GoalRegisterClarityResult {
  ok: boolean;
  issues: string[];
  followUpQuestions: string[];
  suggestedCriteria: string[];
}

function isCriterionMeasurable(criterion: string): boolean {
  const trimmed = criterion.trim();
  if (trimmed.length < 12) return false;
  if (VAGUE_CRITERION_RE.test(trimmed)) return false;
  if (VERIFIABLE_SIGNAL_RE.test(trimmed)) return true;
  // Longer free-text criteria may still be OK if they mention concrete outcomes.
  return trimmed.length >= 40 && /\b(?:when|after|before|must|should|verify|confirm|ensure)\b/i.test(trimmed);
}

function suggestCriteriaFromDescription(description: string, label: string): string[] {
  const d = description.trim();
  const suggestions: string[] = [];
  const lower = d.toLowerCase();

  if (/\bdeploy\b|\bproduction\b|\bprod\b|\brelease\b/.test(lower)) {
    suggestions.push("Deployment completes successfully and the service health check returns OK.");
    suggestions.push("Post-deploy smoke test (or documented verification command) exits 0.");
  }
  if (/\bpr\b|\bpull request\b|\bmerge\b|\bgithub\b/.test(lower)) {
    suggestions.push("Target PR is merged to the default branch (or explicitly named branch).");
    suggestions.push("Required CI checks on the PR are green at merge time.");
  }
  if (/\bci\b|\btest\b|\bfix\b|\bbug\b/.test(lower)) {
    suggestions.push("Relevant test suite passes locally or in CI (name the suite or command).");
    suggestions.push("Reported failure mode no longer reproduces using the original repro steps.");
  }
  if (/\bmonitor\b|\bhealthy\b|\bhealth\b|\bglitchtip\b|\bsentry\b/.test(lower)) {
    suggestions.push("Health/monitoring endpoint returns success for 24h (or named window) without alert noise.");
  }

  if (suggestions.length === 0) {
    suggestions.push(
      `Human can verify "${label}" is done without ambiguity (name artifact, URL, command output, or observable state).`,
    );
    suggestions.push("All blocking external dependencies (reviews, CI, deploy gates) are cleared or documented.");
  }

  return suggestions.slice(0, 5);
}

function buildFollowUpQuestions(input: GoalRegisterClarityInput, issues: string[]): string[] {
  const questions: string[] = [];
  if (VAGUE_DESCRIPTION_RE.test(input.description.trim()) || input.description.trim().length < 25) {
    questions.push("What is the concrete desired end state (artifact, URL, merged PR, deployed service, file path)?");
    questions.push("What would you accept as proof this goal is complete?");
  }
  if (issues.some((i) => i.includes("acceptance criterion"))) {
    questions.push(
      "For each success criterion, how should we verify it mechanically (command, file check, PR state, HTTP probe)?",
    );
    questions.push("Are there blocking external dependencies (CI, review, deploy window) we should track explicitly?");
  }
  if ((input.priority === "critical" || input.priority === "high") && input.acceptance_criteria.length < 2) {
    questions.push("High-priority goals need at least two measurable criteria — what are the must-pass checks?");
  }
  if (questions.length === 0) {
    questions.push("Can you confirm each acceptance criterion is objectively verifiable without interpretation?");
  }
  return questions.slice(0, 5);
}

/** Returns ok=false when criteria/description are too vague to pursue reliably. */
export function validateGoalRegisterClarity(input: GoalRegisterClarityInput): GoalRegisterClarityResult {
  const issues: string[] = [];
  const description = input.description.trim();
  const criteria = input.acceptance_criteria.map((c) => c.trim()).filter(Boolean);

  if (description.length < 20 || VAGUE_DESCRIPTION_RE.test(description)) {
    issues.push("description is too vague — explain the outcome, scope, and how completion will be verified");
  }

  if (criteria.length === 0) {
    issues.push("acceptance_criteria must contain at least one non-empty item");
  }

  for (const [i, c] of criteria.entries()) {
    if (!isCriterionMeasurable(c)) {
      issues.push(
        `acceptance criterion ${i + 1} is not objectively verifiable ("${c.slice(0, 80)}${c.length > 80 ? "…" : ""}")`,
      );
    }
  }

  const unique = new Set(criteria.map((c) => c.toLowerCase()));
  if (unique.size !== criteria.length) {
    issues.push("acceptance_criteria contains duplicate or near-duplicate items");
  }

  if (
    (input.priority === "critical" || input.priority === "high") &&
    criteria.filter(isCriterionMeasurable).length < 2
  ) {
    issues.push("critical/high priority goals need at least two measurable acceptance criteria");
  }

  const suggestedCriteria = issues.length > 0 ? suggestCriteriaFromDescription(description, input.label.trim()) : [];
  const followUpQuestions = issues.length > 0 ? buildFollowUpQuestions(input, issues) : [];

  return {
    ok: issues.length === 0,
    issues,
    followUpQuestions,
    suggestedCriteria,
  };
}

export function formatGoalClarityRejection(result: GoalRegisterClarityResult): string {
  const lines = [
    "Goal not registered — acceptance criteria or description need clarification before pursuit is reliable.",
    "",
    "**Issues:**",
    ...result.issues.map((i) => `- ${i}`),
  ];
  if (result.followUpQuestions.length > 0) {
    lines.push("", "**Ask the user:**", ...result.followUpQuestions.map((q) => `- ${q}`));
  }
  if (result.suggestedCriteria.length > 0) {
    lines.push("", "**Suggested criteria (refine with the user):**", ...result.suggestedCriteria.map((s) => `- ${s}`));
  }
  lines.push(
    "",
    "After the user confirms refined criteria, call goal_register again with updated fields and `confirmed: true`.",
  );
  return lines.join("\n");
}
