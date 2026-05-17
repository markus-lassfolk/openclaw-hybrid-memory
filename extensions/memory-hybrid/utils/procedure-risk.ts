import type { ProcedureEntry } from "../types/memory.js";

export type ProcedureRiskLevel = "low" | "medium" | "high";

const HIGH_RISK_PATTERN =
  /(?:\brm\s+-[rf]+\b|\bdd\s+if=|\bmkfs\b|\bshred\b|\bdrop\s+table\b|\btruncate\s+table\b)|(?:\bprivate[_-]?key\b|\b(?:token|password)\b)\s*[:=]/i;

const MEDIUM_RISK_PATTERN =
  /\b(systemctl|service)\s+(?:start|stop|restart|reload|enable|disable)\b|\b(npm|pnpm|yarn|pip|pip3|apt|apt-get|brew|cargo|gem)\s+(install|add|remove|uninstall|upgrade)\b|\bssh\s+[^\n]+@|\bscp\s+|\brsync\s+[^\n]+:|\b(curl|wget|fetch)\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE))/i;

export function parseRecipeOrRaw(recipeJson: string): unknown {
  try {
    return JSON.parse(recipeJson) as unknown;
  } catch {
    return { malformed: true, raw: recipeJson };
  }
}

/** Heuristic risk tier for procedure text + recipe (used for promotion gates, scoring, and lifecycle demotion). */
export function determineRiskLevel(proc: ProcedureEntry, recipe: unknown): ProcedureRiskLevel {
  const combined = `${proc.taskPattern}\n${JSON.stringify(recipe)}`;
  if (HIGH_RISK_PATTERN.test(combined)) return "high";
  if (MEDIUM_RISK_PATTERN.test(combined)) return "medium";
  return "low";
}
