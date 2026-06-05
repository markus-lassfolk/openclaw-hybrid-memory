/**
 * Classify workflow trace goals — separate user-facing tasks from cron/system injections.
 */

export const DEFAULT_SYSTEM_GOAL_PATTERNS: RegExp[] = [
  /^\[cron:/i,
  /^\[Retry after the previous model/i,
  /^<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/i,
  /^\[Inter-session message\]/i,
  /^A spawned subagent task was interrupted/i,
  /^<!-- memory-hybrid:/i,
  /^<recalled-context>/i,
  /^\[Subagent Context\]/i,
  /^\[Tue \d{4}-\d{2}-\d{2}/i,
  /^\[Wed \d{4}-\d{2}-\d{2}/i,
  /^\[Thu \d{4}-\d{2}-\d{2}/i,
  /^\[Fri \d{4}-\d{2}-\d{2}/i,
  /^\[Sat \d{4}-\d{2}-\d{2}/i,
  /^\[Sun \d{4}-\d{2}-\d{2}/i,
  /^\[Mon \d{4}-\d{2}-\d{2}/i,
  /^Conversation info \(untrusted metadata\):/i,
  /^<!-- recall degraded:/i,
];

function compileExtraPatterns(extra?: string[]): RegExp[] {
  if (!extra?.length) return [];
  const out: RegExp[] = [];
  for (const raw of extra) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      out.push(new RegExp(trimmed, "i"));
    } catch {
      // ignore invalid regex in config
    }
  }
  return out;
}

export function isSystemWorkflowGoal(goal: string, extraPatterns?: string[]): boolean {
  const trimmed = goal.trim();
  if (!trimmed || trimmed === "unknown" || trimmed === "session") return true;
  const patterns = [...DEFAULT_SYSTEM_GOAL_PATTERNS, ...compileExtraPatterns(extraPatterns)];
  return patterns.some((p) => p.test(trimmed));
}

export function extractUserMessageText(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const role = (msg as { role?: string }).role;
  if (role !== "user") return null;
  const flatText = (msg as { text?: string }).text;
  if (typeof flatText === "string" && flatText.trim()) return flatText.trim();
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text.trim());
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}

/** Goals suitable for skill naming, triggers, and examples (drops cron/system injections). */
export function filterUserFacingGoals(
  goals: string[],
  opts?: { excludeSystemGoals?: boolean; excludeGoalPatterns?: string[] },
): string[] {
  if (opts?.excludeSystemGoals === false) {
    return goals.map((g) => g.trim()).filter((g) => g.length > 0);
  }
  return goals
    .map((g) => g.trim())
    .filter((g) => g.length > 0 && !isSystemWorkflowGoal(g, opts?.excludeGoalPatterns));
}

/**
 * Pick the first user message that looks like a real task (not cron/retry injection).
 */
export function extractUserWorkflowGoal(messages: unknown[], extraPatterns?: string[]): string {
  for (const msg of messages) {
    const text = extractUserMessageText(msg);
    if (!text) continue;
    if (!isSystemWorkflowGoal(text, extraPatterns)) return text.slice(0, 200);
  }
  return "unknown";
}

export function patternHasUserFacingGoal(
  exampleGoals: string[],
  opts?: { excludeSystemGoals?: boolean; excludeGoalPatterns?: string[] },
): boolean {
  if (opts?.excludeSystemGoals === false) return true;
  const goals = exampleGoals.filter((g) => g.trim().length > 0);
  if (goals.length === 0) return false;
  return goals.some((g) => !isSystemWorkflowGoal(g, opts?.excludeGoalPatterns));
}
