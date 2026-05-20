/**
 * Concrete Input/Output examples for generated skills (Anthropic examples pattern).
 */

function firstKeyword(task: string): string {
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
  return words[0] ?? "workflow";
}

function verificationSummaryFromRecipe(recipe: unknown): string {
  if (!Array.isArray(recipe)) {
    return "Confirm the outcome with an objective check (exit code, file exists, or status text) before reporting success.";
  }
  for (const step of [...recipe].reverse()) {
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    const summary = typeof s.summary === "string" ? s.summary : "";
    if (/\b(?:verify|validate|confirm|check|expect|exit)\b/i.test(summary)) {
      return `Follow the workflow, then verify: ${summary.slice(0, 200)}`;
    }
  }
  return "Follow the ordered workflow, then confirm output with file existence, schema validation, or command exit status.";
}

export function buildSkillExamplesSection(input: {
  taskPattern: string;
  nearMiss: string;
  recipe: unknown;
}): string {
  const task = input.taskPattern.trim();
  const kw = firstKeyword(task);
  const goodOutput = verificationSummaryFromRecipe(input.recipe);
  const badOutput =
    `Decline this request; it is a near-miss (destructive, send, or out-of-scope). ` +
    `Ask for clarification or route to a more specific skill.`;

  return `## Examples

**Example 1 (should use this skill):**
Input: "${task}"
Output:
${goodOutput}

**Example 2 (should use this skill):**
Input: "please ${task.toLowerCase()}"
Output:
${goodOutput}

**Example 3 (should NOT use this skill):**
Input: "${input.nearMiss}"
Output:
${badOutput}
`;
}
