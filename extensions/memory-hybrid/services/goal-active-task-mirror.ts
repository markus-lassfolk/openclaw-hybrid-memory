/**
 * Regenerate ACTIVE-TASKS.md with an ## Active Goals mirror section (read-only view of goal registry).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { readActiveTaskFile, serializeActiveTaskFile } from "./active-task.js";
import type { Goal } from "./goal-stewardship-types.js";

export function formatGoalsMirrorSection(goals: Goal[]): string {
  if (goals.length === 0) {
    return "_No active goals._\n";
  }
  const lines: string[] = [];
  for (const g of goals) {
    lines.push(`### [${g.label}]: ${g.description.slice(0, 200)}${g.description.length > 200 ? "…" : ""}`);
    lines.push(`- **Goal ID:** \`${g.id}\``);
    lines.push(`- **Status:** ${g.status}`);
    lines.push(`- **Priority:** ${g.priority}`);
    lines.push(
      `- **Progress:** assessments ${g.assessmentCount}/${g.maxAssessments} | dispatches ${g.dispatchCount}/${g.maxDispatches}`,
    );
    if (g.currentBlockers.length > 0) {
      lines.push(`- **Blockers:** ${g.currentBlockers.join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function refreshActiveTaskMirrorWithGoals(opts: {
  activeTaskPath: string;
  goals: Goal[];
  staleMinutes: number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const parsed = await readActiveTaskFile(opts.activeTaskPath, opts.staleMinutes);
    const active = parsed?.active ?? [];
    const completed = parsed?.completed ?? [];
    const goalsMd = formatGoalsMirrorSection(opts.goals);
    const content = serializeActiveTaskFile(active, completed, goalsMd);
    await mkdir(dirname(opts.activeTaskPath), { recursive: true });
    await writeFile(opts.activeTaskPath, content, "utf-8");
    opts.logger?.info?.(
      `memory-hybrid: ACTIVE-TASKS.md mirror refreshed (${opts.goals.length} active goal(s) in Goals section)`,
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.logger?.warn?.(`memory-hybrid: ACTIVE-TASKS.md mirror refresh failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
