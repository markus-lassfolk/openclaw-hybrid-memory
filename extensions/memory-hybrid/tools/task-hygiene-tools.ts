/**
 * Task hygiene tools — draft goal_register payloads from ACTIVE-TASK.md rows.
 * @see docs/TASK-HYGIENE.md
 */
import { Type } from "@sinclair/typebox";
import { isAbsolute, join as pathJoin } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { HybridMemoryConfig } from "../config.js";
import { readActiveTaskFile } from "../services/active-task.js";
import { buildProposeGoalDraftFromTask } from "../services/task-hygiene.js";
import { capturePluginError } from "../services/error-reporter.js";
import { parseDuration } from "../utils/duration.js";
import { stableStringify } from "../utils/stable-stringify.js";

export interface TaskHygieneToolsContext {
  cfg: HybridMemoryConfig;
  /** Absolute path to ACTIVE-TASK.md */
  resolvedActiveTaskPath: string;
  workspaceRoot: string;
}

export function resolveActiveTaskPathForTools(cfg: HybridMemoryConfig, workspaceRoot: string): string {
  return isAbsolute(cfg.activeTask.filePath)
    ? cfg.activeTask.filePath
    : pathJoin(workspaceRoot, cfg.activeTask.filePath);
}

export function registerTaskHygieneTools(ctx: TaskHygieneToolsContext, api: ClawdbotPluginApi): void {
  const path = ctx.resolvedActiveTaskPath;
  const { cfg } = ctx;

  const disabled = () => ({
    content: [
      {
        type: "text" as const,
        text: "Active tasks are disabled. Set activeTask.enabled: true and ensure ACTIVE-TASK.md exists.",
      },
    ],
    details: { error: "active_task_disabled" },
  });

  api.registerTool(
    {
      name: "active_task_propose_goal",
      label: "Propose goal from active task",
      description:
        "Read ACTIVE-TASK.md and return a draft goal_register payload for a task label (promote tactical work to stewardship goals).",
      parameters: Type.Object({
        task_label: Type.String({ minLength: 1 }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        if (!cfg.activeTask.enabled) return disabled();
        try {
          const staleMinutes = parseDuration(cfg.activeTask.staleThreshold);
          const file = await readActiveTaskFile(path, staleMinutes);
          if (!file || file.active.length === 0) {
            return {
              content: [{ type: "text", text: "No active tasks in ACTIVE-TASK.md (or file missing)." }],
              details: { error: "no_active_tasks", path },
            };
          }
          const want = String((params as { task_label: string }).task_label).trim();
          const task =
            file.active.find((t) => t.label === want) ??
            file.active.find((t) => t.label.toLowerCase() === want.toLowerCase());
          if (!task) {
            return {
              content: [
                {
                  type: "text",
                  text: `No active task with label matching "${want}". Labels: ${file.active.map((t) => t.label).join(", ")}`,
                },
              ],
              details: { error: "task_not_found", path },
            };
          }
          const draft = buildProposeGoalDraftFromTask(task);
          const goalRegisterExample = {
            label: draft.suggestedLabel,
            description: draft.suggestedDescription,
            acceptance_criteria: draft.suggestedCriteria,
          };
          const text = [
            "**Draft for `goal_register` (refine with the user before calling when policy requires confirmation):**",
            "",
            "```json",
            stableStringify(goalRegisterExample),
            "```",
            "",
            `**Notes:** ${draft.notes}`,
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: { draft, goal_register_suggestion: goalRegisterExample, activeTaskPath: path },
          };
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "task-hygiene-tools",
            operation: "active_task_propose_goal",
          });
          return { content: [{ type: "text", text: String(err) }], details: { error: String(err) } };
        }
      },
    },
    { name: "active_task_propose_goal" },
  );
}
