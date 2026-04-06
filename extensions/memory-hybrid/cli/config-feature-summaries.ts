/**
 * Shared human-readable summaries for goal stewardship and active-task settings
 * (used by `hybrid-mem config`, `goals config`, `active-tasks config`).
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { ActiveTaskConfig, GoalStewardshipConfig } from "../config.js";
import { getEnv } from "../utils/env-manager.js";

/** Default workspace root for resolving relative paths in CLI output. */
export function workspaceRootForCli(): string {
  return getEnv("OPENCLAW_WORKSPACE") ?? join(homedir(), ".openclaw", "workspace");
}

/** Absolute path to the active-task markdown file / projection target. */
export function resolvedActiveTaskFilePath(at: ActiveTaskConfig): string {
  const fp = typeof at.filePath === "string" && at.filePath.trim().length > 0 ? at.filePath.trim() : "ACTIVE-TASKS.md";
  return isAbsolute(fp) ? fp : join(workspaceRootForCli(), fp);
}

/** Lines for `openclaw hybrid-mem goals config`. */
export function formatGoalStewardshipConfigLines(gs: GoalStewardshipConfig): string[] {
  const lines: string[] = [];
  lines.push(`Goal stewardship — ${gs.enabled ? "enabled" : "disabled"}`);
  lines.push(`  goalsDir: ${gs.goalsDir}`);
  lines.push(`  model: ${gs.model?.trim() ? gs.model.trim() : "(default from LLM tiers)"}`);
  lines.push(`  heartbeatStewardship: ${gs.heartbeatStewardship ? "on" : "off"}`);
  lines.push(`  watchdogHealthCheck: ${gs.watchdogHealthCheck ? "on" : "off"}`);
  lines.push(
    `  heartbeatRefreshActiveTask (Goals mirror in ACTIVE-TASKS.md): ${gs.heartbeatRefreshActiveTask ? "on" : "off"}`,
  );
  lines.push(`  llmTriageOnHeartbeat: ${gs.llmTriageOnHeartbeat ? "on" : "off"}`);
  lines.push(`  multiGoal: max ${gs.multiGoalMaxGoals} goals, ${gs.multiGoalMaxChars} chars cap`);
  lines.push(`  circuitBreaker: ${gs.circuitBreaker.enabled ? "on" : "off"}`);
  if (gs.circuitBreaker.enabled) {
    lines.push(`    sameBlockerRepeatLimit: ${gs.circuitBreaker.sameBlockerRepeatLimit}`);
    lines.push(`    maxAssessmentsWithoutProgress: ${gs.circuitBreaker.maxAssessmentsWithoutProgress}`);
  }
  lines.push(
    `  allowCommandVerification: ${gs.allowCommandVerification ? "on" : "off"} (watchdog shell checks; off by default)`,
  );
  lines.push(
    `  globalLimits: max ${gs.globalLimits.maxActiveGoals} active goals, ${gs.globalLimits.maxDispatchesPerHour} dispatches/hour`,
  );
  lines.push(
    `  defaults: maxDispatches=${gs.defaults.maxDispatches}, maxAssessments=${gs.defaults.maxAssessments}, cooldown=${gs.defaults.cooldownMinutes}m, priority=${gs.defaults.priority}`,
  );
  lines.push("");
  lines.push("Toggle: openclaw hybrid-mem config-set goalStewardship enabled|disabled");
  lines.push("Help:   openclaw hybrid-mem help config-set goalStewardship.enabled");
  return lines;
}

/** Lines for `openclaw hybrid-mem active-tasks config`. */
export function formatActiveTaskConfigLines(at: ActiveTaskConfig): string[] {
  const path = resolvedActiveTaskFilePath(at);
  const lines: string[] = [];
  lines.push(`Active task — ${at.enabled ? "enabled" : "disabled"}`);
  lines.push(
    `  ledger: ${at.ledger} — ${at.ledger === "facts" ? "source: SQLite category:project facts; ACTIVE-TASKS.md can be rendered" : "source: ACTIVE-TASKS.md"}`,
  );
  lines.push(`  filePath: ${path}`);
  lines.push(`  staleThreshold: ${at.staleThreshold}`);
  lines.push(`  injectionBudget: ${at.injectionBudget} tokens`);
  lines.push(`  autoCheckpoint: ${at.autoCheckpoint ? "on" : "off"}`);
  lines.push(`  flushOnComplete: ${at.flushOnComplete !== false ? "on" : "off"}`);
  lines.push(`  staleWarning: ${at.staleWarning.enabled ? "on" : "off"}`);
  lines.push(
    `  taskHygiene — suggestGoalAfterTaskAgeDays: ${at.taskHygiene.suggestGoalAfterTaskAgeDays ?? 0} (0 = off)`,
  );
  lines.push(
    `  projection — mode: ${at.projection.mode}, sectioned: ${at.projection.sectioned}, dedupeBy: ${at.projection.dedupeBy}, maxRowsPerSection: ${at.projection.maxRowsPerSection ?? "(none)"}`,
  );
  lines.push("");
  lines.push("Naming: JSON config uses camelCase `activeTask.*`; CLI command is `active-tasks` (plural).");
  lines.push("The working-memory file default is ACTIVE-TASKS.md (see filePath above).");
  lines.push("Toggle: openclaw hybrid-mem config-set activeTask enabled|disabled");
  lines.push("Ledger: openclaw hybrid-mem config-set activeTask.ledger markdown|facts");
  lines.push("Help:   openclaw hybrid-mem help config-set activeTask.enabled");
  return lines;
}
