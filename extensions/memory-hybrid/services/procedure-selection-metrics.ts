/**
 * Selection-quality metrics for procedure → skill promotion (Skill Creator v2).
 */

const OBVIOUS_SINGLE_TOOL = new Set(["read", "memory_recall", "memory_search", "ls", "pwd", "cat"]);
const OBVIOUS_COMMANDS = /^(?:ls|pwd|cat|git\s+status|echo)\b/i;

const MIN_DOMAIN_NOUNS = 1;
const MIN_TOOL_DIVERSITY_OR_STEPS = 2;

export type ConcretenessResult = {
  score: number;
  domainNounCount: number;
  distinctTools: number;
  stepCount: number;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

function distinctToolsFromRecipe(recipe: unknown): Set<string> {
  const tools = new Set<string>();
  if (!Array.isArray(recipe)) return tools;
  for (const step of recipe) {
    if (step && typeof step === "object" && typeof (step as Record<string, unknown>).tool === "string") {
      tools.add(String((step as Record<string, unknown>).tool).toLowerCase());
    }
  }
  return tools;
}

/**
 * Concreteness: domain nouns from task + tool diversity in recipe.
 */
export function measureConcreteness(taskPattern: string, recipe: unknown): ConcretenessResult {
  const domainNouns = new Set(tokenize(taskPattern));
  const tools = distinctToolsFromRecipe(recipe);
  const stepCount = Array.isArray(recipe) ? recipe.length : 0;
  const domainNounCount = domainNouns.size;
  const distinctToolCount = tools.size;
  const nounScore = Math.min(1, domainNounCount / 3);
  const toolScore = Math.min(1, distinctToolCount / 2);
  const stepScore = Math.min(1, stepCount / 3);
  const score = Number((nounScore * 0.5 + toolScore * 0.3 + stepScore * 0.2).toFixed(3));
  return { score, domainNounCount, distinctTools: distinctToolCount, stepCount };
}

export function isLowConcreteness(taskPattern: string, recipe: unknown): boolean {
  const m = measureConcreteness(taskPattern, recipe);
  if (m.domainNounCount < MIN_DOMAIN_NOUNS) return true;
  if (m.stepCount >= MIN_TOOL_DIVERSITY_OR_STEPS && m.distinctTools < 1) return true;
  return m.score < 0.35;
}

/**
 * Defer when the workflow is a single obvious command Claude already knows.
 */
export function isProcedureTooObvious(recipe: unknown): boolean {
  if (!Array.isArray(recipe) || recipe.length === 0) return false;
  if (recipe.length > 2) return false;
  const tools = distinctToolsFromRecipe(recipe);
  if (tools.size !== 1) return false;
  const only = [...tools][0];
  if (!OBVIOUS_SINGLE_TOOL.has(only)) return false;
  for (const step of recipe) {
    if (!step || typeof step !== "object") continue;
    const s = step as Record<string, unknown>;
    const cmd =
      typeof s.summary === "string"
        ? s.summary
        : s.args && typeof s.args === "object" && typeof (s.args as Record<string, unknown>).command === "string"
          ? String((s.args as Record<string, unknown>).command)
          : "";
    if (cmd && OBVIOUS_COMMANDS.test(cmd.trim())) return true;
    if (!cmd || isTrivialSummary(cmd.trim(), only)) return true;
  }
  return false;
}

function isTrivialSummary(summary: string, tool: string): boolean {
  const lower = summary.toLowerCase();
  return lower === tool || lower === `${tool} file` || (lower.startsWith(`${tool} `) && lower.split(/\s+/).length <= 2);
}

export function reusabilityFromSessions(sourceSessionCount: number): number {
  return Math.min(1, sourceSessionCount / 3);
}
